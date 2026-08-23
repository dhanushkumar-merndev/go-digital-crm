-- Dedicated Team Manager assignment queue.  Assignment itself remains in the
-- existing locking/audited assign_lead transaction; this RPC only returns a
-- bounded, permission-checked view of work that is ready to be assigned.

create index if not exists leads_team_unassigned_queue_idx
  on public.leads (organization_id, team_id, created_at desc, id desc)
  where deleted_at is null and assigned_user_id is null;
create index if not exists lead_assignment_history_team_recent_idx
  on public.lead_assignment_history (organization_id, team_id, created_at desc, id desc);

create or replace function public.get_team_lead_assignment_workspace(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  current_user_id uuid := auth.uid();
  managed_team_ids uuid[];
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  offset_value integer;
  result jsonb;
begin
  if target_page < 1 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_ASSIGNMENT_PAGE';
  end if;
  if length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'INVALID_ASSIGNMENT_SEARCH';
  end if;
  offset_value := (target_page - 1) * target_page_size;

  access_context := public.get_access_context();
  if current_user_id is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'team-manager'
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;
  if not app_private.has_permission(current_organization_id, 'lead.assign') then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_LEAD_ASSIGN_REQUIRED';
  end if;

  select coalesce(array_agg(team_row.id order by team_row.id), array[]::uuid[])
  into managed_team_ids
  from public.teams team_row
  where team_row.organization_id = current_organization_id
    and team_row.active
    and team_row.manager_id = current_user_id
    and app_private.can_access_team(current_organization_id, team_row.id);
  if cardinality(managed_team_ids) = 0 then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_TEAM_REQUIRED';
  end if;

  with queue as materialized (
    select lead_row.id,
      lead_row.team_id,
      lead_row.customer_id,
      lead_row.customer_name,
      lead_row.phone,
      lead_row.source,
      lead_row.interested_model,
      lead_row.lifecycle_status::text as lifecycle_status,
      lead_row.temperature::text as temperature,
      lead_row.created_at,
      team_row.name as team_name,
      case when lead_row.lifecycle_status = 'Qualified' then 'QUALIFIED' else 'FRESH' end as assignment_kind,
      case when lead_row.lifecycle_status = 'Qualified'
        then team_row.qualified_assignment_mode::text
        else team_row.fresh_assignment_mode::text end as assignment_mode
    from public.leads lead_row
    join public.teams team_row
      on team_row.id = lead_row.team_id
     and team_row.organization_id = lead_row.organization_id
     and team_row.active
    where lead_row.organization_id = current_organization_id
      and lead_row.team_id = any(managed_team_ids)
      and lead_row.assigned_user_id is null
      and lead_row.deleted_at is null
      and (
        normalized_search = ''
        or lead_row.id::text ilike '%' || normalized_search || '%'
        or lower(lead_row.customer_name) ilike '%' || normalized_search || '%'
        or lead_row.normalized_phone ilike '%' || regexp_replace(normalized_search, '[^0-9]', '', 'g') || '%'
      )
  ), queued_page as (
    select * from queue
    order by created_at asc, id asc
    offset offset_value limit target_page_size
  ), consultant_rows as (
    select member_row.user_id,
      member_row.team_id,
      profile_row.full_name,
      member_row.eligible_for_fresh_leads,
      member_row.eligible_for_qualified_leads,
      count(lead_row.id) filter (where lead_row.deleted_at is null
        and lead_row.lifecycle_status <> 'Lost')::bigint as current_leads,
      count(lead_row.id) filter (where lead_row.deleted_at is null
        and lead_row.temperature = 'HOT'
        and lead_row.lifecycle_status <> 'Lost')::bigint as hot_leads
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    left join public.leads lead_row
      on lead_row.organization_id = member_row.organization_id
     and lead_row.team_id = member_row.team_id
     and lead_row.assigned_user_id = member_row.user_id
    where member_row.organization_id = current_organization_id
      and member_row.team_id = any(managed_team_ids)
      and member_row.active
      and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
      and profile_row.active
    group by member_row.user_id, member_row.team_id, profile_row.full_name,
      member_row.eligible_for_fresh_leads, member_row.eligible_for_qualified_leads
  ), history_rows as (
    select history_row.id,
      history_row.lead_id,
      history_row.team_id,
      history_row.method::text as method,
      history_row.reason,
      history_row.created_at,
      lead_row.customer_name,
      profile_row.full_name as assigned_to_name,
      actor_row.full_name as assigned_by_name
    from public.lead_assignment_history history_row
    join public.leads lead_row
      on lead_row.id = history_row.lead_id
     and lead_row.organization_id = history_row.organization_id
    join public.profiles profile_row
      on profile_row.id = history_row.new_owner_id
     and profile_row.organization_id = history_row.organization_id
    left join public.profiles actor_row
      on actor_row.id = history_row.assigned_by
     and actor_row.organization_id = history_row.organization_id
    where history_row.organization_id = current_organization_id
      and history_row.team_id = any(managed_team_ids)
    order by history_row.created_at desc, history_row.id desc
    limit 25
  )
  select jsonb_build_object(
    'total', (select count(*) from queue),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
      'id', row.id,
      'team_id', row.team_id,
      'team_name', row.team_name,
      'customer_id', row.customer_id,
      'customer_name', row.customer_name,
      'phone', row.phone,
      'source', row.source,
      'interested_model', row.interested_model,
      'lifecycle_status', row.lifecycle_status,
      'temperature', row.temperature,
      'created_at', row.created_at,
      'assignment_kind', row.assignment_kind,
      'assignment_mode', row.assignment_mode
    ) order by row.created_at, row.id) from queued_page row), '[]'::jsonb),
    'consultants', coalesce((select jsonb_agg(jsonb_build_object(
      'user_id', row.user_id,
      'team_id', row.team_id,
      'full_name', row.full_name,
      'eligible_for_fresh_leads', row.eligible_for_fresh_leads,
      'eligible_for_qualified_leads', row.eligible_for_qualified_leads,
      'current_leads', row.current_leads,
      'hot_leads', row.hot_leads
    ) order by row.current_leads, row.full_name) from consultant_rows row), '[]'::jsonb),
    'recent_assignments', coalesce((select jsonb_agg(jsonb_build_object(
      'id', row.id,
      'lead_id', row.lead_id,
      'customer_name', row.customer_name,
      'assigned_to_name', row.assigned_to_name,
      'assigned_by_name', row.assigned_by_name,
      'method', row.method,
      'reason', row.reason,
      'created_at', row.created_at
    ) order by row.created_at desc, row.id desc) from history_rows row), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_team_lead_assignment_workspace(text, integer, integer) from public, anon;
grant execute on function public.get_team_lead_assignment_workspace(text, integer, integer) to authenticated;
