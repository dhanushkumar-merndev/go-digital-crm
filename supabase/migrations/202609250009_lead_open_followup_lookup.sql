-- The "Follow-up still pending" dialog needs the one open follow-up blocking a
-- lead (its id and version are the concurrency token for Complete / Cancel).
-- It found it by calling get_followup_workspace_filtered_page with the lead id
-- as the search term. That RPC materialises every follow-up the user can see,
-- with per-row access checks, before the search narrows it -- so the dialog sat
-- on a skeleton with both buttons disabled for seconds on a cold connection.
--
-- This returns the same record shape for one lead, read through
-- followups_detail_lead_due_idx, with the page RPC's access rules applied to
-- that lead's rows only. Earliest due OPEN follow-up wins; null when none is
-- visible in the caller's scope.

create or replace function public.get_lead_open_followup(target_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  query_now timestamptz := now();
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_lead_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_ID';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'followup.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if not exists (
    select 1 from public.leads lead_row
    where lead_row.id = target_lead_id
      and lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
  ) or not app_private.can_access_lead(target_lead_id) then
    return null;
  end if;

  select to_jsonb(record_row) into result
  from (
    select
      followup_row.id, followup_row.version, followup_row.lead_id, followup_row.customer_id,
      coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer') as customer_name,
      coalesce(customer_row.primary_phone, lead_row.phone) as phone,
      lead_row.interested_model, lead_row.source::text as lead_source,
      lead_row.temperature::text as lead_temperature,
      followup_row.reason, followup_row.priority, followup_row.due_at,
      case when followup_row.status = 'OPEN' and followup_row.due_at < query_now then 'OVERDUE'
        else followup_row.status end as display_status,
      followup_row.status, followup_row.assigned_user_id,
      assigned_profile.full_name as assigned_user_name,
      followup_row.created_by, creator_profile.full_name as created_by_name,
      followup_row.branch_id, branch_row.name as branch_name,
      followup_row.team_id, team_row.name as team_name,
      followup_row.completed_at, followup_row.cancelled_at, followup_row.updated_at
    from public.followups followup_row
    join public.leads lead_row on lead_row.id = followup_row.lead_id
      and lead_row.organization_id = followup_row.organization_id
    join public.branches branch_row on branch_row.id = followup_row.branch_id
      and branch_row.organization_id = followup_row.organization_id
    left join public.teams team_row on team_row.id = followup_row.team_id
      and team_row.organization_id = followup_row.organization_id
    left join public.customers customer_row on customer_row.id = followup_row.customer_id
      and customer_row.organization_id = followup_row.organization_id
      and customer_row.deleted_at is null
    join public.profiles assigned_profile on assigned_profile.id = followup_row.assigned_user_id
      and assigned_profile.organization_id = followup_row.organization_id
    left join public.profiles creator_profile on creator_profile.id = followup_row.created_by
      and creator_profile.organization_id = followup_row.organization_id
    where followup_row.organization_id = current_organization_id
      and followup_row.lead_id = target_lead_id
      and followup_row.status in ('OPEN', 'OVERDUE')
      and app_private.can_access_record(followup_row.organization_id, followup_row.branch_id,
        followup_row.team_id, followup_row.assigned_user_id)
      and (followup_row.customer_id is null or (
        app_private.has_permission(followup_row.organization_id, 'customer.view')
        and app_private.can_access_customer(followup_row.organization_id, followup_row.customer_id)
      ))
    order by followup_row.due_at asc, followup_row.id asc
    limit 1
  ) record_row;
  return result;
end;
$$;

revoke all on function public.get_lead_open_followup(uuid) from public, anon;
grant execute on function public.get_lead_open_followup(uuid) to authenticated, service_role;
