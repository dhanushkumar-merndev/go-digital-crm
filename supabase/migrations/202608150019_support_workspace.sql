begin;

create index if not exists support_requests_created_idx
  on public.support_access_requests (created_at desc, id desc);
create index if not exists support_requests_org_status_created_idx
  on public.support_access_requests (organization_id, status, created_at desc, id desc);
create index if not exists support_sessions_open_expiry_idx
  on public.support_sessions (expires_at, organization_id)
  where ended_at is null;

create or replace function public.get_support_workspace_page(
  search_term text default null,
  status_filter text default 'all',
  page_size integer default 25,
  page_offset integer default 0,
  sort_key text default 'created_desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_organization_id uuid;
  platform_viewer boolean := false;
  tenant_can_decide boolean := false;
  normalized_search text := nullif(btrim(coalesce(search_term, '')), '');
  result_payload jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'SUPPORT_WORKSPACE_ACCESS_REQUIRED';
  end if;
  if char_length(coalesce(normalized_search, '')) > 120
    or status_filter not in ('all', 'pending', 'active', 'rejected', 'ended', 'expired')
    or page_size not in (25, 50, 100)
    or page_offset < 0
    or page_offset > 1000000
    or sort_key not in ('created_desc', 'created_asc', 'tenant_asc', 'expires_asc')
  then
    raise exception using errcode = '22023', message = 'INVALID_SUPPORT_WORKSPACE_QUERY';
  end if;

  platform_viewer := app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null);
  if not platform_viewer then
    select profile_row.organization_id
    into actor_organization_id
    from public.profiles profile_row
    where profile_row.id = actor_id
      and profile_row.active
      and profile_row.deleted_at is null;

    if actor_organization_id is null
      or not app_private.is_tenant_support_controller(actor_organization_id)
      or not app_private.has_organization_wide_scope(actor_organization_id)
    then
      raise exception using errcode = '42501', message = 'SUPPORT_WORKSPACE_ACCESS_REQUIRED';
    end if;

    select exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      join public.role_permissions role_permission_row
        on role_permission_row.role_id = role_row.id
      join public.permissions permission_row
        on permission_row.id = role_permission_row.permission_id
       and permission_row.permission_key = 'support.approve'
      where assignment_row.user_id = actor_id
        and assignment_row.organization_id = actor_organization_id
        and assignment_row.active
        and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
        and role_row.role_key = 'business_owner'
    ) into tenant_can_decide;
  end if;

  with visible_requests as (
    select
      request_row.id,
      request_row.organization_id,
      organization_row.name as organization_name,
      request_row.requested_by,
      requester_profile.full_name as requester_name,
      request_row.purpose,
      coalesce(request_row.capability_scope -> 'permissions', '[]'::jsonb) as permissions,
      greatest(
        5,
        least(60, coalesce((request_row.capability_scope ->> 'duration_minutes')::integer, 30))
      ) as duration_minutes,
      request_row.status as request_status,
      request_row.approved_by,
      approver_profile.full_name as approver_name,
      request_row.created_at,
      request_row.decided_at,
      session_row.id as session_id,
      session_row.starts_at,
      session_row.expires_at,
      session_row.ended_at,
      session_row.termination_reason,
      case
        when request_row.status = 'PENDING' then 'PENDING'
        when request_row.status = 'REJECTED' then 'REJECTED'
        when session_row.id is null then 'APPROVED'
        when session_row.ended_at is null and session_row.expires_at > now() then 'ACTIVE'
        when session_row.ended_at is null and session_row.expires_at <= now() then 'EXPIRED'
        when session_row.termination_reason ilike 'Automatically expired%' then 'EXPIRED'
        else 'ENDED'
      end as workspace_status,
      (
        case
          when platform_viewer then request_row.requested_by = actor_id
          else true
        end
      ) as can_end
    from public.support_access_requests request_row
    join public.organizations organization_row
      on organization_row.id = request_row.organization_id
    join public.profiles requester_profile
      on requester_profile.id = request_row.requested_by
    left join public.profiles approver_profile
      on approver_profile.id = request_row.approved_by
    left join public.support_sessions session_row
      on session_row.request_id = request_row.id
    where (platform_viewer or request_row.organization_id = actor_organization_id)
  ),
  filtered_requests as (
    select visible_row.*
    from visible_requests visible_row
    where (
      status_filter = 'all'
      or lower(visible_row.workspace_status) = status_filter
    )
      and (
        normalized_search is null
        or position(lower(normalized_search) in lower(visible_row.organization_name)) > 0
        or position(lower(normalized_search) in lower(visible_row.requester_name)) > 0
        or position(lower(normalized_search) in lower(coalesce(visible_row.approver_name, ''))) > 0
        or position(lower(normalized_search) in lower(visible_row.purpose)) > 0
        or position(lower(normalized_search) in lower(visible_row.id::text)) > 0
      )
  ),
  page_rows as (
    select filtered_row.*
    from filtered_requests filtered_row
    order by
      case when sort_key = 'created_asc' then filtered_row.created_at end asc,
      case when sort_key = 'tenant_asc' then lower(filtered_row.organization_name) end asc,
      case when sort_key = 'expires_asc' then filtered_row.expires_at end asc nulls last,
      case when sort_key = 'created_desc' then filtered_row.created_at end desc,
      filtered_row.id desc
    limit page_size
    offset page_offset
  ),
  page_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', page_row.id,
          'organization_id', page_row.organization_id,
          'organization_name', page_row.organization_name,
          'requested_by', page_row.requested_by,
          'requester_name', page_row.requester_name,
          'purpose', page_row.purpose,
          'permissions', page_row.permissions,
          'duration_minutes', page_row.duration_minutes,
          'request_status', page_row.request_status,
          'approved_by', page_row.approved_by,
          'approver_name', page_row.approver_name,
          'created_at', page_row.created_at,
          'decided_at', page_row.decided_at,
          'session_id', page_row.session_id,
          'starts_at', page_row.starts_at,
          'expires_at', page_row.expires_at,
          'ended_at', page_row.ended_at,
          'termination_reason', page_row.termination_reason,
          'status', page_row.workspace_status,
          'can_end', page_row.can_end
        )
        order by
          case when sort_key = 'created_asc' then page_row.created_at end asc,
          case when sort_key = 'tenant_asc' then lower(page_row.organization_name) end asc,
          case when sort_key = 'expires_asc' then page_row.expires_at end asc nulls last,
          case when sort_key = 'created_desc' then page_row.created_at end desc,
          page_row.id desc
      ),
      '[]'::jsonb
    ) as records
    from page_rows page_row
  ),
  kpi_payload as (
    select jsonb_build_object(
      'pending', count(*) filter (where visible_row.workspace_status = 'PENDING'),
      'active', count(*) filter (where visible_row.workspace_status = 'ACTIVE'),
      'expiring_soon', count(*) filter (
        where visible_row.workspace_status = 'ACTIVE'
          and visible_row.expires_at <= now() + interval '10 minutes'
      ),
      'sessions_this_month', count(*) filter (
        where visible_row.starts_at >= date_trunc('month', now())
      )
    ) as kpis
    from visible_requests visible_row
  )
  select jsonb_build_object(
    'records', page_payload.records,
    'total', (select count(*) from filtered_requests),
    'kpis', kpi_payload.kpis,
    'viewer', jsonb_build_object(
      'mode', case when platform_viewer then 'PLATFORM' else 'TENANT' end,
      'user_id', actor_id,
      'organization_id', actor_organization_id,
      'can_request', platform_viewer,
      'can_decide', tenant_can_decide,
      'can_end', true
    )
  )
  into result_payload
  from page_payload
  cross join kpi_payload;

  return result_payload;
end;
$$;

create or replace function public.search_support_tenants(
  search_term text,
  result_limit integer default 25
)
returns table (
  id uuid,
  name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare normalized_search text := nullif(btrim(coalesce(search_term, '')), '');
begin
  if not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
  end if;
  if normalized_search is null
    or char_length(normalized_search) not between 2 and 80
    or result_limit not between 1 and 25
  then
    raise exception using errcode = '22023', message = 'INVALID_SUPPORT_TENANT_SEARCH';
  end if;

  return query
  select organization_row.id, organization_row.name
  from public.organizations organization_row
  where organization_row.status = 'ACTIVE'
    and organization_row.deleted_at is null
    and (
      position(lower(normalized_search) in lower(organization_row.name)) > 0
      or position(lower(normalized_search) in lower(coalesce(organization_row.legal_name, ''))) > 0
      or position(lower(normalized_search) in lower(organization_row.slug)) > 0
    )
  order by lower(organization_row.name), organization_row.id
  limit result_limit;
end;
$$;

create or replace function public.list_support_capabilities()
returns table (
  permission_key text,
  module text,
  description text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
  end if;

  return query
  select permission_row.permission_key, permission_row.module, permission_row.description
  from public.permissions permission_row
  where permission_row.permission_key <> 'support.approve'
  order by permission_row.module, permission_row.permission_key;
end;
$$;

revoke all on function public.get_support_workspace_page(text, text, integer, integer, text)
from public, anon;
grant execute on function public.get_support_workspace_page(text, text, integer, integer, text)
to authenticated;
revoke all on function public.search_support_tenants(text, integer)
from public, anon;
grant execute on function public.search_support_tenants(text, integer)
to authenticated;
revoke all on function public.list_support_capabilities()
from public, anon;
grant execute on function public.list_support_capabilities()
to authenticated;

commit;
