-- The Client Admin and System Administrator dashboards showed the sales tenant
-- dashboard. PRD 54.6 §7-11 and 54.8 §6-9 ask for the administration picture:
-- branches, users by role and branch, MFA, integration health and what needs
-- attention. This returns those aggregates only (no names, no contact data),
-- behind the same user-administration gate as the Users page, and limited to
-- the branches of the caller's user.manage assignment.
--
-- Every figure is one grouped pass over the tenant's users, branches or
-- connections; nothing takes a caller-controlled width.

begin;

create or replace function public.get_admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_organization_id uuid;
  actor_scope public.data_scope;
  actor_scope_branch_id uuid;
  actor_selected_branch_ids uuid[] := '{}'::uuid[];
  organization_wide boolean;
  visible_branch_ids uuid[];
  result jsonb;
begin
  if not app_private.tenant_user_mode_allowed(actor_id, 'USER_ADMIN') then
    raise exception using errcode = '42501', message = 'TENANT_USER_ADMINISTRATION_REQUIRED';
  end if;

  select profile_row.organization_id into actor_organization_id
  from public.profiles profile_row
  where profile_row.id = actor_id;

  -- The widest user.manage assignment held as Client Admin or System
  -- Administrator, chosen the way get_tenant_user_workspace chooses it.
  select assignment_row.data_scope, assignment_row.scope_branch_id,
    assignment_row.selected_branch_ids
  into actor_scope, actor_scope_branch_id, actor_selected_branch_ids
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
    and assignment_row.data_scope in ('ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES', 'ORGANIZATION')
  order by role_row.authority_level desc,
    app_private.scope_rank(assignment_row.data_scope) desc,
    assignment_row.created_at desc
  limit 1;

  if actor_organization_id is null or actor_scope is null then
    raise exception using errcode = '42501', message = 'TENANT_USER_ADMINISTRATION_REQUIRED';
  end if;

  organization_wide := actor_scope in ('ORGANIZATION', 'ALL_BRANCHES');
  select coalesce(array_agg(branch_row.id), '{}'::uuid[]) into visible_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = actor_organization_id
    and branch_row.deleted_at is null
    and (
      organization_wide
      or branch_row.id = actor_scope_branch_id
      or branch_row.id = any(coalesce(actor_selected_branch_ids, '{}'::uuid[]))
    );

  with assignments as materialized (
    select
      assignment_row.user_id,
      role_row.role_key,
      role_row.name as role_name,
      role_row.authority_level,
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids,
      profile_row.active as user_active,
      profile_row.mfa_required or role_row.mfa_required as mfa_required
    from public.user_role_assignments assignment_row
    join public.profiles profile_row
      on profile_row.id = assignment_row.user_id
     and profile_row.organization_id = assignment_row.organization_id
     and profile_row.deleted_at is null
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.active
      and role_row.role_key <> 'super_admin'
      and (
        organization_wide
        or assignment_row.scope_branch_id = any(visible_branch_ids)
        or assignment_row.selected_branch_ids && visible_branch_ids
      )
  ),
  -- One row per user: the highest-authority role they hold.
  people as materialized (
    select distinct on (assignment_row.user_id) assignment_row.*
    from assignments assignment_row
    order by assignment_row.user_id, assignment_row.authority_level desc
  ),
  branch_members as (
    select member_row.branch_id, count(distinct member_row.user_id) as users
    from (
      select assignment_row.user_id, assignment_row.scope_branch_id as branch_id
      from assignments assignment_row
      where assignment_row.scope_branch_id is not null
      union all
      select assignment_row.user_id, unnest(assignment_row.selected_branch_ids)
      from assignments assignment_row
    ) member_row
    where member_row.branch_id = any(visible_branch_ids)
    group by member_row.branch_id
  ),
  connections as (
    select connection_row.status, connection_row.last_error_code
    from public.connected_accounts connection_row
    where connection_row.organization_id = actor_organization_id
      and connection_row.deleted_at is null
      and organization_wide
  )
  select jsonb_build_object(
    'organization_wide', organization_wide,
    'kpis', jsonb_build_object(
      'branches', cardinality(visible_branch_ids),
      'active_branches', (
        select count(*) from public.branches branch_row
        where branch_row.organization_id = actor_organization_id
          and branch_row.id = any(visible_branch_ids)
          and branch_row.active
      ),
      'users', (select count(*) from people),
      'active_users', (select count(*) from people where user_active),
      'inactive_users', (select count(*) from people where not user_active),
      'sales_users', (
        select count(*) from people
        where user_active and role_key in (
          'telecaller_bdc', 'sales_consultant', 'team_manager', 'showroom_manager', 'gm_sales'
        )
      ),
      'operational_users', (
        select count(*) from people
        where user_active and role_key not in (
          'telecaller_bdc', 'sales_consultant', 'team_manager', 'showroom_manager', 'gm_sales',
          'client_admin', 'system_administrator', 'business_owner'
        )
      ),
      'mfa_required_users', (select count(*) from people where user_active and mfa_required),
      'integrations_connected', (select count(*) from connections where status = 'CONNECTED'),
      'integration_issues', (
        select count(*) from connections
        where status in ('ERROR', 'DISCONNECTED') or last_error_code is not null
      )
    ),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('name', role_row.role_name, 'value', role_row.users)
        order by role_row.users desc, role_row.role_name)
      from (
        select people_row.role_name, count(*) as users
        from people people_row
        where people_row.user_active
        group by people_row.role_name
      ) role_row
    ), '[]'::jsonb),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', branch_row.name,
        'value', coalesce(member_row.users, 0)
      ) order by coalesce(member_row.users, 0) desc, branch_row.name)
      from public.branches branch_row
      left join branch_members member_row on member_row.branch_id = branch_row.id
      where branch_row.organization_id = actor_organization_id
        and branch_row.id = any(visible_branch_ids)
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_admin_overview() from public, anon;
grant execute on function public.get_admin_overview() to authenticated;

commit;
