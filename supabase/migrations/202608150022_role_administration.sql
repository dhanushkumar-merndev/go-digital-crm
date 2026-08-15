begin;

alter table public.roles
  add column if not exists updated_at timestamptz not null default now();

create index if not exists roles_org_created_idx
  on public.roles (organization_id, created_at desc, id desc)
  where organization_id is not null;

create or replace function public.get_role_administration_page(
  search_term text default null,
  role_filter text default 'all',
  page_size integer default 25,
  page_offset integer default 0,
  sort_key text default 'authority_desc'
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
  normalized_search text := nullif(btrim(coalesce(search_term, '')), '');
  result_payload jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'ROLE_ADMINISTRATION_ACCESS_REQUIRED';
  end if;
  if char_length(coalesce(normalized_search, '')) > 100
    or role_filter not in ('all', 'system', 'custom', 'mfa')
    or page_size not in (25, 50, 100)
    or page_offset < 0
    or page_offset > 1000000
    or sort_key not in ('authority_desc', 'name_asc', 'created_desc')
  then
    raise exception using errcode = '22023', message = 'INVALID_ROLE_ADMINISTRATION_QUERY';
  end if;

  select profile_row.organization_id
  into actor_organization_id
  from public.profiles profile_row
  where profile_row.id = actor_id
    and profile_row.active
    and profile_row.deleted_at is null;
  if actor_organization_id is null
    or not app_private.mfa_policy_satisfied(actor_organization_id)
    or not app_private.has_permission(actor_organization_id, 'role.manage')
  then
    raise exception using errcode = '42501', message = 'ROLE_ADMINISTRATION_ACCESS_REQUIRED';
  end if;

  select max(role_row.authority_level)
  into actor_authority
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  join public.role_permissions role_permission_row
    on role_permission_row.role_id = role_row.id
  join public.permissions permission_row
    on permission_row.id = role_permission_row.permission_id
   and permission_row.permission_key = 'role.manage'
  where assignment_row.organization_id = actor_organization_id
    and assignment_row.user_id = actor_id
    and assignment_row.active;
  if actor_authority is null then
    raise exception using errcode = '42501', message = 'ROLE_ADMINISTRATION_ACCESS_REQUIRED';
  end if;

  with role_rows as (
    select
      role_row.id,
      role_row.name,
      role_row.role_key,
      role_row.authority_level,
      role_row.system_role,
      role_row.mfa_required,
      role_row.created_at,
      role_row.updated_at,
      coalesce((
        select jsonb_agg(permission_row.permission_key order by permission_row.permission_key)
        from public.role_permissions role_permission_row
        join public.permissions permission_row
          on permission_row.id = role_permission_row.permission_id
        where role_permission_row.role_id = role_row.id
      ), '[]'::jsonb) as permissions,
      (
        select count(distinct assignment_row.user_id)
        from public.user_role_assignments assignment_row
        where assignment_row.role_id = role_row.id
          and assignment_row.active
      ) as assigned_users,
      (not role_row.system_role and role_row.authority_level < actor_authority) as can_edit
    from public.roles role_row
    where role_row.organization_id = actor_organization_id
  ),
  filtered_rows as (
    select role_row.*
    from role_rows role_row
    where (
      role_filter = 'all'
      or (role_filter = 'system' and role_row.system_role)
      or (role_filter = 'custom' and not role_row.system_role)
      or (role_filter = 'mfa' and role_row.mfa_required)
    )
      and (
        normalized_search is null
        or position(lower(normalized_search) in lower(role_row.name)) > 0
        or position(lower(normalized_search) in lower(role_row.role_key)) > 0
      )
  ),
  page_rows as (
    select filtered_row.*
    from filtered_rows filtered_row
    order by
      case when sort_key = 'authority_desc' then filtered_row.authority_level end desc,
      case when sort_key = 'name_asc' then lower(filtered_row.name) end asc,
      case when sort_key = 'created_desc' then filtered_row.created_at end desc,
      filtered_row.id
    limit page_size
    offset page_offset
  ),
  page_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', page_row.id,
          'name', page_row.name,
          'role_key', page_row.role_key,
          'authority_level', page_row.authority_level,
          'system_role', page_row.system_role,
          'mfa_required', page_row.mfa_required,
          'permissions', page_row.permissions,
          'assigned_users', page_row.assigned_users,
          'can_edit', page_row.can_edit,
          'created_at', page_row.created_at,
          'updated_at', page_row.updated_at
        )
        order by
          case when sort_key = 'authority_desc' then page_row.authority_level end desc,
          case when sort_key = 'name_asc' then lower(page_row.name) end asc,
          case when sort_key = 'created_desc' then page_row.created_at end desc,
          page_row.id
      ),
      '[]'::jsonb
    ) as records
    from page_rows page_row
  ),
  kpi_payload as (
    select jsonb_build_object(
      'total_roles', count(*),
      'custom_roles', count(*) filter (where not role_row.system_role),
      'mfa_roles', count(*) filter (where role_row.mfa_required),
      'assigned_users', coalesce(sum(role_row.assigned_users), 0)
    ) as kpis
    from role_rows role_row
  )
  select jsonb_build_object(
    'records', page_payload.records,
    'total', (select count(*) from filtered_rows),
    'kpis', kpi_payload.kpis,
    'viewer', jsonb_build_object(
      'organization_id', actor_organization_id,
      'authority_ceiling', actor_authority,
      'can_manage', true
    )
  )
  into result_payload
  from page_payload
  cross join kpi_payload;

  return result_payload;
end;
$$;

create or replace function public.list_delegable_role_permissions()
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
declare actor_organization_id uuid;
begin
  select profile_row.organization_id
  into actor_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if actor_organization_id is null
    or not app_private.mfa_policy_satisfied(actor_organization_id)
    or not app_private.has_permission(actor_organization_id, 'role.manage')
  then
    raise exception using errcode = '42501', message = 'ROLE_ADMINISTRATION_ACCESS_REQUIRED';
  end if;

  return query
  select distinct permission_row.permission_key, permission_row.module, permission_row.description
  from public.user_role_assignments assignment_row
  join public.role_permissions role_permission_row
    on role_permission_row.role_id = assignment_row.role_id
  join public.permissions permission_row
    on permission_row.id = role_permission_row.permission_id
  where assignment_row.organization_id = actor_organization_id
    and assignment_row.user_id = auth.uid()
    and assignment_row.active
  order by permission_row.module, permission_row.permission_key;
end;
$$;

create or replace function public.save_delegated_role(
  target_role_id uuid,
  expected_updated_at timestamptz,
  target_role_name text,
  target_role_key text,
  target_authority_level integer,
  target_require_mfa boolean,
  target_permission_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_organization_id uuid;
  actor_authority integer;
  normalized_name text := btrim(coalesce(target_role_name, ''));
  normalized_key text := lower(btrim(coalesce(target_role_key, '')));
  normalized_permissions text[];
  role_row public.roles%rowtype;
  removed_permission record;
begin
  select profile_row.organization_id
  into actor_organization_id
  from public.profiles profile_row
  where profile_row.id = actor_id
    and profile_row.active
    and profile_row.deleted_at is null;
  if actor_id is null
    or actor_organization_id is null
    or not app_private.mfa_policy_satisfied(actor_organization_id)
    or not app_private.has_permission(actor_organization_id, 'role.manage')
  then
    raise exception using errcode = '42501', message = 'ROLE_ADMINISTRATION_ACCESS_REQUIRED';
  end if;

  select max(actor_role.authority_level)
  into actor_authority
  from public.user_role_assignments actor_assignment
  join public.roles actor_role
    on actor_role.id = actor_assignment.role_id
   and actor_role.organization_id = actor_assignment.organization_id
  join public.role_permissions actor_role_permission
    on actor_role_permission.role_id = actor_role.id
  join public.permissions actor_permission
    on actor_permission.id = actor_role_permission.permission_id
   and actor_permission.permission_key = 'role.manage'
  where actor_assignment.organization_id = actor_organization_id
    and actor_assignment.user_id = actor_id
    and actor_assignment.active;
  if actor_authority is null then
    raise exception using errcode = '42501', message = 'ROLE_ADMINISTRATION_ACCESS_REQUIRED';
  end if;

  select array_agg(distinct btrim(permission_key) order by btrim(permission_key))
  into normalized_permissions
  from unnest(coalesce(target_permission_keys, '{}'::text[])) permission_key
  where nullif(btrim(permission_key), '') is not null;

  if char_length(normalized_name) not between 2 and 100
    or normalized_key !~ '^custom_[a-z0-9]+(?:_[a-z0-9]+)*$'
    or char_length(normalized_key) not between 9 and 63
    or normalized_name ilike '%team leader%'
    or normalized_key like '%team_leader%'
    or target_authority_level not between 1 and actor_authority - 1
    or coalesce(cardinality(normalized_permissions), 0) not between 1 and 50
  then
    raise exception using errcode = '22023', message = 'INVALID_DELEGATED_ROLE';
  end if;
  if exists (
    select 1
    from unnest(normalized_permissions) requested_permission(permission_key)
    where not exists (
      select 1
      from public.user_role_assignments actor_assignment
      join public.role_permissions actor_role_permission
        on actor_role_permission.role_id = actor_assignment.role_id
      join public.permissions actor_permission
        on actor_permission.id = actor_role_permission.permission_id
      where actor_assignment.organization_id = actor_organization_id
        and actor_assignment.user_id = actor_id
        and actor_assignment.active
        and actor_permission.permission_key = requested_permission.permission_key
    )
  ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DELEGATION_CEILING_EXCEEDED';
  end if;
  if exists (
    select 1
    from unnest(normalized_permissions) requested_permission(permission_key)
    left join public.permissions permission_row
      on permission_row.permission_key = requested_permission.permission_key
    where permission_row.id is null
  ) then
    raise exception using errcode = '22023', message = 'UNKNOWN_PERMISSION';
  end if;

  if target_role_id is null then
    insert into public.roles (
      organization_id,
      name,
      role_key,
      authority_level,
      system_role,
      mfa_required,
      updated_at
    ) values (
      actor_organization_id,
      normalized_name,
      normalized_key,
      target_authority_level,
      false,
      coalesce(target_require_mfa, false),
      now()
    )
    returning * into role_row;
  else
    select *
    into role_row
    from public.roles existing_role
    where existing_role.id = target_role_id
      and existing_role.organization_id = actor_organization_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'ROLE_NOT_FOUND';
    end if;
    if role_row.system_role
      or role_row.role_key <> normalized_key
      or expected_updated_at is null
      or role_row.updated_at <> expected_updated_at
    then
      raise exception using errcode = '40001', message = 'ROLE_VERSION_CONFLICT';
    end if;

    update public.roles
    set name = normalized_name,
        authority_level = target_authority_level,
        mfa_required = coalesce(target_require_mfa, false),
        updated_at = now()
    where id = role_row.id
    returning * into role_row;
  end if;

  for removed_permission in
    select permission_row.id, permission_row.permission_key
    from public.role_permissions role_permission_row
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
    where role_permission_row.role_id = role_row.id
      and not (permission_row.permission_key = any(normalized_permissions))
  loop
    delete from public.role_permissions
    where role_id = role_row.id
      and permission_id = removed_permission.id;
    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, metadata
    ) values (
      actor_organization_id,
      actor_id,
      'role.permission.revoked',
      'role',
      role_row.id::text,
      jsonb_build_object('permission_key', removed_permission.permission_key)
    );
  end loop;

  insert into public.role_permissions (role_id, permission_id)
  select role_row.id, permission_row.id
  from public.permissions permission_row
  where permission_row.permission_key = any(normalized_permissions)
    and not exists (
      select 1
      from public.role_permissions existing_permission
      where existing_permission.role_id = role_row.id
        and existing_permission.permission_id = permission_row.id
    );

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    actor_organization_id,
    actor_id,
    'role.permission_set.saved',
    'role',
    role_row.id::text,
    jsonb_build_object(
      'permission_count', cardinality(normalized_permissions),
      'authority_level', role_row.authority_level,
      'mfa_required', role_row.mfa_required
    )
  );

  return jsonb_build_object(
    'id', role_row.id,
    'name', role_row.name,
    'role_key', role_row.role_key,
    'authority_level', role_row.authority_level,
    'mfa_required', role_row.mfa_required,
    'permissions', to_jsonb(normalized_permissions),
    'updated_at', role_row.updated_at
  );
end;
$$;

drop policy if exists roles_insert on public.roles;
drop policy if exists roles_update on public.roles;
drop policy if exists role_permissions_insert on public.role_permissions;

drop trigger if exists realtime_roles_administration_invalidate on public.roles;
create trigger realtime_roles_administration_invalidate
after insert or update on public.roles
for each row execute function app_private.broadcast_tenant_invalidation('administration');

revoke all on function public.get_role_administration_page(text, text, integer, integer, text)
from public, anon;
grant execute on function public.get_role_administration_page(text, text, integer, integer, text)
to authenticated;
revoke all on function public.list_delegable_role_permissions()
from public, anon;
grant execute on function public.list_delegable_role_permissions()
to authenticated;
revoke all on function public.save_delegated_role(uuid, timestamptz, text, text, integer, boolean, text[])
from public, anon;
grant execute on function public.save_delegated_role(uuid, timestamptz, text, text, integer, boolean, text[])
to authenticated;

commit;
