-- User directories are read-heavy and can span large tenants or the complete
-- platform. Keep the page order and the two supported search paths indexed
-- without adding write-heavy indexes to unrelated profile fields.
--
-- This migration intentionally has no explicit transaction: PostgreSQL does
-- not allow CREATE INDEX CONCURRENTLY inside a transaction block.
create index concurrently if not exists profiles_tenant_user_updated_page_idx
  on public.profiles (organization_id, updated_at desc, id)
  where deleted_at is null and organization_id is not null;

create index concurrently if not exists profiles_platform_user_page_idx
  on public.profiles (active desc, updated_at desc, id desc)
  where deleted_at is null;

create index concurrently if not exists profiles_user_directory_search_trgm_idx
  on public.profiles using gin (
    (
      lower(
        full_name || ' ' || email || ' ' || coalesce(phone, '') || ' '
          || coalesce(employee_id, '')
      )
    ) gin_trgm_ops
  )
  where deleted_at is null;

create index concurrently if not exists profiles_tenant_phone_digits_prefix_idx
  on public.profiles (
    organization_id,
    app_private.normalize_phone_digits(normalized_phone) text_pattern_ops,
    id
  )
  where deleted_at is null
    and organization_id is not null
    and normalized_phone is not null;

begin;

-- Resolve the actor's administration ceiling once, choose each target's
-- primary assignment once, and keep every count/filter row lean. Branch and
-- team display JSON is built only for the bounded page.
create or replace function public.get_tenant_user_workspace(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default '',
  target_status text default 'ALL',
  target_role_id uuid default null,
  target_branch_id uuid default null,
  target_sort text default 'CREATED_DESC',
  target_mode text default 'USER_ADMIN'
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
  actor_authority integer;
  actor_scope public.data_scope;
  actor_scope_branch_id uuid;
  actor_selected_branch_ids uuid[] := '{}'::uuid[];
  actor_admin_role_id uuid;
  actor_permission_ids uuid[] := '{}'::uuid[];
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  escaped_search text;
  search_phone_digits text;
  offset_value bigint;
  result_payload jsonb;
begin
  if not app_private.tenant_user_mode_allowed(actor_id, target_mode) then
    raise exception using
      errcode = '42501',
      message = 'TENANT_USER_ADMINISTRATION_REQUIRED';
  end if;

  if target_page is null
    or target_page < 1
    or target_page > 1000000
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
    or char_length(normalized_search) > 160
    or target_status is null
    or target_status not in ('ALL', 'ACTIVE', 'INACTIVE', 'MFA_REQUIRED')
    or target_sort is null
    or target_sort not in ('CREATED_DESC', 'UPDATED_DESC', 'NAME_ASC', 'ROLE_ASC')
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_USER_WORKSPACE_QUERY';
  end if;

  offset_value := (target_page::bigint - 1) * target_page_size::bigint;
  if offset_value > 100000 then
    raise exception using
      errcode = '22023',
      message = 'USER_DIRECTORY_PAGE_WINDOW_EXCEEDED';
  end if;

  escaped_search := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(
        normalized_search,
        pg_catalog.chr(92),
        pg_catalog.chr(92) || pg_catalog.chr(92)
      ),
      '%',
      pg_catalog.chr(92) || '%'
    ),
    '_',
    pg_catalog.chr(92) || '_'
  );
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);

  select profile_row.organization_id
  into actor_organization_id
  from public.profiles profile_row
  where profile_row.id = actor_id;

  if target_mode = 'CLIENT_ADMIN_BOOTSTRAP' then
    select
      role_row.authority_level,
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids,
      role_row.id
    into
      actor_authority,
      actor_scope,
      actor_scope_branch_id,
      actor_selected_branch_ids,
      actor_admin_role_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
     and role_row.role_key = 'business_owner'
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.user_id = actor_id
      and assignment_row.active
      and assignment_row.data_scope = 'ORGANIZATION'
    order by role_row.authority_level desc, assignment_row.created_at desc
    limit 1;
  else
    select
      role_row.authority_level,
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids,
      role_row.id
    into
      actor_authority,
      actor_scope,
      actor_scope_branch_id,
      actor_selected_branch_ids,
      actor_admin_role_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
     and role_row.role_key in ('client_admin', 'system_administrator')
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = role_row.id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'user.manage'
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.user_id = actor_id
      and assignment_row.active
      and assignment_row.data_scope in (
        'ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES', 'ORGANIZATION'
      )
    order by
      role_row.authority_level desc,
      app_private.scope_rank(assignment_row.data_scope) desc,
      assignment_row.created_at desc
    limit 1;

    -- The permission and scope ceilings must come from the same selected
    -- user.manage assignment. An unrelated narrow role must never contribute
    -- permissions that can be delegated through a wider admin assignment.
    select coalesce(array_agg(role_permission_row.permission_id), '{}'::uuid[])
    into actor_permission_ids
    from public.role_permissions role_permission_row
    where role_permission_row.role_id = actor_admin_role_id;
  end if;

  if actor_organization_id is null
    or actor_authority is null
    or actor_scope is null
  then
    raise exception using
      errcode = '42501',
      message = 'TENANT_USER_ADMINISTRATION_REQUIRED';
  end if;

  actor_selected_branch_ids := coalesce(actor_selected_branch_ids, '{}'::uuid[]);

  with primary_assignments as materialized (
    select distinct on (assignment_row.user_id)
      assignment_row.user_id,
      assignment_row.id as assignment_id,
      assignment_row.role_id,
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.active
    order by
      assignment_row.user_id,
      role_row.authority_level desc,
      assignment_row.created_at desc,
      assignment_row.id desc
  ), delegable_roles as materialized (
    select
      role_row.id,
      role_row.name,
      role_row.role_key,
      role_row.authority_level
    from public.roles role_row
    where role_row.organization_id = actor_organization_id
      and role_row.authority_level < actor_authority
      and (
        (
          target_mode = 'CLIENT_ADMIN_BOOTSTRAP'
          and role_row.role_key = 'client_admin'
        )
        or (
          target_mode = 'USER_ADMIN'
          and role_row.role_key not in (
            'business_owner', 'client_admin', 'super_admin'
          )
          and not exists (
            select 1
            from public.role_permissions target_permission_row
            where target_permission_row.role_id = role_row.id
              and not (
                target_permission_row.permission_id = any(actor_permission_ids)
              )
          )
        )
      )
  ), outside_actor_scope_users as materialized (
    select access_row.user_id
    from public.user_branch_access access_row
    where access_row.organization_id = actor_organization_id
      and access_row.active
      and (
        (
          actor_scope = 'ONE_BRANCH'
          and access_row.branch_id <> actor_scope_branch_id
        )
        or (
          actor_scope = 'SELECTED_BRANCHES'
          and not (access_row.branch_id = any(actor_selected_branch_ids))
        )
      )
    union
    select member_row.user_id
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
    where member_row.organization_id = actor_organization_id
      and member_row.active
      and (
        (
          actor_scope = 'ONE_BRANCH'
          and team_row.branch_id <> actor_scope_branch_id
        )
        or (
          actor_scope = 'SELECTED_BRANCHES'
          and not (team_row.branch_id = any(actor_selected_branch_ids))
        )
      )
  ), eligible_rows as materialized (
    select
      profile_row.id,
      profile_row.full_name,
      profile_row.email,
      profile_row.phone,
      profile_row.normalized_phone,
      profile_row.employee_id,
      profile_row.active,
      profile_row.mfa_required,
      profile_row.created_at,
      profile_row.updated_at,
      assignment_row.assignment_id,
      assignment_row.role_id,
      role_row.name as role_name,
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    from public.profiles profile_row
    join primary_assignments assignment_row
      on assignment_row.user_id = profile_row.id
    join delegable_roles role_row
      on role_row.id = assignment_row.role_id
    where profile_row.organization_id = actor_organization_id
      and profile_row.deleted_at is null
      and profile_row.id <> actor_id
      and app_private.scope_rank(assignment_row.data_scope)
        <= app_private.scope_rank(actor_scope)
      and (
        actor_scope in ('ALL_BRANCHES', 'ORGANIZATION')
        or (
          actor_scope = 'ONE_BRANCH'
          and (
            (
              assignment_row.data_scope = 'ONE_BRANCH'
              and assignment_row.scope_branch_id = actor_scope_branch_id
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and assignment_row.selected_branch_ids
                <@ array[actor_scope_branch_id]
            )
            or (
              assignment_row.data_scope in ('OWN_RECORDS', 'OWN_TEAM')
              and not exists (
                select 1
                from outside_actor_scope_users outside_row
                where outside_row.user_id = profile_row.id
              )
            )
          )
        )
        or (
          actor_scope = 'SELECTED_BRANCHES'
          and (
            (
              assignment_row.data_scope = 'ONE_BRANCH'
              and assignment_row.scope_branch_id = any(actor_selected_branch_ids)
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and assignment_row.selected_branch_ids <@ actor_selected_branch_ids
            )
            or (
              assignment_row.data_scope in ('OWN_RECORDS', 'OWN_TEAM')
              and not exists (
                select 1
                from outside_actor_scope_users outside_row
                where outside_row.user_id = profile_row.id
              )
            )
          )
        )
      )
  ), filtered_rows as materialized (
    select eligible_row.*
    from eligible_rows eligible_row
    where (
      target_status = 'ALL'
      or (target_status = 'ACTIVE' and eligible_row.active)
      or (target_status = 'INACTIVE' and not eligible_row.active)
      or (target_status = 'MFA_REQUIRED' and eligible_row.mfa_required)
    )
      and (target_role_id is null or eligible_row.role_id = target_role_id)
      and (
        target_branch_id is null
        or eligible_row.scope_branch_id = target_branch_id
        or target_branch_id = any(eligible_row.selected_branch_ids)
        or eligible_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
        or exists (
          select 1
          from public.user_branch_access access_row
          join public.branches branch_row
            on branch_row.id = access_row.branch_id
           and branch_row.organization_id = access_row.organization_id
          where access_row.organization_id = actor_organization_id
            and access_row.user_id = eligible_row.id
            and access_row.branch_id = target_branch_id
            and access_row.active
        )
        or exists (
          select 1
          from public.team_members member_row
          join public.teams team_row
            on team_row.id = member_row.team_id
           and team_row.organization_id = member_row.organization_id
          where member_row.organization_id = actor_organization_id
            and member_row.user_id = eligible_row.id
            and member_row.active
            and team_row.branch_id = target_branch_id
        )
      )
      and (
        normalized_search = ''
        or lower(
          eligible_row.full_name || ' ' || eligible_row.email || ' '
            || coalesce(eligible_row.phone, '') || ' '
            || coalesce(eligible_row.employee_id, '')
        ) like '%' || escaped_search || '%' escape E'\\'
        or (
          char_length(search_phone_digits) >= 3
          and app_private.normalize_phone_digits(eligible_row.normalized_phone)
            like search_phone_digits || '%'
        )
      )
  ), page_ids as materialized (
    select filtered_row.id, filtered_row.assignment_id
    from filtered_rows filtered_row
    order by
      case when target_sort = 'CREATED_DESC' then filtered_row.created_at end desc,
      case when target_sort = 'UPDATED_DESC' then filtered_row.updated_at end desc,
      case when target_sort = 'NAME_ASC' then lower(filtered_row.full_name) end asc,
      case when target_sort = 'ROLE_ASC' then lower(filtered_row.role_name) end asc,
      filtered_row.id
    offset offset_value
    limit target_page_size
  ), page_rows as materialized (
    select
      profile_row.id,
      profile_row.full_name,
      profile_row.email,
      profile_row.phone,
      profile_row.employee_id,
      profile_row.active,
      profile_row.mfa_required,
      profile_row.version,
      profile_row.created_at,
      profile_row.updated_at,
      assignment_row.id as assignment_id,
      assignment_row.role_id,
      role_row.name as role_name,
      role_row.role_key,
      role_row.authority_level,
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    from page_ids page_row
    join public.profiles profile_row
      on profile_row.id = page_row.id
     and profile_row.organization_id = actor_organization_id
     and profile_row.deleted_at is null
    join public.user_role_assignments assignment_row
      on assignment_row.id = page_row.assignment_id
     and assignment_row.organization_id = actor_organization_id
     and assignment_row.user_id = profile_row.id
     and assignment_row.active
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
  ), page_branches as materialized (
    select
      access_row.user_id,
      jsonb_agg(
        jsonb_build_object(
          'id', branch_row.id,
          'name', branch_row.name,
          'code', branch_row.code
        ) order by branch_row.name, branch_row.id
      ) as branches
    from page_ids page_row
    join public.user_branch_access access_row
      on access_row.organization_id = actor_organization_id
     and access_row.user_id = page_row.id
     and access_row.active
    join public.branches branch_row
      on branch_row.id = access_row.branch_id
     and branch_row.organization_id = access_row.organization_id
    group by access_row.user_id
  ), page_teams as materialized (
    select
      member_row.user_id,
      jsonb_agg(
        jsonb_build_object(
          'id', team_row.id,
          'name', team_row.name,
          'branch_id', team_row.branch_id,
          'member_type', member_row.member_type
        ) order by team_row.name, team_row.id
      ) as teams
    from page_ids page_row
    join public.team_members member_row
      on member_row.organization_id = actor_organization_id
     and member_row.user_id = page_row.id
     and member_row.active
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
    group by member_row.user_id
  ), eligible_summary as (
    select
      count(*)::bigint as total_users,
      count(*) filter (where eligible_row.active) as active_users,
      count(*) filter (where not eligible_row.active) as inactive_users,
      count(*) filter (where eligible_row.mfa_required) as mfa_required
    from eligible_rows eligible_row
  ), filtered_summary as (
    select count(*)::bigint as total
    from filtered_rows
  )
  select jsonb_build_object(
    'organization_id', actor_organization_id,
    'mode', target_mode,
    'records', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', page_row.id,
          'full_name', page_row.full_name,
          'email', page_row.email,
          'phone', page_row.phone,
          'employee_id', page_row.employee_id,
          'active', page_row.active,
          'mfa_required', page_row.mfa_required,
          'version', page_row.version,
          'assignment_id', page_row.assignment_id,
          'role_id', page_row.role_id,
          'role_name', page_row.role_name,
          'role_key', page_row.role_key,
          'authority_level', page_row.authority_level,
          'data_scope', page_row.data_scope,
          'scope_branch_id', page_row.scope_branch_id,
          'selected_branch_ids', to_jsonb(page_row.selected_branch_ids),
          'branches', coalesce(branch_data.branches, '[]'::jsonb),
          'teams', coalesce(team_data.teams, '[]'::jsonb),
          'created_at', page_row.created_at,
          'updated_at', page_row.updated_at,
          'can_edit', true
        ) order by
          case when target_sort = 'CREATED_DESC' then page_row.created_at end desc,
          case when target_sort = 'UPDATED_DESC' then page_row.updated_at end desc,
          case when target_sort = 'NAME_ASC' then lower(page_row.full_name) end asc,
          case when target_sort = 'ROLE_ASC' then lower(page_row.role_name) end asc,
          page_row.id
      )
      from page_rows page_row
      left join page_branches branch_data on branch_data.user_id = page_row.id
      left join page_teams team_data on team_data.user_id = page_row.id
    ), '[]'::jsonb),
    'total', filtered_summary.total,
    'kpis', jsonb_build_object(
      'total_users', eligible_summary.total_users,
      'active_users', eligible_summary.active_users,
      'inactive_users', eligible_summary.inactive_users,
      'mfa_required', eligible_summary.mfa_required
    )
  )
  into result_payload
  from eligible_summary
  cross join filtered_summary;

  return result_payload;
end;
$$;

revoke all on function public.get_tenant_user_workspace(
  integer, integer, text, text, uuid, uuid, text, text
) from public, anon;
grant execute on function public.get_tenant_user_workspace(
  integer, integer, text, text, uuid, uuid, text, text
) to authenticated;

-- Platform filtering and KPI counts now touch only profile/organization
-- columns. Role JSON and branch counts are hydrated after selecting page IDs.
create or replace function public.get_platform_user_access_workspace(
  target_search text default '',
  target_status text default 'ALL',
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
  escaped_search text;
  offset_value bigint;
begin
  if char_length(normalized_search) > 160
    or normalized_status not in ('ALL', 'ACTIVE', 'INACTIVE')
    or target_page is null
    or target_page not between 1 and 100000
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_PLATFORM_USER_ACCESS_QUERY';
  end if;

  offset_value := (target_page::bigint - 1) * target_page_size::bigint;
  if offset_value > 100000 then
    raise exception using
      errcode = '22023',
      message = 'PLATFORM_USER_DIRECTORY_PAGE_WINDOW_EXCEEDED';
  end if;

  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using
      errcode = '42501',
      message = 'PLATFORM_USER_ACCESS_REQUIRED';
  end if;

  escaped_search := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(
        normalized_search,
        pg_catalog.chr(92),
        pg_catalog.chr(92) || pg_catalog.chr(92)
      ),
      '%',
      pg_catalog.chr(92) || '%'
    ),
    '_',
    pg_catalog.chr(92) || '_'
  );

  return (
    with filtered_rows as materialized (
      select
        profile_row.id,
        profile_row.organization_id,
        profile_row.active,
        profile_row.mfa_required,
        profile_row.updated_at
      from public.profiles profile_row
      left join public.organizations organization_row
        on organization_row.id = profile_row.organization_id
       and organization_row.deleted_at is null
      where profile_row.deleted_at is null
        and (
          normalized_status = 'ALL'
          or (normalized_status = 'ACTIVE' and profile_row.active)
          or (normalized_status = 'INACTIVE' and not profile_row.active)
        )
        and (
          normalized_search = ''
          or lower(
            profile_row.full_name || ' ' || profile_row.email || ' '
              || coalesce(profile_row.phone, '') || ' '
              || coalesce(profile_row.employee_id, '')
          ) like '%' || escaped_search || '%' escape E'\\'
          or organization_row.name
            ilike '%' || escaped_search || '%' escape E'\\'
        )
    ), page_ids as materialized (
      select filtered_row.id
      from filtered_rows filtered_row
      order by
        filtered_row.active desc,
        filtered_row.updated_at desc,
        filtered_row.id desc
      offset offset_value
      limit target_page_size
    ), page_rows as materialized (
      select
        profile_row.id,
        profile_row.organization_id,
        coalesce(
          organization_row.name,
          'Go Digital Marketing CRM'
        ) as organization_name,
        profile_row.full_name,
        profile_row.email,
        profile_row.phone,
        profile_row.employee_id,
        profile_row.active,
        profile_row.mfa_required,
        profile_row.created_at,
        profile_row.updated_at
      from page_ids page_row
      join public.profiles profile_row
        on profile_row.id = page_row.id
       and profile_row.deleted_at is null
      left join public.organizations organization_row
        on organization_row.id = profile_row.organization_id
       and organization_row.deleted_at is null
    ), page_roles as materialized (
      select
        assignment_row.user_id,
        jsonb_agg(
          jsonb_build_object(
            'name', role_row.name,
            'key', role_row.role_key,
            'scope', assignment_row.data_scope
          ) order by role_row.authority_level desc, role_row.name
        ) as roles
      from page_ids page_row
      join public.user_role_assignments assignment_row
        on assignment_row.user_id = page_row.id
       and assignment_row.active
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id is not distinct from assignment_row.organization_id
      group by assignment_row.user_id
    ), page_branch_counts as materialized (
      select access_row.user_id, count(*)::bigint as branch_count
      from page_ids page_row
      join public.user_branch_access access_row
        on access_row.user_id = page_row.id
       and access_row.active
      join public.branches branch_row
        on branch_row.id = access_row.branch_id
       and branch_row.organization_id = access_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      group by access_row.user_id
    ), filtered_summary as (
      select
        count(*)::bigint as total,
        count(*) filter (where filtered_row.active) as active,
        count(*) filter (where filtered_row.mfa_required) as mfa_required,
        count(distinct filtered_row.organization_id)
          filter (where filtered_row.organization_id is not null)
          as organizations
      from filtered_rows filtered_row
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'organization_id', page_row.organization_id,
            'organization_name', page_row.organization_name,
            'full_name', page_row.full_name,
            'email', page_row.email,
            'phone', page_row.phone,
            'employee_id', page_row.employee_id,
            'active', page_row.active,
            'mfa_required', page_row.mfa_required,
            'created_at', page_row.created_at,
            'updated_at', page_row.updated_at,
            'roles', coalesce(role_data.roles, '[]'::jsonb),
            'branch_count', coalesce(branch_data.branch_count, 0)::bigint
          ) order by page_row.active desc, page_row.updated_at desc, page_row.id desc
        )
        from page_rows page_row
        left join page_roles role_data on role_data.user_id = page_row.id
        left join page_branch_counts branch_data
          on branch_data.user_id = page_row.id
      ), '[]'::jsonb),
      'total', filtered_summary.total,
      'kpis', jsonb_build_object(
        'total', filtered_summary.total,
        'active', filtered_summary.active,
        'mfa_required', filtered_summary.mfa_required,
        'organizations', filtered_summary.organizations
      )
    )
    from filtered_summary
  );
end;
$$;

revoke all on function public.get_platform_user_access_workspace(
  text, text, integer, integer
) from public, anon;
grant execute on function public.get_platform_user_access_workspace(
  text, text, integer, integer
) to authenticated;

-- Rebind the mutation and row-administration permission ceiling to the same
-- selected user.manage assignment that supplies authority and branch scope.
-- This closes the direct-RPC path as well as the optimized directory read.
create or replace function app_private.can_administer_tenant_user(
  target_actor_id uuid,
  target_user_id uuid,
  target_mode text default 'USER_ADMIN'
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_organization_id uuid;
declare actor_authority integer;
declare actor_scope public.data_scope;
declare actor_scope_branch_id uuid;
declare actor_selected_branch_ids uuid[];
declare actor_admin_role_id uuid;
declare target_authority integer;
declare target_scope public.data_scope;
declare target_scope_branch_id uuid;
declare target_selected_branch_ids uuid[];
declare target_role_id uuid;
declare target_role_key text;
begin
  if target_actor_id is null
    or target_user_id is null
    or target_actor_id = target_user_id
    or target_mode not in ('USER_ADMIN', 'CLIENT_ADMIN_BOOTSTRAP')
  then
    return false;
  end if;

  select profile_row.organization_id
  into actor_organization_id
  from public.profiles profile_row
  join public.organizations organization_row
    on organization_row.id = profile_row.organization_id
   and organization_row.status = 'ACTIVE'
   and organization_row.deleted_at is null
  where profile_row.id = target_actor_id
    and profile_row.active
    and profile_row.deleted_at is null;
  if actor_organization_id is null then return false; end if;
  if auth.role() <> 'service_role'
    and not app_private.mfa_policy_satisfied(actor_organization_id)
  then
    return false;
  end if;

  if target_mode = 'CLIENT_ADMIN_BOOTSTRAP' then
    select role_row.authority_level,
           assignment_row.data_scope,
           assignment_row.scope_branch_id,
           assignment_row.selected_branch_ids,
           role_row.id
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids,
         actor_admin_role_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
     and role_row.role_key = 'business_owner'
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.user_id = target_actor_id
      and assignment_row.active
      and assignment_row.data_scope = 'ORGANIZATION'
    order by role_row.authority_level desc, assignment_row.created_at desc
    limit 1;
  else
    select role_row.authority_level,
           assignment_row.data_scope,
           assignment_row.scope_branch_id,
           assignment_row.selected_branch_ids,
           role_row.id
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids,
         actor_admin_role_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
     and role_row.role_key in ('client_admin', 'system_administrator')
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = role_row.id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'user.manage'
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.user_id = target_actor_id
      and assignment_row.active
      and assignment_row.data_scope in (
        'ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES', 'ORGANIZATION'
      )
    order by role_row.authority_level desc,
             app_private.scope_rank(assignment_row.data_scope) desc,
             assignment_row.created_at desc
    limit 1;
  end if;
  if actor_authority is null then return false; end if;

  select role_row.authority_level,
         assignment_row.data_scope,
         assignment_row.scope_branch_id,
         assignment_row.selected_branch_ids,
         role_row.id,
         role_row.role_key
  into target_authority,
       target_scope,
       target_scope_branch_id,
       target_selected_branch_ids,
       target_role_id,
       target_role_key
  from public.profiles profile_row
  join public.user_role_assignments assignment_row
    on assignment_row.organization_id = profile_row.organization_id
   and assignment_row.user_id = profile_row.id
   and assignment_row.active
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  where profile_row.id = target_user_id
    and profile_row.organization_id = actor_organization_id
    and profile_row.deleted_at is null
  order by role_row.authority_level desc, assignment_row.created_at desc
  limit 1;
  if target_authority is null or target_authority >= actor_authority then return false; end if;
  if app_private.scope_rank(target_scope) > app_private.scope_rank(actor_scope) then return false; end if;

  -- A profile can have more than one active assignment. Every assignment must
  -- stay below the same selected admin role's authority, permission and branch
  -- ceilings; checking only the highest assignment can hide a wider secondary
  -- assignment from both RLS and direct mutation validation.
  if exists (
    select 1
    from public.user_role_assignments target_assignment_row
    join public.roles target_role_row
      on target_role_row.id = target_assignment_row.role_id
     and target_role_row.organization_id = target_assignment_row.organization_id
    where target_assignment_row.organization_id = actor_organization_id
      and target_assignment_row.user_id = target_user_id
      and target_assignment_row.active
      and (
        target_role_row.authority_level >= actor_authority
        or app_private.scope_rank(target_assignment_row.data_scope)
          > app_private.scope_rank(actor_scope)
        or (
          target_mode = 'CLIENT_ADMIN_BOOTSTRAP'
          and target_role_row.role_key <> 'client_admin'
        )
        or (
          target_mode = 'USER_ADMIN'
          and target_role_row.role_key in (
            'business_owner', 'client_admin', 'super_admin'
          )
        )
        or (
          target_mode = 'USER_ADMIN'
          and exists (
            select 1
            from public.role_permissions target_permission_row
            where target_permission_row.role_id = target_assignment_row.role_id
              and not exists (
                select 1
                from public.role_permissions actor_permission_row
                where actor_permission_row.role_id = actor_admin_role_id
                  and actor_permission_row.permission_id
                    = target_permission_row.permission_id
              )
          )
        )
        or (
          actor_scope = 'ONE_BRANCH'
          and (
            (
              target_assignment_row.data_scope = 'ONE_BRANCH'
              and target_assignment_row.scope_branch_id
                is distinct from actor_scope_branch_id
            )
            or (
              target_assignment_row.data_scope = 'SELECTED_BRANCHES'
              and not coalesce(
                target_assignment_row.selected_branch_ids,
                '{}'::uuid[]
              ) <@ array[actor_scope_branch_id]
            )
            or target_assignment_row.data_scope in (
              'ALL_BRANCHES', 'ORGANIZATION', 'PLATFORM'
            )
            or (
              target_assignment_row.data_scope in ('OWN_RECORDS', 'OWN_TEAM')
              and (
                exists (
                  select 1
                  from public.user_branch_access access_row
                  where access_row.organization_id = actor_organization_id
                    and access_row.user_id = target_user_id
                    and access_row.active
                    and access_row.branch_id <> actor_scope_branch_id
                )
                or exists (
                  select 1
                  from public.team_members member_row
                  join public.teams team_row
                    on team_row.id = member_row.team_id
                   and team_row.organization_id = member_row.organization_id
                  where member_row.organization_id = actor_organization_id
                    and member_row.user_id = target_user_id
                    and member_row.active
                    and team_row.branch_id <> actor_scope_branch_id
                )
              )
            )
          )
        )
        or (
          actor_scope = 'SELECTED_BRANCHES'
          and (
            (
              target_assignment_row.data_scope = 'ONE_BRANCH'
              and not (
                target_assignment_row.scope_branch_id
                  = any(coalesce(actor_selected_branch_ids, '{}'::uuid[]))
              )
            )
            or (
              target_assignment_row.data_scope = 'SELECTED_BRANCHES'
              and not coalesce(
                target_assignment_row.selected_branch_ids,
                '{}'::uuid[]
              ) <@ coalesce(actor_selected_branch_ids, '{}'::uuid[])
            )
            or target_assignment_row.data_scope in (
              'ALL_BRANCHES', 'ORGANIZATION', 'PLATFORM'
            )
            or (
              target_assignment_row.data_scope in ('OWN_RECORDS', 'OWN_TEAM')
              and (
                exists (
                  select 1
                  from public.user_branch_access access_row
                  where access_row.organization_id = actor_organization_id
                    and access_row.user_id = target_user_id
                    and access_row.active
                    and not (
                      access_row.branch_id
                        = any(coalesce(actor_selected_branch_ids, '{}'::uuid[]))
                    )
                )
                or exists (
                  select 1
                  from public.team_members member_row
                  join public.teams team_row
                    on team_row.id = member_row.team_id
                   and team_row.organization_id = member_row.organization_id
                  where member_row.organization_id = actor_organization_id
                    and member_row.user_id = target_user_id
                    and member_row.active
                    and not (
                      team_row.branch_id
                        = any(coalesce(actor_selected_branch_ids, '{}'::uuid[]))
                    )
                )
              )
            )
          )
        )
      )
  ) then
    return false;
  end if;

  if target_mode = 'CLIENT_ADMIN_BOOTSTRAP' then
    if target_role_key <> 'client_admin' then return false; end if;
  elsif target_role_key in ('business_owner', 'client_admin', 'super_admin') then
    return false;
  end if;

  if target_mode = 'USER_ADMIN' and exists (
    select 1
    from public.role_permissions target_permission_row
    where target_permission_row.role_id = target_role_id
      and not exists (
        select 1
        from public.role_permissions actor_permission_row
        where actor_permission_row.role_id = actor_admin_role_id
          and actor_permission_row.permission_id = target_permission_row.permission_id
      )
  ) then
    return false;
  end if;

  if actor_scope = 'ONE_BRANCH' then
    if target_scope = 'ONE_BRANCH' and target_scope_branch_id <> actor_scope_branch_id then
      return false;
    elsif target_scope = 'SELECTED_BRANCHES'
      and not target_selected_branch_ids <@ array[actor_scope_branch_id]
    then
      return false;
    elsif target_scope in ('ALL_BRANCHES', 'ORGANIZATION') then
      return false;
    elsif target_scope in ('OWN_RECORDS', 'OWN_TEAM') and (
      exists (
        select 1
        from public.user_branch_access access_row
        where access_row.organization_id = actor_organization_id
          and access_row.user_id = target_user_id
          and access_row.active
          and access_row.branch_id <> actor_scope_branch_id
      )
      or exists (
        select 1
        from public.team_members member_row
        join public.teams team_row
          on team_row.id = member_row.team_id
         and team_row.organization_id = member_row.organization_id
        where member_row.organization_id = actor_organization_id
          and member_row.user_id = target_user_id
          and member_row.active
          and team_row.branch_id <> actor_scope_branch_id
      )
    ) then
      return false;
    end if;
  elsif actor_scope = 'SELECTED_BRANCHES' then
    if target_scope = 'ONE_BRANCH'
      and not (target_scope_branch_id = any(actor_selected_branch_ids))
    then
      return false;
    elsif target_scope = 'SELECTED_BRANCHES'
      and not target_selected_branch_ids <@ actor_selected_branch_ids
    then
      return false;
    elsif target_scope in ('ALL_BRANCHES', 'ORGANIZATION') then
      return false;
    elsif target_scope in ('OWN_RECORDS', 'OWN_TEAM') and (
      exists (
        select 1
        from public.user_branch_access access_row
        where access_row.organization_id = actor_organization_id
          and access_row.user_id = target_user_id
          and access_row.active
          and not (access_row.branch_id = any(actor_selected_branch_ids))
      )
      or exists (
        select 1
        from public.team_members member_row
        join public.teams team_row
          on team_row.id = member_row.team_id
         and team_row.organization_id = member_row.organization_id
        where member_row.organization_id = actor_organization_id
          and member_row.user_id = target_user_id
          and member_row.active
          and not (team_row.branch_id = any(actor_selected_branch_ids))
      )
    ) then
      return false;
    end if;
  end if;
  return true;
end;
$$;

create or replace function app_private.assert_tenant_user_assignment(
  target_actor_id uuid,
  target_role_id uuid,
  target_data_scope public.data_scope,
  target_scope_branch_id uuid,
  target_selected_branch_ids uuid[],
  target_team_ids uuid[],
  target_mode text,
  target_existing_user_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_organization_id uuid;
declare actor_authority integer;
declare actor_scope public.data_scope;
declare actor_scope_branch_id uuid;
declare actor_selected_branch_ids uuid[];
declare actor_admin_role_id uuid;
declare target_authority integer;
declare target_role_key text;
declare target_role_mfa boolean;
declare target_member_type text;
declare normalized_selected_branch_ids uuid[];
declare normalized_team_ids uuid[];
declare required_mfa boolean;
begin
  if target_actor_id is null
    or target_role_id is null
    or target_data_scope is null
    or target_mode not in ('USER_ADMIN', 'CLIENT_ADMIN_BOOTSTRAP')
  then
    raise exception using errcode = '22023', message = 'INVALID_USER_ASSIGNMENT';
  end if;

  select profile_row.organization_id
  into actor_organization_id
  from public.profiles profile_row
  join public.organizations organization_row
    on organization_row.id = profile_row.organization_id
   and organization_row.status = 'ACTIVE'
   and organization_row.deleted_at is null
  where profile_row.id = target_actor_id
    and profile_row.active
    and profile_row.deleted_at is null;
  if actor_organization_id is null then
    raise exception using errcode = '42501', message = 'TENANT_USER_ADMINISTRATION_REQUIRED';
  end if;

  if target_mode = 'CLIENT_ADMIN_BOOTSTRAP' then
    select role_row.authority_level,
           assignment_row.data_scope,
           assignment_row.scope_branch_id,
           assignment_row.selected_branch_ids,
           role_row.id
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids,
         actor_admin_role_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
     and role_row.role_key = 'business_owner'
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.user_id = target_actor_id
      and assignment_row.active
      and assignment_row.data_scope = 'ORGANIZATION'
    order by role_row.authority_level desc, assignment_row.created_at desc
    limit 1;
  else
    select role_row.authority_level,
           assignment_row.data_scope,
           assignment_row.scope_branch_id,
           assignment_row.selected_branch_ids,
           role_row.id
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids,
         actor_admin_role_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
     and role_row.role_key in ('client_admin', 'system_administrator')
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = role_row.id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'user.manage'
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.user_id = target_actor_id
      and assignment_row.active
      and assignment_row.data_scope in (
        'ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES', 'ORGANIZATION'
      )
    order by role_row.authority_level desc,
             app_private.scope_rank(assignment_row.data_scope) desc,
             assignment_row.created_at desc
    limit 1;
  end if;
  if actor_authority is null then
    raise exception using errcode = '42501', message = 'TENANT_USER_ADMINISTRATION_REQUIRED';
  end if;

  select role_row.authority_level,
         role_row.role_key,
         role_row.mfa_required
  into target_authority, target_role_key, target_role_mfa
  from public.roles role_row
  where role_row.id = target_role_id
    and role_row.organization_id = actor_organization_id;
  if target_authority is null then
    raise exception using errcode = '23503', message = 'ROLE_NOT_IN_ORGANIZATION';
  end if;
  if target_authority >= actor_authority
    or app_private.scope_rank(target_data_scope) > app_private.scope_rank(actor_scope)
  then
    raise exception using errcode = '42501', message = 'DELEGATION_CEILING_EXCEEDED';
  end if;
  if target_data_scope = 'PLATFORM' then
    raise exception using errcode = '42501', message = 'PLATFORM_SCOPE_FORBIDDEN';
  end if;
  if target_mode = 'CLIENT_ADMIN_BOOTSTRAP' then
    if target_role_key <> 'client_admin' then
      raise exception using errcode = '42501', message = 'CLIENT_ADMIN_ROLE_REQUIRED';
    end if;
  elsif target_role_key in ('business_owner', 'client_admin', 'super_admin') then
    raise exception using errcode = '42501', message = 'ROLE_DELEGATION_FORBIDDEN';
  end if;

  if target_existing_user_id is not null and not app_private.can_administer_tenant_user(
    target_actor_id, target_existing_user_id, target_mode
  ) then
    raise exception using errcode = '42501', message = 'TARGET_USER_OUTSIDE_AUTHORITY';
  end if;

  normalized_selected_branch_ids := coalesce(array(
    select distinct selected_branch.branch_id
    from unnest(coalesce(target_selected_branch_ids, '{}'::uuid[]))
      as selected_branch(branch_id)
    order by selected_branch.branch_id
  ), '{}'::uuid[]);
  normalized_team_ids := coalesce(array(
    select distinct selected_team.team_id
    from unnest(coalesce(target_team_ids, '{}'::uuid[])) as selected_team(team_id)
    order by selected_team.team_id
  ), '{}'::uuid[]);
  if cardinality(normalized_selected_branch_ids)
      <> cardinality(coalesce(target_selected_branch_ids, '{}'::uuid[]))
    or cardinality(normalized_team_ids) <> cardinality(coalesce(target_team_ids, '{}'::uuid[]))
    or exists (
      select 1
      from unnest(coalesce(target_selected_branch_ids, '{}'::uuid[]))
        as selected_branch(branch_id)
      where selected_branch.branch_id is null
    )
    or exists (
      select 1
      from unnest(coalesce(target_team_ids, '{}'::uuid[])) as selected_team(team_id)
      where selected_team.team_id is null
    )
  then
    raise exception using errcode = '22023', message = 'DUPLICATE_OR_NULL_SCOPE_ID';
  end if;

  if not (
    (
      target_data_scope = 'ONE_BRANCH'
      and target_scope_branch_id is not null
      and cardinality(normalized_selected_branch_ids) = 0
    )
    or (
      target_data_scope = 'SELECTED_BRANCHES'
      and target_scope_branch_id is null
      and cardinality(normalized_selected_branch_ids) > 0
    )
    or (
      target_data_scope not in ('ONE_BRANCH', 'SELECTED_BRANCHES')
      and target_scope_branch_id is null
      and cardinality(normalized_selected_branch_ids) = 0
    )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_BRANCH_SCOPE_SHAPE';
  end if;
  if target_scope_branch_id is not null and not exists (
    select 1 from public.branches branch_row
    where branch_row.id = target_scope_branch_id
      and branch_row.organization_id = actor_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'BRANCH_NOT_IN_ORGANIZATION';
  end if;
  if exists (
    select 1
    from unnest(normalized_selected_branch_ids) as selected_branch(branch_id)
    where not exists (
      select 1 from public.branches branch_row
      where branch_row.id = selected_branch.branch_id
        and branch_row.organization_id = actor_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
    )
  ) then
    raise exception using errcode = '23503', message = 'BRANCH_NOT_IN_ORGANIZATION';
  end if;

  target_member_type := case target_role_key
    when 'team_manager' then 'TEAM_MANAGER'
    when 'sales_consultant' then 'SALES_CONSULTANT'
    when 'telecaller_bdc' then 'TELECALLER_BDC'
    else null
  end;
  if cardinality(normalized_team_ids) > 0 and target_member_type is null then
    raise exception using errcode = '22023', message = 'ROLE_DOES_NOT_SUPPORT_TEAM_MEMBERSHIP';
  end if;
  if target_data_scope in ('OWN_RECORDS', 'OWN_TEAM')
    and (target_member_type is null or cardinality(normalized_team_ids) = 0)
  then
    raise exception using errcode = '22023', message = 'TEAM_MEMBERSHIP_REQUIRED_FOR_SCOPE';
  end if;
  if target_role_key = 'team_manager' and target_data_scope = 'OWN_RECORDS' then
    raise exception using errcode = '22023', message = 'TEAM_MANAGER_SCOPE_INVALID';
  end if;
  if target_role_key in ('sales_consultant', 'telecaller_bdc')
    and target_data_scope = 'OWN_TEAM'
  then
    raise exception using errcode = '22023', message = 'INDIVIDUAL_CONTRIBUTOR_SCOPE_INVALID';
  end if;
  if exists (
    select 1
    from unnest(normalized_team_ids) as selected_team(team_id)
    where not exists (
      select 1 from public.teams team_row
      where team_row.id = selected_team.team_id
        and team_row.organization_id = actor_organization_id
        and team_row.active
    )
  ) then
    raise exception using errcode = '23503', message = 'TEAM_NOT_IN_ORGANIZATION';
  end if;
  if target_data_scope = 'ONE_BRANCH' and exists (
    select 1
    from public.teams team_row
    where team_row.id = any(normalized_team_ids)
      and team_row.branch_id <> target_scope_branch_id
  ) then
    raise exception using errcode = '22023', message = 'TEAM_OUTSIDE_TARGET_BRANCH_SCOPE';
  end if;
  if target_data_scope = 'SELECTED_BRANCHES' and exists (
    select 1
    from public.teams team_row
    where team_row.id = any(normalized_team_ids)
      and not (team_row.branch_id = any(normalized_selected_branch_ids))
  ) then
    raise exception using errcode = '22023', message = 'TEAM_OUTSIDE_TARGET_BRANCH_SCOPE';
  end if;

  if target_mode = 'USER_ADMIN' and exists (
    select 1
    from public.role_permissions target_permission_row
    where target_permission_row.role_id = target_role_id
      and not exists (
        select 1
        from public.role_permissions actor_permission_row
        where actor_permission_row.role_id = actor_admin_role_id
          and actor_permission_row.permission_id = target_permission_row.permission_id
      )
  ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DELEGATION_CEILING_EXCEEDED';
  end if;

  if actor_scope = 'ONE_BRANCH' and (
    (target_data_scope = 'ONE_BRANCH' and target_scope_branch_id <> actor_scope_branch_id)
    or target_data_scope in ('SELECTED_BRANCHES', 'ALL_BRANCHES', 'ORGANIZATION')
    or exists (
      select 1 from public.teams team_row
      where team_row.id = any(normalized_team_ids)
        and team_row.branch_id <> actor_scope_branch_id
    )
  ) then
    raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED';
  elsif actor_scope = 'SELECTED_BRANCHES' and (
    (
      target_data_scope = 'ONE_BRANCH'
      and not (target_scope_branch_id = any(actor_selected_branch_ids))
    )
    or (
      target_data_scope = 'SELECTED_BRANCHES'
      and not normalized_selected_branch_ids <@ actor_selected_branch_ids
    )
    or target_data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
    or exists (
      select 1 from public.teams team_row
      where team_row.id = any(normalized_team_ids)
        and not (team_row.branch_id = any(actor_selected_branch_ids))
    )
  ) then
    raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED';
  end if;

  if target_member_type = 'TEAM_MANAGER' and exists (
    select 1
    from public.teams team_row
    where team_row.id = any(normalized_team_ids)
      and team_row.manager_id is not null
      and team_row.manager_id is distinct from target_existing_user_id
  ) then
    raise exception using errcode = '40900', message = 'TEAM_ALREADY_HAS_MANAGER';
  end if;

  required_mfa := coalesce(target_role_mfa, false) or (
    target_data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
    and exists (
      select 1
      from public.role_permissions role_permission_row
      join public.permissions permission_row
        on permission_row.id = role_permission_row.permission_id
      where role_permission_row.role_id = target_role_id
        and permission_row.permission_key in (
          'user.manage', 'role.manage', 'integration.manage', 'credit.allocate',
          'support.approve', 'audit.view'
        )
    )
  );
  return jsonb_build_object(
    'organization_id', actor_organization_id,
    'role_key', target_role_key,
    'member_type', target_member_type,
    'required_mfa', required_mfa,
    'selected_branch_ids', to_jsonb(normalized_selected_branch_ids),
    'team_ids', to_jsonb(normalized_team_ids)
  );
end;
$$;

revoke all on function app_private.can_administer_tenant_user(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function app_private.assert_tenant_user_assignment(
  uuid, uuid, public.data_scope, uuid, uuid[], uuid[], text, uuid
) from public, anon, authenticated;

commit;
