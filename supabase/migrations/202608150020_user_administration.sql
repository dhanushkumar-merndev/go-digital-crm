begin;

-- User administration is a controlled workflow. Access grants and assignments are
-- retained as history; ordinary administrator actions never delete them.
alter table public.profiles
  add column if not exists version bigint not null default 1 check (version > 0);

alter table public.user_branch_access
  add column if not exists active boolean not null default true,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references public.profiles(id);

create index if not exists profiles_org_active_created_page_idx
  on public.profiles (organization_id, active, created_at desc, id)
  where deleted_at is null and organization_id is not null;
create index if not exists profiles_org_email_page_idx
  on public.profiles (organization_id, normalized_email, id)
  where deleted_at is null and organization_id is not null;
create index if not exists user_role_assignments_org_user_active_idx
  on public.user_role_assignments (organization_id, user_id, active, created_at desc, id);
create index if not exists user_branch_access_org_user_active_idx
  on public.user_branch_access (organization_id, user_id, active, branch_id);
create index if not exists team_members_org_user_active_idx
  on public.team_members (organization_id, user_id, active, team_id);

create unique index if not exists tenant_user_mutation_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null
    and action in (
      'tenant_user.invited',
      'tenant_user.updated',
      'tenant_user.invite_compensation_failed'
    );

-- Business Owners can bootstrap and administer Client Admins only through the
-- dedicated workflow below. They are deliberately not general user managers.
insert into public.audit_logs (
  organization_id, actor_id, action, resource_type, resource_id, metadata
)
select
  role_row.organization_id,
  null,
  'business_owner.user_manage_removed',
  'role',
  role_row.id::text,
  jsonb_build_object(
    'role_key', role_row.role_key,
    'reason', 'Replaced by the Client-Admin-only bootstrap boundary',
    'migration', '202608150020_user_administration'
  )
from public.roles role_row
join public.role_permissions role_permission_row
  on role_permission_row.role_id = role_row.id
join public.permissions permission_row
  on permission_row.id = role_permission_row.permission_id
where role_row.organization_id is not null
  and role_row.role_key = 'business_owner'
  and permission_row.permission_key = 'user.manage';

delete from public.role_permissions role_permission_row
using public.roles role_row, public.permissions permission_row
where role_permission_row.role_id = role_row.id
  and role_permission_row.permission_id = permission_row.id
  and role_row.organization_id is not null
  and role_row.role_key = 'business_owner'
  and permission_row.permission_key = 'user.manage';

create or replace function app_private.enforce_business_owner_user_boundary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.roles role_row
    join public.permissions permission_row on permission_row.id = new.permission_id
    where role_row.id = new.role_id
      and role_row.organization_id is not null
      and role_row.role_key = 'business_owner'
      and permission_row.permission_key = 'user.manage'
  ) then
    if coalesce(auth.role(), '') = 'service_role' then
      -- provision_default_roles is a bulk INSERT and must continue provisioning
      -- the other frozen permissions for a new tenant.
      return null;
    end if;
    raise exception using errcode = '42501', message = 'BUSINESS_OWNER_USER_MANAGE_FORBIDDEN';
  end if;
  return new;
end;
$$;

drop trigger if exists a_business_owner_user_boundary on public.role_permissions;
create trigger a_business_owner_user_boundary
before insert or update on public.role_permissions
for each row execute function app_private.enforce_business_owner_user_boundary();

create or replace function app_private.bump_profile_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists profiles_bump_version on public.profiles;
create trigger profiles_bump_version
before update on public.profiles
for each row execute function app_private.bump_profile_version();

-- Revoked branch-access rows must not continue widening record or work scope.
create or replace function app_private.can_access_branch(
  target_organization_id uuid,
  target_branch_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_branch_id is not null
    and app_private.can_access_organization(target_organization_id)
    and exists (
      select 1
      from public.branches branch_row
      where branch_row.id = target_branch_id
        and branch_row.organization_id = target_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
    )
    and (
      app_private.has_active_approved_support_session(target_organization_id)
      or exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.user_id = auth.uid()
          and assignment_row.organization_id = target_organization_id
          and assignment_row.active
          and (
            assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
            or (
              assignment_row.data_scope = 'ONE_BRANCH'
              and assignment_row.scope_branch_id = target_branch_id
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and target_branch_id = any(assignment_row.selected_branch_ids)
            )
            or exists (
              select 1
              from public.user_branch_access branch_access_row
              where branch_access_row.organization_id = target_organization_id
                and branch_access_row.user_id = auth.uid()
                and branch_access_row.branch_id = target_branch_id
                and branch_access_row.active
            )
            or exists (
              select 1
              from public.team_members member_row
              join public.teams team_row
                on team_row.id = member_row.team_id
               and team_row.organization_id = member_row.organization_id
              where member_row.organization_id = target_organization_id
                and member_row.user_id = auth.uid()
                and member_row.active
                and team_row.active
                and team_row.branch_id = target_branch_id
            )
          )
      )
    );
$$;

create or replace function app_private.can_access_record(
  target_organization_id uuid,
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.can_access_organization(target_organization_id)
    and (
      app_private.has_active_approved_support_session(target_organization_id)
      or exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.user_id = auth.uid()
          and assignment_row.organization_id = target_organization_id
          and assignment_row.active
          and (
            assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
            or (
              assignment_row.data_scope = 'ONE_BRANCH'
              and target_branch_id = assignment_row.scope_branch_id
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and target_branch_id = any(assignment_row.selected_branch_ids)
            )
            or (
              assignment_row.data_scope = 'OWN_RECORDS'
              and target_owner_id = auth.uid()
              and (
                target_branch_id is null
                or exists (
                  select 1
                  from public.user_branch_access branch_access_row
                  where branch_access_row.organization_id = target_organization_id
                    and branch_access_row.user_id = auth.uid()
                    and branch_access_row.branch_id = target_branch_id
                    and branch_access_row.active
                )
                or exists (
                  select 1
                  from public.team_members member_row
                  join public.teams team_row
                    on team_row.id = member_row.team_id
                   and team_row.organization_id = member_row.organization_id
                  where member_row.organization_id = target_organization_id
                    and member_row.user_id = auth.uid()
                    and member_row.active
                    and team_row.active
                    and team_row.branch_id = target_branch_id
                )
              )
            )
            or (
              assignment_row.data_scope = 'OWN_TEAM'
              and target_team_id in (
                select member_row.team_id
                from public.team_members member_row
                where member_row.organization_id = target_organization_id
                  and member_row.user_id = auth.uid()
                  and member_row.active
              )
            )
          )
      )
    );
$$;

create or replace function app_private.user_can_receive_work(
  target_organization_id uuid,
  target_branch_id uuid,
  target_team_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile_row
    where profile_row.id = target_user_id
      and profile_row.organization_id = target_organization_id
      and profile_row.active
      and profile_row.deleted_at is null
      and (
        (
          target_team_id is not null
          and exists (
            select 1
            from public.teams team_row
            join public.team_members member_row
              on member_row.organization_id = team_row.organization_id
             and member_row.team_id = team_row.id
             and member_row.user_id = target_user_id
             and member_row.active
            where team_row.id = target_team_id
              and team_row.organization_id = target_organization_id
              and team_row.branch_id = target_branch_id
              and team_row.active
          )
        )
        or (
          target_team_id is null
          and (
            exists (
              select 1
              from public.user_branch_access access_row
              where access_row.organization_id = target_organization_id
                and access_row.user_id = target_user_id
                and access_row.branch_id = target_branch_id
                and access_row.active
            )
            or exists (
              select 1
              from public.user_role_assignments assignment_row
              where assignment_row.organization_id = target_organization_id
                and assignment_row.user_id = target_user_id
                and assignment_row.active
                and (
                  assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
                  or (
                    assignment_row.data_scope = 'ONE_BRANCH'
                    and assignment_row.scope_branch_id = target_branch_id
                  )
                  or (
                    assignment_row.data_scope = 'SELECTED_BRANCHES'
                    and target_branch_id = any(assignment_row.selected_branch_ids)
                  )
                )
            )
          )
        )
      )
  );
$$;

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

  if target_mode = 'CLIENT_ADMIN_BOOTSTRAP' then
    select role_row.authority_level,
           assignment_row.data_scope,
           assignment_row.scope_branch_id,
           assignment_row.selected_branch_ids
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids
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
           assignment_row.selected_branch_ids
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids
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
        from public.user_role_assignments actor_assignment_row
        join public.role_permissions actor_permission_row
          on actor_permission_row.role_id = actor_assignment_row.role_id
        where actor_assignment_row.organization_id = actor_organization_id
          and actor_assignment_row.user_id = target_actor_id
          and actor_assignment_row.active
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
           assignment_row.selected_branch_ids
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids
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
           assignment_row.selected_branch_ids
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids
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
        from public.user_role_assignments actor_assignment_row
        join public.role_permissions actor_permission_row
          on actor_permission_row.role_id = actor_assignment_row.role_id
        where actor_assignment_row.organization_id = actor_organization_id
          and actor_assignment_row.user_id = target_actor_id
          and actor_assignment_row.active
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

create or replace function app_private.apply_tenant_user_entitlements(
  target_organization_id uuid,
  target_actor_id uuid,
  target_user_id uuid,
  target_role_key text,
  target_data_scope public.data_scope,
  target_scope_branch_id uuid,
  target_selected_branch_ids uuid[],
  target_team_ids uuid[],
  target_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare normalized_selected_branch_ids uuid[];
declare normalized_team_ids uuid[];
declare desired_branch_ids uuid[];
declare target_member_type text;
begin
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
  desired_branch_ids := case target_data_scope
    when 'ONE_BRANCH' then array[target_scope_branch_id]
    when 'SELECTED_BRANCHES' then normalized_selected_branch_ids
    when 'OWN_RECORDS' then coalesce(array(
      select distinct team_row.branch_id
      from public.teams team_row
      where team_row.organization_id = target_organization_id
        and team_row.id = any(normalized_team_ids)
      order by team_row.branch_id
    ), '{}'::uuid[])
    when 'OWN_TEAM' then coalesce(array(
      select distinct team_row.branch_id
      from public.teams team_row
      where team_row.organization_id = target_organization_id
        and team_row.id = any(normalized_team_ids)
      order by team_row.branch_id
    ), '{}'::uuid[])
    else '{}'::uuid[]
  end;
  target_member_type := case target_role_key
    when 'team_manager' then 'TEAM_MANAGER'
    when 'sales_consultant' then 'SALES_CONSULTANT'
    when 'telecaller_bdc' then 'TELECALLER_BDC'
    else null
  end;

  update public.user_branch_access access_row
  set active = false,
      revoked_at = now(),
      revoked_by = target_actor_id
  where access_row.organization_id = target_organization_id
    and access_row.user_id = target_user_id
    and access_row.active
    and (
      not target_active
      or not (access_row.branch_id = any(desired_branch_ids))
    );

  insert into public.user_branch_access (
    organization_id, user_id, branch_id, granted_by, active, revoked_at, revoked_by
  )
  select
    target_organization_id,
    target_user_id,
    desired_branch.branch_id,
    target_actor_id,
    target_active,
    case when target_active then null else now() end,
    case when target_active then null else target_actor_id end
  from unnest(desired_branch_ids) as desired_branch(branch_id)
  on conflict (user_id, branch_id) do update
  set organization_id = excluded.organization_id,
      granted_by = excluded.granted_by,
      active = excluded.active,
      revoked_at = excluded.revoked_at,
      revoked_by = excluded.revoked_by;

  update public.team_members member_row
  set active = false
  where member_row.organization_id = target_organization_id
    and member_row.user_id = target_user_id
    and member_row.active
    and (
      not target_active
      or not (member_row.team_id = any(normalized_team_ids))
    );

  if target_member_type is not null then
    insert into public.team_members (
      organization_id,
      team_id,
      user_id,
      member_type,
      eligible_for_fresh_leads,
      eligible_for_qualified_leads,
      active
    )
    select
      target_organization_id,
      selected_team.team_id,
      target_user_id,
      target_member_type,
      false,
      false,
      target_active
    from unnest(normalized_team_ids) as selected_team(team_id)
    on conflict (team_id, user_id) do update
    set organization_id = excluded.organization_id,
        member_type = excluded.member_type,
        active = excluded.active;
  end if;

  update public.teams team_row
  set manager_id = null,
      updated_at = now()
  where team_row.organization_id = target_organization_id
    and team_row.manager_id = target_user_id
    and (
      not target_active
      or target_member_type is distinct from 'TEAM_MANAGER'
      or not (team_row.id = any(normalized_team_ids))
    );
  if target_active and target_member_type = 'TEAM_MANAGER' then
    update public.teams team_row
    set manager_id = target_user_id,
        updated_at = now()
    where team_row.organization_id = target_organization_id
      and team_row.id = any(normalized_team_ids);
  end if;
end;
$$;

create or replace function public.get_tenant_user_request_result(target_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare result_row record;
declare current_organization_id uuid;
begin
  if auth.uid() is null or target_request_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.mfa_policy_satisfied(current_organization_id)
  then
    raise exception using errcode = '42501', message = 'MFA_REQUIRED';
  end if;
  select audit_row.action, audit_row.metadata
  into result_row
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action in (
      'tenant_user.invited',
      'tenant_user.updated',
      'tenant_user.invite_compensation_failed'
    )
  order by audit_row.id desc
  limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'action', result_row.action,
    'result', result_row.metadata -> 'result'
  );
end;
$$;

create or replace function public.provision_tenant_user(
  target_actor_id uuid,
  target_user_id uuid,
  target_email text,
  target_full_name text,
  target_phone text,
  target_employee_id text,
  target_role_id uuid,
  target_data_scope public.data_scope,
  target_scope_branch_id uuid,
  target_selected_branch_ids uuid[],
  target_team_ids uuid[],
  target_active boolean,
  target_mfa_required boolean,
  target_request_id uuid,
  target_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare assignment_context jsonb;
declare target_organization_id uuid;
declare target_role_key text;
declare normalized_email text;
declare normalized_phone_value text;
declare normalized_employee_id_value text;
declare normalized_selected_branch_ids uuid[];
declare normalized_team_ids uuid[];
declare effective_mfa_required boolean;
declare result_payload jsonb;
declare prior_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_request_id is null or target_user_id is null then
    raise exception using errcode = '22023', message = 'INVALID_USER_INVITATION';
  end if;

  select audit_row.metadata -> 'result'
  into prior_result
  from public.audit_logs audit_row
  join public.profiles actor_profile on actor_profile.id = audit_row.actor_id
  where audit_row.actor_id = target_actor_id
    and audit_row.request_id = target_request_id
    and audit_row.action = 'tenant_user.invited'
    and actor_profile.organization_id = audit_row.organization_id
  limit 1;
  if prior_result is not null then return prior_result; end if;

  assignment_context := app_private.assert_tenant_user_assignment(
    target_actor_id,
    target_role_id,
    target_data_scope,
    target_scope_branch_id,
    target_selected_branch_ids,
    target_team_ids,
    target_mode,
    null
  );
  target_organization_id := (assignment_context ->> 'organization_id')::uuid;
  target_role_key := assignment_context ->> 'role_key';
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

  normalized_email := lower(btrim(coalesce(target_email, '')));
  normalized_phone_value := nullif(
    regexp_replace(btrim(coalesce(target_phone, '')), '[^0-9+]', '', 'g'), ''
  );
  normalized_employee_id_value := nullif(btrim(coalesce(target_employee_id, '')), '');
  if char_length(btrim(coalesce(target_full_name, ''))) not between 2 and 160
    or char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or (
      normalized_phone_value is not null
      and normalized_phone_value !~ '^[+]?[0-9]{7,15}$'
    )
    or (
      normalized_employee_id_value is not null
      and char_length(normalized_employee_id_value) > 64
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_USER_IDENTITY';
  end if;
  if not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = target_user_id
      and lower(auth_user.email) = normalized_email
  ) or exists (
    select 1 from public.profiles profile_row where profile_row.id = target_user_id
  ) then
    raise exception using errcode = '23505', message = 'USER_IDENTITY_ALREADY_PROVISIONED';
  end if;

  effective_mfa_required := coalesce(target_mfa_required, false)
    or coalesce((assignment_context ->> 'required_mfa')::boolean, false);
  insert into public.profiles (
    id,
    organization_id,
    full_name,
    email,
    phone,
    normalized_phone,
    employee_id,
    active,
    mfa_required
  ) values (
    target_user_id,
    target_organization_id,
    btrim(target_full_name),
    normalized_email,
    nullif(btrim(coalesce(target_phone, '')), ''),
    normalized_phone_value,
    normalized_employee_id_value,
    coalesce(target_active, true),
    effective_mfa_required
  );
  insert into public.user_role_assignments (
    organization_id,
    user_id,
    role_id,
    data_scope,
    scope_branch_id,
    selected_branch_ids,
    active,
    granted_by
  ) values (
    target_organization_id,
    target_user_id,
    target_role_id,
    target_data_scope,
    target_scope_branch_id,
    normalized_selected_branch_ids,
    true,
    target_actor_id
  );
  perform app_private.apply_tenant_user_entitlements(
    target_organization_id,
    target_actor_id,
    target_user_id,
    target_role_key,
    target_data_scope,
    target_scope_branch_id,
    normalized_selected_branch_ids,
    normalized_team_ids,
    coalesce(target_active, true)
  );

  result_payload := jsonb_build_object(
    'user_id', target_user_id,
    'organization_id', target_organization_id,
    'status', 'INVITED',
    'active', coalesce(target_active, true),
    'mfa_required', effective_mfa_required,
    'version', 1
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id,
    target_actor_id,
    'tenant_user.invited',
    'profile',
    target_user_id::text,
    target_request_id,
    jsonb_build_object(
      'mode', target_mode,
      'after', jsonb_build_object(
        'role_id', target_role_id,
        'data_scope', target_data_scope,
        'scope_branch_id', target_scope_branch_id,
        'selected_branch_ids', to_jsonb(normalized_selected_branch_ids),
        'team_ids', to_jsonb(normalized_team_ids),
        'active', coalesce(target_active, true),
        'mfa_required', effective_mfa_required
      ),
      'result', result_payload
    )
  );
  return result_payload;
end;
$$;

create or replace function public.update_tenant_user_administration(
  target_actor_id uuid,
  target_user_id uuid,
  expected_version bigint,
  target_full_name text,
  target_phone text,
  target_employee_id text,
  target_role_id uuid,
  target_data_scope public.data_scope,
  target_scope_branch_id uuid,
  target_selected_branch_ids uuid[],
  target_team_ids uuid[],
  target_active boolean,
  target_mfa_required boolean,
  target_request_id uuid,
  target_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare assignment_context jsonb;
declare target_organization_id uuid;
declare target_role_key text;
declare normalized_phone_value text;
declare normalized_employee_id_value text;
declare normalized_selected_branch_ids uuid[];
declare normalized_team_ids uuid[];
declare effective_mfa_required boolean;
declare current_profile public.profiles%rowtype;
declare current_assignment record;
declare current_branch_ids uuid[];
declare current_team_ids uuid[];
declare next_version bigint;
declare before_payload jsonb;
declare result_payload jsonb;
declare prior_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_request_id is null
    or target_user_id is null
    or expected_version is null
    or target_active is null
  then
    raise exception using errcode = '22023', message = 'INVALID_USER_UPDATE';
  end if;

  select audit_row.metadata -> 'result'
  into prior_result
  from public.audit_logs audit_row
  join public.profiles actor_profile on actor_profile.id = audit_row.actor_id
  where audit_row.actor_id = target_actor_id
    and audit_row.request_id = target_request_id
    and audit_row.action = 'tenant_user.updated'
    and actor_profile.organization_id = audit_row.organization_id
  limit 1;
  if prior_result is not null then return prior_result; end if;

  assignment_context := app_private.assert_tenant_user_assignment(
    target_actor_id,
    target_role_id,
    target_data_scope,
    target_scope_branch_id,
    target_selected_branch_ids,
    target_team_ids,
    target_mode,
    target_user_id
  );
  target_organization_id := (assignment_context ->> 'organization_id')::uuid;
  target_role_key := assignment_context ->> 'role_key';

  select * into current_profile
  from public.profiles profile_row
  where profile_row.id = target_user_id
    and profile_row.organization_id = target_organization_id
    and profile_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  if current_profile.version <> expected_version then
    raise exception using errcode = '40001', message = 'STALE_USER_VERSION';
  end if;

  select assignment_row.id,
         assignment_row.role_id,
         assignment_row.data_scope,
         assignment_row.scope_branch_id,
         assignment_row.selected_branch_ids
  into current_assignment
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  where assignment_row.organization_id = target_organization_id
    and assignment_row.user_id = target_user_id
    and assignment_row.active
  order by role_row.authority_level desc, assignment_row.created_at desc
  limit 1
  for update of assignment_row;
  if not found then
    raise exception using errcode = 'P0002', message = 'ACTIVE_ASSIGNMENT_NOT_FOUND';
  end if;
  select coalesce(array_agg(access_row.branch_id order by access_row.branch_id), '{}'::uuid[])
  into current_branch_ids
  from public.user_branch_access access_row
  where access_row.organization_id = target_organization_id
    and access_row.user_id = target_user_id
    and access_row.active;
  select coalesce(array_agg(member_row.team_id order by member_row.team_id), '{}'::uuid[])
  into current_team_ids
  from public.team_members member_row
  where member_row.organization_id = target_organization_id
    and member_row.user_id = target_user_id
    and member_row.active;

  normalized_phone_value := nullif(
    regexp_replace(btrim(coalesce(target_phone, '')), '[^0-9+]', '', 'g'), ''
  );
  normalized_employee_id_value := nullif(btrim(coalesce(target_employee_id, '')), '');
  if char_length(btrim(coalesce(target_full_name, ''))) not between 2 and 160
    or (
      normalized_phone_value is not null
      and normalized_phone_value !~ '^[+]?[0-9]{7,15}$'
    )
    or (
      normalized_employee_id_value is not null
      and char_length(normalized_employee_id_value) > 64
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_USER_IDENTITY';
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
  effective_mfa_required := coalesce(target_mfa_required, false)
    or coalesce((assignment_context ->> 'required_mfa')::boolean, false);
  before_payload := jsonb_build_object(
    'full_name', current_profile.full_name,
    'phone_present', current_profile.phone is not null,
    'employee_id', current_profile.employee_id,
    'active', current_profile.active,
    'mfa_required', current_profile.mfa_required,
    'version', current_profile.version,
    'role_id', current_assignment.role_id,
    'data_scope', current_assignment.data_scope,
    'scope_branch_id', current_assignment.scope_branch_id,
    'selected_branch_ids', to_jsonb(current_assignment.selected_branch_ids),
    'branch_ids', to_jsonb(current_branch_ids),
    'team_ids', to_jsonb(current_team_ids)
  );

  update public.profiles profile_row
  set full_name = btrim(target_full_name),
      phone = nullif(btrim(coalesce(target_phone, '')), ''),
      normalized_phone = normalized_phone_value,
      employee_id = normalized_employee_id_value,
      active = target_active,
      mfa_required = effective_mfa_required,
      updated_at = now()
  where profile_row.id = target_user_id
  returning profile_row.version into next_version;

  update public.user_role_assignments assignment_row
  set active = false
  where assignment_row.organization_id = target_organization_id
    and assignment_row.user_id = target_user_id
    and assignment_row.active;
  insert into public.user_role_assignments (
    organization_id,
    user_id,
    role_id,
    data_scope,
    scope_branch_id,
    selected_branch_ids,
    active,
    granted_by
  ) values (
    target_organization_id,
    target_user_id,
    target_role_id,
    target_data_scope,
    target_scope_branch_id,
    normalized_selected_branch_ids,
    true,
    target_actor_id
  );
  perform app_private.apply_tenant_user_entitlements(
    target_organization_id,
    target_actor_id,
    target_user_id,
    target_role_key,
    target_data_scope,
    target_scope_branch_id,
    normalized_selected_branch_ids,
    normalized_team_ids,
    target_active
  );

  result_payload := jsonb_build_object(
    'user_id', target_user_id,
    'organization_id', target_organization_id,
    'status', 'UPDATED',
    'active', target_active,
    'mfa_required', effective_mfa_required,
    'version', next_version
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id,
    target_actor_id,
    'tenant_user.updated',
    'profile',
    target_user_id::text,
    target_request_id,
    jsonb_build_object(
      'mode', target_mode,
      'before', before_payload,
      'after', jsonb_build_object(
        'full_name', btrim(target_full_name),
        'phone_present', normalized_phone_value is not null,
        'employee_id', normalized_employee_id_value,
        'active', target_active,
        'mfa_required', effective_mfa_required,
        'version', next_version,
        'role_id', target_role_id,
        'data_scope', target_data_scope,
        'scope_branch_id', target_scope_branch_id,
        'selected_branch_ids', to_jsonb(normalized_selected_branch_ids),
        'team_ids', to_jsonb(normalized_team_ids)
      ),
      'result', result_payload
    )
  );
  return result_payload;
end;
$$;

create or replace function public.record_tenant_user_invite_compensation_failure(
  target_actor_id uuid,
  target_user_id uuid,
  target_request_id uuid,
  failure_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare target_organization_id uuid;
declare result_payload jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select profile_row.organization_id into target_organization_id
  from public.profiles profile_row
  where profile_row.id = target_actor_id;
  if target_organization_id is null
    or target_user_id is null
    or target_request_id is null
    or failure_code !~ '^[A-Z0-9_]{3,80}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_COMPENSATION_FAILURE';
  end if;
  result_payload := jsonb_build_object(
    'user_id', target_user_id,
    'organization_id', target_organization_id,
    'status', 'AUTH_ORPHAN_REQUIRES_REMEDIATION'
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id,
    target_actor_id,
    'tenant_user.invite_compensation_failed',
    'auth_user',
    target_user_id::text,
    target_request_id,
    jsonb_build_object('failure_code', failure_code, 'result', result_payload)
  )
  on conflict do nothing;
  return true;
end;
$$;

create or replace function app_private.tenant_user_mode_allowed(
  target_actor_id uuid,
  target_mode text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_actor_id is not null
    and target_mode in ('USER_ADMIN', 'CLIENT_ADMIN_BOOTSTRAP')
    and exists (
      select 1
      from public.profiles profile_row
      join public.organizations organization_row
        on organization_row.id = profile_row.organization_id
       and organization_row.status = 'ACTIVE'
       and organization_row.deleted_at is null
      where profile_row.id = target_actor_id
        and profile_row.active
        and profile_row.deleted_at is null
        and app_private.mfa_policy_satisfied(profile_row.organization_id)
        and (
          (
            target_mode = 'CLIENT_ADMIN_BOOTSTRAP'
            and exists (
              select 1
              from public.user_role_assignments assignment_row
              join public.roles role_row
                on role_row.id = assignment_row.role_id
               and role_row.organization_id = assignment_row.organization_id
               and role_row.role_key = 'business_owner'
              where assignment_row.organization_id = profile_row.organization_id
                and assignment_row.user_id = target_actor_id
                and assignment_row.active
                and assignment_row.data_scope = 'ORGANIZATION'
            )
          )
          or (
            target_mode = 'USER_ADMIN'
            and exists (
              select 1
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
              where assignment_row.organization_id = profile_row.organization_id
                and assignment_row.user_id = target_actor_id
                and assignment_row.active
                and assignment_row.data_scope in (
                  'ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES', 'ORGANIZATION'
                )
            )
          )
        )
    );
$$;

create or replace function public.get_tenant_user_admin_options(
  target_mode text default 'USER_ADMIN'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_id uuid := auth.uid();
declare actor_organization_id uuid;
declare actor_authority integer;
declare actor_scope public.data_scope;
declare actor_scope_branch_id uuid;
declare actor_selected_branch_ids uuid[];
declare result_payload jsonb;
begin
  if not app_private.tenant_user_mode_allowed(actor_id, target_mode) then
    raise exception using errcode = '42501', message = 'TENANT_USER_ADMINISTRATION_REQUIRED';
  end if;
  select profile_row.organization_id into actor_organization_id
  from public.profiles profile_row where profile_row.id = actor_id;
  if target_mode = 'CLIENT_ADMIN_BOOTSTRAP' then
    select role_row.authority_level,
           assignment_row.data_scope,
           assignment_row.scope_branch_id,
           assignment_row.selected_branch_ids
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
     and role_row.role_key = 'business_owner'
    where assignment_row.organization_id = actor_organization_id
      and assignment_row.user_id = actor_id
      and assignment_row.active
      and assignment_row.data_scope = 'ORGANIZATION'
    order by role_row.authority_level desc
    limit 1;
  else
    select role_row.authority_level,
           assignment_row.data_scope,
           assignment_row.scope_branch_id,
           assignment_row.selected_branch_ids
    into actor_authority, actor_scope, actor_scope_branch_id, actor_selected_branch_ids
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
    order by role_row.authority_level desc,
             app_private.scope_rank(assignment_row.data_scope) desc
    limit 1;
  end if;

  select jsonb_build_object(
    'organization_id', actor_organization_id,
    'mode', target_mode,
    'roles', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', role_row.id,
          'name', role_row.name,
          'role_key', role_row.role_key,
          'authority_level', role_row.authority_level,
          'mfa_required', role_row.mfa_required
        ) order by role_row.authority_level desc, role_row.name
      )
      from public.roles role_row
      where role_row.organization_id = actor_organization_id
        and role_row.authority_level < actor_authority
        and (
          (target_mode = 'CLIENT_ADMIN_BOOTSTRAP' and role_row.role_key = 'client_admin')
          or (
            target_mode = 'USER_ADMIN'
            and role_row.role_key not in ('business_owner', 'client_admin', 'super_admin')
            and not exists (
              select 1
              from public.role_permissions target_permission_row
              where target_permission_row.role_id = role_row.id
                and not exists (
                  select 1
                  from public.user_role_assignments actor_assignment_row
                  join public.role_permissions actor_permission_row
                    on actor_permission_row.role_id = actor_assignment_row.role_id
                  where actor_assignment_row.organization_id = actor_organization_id
                    and actor_assignment_row.user_id = actor_id
                    and actor_assignment_row.active
                    and actor_permission_row.permission_id = target_permission_row.permission_id
                )
            )
          )
        )
    ), '[]'::jsonb),
    'branches', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', branch_row.id, 'name', branch_row.name, 'code', branch_row.code)
        order by branch_row.name, branch_row.id
      )
      from public.branches branch_row
      where branch_row.organization_id = actor_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
        and (
          actor_scope in ('ALL_BRANCHES', 'ORGANIZATION')
          or (actor_scope = 'ONE_BRANCH' and branch_row.id = actor_scope_branch_id)
          or (
            actor_scope = 'SELECTED_BRANCHES'
            and branch_row.id = any(actor_selected_branch_ids)
          )
        )
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', team_row.id,
          'name', team_row.name,
          'branch_id', team_row.branch_id
        ) order by team_row.name, team_row.id
      )
      from public.teams team_row
      where team_row.organization_id = actor_organization_id
        and team_row.active
        and (
          actor_scope in ('ALL_BRANCHES', 'ORGANIZATION')
          or (actor_scope = 'ONE_BRANCH' and team_row.branch_id = actor_scope_branch_id)
          or (
            actor_scope = 'SELECTED_BRANCHES'
            and team_row.branch_id = any(actor_selected_branch_ids)
          )
        )
    ), '[]'::jsonb),
    'data_scopes', coalesce((
      select jsonb_agg(
        jsonb_build_object('value', scope_option.scope_value, 'label', scope_option.scope_label)
        order by scope_option.scope_order
      )
      from (values
        ('OWN_RECORDS'::public.data_scope, 'Own records', 1),
        ('OWN_TEAM'::public.data_scope, 'Own team', 2),
        ('ONE_BRANCH'::public.data_scope, 'One branch', 3),
        ('SELECTED_BRANCHES'::public.data_scope, 'Selected branches', 4),
        ('ALL_BRANCHES'::public.data_scope, 'All branches', 5),
        ('ORGANIZATION'::public.data_scope, 'Organization', 6)
      ) as scope_option(scope_value, scope_label, scope_order)
      where app_private.scope_rank(scope_option.scope_value) <= app_private.scope_rank(actor_scope)
    ), '[]'::jsonb)
  ) into result_payload;
  return result_payload;
end;
$$;

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
declare actor_id uuid := auth.uid();
declare actor_organization_id uuid;
declare normalized_search text := lower(btrim(coalesce(target_search, '')));
declare search_phone_digits text;
declare result_payload jsonb;
begin
  if not app_private.tenant_user_mode_allowed(actor_id, target_mode) then
    raise exception using errcode = '42501', message = 'TENANT_USER_ADMINISTRATION_REQUIRED';
  end if;
  if target_page < 1
    or target_page > 1000000
    or target_page_size not in (25, 50, 100)
    or char_length(normalized_search) > 160
    or target_status not in ('ALL', 'ACTIVE', 'INACTIVE', 'MFA_REQUIRED')
    or target_sort not in ('CREATED_DESC', 'UPDATED_DESC', 'NAME_ASC', 'ROLE_ASC')
  then
    raise exception using errcode = '22023', message = 'INVALID_USER_WORKSPACE_QUERY';
  end if;
  select profile_row.organization_id into actor_organization_id
  from public.profiles profile_row where profile_row.id = actor_id;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);

  with scoped_rows as materialized (
    select
      profile_row.id,
      profile_row.full_name,
      profile_row.email,
      profile_row.phone,
      profile_row.normalized_phone,
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
      assignment_row.selected_branch_ids,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('id', branch_row.id, 'name', branch_row.name, 'code', branch_row.code)
          order by branch_row.name, branch_row.id
        )
        from public.user_branch_access access_row
        join public.branches branch_row
          on branch_row.id = access_row.branch_id
         and branch_row.organization_id = access_row.organization_id
        where access_row.organization_id = actor_organization_id
          and access_row.user_id = profile_row.id
          and access_row.active
      ), '[]'::jsonb) as branches,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', team_row.id,
            'name', team_row.name,
            'branch_id', team_row.branch_id,
            'member_type', member_row.member_type
          ) order by team_row.name, team_row.id
        )
        from public.team_members member_row
        join public.teams team_row
          on team_row.id = member_row.team_id
         and team_row.organization_id = member_row.organization_id
        where member_row.organization_id = actor_organization_id
          and member_row.user_id = profile_row.id
          and member_row.active
      ), '[]'::jsonb) as teams
    from public.profiles profile_row
    join lateral (
      select candidate_assignment.*
      from public.user_role_assignments candidate_assignment
      join public.roles candidate_role
        on candidate_role.id = candidate_assignment.role_id
       and candidate_role.organization_id = candidate_assignment.organization_id
      where candidate_assignment.organization_id = profile_row.organization_id
        and candidate_assignment.user_id = profile_row.id
        and candidate_assignment.active
      order by candidate_role.authority_level desc, candidate_assignment.created_at desc
      limit 1
    ) assignment_row on true
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where profile_row.organization_id = actor_organization_id
      and profile_row.deleted_at is null
      and app_private.can_administer_tenant_user(actor_id, profile_row.id, target_mode)
  ), filtered_rows as materialized (
    select scoped_row.*
    from scoped_rows scoped_row
    where (
      target_status = 'ALL'
      or (target_status = 'ACTIVE' and scoped_row.active)
      or (target_status = 'INACTIVE' and not scoped_row.active)
      or (target_status = 'MFA_REQUIRED' and scoped_row.mfa_required)
    )
      and (target_role_id is null or scoped_row.role_id = target_role_id)
      and (
        target_branch_id is null
        or scoped_row.scope_branch_id = target_branch_id
        or target_branch_id = any(scoped_row.selected_branch_ids)
        or scoped_row.branches @> jsonb_build_array(jsonb_build_object('id', target_branch_id))
        or exists (
          select 1
          from jsonb_array_elements(scoped_row.teams) team_item
          where team_item ->> 'branch_id' = target_branch_id::text
        )
        or scoped_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
      )
      and (
        normalized_search = ''
        or lower(scoped_row.full_name) like '%' || normalized_search || '%'
        or lower(scoped_row.email) like normalized_search || '%'
        or lower(coalesce(scoped_row.employee_id, '')) like normalized_search || '%'
        or (
          char_length(search_phone_digits) >= 3
          and app_private.normalize_phone_digits(scoped_row.normalized_phone)
            like search_phone_digits || '%'
        )
      )
  ), page_rows as materialized (
    select filtered_row.*
    from filtered_rows filtered_row
    order by
      case when target_sort = 'CREATED_DESC' then filtered_row.created_at end desc,
      case when target_sort = 'UPDATED_DESC' then filtered_row.updated_at end desc,
      case when target_sort = 'NAME_ASC' then lower(filtered_row.full_name) end asc,
      case when target_sort = 'ROLE_ASC' then lower(filtered_row.role_name) end asc,
      filtered_row.id
    limit target_page_size
    offset (target_page - 1) * target_page_size
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
          'branches', page_row.branches,
          'teams', page_row.teams,
          'created_at', page_row.created_at,
          'updated_at', page_row.updated_at,
          'can_edit', true
        ) order by
          case when target_sort = 'CREATED_DESC' then page_row.created_at end desc,
          case when target_sort = 'UPDATED_DESC' then page_row.updated_at end desc,
          case when target_sort = 'NAME_ASC' then lower(page_row.full_name) end asc,
          case when target_sort = 'ROLE_ASC' then lower(page_row.role_name) end asc,
          page_row.id
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_rows),
    'kpis', jsonb_build_object(
      'total_users', (select count(*) from scoped_rows),
      'active_users', (select count(*) from scoped_rows where active),
      'inactive_users', (select count(*) from scoped_rows where not active),
      'mfa_required', (select count(*) from scoped_rows where mfa_required)
    )
  ) into result_payload;
  return result_payload;
end;
$$;

-- Direct directory reads use the same authority and branch ceiling as the
-- workspace RPC. Business Owners can see Client Admins only.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
for select to authenticated using (
  app_private.mfa_policy_satisfied(organization_id)
  and (
    id = auth.uid()
    or app_private.can_administer_tenant_user(auth.uid(), id, 'USER_ADMIN')
    or app_private.can_administer_tenant_user(auth.uid(), id, 'CLIENT_ADMIN_BOOTSTRAP')
    or (
      organization_id is not null
      and app_private.can_access_organization(organization_id)
      and exists (
        select 1
        from public.team_members self_member
        join public.team_members target_member
          on target_member.organization_id = self_member.organization_id
         and target_member.team_id = self_member.team_id
         and target_member.active
        where self_member.organization_id = profiles.organization_id
          and self_member.user_id = auth.uid()
          and self_member.active
          and target_member.user_id = profiles.id
      )
    )
  )
);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
for update to authenticated using (
  id = auth.uid() and app_private.mfa_policy_satisfied(organization_id)
) with check (
  id = auth.uid() and app_private.mfa_policy_satisfied(organization_id)
);

drop policy if exists role_assignments_read on public.user_role_assignments;
create policy role_assignments_read on public.user_role_assignments
for select to authenticated using (
  (user_id = auth.uid() and app_private.mfa_policy_satisfied(organization_id))
  or app_private.can_administer_tenant_user(auth.uid(), user_id, 'USER_ADMIN')
  or app_private.can_administer_tenant_user(
    auth.uid(), user_id, 'CLIENT_ADMIN_BOOTSTRAP'
  )
  or (
    organization_id is null
    and app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  )
);
drop policy if exists role_assignments_insert on public.user_role_assignments;
drop policy if exists role_assignments_update on public.user_role_assignments;

drop policy if exists user_branch_access_read on public.user_branch_access;
create policy user_branch_access_read on public.user_branch_access
for select to authenticated using (
  (
    user_id = auth.uid()
    and app_private.can_access_organization(organization_id)
  )
  or app_private.can_administer_tenant_user(auth.uid(), user_id, 'USER_ADMIN')
  or app_private.can_administer_tenant_user(
    auth.uid(), user_id, 'CLIENT_ADMIN_BOOTSTRAP'
  )
);

drop policy if exists team_members_read on public.team_members;
create policy team_members_read on public.team_members
for select to authenticated using (
  (
    app_private.can_access_team(organization_id, team_id)
    and (
      not app_private.is_platform_admin()
      or app_private.support_session_allows_permission(
        organization_id, 'data.directory.view'
      )
    )
  )
  or app_private.can_administer_tenant_user(auth.uid(), user_id, 'USER_ADMIN')
  or app_private.can_administer_tenant_user(
    auth.uid(), user_id, 'CLIENT_ADMIN_BOOTSTRAP'
  )
);

revoke insert, update, delete on public.user_role_assignments from anon, authenticated;
revoke insert, update, delete on public.user_branch_access from anon, authenticated;
revoke insert, update, delete on public.team_members from anon, authenticated;

create or replace function app_private.realtime_topic_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_topic text;
declare topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(
    current_topic,
    '^organization:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):(leads|customers|communications|work|notifications|integrations|support|administration)$'
  );
  return case when topic_match is null then null else topic_match[1]::uuid end;
exception when others then
  return null;
end;
$$;

create or replace function app_private.realtime_topic_resource()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_topic text;
declare topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(
    current_topic,
    '^organization:[0-9a-fA-F-]{36}:(leads|customers|communications|work|notifications|integrations|support|administration)$'
  );
  return case when topic_match is null then null else topic_match[1] end;
exception when others then
  return null;
end;
$$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists crm_tenant_broadcast_read on realtime.messages';
    execute $policy$
      create policy crm_tenant_broadcast_read on realtime.messages
      for select to authenticated using (
        realtime.messages.extension = 'broadcast'
        and app_private.can_access_organization(app_private.realtime_topic_organization())
        and case app_private.realtime_topic_resource()
          when 'leads' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'lead.view'
          )
          when 'customers' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'customer.view'
          )
          when 'communications' then
            app_private.has_permission(
              app_private.realtime_topic_organization(), 'message.view'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'call.view'
            )
          when 'work' then
            app_private.has_permission(
              app_private.realtime_topic_organization(), 'lead.view'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'test_drive.manage'
            )
          when 'notifications' then true
          when 'integrations' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'integration.view'
          )
          when 'support' then
            app_private.has_permission(
              app_private.realtime_topic_organization(), 'support.request'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'support.approve'
            )
          when 'administration' then
            app_private.tenant_user_mode_allowed(auth.uid(), 'USER_ADMIN')
            or app_private.tenant_user_mode_allowed(
              auth.uid(), 'CLIENT_ADMIN_BOOTSTRAP'
            )
          else false
        end
      )
    $policy$;
  end if;
end $$;

drop trigger if exists realtime_profiles_administration_invalidate on public.profiles;
create trigger realtime_profiles_administration_invalidate
after insert or update on public.profiles
for each row execute function app_private.broadcast_tenant_invalidation('administration');
drop trigger if exists realtime_assignments_administration_invalidate
on public.user_role_assignments;
create trigger realtime_assignments_administration_invalidate
after insert or update on public.user_role_assignments
for each row execute function app_private.broadcast_tenant_invalidation('administration');
drop trigger if exists realtime_branch_access_administration_invalidate
on public.user_branch_access;
create trigger realtime_branch_access_administration_invalidate
after insert or update on public.user_branch_access
for each row execute function app_private.broadcast_tenant_invalidation('administration');
drop trigger if exists realtime_team_members_administration_invalidate on public.team_members;
create trigger realtime_team_members_administration_invalidate
after insert or update on public.team_members
for each row execute function app_private.broadcast_tenant_invalidation('administration');

revoke all on function public.get_tenant_user_request_result(uuid) from public, anon;
grant execute on function public.get_tenant_user_request_result(uuid) to authenticated;
revoke all on function public.get_tenant_user_admin_options(text) from public, anon;
grant execute on function public.get_tenant_user_admin_options(text) to authenticated;
revoke all on function public.get_tenant_user_workspace(
  integer, integer, text, text, uuid, uuid, text, text
) from public, anon;
grant execute on function public.get_tenant_user_workspace(
  integer, integer, text, text, uuid, uuid, text, text
) to authenticated;

revoke all on function public.provision_tenant_user(
  uuid, uuid, text, text, text, text, uuid, public.data_scope,
  uuid, uuid[], uuid[], boolean, boolean, uuid, text
) from public, anon, authenticated;
grant execute on function public.provision_tenant_user(
  uuid, uuid, text, text, text, text, uuid, public.data_scope,
  uuid, uuid[], uuid[], boolean, boolean, uuid, text
) to service_role;
revoke all on function public.update_tenant_user_administration(
  uuid, uuid, bigint, text, text, text, uuid, public.data_scope,
  uuid, uuid[], uuid[], boolean, boolean, uuid, text
) from public, anon, authenticated;
grant execute on function public.update_tenant_user_administration(
  uuid, uuid, bigint, text, text, text, uuid, public.data_scope,
  uuid, uuid[], uuid[], boolean, boolean, uuid, text
) to service_role;
revoke all on function public.record_tenant_user_invite_compensation_failure(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.record_tenant_user_invite_compensation_failure(
  uuid, uuid, uuid, text
) to service_role;

revoke all on function app_private.enforce_business_owner_user_boundary()
from public, anon, authenticated;
revoke all on function app_private.bump_profile_version()
from public, anon, authenticated;
revoke all on function app_private.can_administer_tenant_user(uuid, uuid, text)
from public, anon, authenticated;
revoke all on function app_private.assert_tenant_user_assignment(
  uuid, uuid, public.data_scope, uuid, uuid[], uuid[], text, uuid
) from public, anon, authenticated;
revoke all on function app_private.apply_tenant_user_entitlements(
  uuid, uuid, uuid, text, public.data_scope, uuid, uuid[], uuid[], boolean
) from public, anon, authenticated;
revoke all on function app_private.tenant_user_mode_allowed(uuid, text)
from public, anon, authenticated;
revoke all on function app_private.realtime_topic_organization()
from public, anon, authenticated;
revoke all on function app_private.realtime_topic_resource()
from public, anon, authenticated;

commit;
