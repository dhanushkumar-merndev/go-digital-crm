begin;

-- transfer_lead_to_sales is the only public operation that should cross both
-- protected boundaries in one transaction:
--   1. Qualified -> Transferred to Sales is system-owned.
--   2. assigned_user_id moves from the Telecaller to the Sales Consultant.
--
-- The RPC previously set neither trusted transaction flag. The automatic
-- lifecycle trigger could run, but the final owner update was rejected by
-- validate_lead_tenant_integrity with ASSIGNMENT_RPC_REQUIRED, rolling the
-- complete handoff back.
do $migration$
declare
  current_definition text;
  updated_definition text;
  patch_anchor text := E'  if target_lead.lifecycle_status = ''Transferred to Sales'' then\n    raise exception using errcode = ''23514'', message = ''LEAD_ALREADY_WITH_SALES'';\n  end if;\n\n  if selected_user_id is not null then';
  patched_anchor text := E'  if target_lead.lifecycle_status = ''Transferred to Sales'' then\n    raise exception using errcode = ''23514'', message = ''LEAD_ALREADY_WITH_SALES'';\n  end if;\n\n  -- These transaction-local flags are trusted because only this SECURITY\n  -- DEFINER RPC sets them. They let the automatic handoff trigger write the\n  -- system-owned lifecycle and let this RPC replace the lead owner.\n  perform set_config(''app.sales_handoff_rpc'', ''on'', true);\n  perform set_config(''app.assign_lead_rpc'', ''on'', true);\n\n  if selected_user_id is not null then';
begin
  select pg_get_functiondef(
    'public.transfer_lead_to_sales(uuid,uuid,text)'::regprocedure
  ) into current_definition;

  if current_definition is null then
    raise exception 'TRANSFER_LEAD_TO_SALES_FUNCTION_NOT_FOUND';
  end if;

  if position('app.sales_handoff_rpc' in current_definition) > 0
    and position('app.assign_lead_rpc' in current_definition) > 0
  then
    return;
  end if;

  updated_definition := replace(current_definition, patch_anchor, patched_anchor);
  if updated_definition = current_definition
    or position('app.sales_handoff_rpc' in updated_definition) = 0
    or position('app.assign_lead_rpc' in updated_definition) = 0
  then
    raise exception 'TRANSFER_LEAD_TO_SALES_GUARD_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

-- A Qualified -> Transferred transition is no longer trusted merely because
-- its old/new values look correct. It must occur inside transfer_lead_to_sales.
create or replace function app_private.enforce_role_lead_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_is_sales_consultant boolean;
  actor_is_telecaller boolean;
  trusted_sales_handoff boolean :=
    coalesce(current_setting('app.sales_handoff_rpc', true), '') = 'on';
begin
  if new.lifecycle_status is not distinct from old.lifecycle_status then
    return new;
  end if;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row on role_row.id = assignment_row.role_id
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) into actor_is_sales_consultant;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row on role_row.id = assignment_row.role_id
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) into actor_is_telecaller;

  if actor_is_sales_consultant
    and new.lifecycle_status not in ('Appointment Scheduled', 'Lost')
  then
    raise exception using errcode = '42501', message = 'SALES_CONSULTANT_LIFECYCLE_FORBIDDEN';
  end if;

  if actor_is_telecaller
    and new.lifecycle_status not in ('New', 'Contacted', 'Qualified', 'Lost')
    and not (
      trusted_sales_handoff
      and old.lifecycle_status = 'Qualified'
      and new.lifecycle_status = 'Transferred to Sales'
    )
  then
    raise exception using errcode = '42501', message = 'TELECALLER_LIFECYCLE_FORBIDDEN';
  end if;

  return new;
end;
$$;

revoke all on function app_private.enforce_role_lead_lifecycle() from public, anon, authenticated;

commit;
