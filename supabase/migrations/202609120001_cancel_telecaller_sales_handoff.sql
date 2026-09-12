begin;

-- A Telecaller can correct an immediate handoff decision without deleting the
-- original handoff. The lead returns to the same Telecaller as Contacted; the
-- Sales Consultant's active assignment is closed and both histories receive a
-- reverse event for an auditable timeline.

-- The assignment guard normally treats any lead with a past sales handoff as
-- Sales-only. Admit exactly the transaction-local return assignment written by
-- cancel_sales_handoff; direct inserts cannot set this trusted RPC context.
do $migration$
declare
  current_definition text;
  updated_definition text;
  guard_anchor constant text :=
    E'  if current_lifecycle = ''Qualified'' or has_prior_sales_handoff then\n'
    || E'    if not target_is_sales_consultant or new.assignment_type <> ''QUALIFIED'' then\n'
    || E'      raise exception using errcode = ''23514'', message = ''SALES_HANDOFF_REQUIRES_QUALIFIED_LEAD'';\n'
    || E'    end if;\n'
    || E'  elsif not target_is_telecaller or new.assignment_type <> ''FRESH'' then\n'
    || E'    raise exception using errcode = ''23514'', message = ''FRESH_ASSIGNMENT_REQUIRES_TELECALLER'';\n'
    || E'  end if;';
  cancellation_guard constant text :=
    E'  if coalesce(current_setting(''app.sales_handoff_cancellation_rpc'', true), '''') = ''on''\n'
    || E'    and new.assigned_user_id = auth.uid()\n'
    || E'    and target_is_telecaller\n'
    || E'    and new.assignment_type = ''FRESH''\n'
    || E'  then\n'
    || E'    return new;\n'
    || E'  elsif current_lifecycle = ''Qualified'' or has_prior_sales_handoff then\n'
    || E'    if not target_is_sales_consultant or new.assignment_type <> ''QUALIFIED'' then\n'
    || E'      raise exception using errcode = ''23514'', message = ''SALES_HANDOFF_REQUIRES_QUALIFIED_LEAD'';\n'
    || E'    end if;\n'
    || E'  elsif not target_is_telecaller or new.assignment_type <> ''FRESH'' then\n'
    || E'    raise exception using errcode = ''23514'', message = ''FRESH_ASSIGNMENT_REQUIRES_TELECALLER'';\n'
    || E'  end if;';
begin
  select pg_get_functiondef(
    'app_private.enforce_sales_lead_assignment()'::regprocedure
  ) into current_definition;
  updated_definition := replace(current_definition, guard_anchor, cancellation_guard);

  if updated_definition = current_definition
    or position('app.sales_handoff_cancellation_rpc' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'HANDOFF_CANCELLATION_GUARD_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

create or replace function public.cancel_sales_handoff(
  target_lead_id uuid,
  cancellation_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  target_lead public.leads%rowtype;
  handoff_history record;
  normalized_reason text := nullif(btrim(coalesce(cancellation_reason, '')), '');
  cancelled_at timestamptz := clock_timestamp();
  restored_assignment_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if normalized_reason is null then
    raise exception using errcode = '22023', message = 'HANDOFF_CANCELLATION_REASON_REQUIRED';
  end if;
  if char_length(normalized_reason) > 500 then
    raise exception using errcode = '22023', message = 'HANDOFF_CANCELLATION_REASON_TOO_LONG';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.id = target_lead_id
    and lead_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if target_lead.lifecycle_status <> 'Transferred to Sales'
    or target_lead.assigned_user_id is null then
    raise exception using errcode = '23514', message = 'HANDOFF_NOT_CANCELLABLE';
  end if;
  if not app_private.has_permission(current_organization_id, 'lead.update') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.organization_id = assignment_row.organization_id
     and role_row.id = assignment_row.role_id
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) then
    raise exception using errcode = '42501', message = 'HANDOFF_ORIGINAL_TELECALLER_REQUIRED';
  end if;

  select history_row.* into handoff_history
  from public.lead_assignment_history history_row
  where history_row.organization_id = current_organization_id
    and history_row.lead_id = target_lead.id
    and history_row.previous_owner_id = auth.uid()
    and history_row.new_owner_id = target_lead.assigned_user_id
  order by history_row.created_at desc, history_row.id desc
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'HANDOFF_ORIGINAL_TELECALLER_REQUIRED';
  end if;
  if target_lead.team_id is null or not exists (
    select 1
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.organization_id = member_row.organization_id
     and profile_row.id = member_row.user_id
    where member_row.organization_id = current_organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.user_id = auth.uid()
      and member_row.active
      and profile_row.active
      and profile_row.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'HANDOFF_RETURN_OWNER_NOT_ELIGIBLE';
  end if;

  -- Only this security-definer operation may cross the owner invariant and
  -- insert a fresh assignment after a previous qualified handoff.
  perform set_config('app.assign_lead_rpc', 'on', true);
  perform set_config('app.sales_handoff_cancellation_rpc', 'on', true);

  update public.leads
  set lifecycle_status = 'Contacted',
      assigned_user_id = auth.uid(),
      updated_at = greatest(cancelled_at, updated_at + interval '1 microsecond')
  where id = target_lead.id;

  update public.lead_assignments
  set active = false
  where organization_id = current_organization_id
    and lead_id = target_lead.id
    and active;

  insert into public.lead_assignments (
    organization_id, lead_id, branch_id, team_id, assigned_user_id,
    assignment_type, method, assigned_by, reason
  ) values (
    current_organization_id, target_lead.id, target_lead.branch_id, target_lead.team_id,
    auth.uid(), 'FRESH', 'MANUAL_ASSIGNMENT', auth.uid(), normalized_reason
  ) returning id into restored_assignment_id;

  insert into public.lead_assignment_history (
    organization_id, lead_id, branch_id, team_id, previous_owner_id,
    new_owner_id, assigned_by, method, reason
  ) values (
    current_organization_id, target_lead.id, target_lead.branch_id, target_lead.team_id,
    target_lead.assigned_user_id, auth.uid(), auth.uid(), 'MANUAL_ASSIGNMENT', normalized_reason
  );

  insert into public.lead_stage_history (
    organization_id, lead_id, from_status, to_status, changed_by, reason
  ) values (
    current_organization_id, target_lead.id, 'Transferred to Sales', 'Contacted', auth.uid(),
    normalized_reason
  );

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, target_lead.customer_id, target_lead.id,
    'SALES_HANDOFF_CANCELLED', auth.uid(),
    jsonb_build_object(
      'previous_sales_consultant_id', target_lead.assigned_user_id,
      'restored_telecaller_id', auth.uid(),
      'handoff_assignment_history_id', handoff_history.id,
      'restored_assignment_id', restored_assignment_id,
      'reason', normalized_reason
    )
  );

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'lead.sales_handoff_cancelled', 'lead',
    target_lead.id::text, target_lead.branch_id,
    jsonb_build_object(
      'previous_sales_consultant_id', target_lead.assigned_user_id,
      'restored_telecaller_id', auth.uid(),
      'handoff_assignment_history_id', handoff_history.id,
      'restored_assignment_id', restored_assignment_id,
      'reason', normalized_reason
    )
  );

  return jsonb_build_object(
    'lead_id', target_lead.id,
    'assigned_user_id', auth.uid(),
    'lifecycle_status', 'Contacted'
  );
end;
$$;

revoke all on function public.cancel_sales_handoff(uuid, text) from public, anon;
grant execute on function public.cancel_sales_handoff(uuid, text) to authenticated;

commit;
