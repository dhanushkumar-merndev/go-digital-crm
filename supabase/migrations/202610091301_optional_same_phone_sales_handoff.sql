begin;

-- Product-owner decision: a shared phone/customer can have different Sales
-- Consultants on separate enquiries. Only automatic handoffs prefer continuity.
-- Tenant/team/role eligibility, lead scope and the audit trail remain mandatory.

CREATE OR REPLACE FUNCTION public.transfer_lead_to_sales(target_lead_id uuid, target_user_id uuid DEFAULT NULL::uuid, transfer_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  target_lead public.leads%rowtype;
  normalized_reason text := nullif(btrim(coalesce(transfer_reason, '')), '');
  actor_is_owning_telecaller boolean := false;
  selected_user_id uuid := target_user_id;
  selected_method public.assignment_mode;
  selected_open_leads bigint;
  qualified_mode public.assignment_mode;
  assignment_id uuid;
  prior_owner_id uuid;
  handoff_at timestamptz := clock_timestamp();
  customer_owner_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if char_length(coalesce(normalized_reason, '')) > 500 then
    raise exception using errcode = '22023', message = 'TRANSFER_REASON_TOO_LONG';
  end if;

  if normalized_reason is null then
    raise exception using errcode = '22023', message = 'TRANSFER_REASON_REQUIRED';
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
  if target_lead.team_id is null then
    raise exception using errcode = '23514', message = 'LEAD_TEAM_REQUIRED';
  end if;
  select team_row.qualified_assignment_mode into qualified_mode
  from public.teams team_row
  where team_row.id = target_lead.team_id
    and team_row.organization_id = current_organization_id
  for update;
  if not app_private.can_access_record(
    current_organization_id, target_lead.branch_id, target_lead.team_id, target_lead.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;

  -- An unassigned lead leaves the comparison NULL, and a NULL guard is a guard
  -- that never fires, so the ownership test is pinned to false explicitly.
  actor_is_owning_telecaller := coalesce(target_lead.assigned_user_id = auth.uid(), false)
    and app_private.has_permission(current_organization_id, 'lead.update')
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.organization_id = current_organization_id
        and assignment_row.user_id = auth.uid()
        and assignment_row.active
        and role_row.role_key = 'telecaller_bdc'
    );
  if not actor_is_owning_telecaller
    and not app_private.has_permission(current_organization_id, 'lead.assign') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  if target_lead.lifecycle_status = 'Lost' then
    raise exception using errcode = '23514', message = 'LOST_LEAD_CANNOT_TRANSFER';
  end if;

  if exists (
    select 1 from public.followups followup_row
    where followup_row.organization_id = current_organization_id
      and followup_row.lead_id = target_lead.id
      and followup_row.status in ('OPEN', 'OVERDUE')
  ) then
    raise exception using errcode = '23514', message = 'FOLLOWUP_PENDING_BEFORE_SALES_HANDOFF';
  end if;

  if target_lead.customer_id is null then
    raise exception using errcode = '23514', message = 'LEAD_CUSTOMER_REQUIRED';
  end if;
  if target_lead.lifecycle_status = 'Transferred to Sales' then
    raise exception using errcode = '23514', message = 'LEAD_ALREADY_WITH_SALES';
  end if;

  -- These transaction-local flags are trusted because only this SECURITY
  -- DEFINER RPC sets them. They let the automatic handoff trigger write the
  -- system-owned lifecycle and let this RPC replace the lead owner.
  perform set_config('app.sales_handoff_rpc', 'on', true);
  perform set_config('app.assign_lead_rpc', 'on', true);

  -- Continuity is an automatic preference, never a restriction on an
  -- authorized explicit choice. The normal eligibility checks still apply.
  customer_owner_id := app_private.same_customer_owner(
    current_organization_id, target_lead.team_id, target_lead.normalized_phone,
    target_lead.customer_id, target_lead.id, 'QUALIFIED'
  );
  if selected_user_id is null and customer_owner_id is not null then
    selected_user_id := customer_owner_id;
  end if;

  if selected_user_id is not null then
    -- A manual pick must still be a Sales Consultant this team can hand to.
    if not exists (
      select 1
      from public.team_members member_row
      join public.profiles profile_row
        on profile_row.id = member_row.user_id
       and profile_row.organization_id = member_row.organization_id
      where member_row.organization_id = current_organization_id
        and member_row.team_id = target_lead.team_id
        and member_row.user_id = selected_user_id
        and member_row.active
        and member_row.eligible_for_qualified_leads
        and profile_row.active
        and profile_row.deleted_at is null
        and exists (
          select 1
          from public.user_role_assignments assignment_row
          join public.roles role_row
            on role_row.id = assignment_row.role_id
           and role_row.organization_id = assignment_row.organization_id
          where assignment_row.organization_id = current_organization_id
            and assignment_row.user_id = member_row.user_id
            and assignment_row.active
            and role_row.role_key = 'sales_consultant'
        )
    ) then
      raise exception using errcode = '23514', message = 'SALES_CONSULTANT_NOT_ELIGIBLE';
    end if;
    selected_method := case
      when target_user_id is null and customer_owner_id is not null then 'SAME_CUSTOMER'
      else 'MANUAL_ASSIGNMENT'
    end::public.assignment_mode;
  else
    select candidate.user_id, candidate.open_leads
    into selected_user_id, selected_open_leads
    from (
      select member_row.user_id,
        member_row.last_qualified_assigned_at,
        member_row.joined_at,
        (
          select count(*)::bigint
          from public.leads lead_row
          where lead_row.organization_id = current_organization_id
            and lead_row.team_id = target_lead.team_id
            and lead_row.assigned_user_id = member_row.user_id
            and lead_row.deleted_at is null
            and lead_row.lifecycle_status <> 'Lost'
        ) as open_leads
      from public.team_members member_row
      join public.profiles profile_row
        on profile_row.id = member_row.user_id
       and profile_row.organization_id = member_row.organization_id
      where member_row.organization_id = current_organization_id
        and member_row.team_id = target_lead.team_id
        and member_row.active
        and member_row.eligible_for_qualified_leads
        and profile_row.active
        and profile_row.deleted_at is null
        and exists (
          select 1
          from public.user_role_assignments assignment_row
          join public.roles role_row
            on role_row.id = assignment_row.role_id
           and role_row.organization_id = assignment_row.organization_id
          where assignment_row.organization_id = current_organization_id
            and assignment_row.user_id = member_row.user_id
            and assignment_row.active
            and role_row.role_key = 'sales_consultant'
        )
    ) candidate
    order by case when qualified_mode = 'ROUND_ROBIN' then 0 else candidate.open_leads end asc,
      candidate.last_qualified_assigned_at asc nulls first,
      candidate.joined_at asc,
      candidate.user_id
    limit 1;
    if selected_user_id is null then
      raise exception using errcode = '23514', message = 'NO_ELIGIBLE_SALES_CONSULTANT';
    end if;
    selected_method := case
      when qualified_mode = 'ROUND_ROBIN' then 'ROUND_ROBIN'
      else 'LEAST_ASSIGNED'
    end::public.assignment_mode;
  end if;

  prior_owner_id := target_lead.assigned_user_id;

  -- Qualified is the state the handoff guard and trigger both key off, so it
  -- has to land before the assignment row is written.
  if target_lead.lifecycle_status <> 'Qualified' then
    update public.leads
    set lifecycle_status = 'Qualified',
        first_contacted_at = coalesce(first_contacted_at, handoff_at),
        updated_at = greatest(handoff_at, updated_at + interval '1 microsecond')
    where id = target_lead.id;

    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      current_organization_id,
      target_lead.id,
      target_lead.lifecycle_status,
      'Qualified',
      auth.uid(),
      coalesce(normalized_reason, 'Qualified for sales handoff')
    );
  end if;

  update public.lead_assignments
  set active = false
  where lead_id = target_lead.id and active;

  insert into public.lead_assignments (
    organization_id, lead_id, branch_id, team_id, assigned_user_id,
    assignment_type, method, assigned_by, reason
  ) values (
    current_organization_id,
    target_lead.id,
    target_lead.branch_id,
    target_lead.team_id,
    selected_user_id,
    'QUALIFIED',
    selected_method,
    auth.uid(),
    coalesce(
      normalized_reason,
      case
        when selected_method = 'ROUND_ROBIN'
          then 'Auto-assigned to the next Sales Consultant in rotation.'
        when selected_method = 'LEAST_ASSIGNED'
          then 'Auto-assigned to the Sales Consultant with the fewest open leads.'
        when selected_method = 'SAME_CUSTOMER'
          then 'Kept with the Sales Consultant already handling this customer.'
        else 'Transferred to the selected Sales Consultant.'
      end
    )
  ) returning id into assignment_id;

  insert into public.lead_assignment_history (
    organization_id, lead_id, branch_id, team_id, previous_owner_id,
    new_owner_id, assigned_by, method, reason
  ) values (
    current_organization_id,
    target_lead.id,
    target_lead.branch_id,
    target_lead.team_id,
    prior_owner_id,
    selected_user_id,
    auth.uid(),
    selected_method,
    normalized_reason
  );

  update public.leads
  set assigned_user_id = selected_user_id,
      updated_at = greatest(handoff_at, updated_at + interval '1 microsecond')
  where id = target_lead.id;

  update public.team_members
  set last_qualified_assigned_at = handoff_at
  where organization_id = current_organization_id
    and team_id = target_lead.team_id
    and user_id = selected_user_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id,
    auth.uid(),
    'lead.sales_handoff_requested',
    'lead',
    target_lead.id::text,
    target_lead.branch_id,
    jsonb_build_object(
      'assignment_id', assignment_id,
      'sales_consultant_id', selected_user_id,
      'previous_owner_id', prior_owner_id,
      'method', selected_method,
      'open_leads_at_assignment', selected_open_leads,
      'reason', normalized_reason
    )
  );

  return jsonb_build_object(
    'lead_id', target_lead.id,
    'assignment_id', assignment_id,
    'assigned_user_id', selected_user_id,
    'method', selected_method,
    'lifecycle_status', (
      select lead_row.lifecycle_status
      from public.leads lead_row
      where lead_row.id = target_lead.id
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_handoff_candidates(target_lead_id uuid, target_search text DEFAULT ''::text)
 RETURNS TABLE(user_id uuid, full_name text, open_leads bigint, hot_leads bigint, recommended boolean, assignment_mode text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target_lead public.leads%rowtype;
  normalized_search text;
  qualified_mode public.assignment_mode;
  customer_owner_id uuid;
begin
  if target_lead_id is null then
    raise exception using errcode = '22023', message = 'LEAD_ID_REQUIRED';
  end if;
  normalized_search := left(btrim(coalesce(target_search, '')), 160);

  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.id = target_lead_id
    and lead_row.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.can_access_record(
      target_lead.organization_id,
      target_lead.branch_id,
      target_lead.team_id,
      target_lead.assigned_user_id
    )
    or not (
      app_private.has_permission(target_lead.organization_id, 'lead.assign')
      or (
        coalesce(target_lead.assigned_user_id = auth.uid(), false)
        and app_private.has_permission(target_lead.organization_id, 'lead.update')
      )
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_lead.team_id is null then
    raise exception using errcode = '23514', message = 'LEAD_TEAM_REQUIRED';
  end if;

  select team_row.qualified_assignment_mode into qualified_mode
  from public.teams team_row
  where team_row.id = target_lead.team_id
    and team_row.organization_id = target_lead.organization_id;

  -- Recommend continuity without hiding any other eligible consultant.
  -- An explicit choice is validated by transfer_lead_to_sales.
  customer_owner_id := app_private.same_customer_owner(
    target_lead.organization_id, target_lead.team_id, target_lead.normalized_phone,
    target_lead.customer_id, target_lead.id, 'QUALIFIED'
  );

  return query
  with eligible as (
    select member_row.user_id,
      profile_row.full_name,
      member_row.last_qualified_assigned_at,
      member_row.joined_at
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_lead.organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.active
      and member_row.eligible_for_qualified_leads
      and profile_row.active
      and profile_row.deleted_at is null
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.organization_id = target_lead.organization_id
          and assignment_row.user_id = member_row.user_id
          and assignment_row.active
          and role_row.role_key = 'sales_consultant'
      )
  ), loaded as (
    select eligible_row.*,
      coalesce(book.open_leads, 0)::bigint as open_leads,
      coalesce(book.hot_leads, 0)::bigint as hot_leads
    from eligible eligible_row
    left join lateral (
      select count(*)::bigint as open_leads,
        count(*) filter (where lead_row.temperature = 'HOT')::bigint as hot_leads
      from public.leads lead_row
      where lead_row.organization_id = target_lead.organization_id
        and lead_row.team_id = target_lead.team_id
        and lead_row.assigned_user_id = eligible_row.user_id
        and lead_row.deleted_at is null
        and lead_row.lifecycle_status <> 'Lost'
    ) book on true
  ), ranked as (
    -- The recommendation is a property of the team, not of the search box, so
    -- it is decided before any name filter is applied. It mirrors the order
    -- transfer_lead_to_sales uses for an automatic pick.
    select loaded_row.*,
      row_number() over (
        order by case when loaded_row.user_id = customer_owner_id then 0 else 1 end asc,
          case when qualified_mode = 'ROUND_ROBIN' then 0 else loaded_row.open_leads end asc,
          loaded_row.last_qualified_assigned_at asc nulls first,
          loaded_row.joined_at asc,
          loaded_row.user_id
      ) = 1 as recommended
    from loaded loaded_row
  )
  select ranked_row.user_id,
    ranked_row.full_name,
    ranked_row.open_leads,
    ranked_row.hot_leads,
    ranked_row.recommended,
    case
      when customer_owner_id is not null then 'SAME_CUSTOMER'
      else coalesce(qualified_mode::text, 'MANUAL_ASSIGNMENT')
    end
  from ranked ranked_row
  where normalized_search = ''
    or ranked_row.full_name ilike '%' || normalized_search || '%'
  order by ranked_row.recommended desc, ranked_row.open_leads asc, ranked_row.full_name, ranked_row.user_id
  limit 50;
end;
$function$;

revoke all on function public.transfer_lead_to_sales(uuid, uuid, text) from public, anon;
grant execute on function public.transfer_lead_to_sales(uuid, uuid, text) to authenticated;
revoke all on function public.get_sales_handoff_candidates(uuid, text) from public, anon;
grant execute on function public.get_sales_handoff_candidates(uuid, text) to authenticated;
notify pgrst, 'reload schema';
commit;
