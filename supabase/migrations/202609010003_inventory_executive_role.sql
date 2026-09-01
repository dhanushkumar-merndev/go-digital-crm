begin;

-- These guards intentionally reject anonymous SQL writes. A migration runs as
-- the database owner rather than as a tenant/service JWT, so suspend only the
-- two mutation guards inside this transaction and restore them before commit.
alter table public.roles disable trigger enforce_role_write_security;
alter table public.role_permissions disable trigger enforce_role_permission_write_security;

-- Inventory is a department, not a single manager account. The manager keeps
-- allocation and inter-branch movement authority; executives perform daily
-- intake and stock-detail maintenance inside their independently assigned
-- branch scope.
insert into public.roles (
  organization_id,
  name,
  role_key,
  authority_level,
  system_role,
  mfa_required
)
select
  organization_row.id,
  'Inventory Executive',
  'inventory_executive',
  400,
  true,
  false
from public.organizations organization_row
where organization_row.deleted_at is null
on conflict (organization_id, role_key) do update
set name = excluded.name,
    authority_level = excluded.authority_level,
    system_role = excluded.system_role,
    mfa_required = excluded.mfa_required;

-- Exact employee-level preset: operational intake/update, but no stock
-- allocation or cross-branch movement authority.
delete from public.role_permissions role_permission_row
using public.roles role_row, public.permissions permission_row
where role_permission_row.role_id = role_row.id
  and role_permission_row.permission_id = permission_row.id
  and role_row.role_key = 'inventory_executive'
  and permission_row.permission_key not in (
    'inventory.stock_check',
    'inventory.view',
    'inventory.create',
    'inventory.update',
    'document.upload',
    'document.download'
  );

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.role_key = 'inventory_executive'
  and permission_row.permission_key in (
    'inventory.stock_check',
    'inventory.view',
    'inventory.create',
    'inventory.update',
    'document.upload',
    'document.download'
  )
on conflict do nothing;

-- New or repaired system roles receive the same preset from the existing role
-- provisioning trigger. Permission checks remain the mutation boundary.
create or replace function app_private.apply_default_inventory_role_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is null or not new.system_role then
    return new;
  end if;

  insert into public.role_permissions (role_id, permission_id)
  select new.id, permission_row.id
  from public.permissions permission_row
  where (
    new.role_key in ('client_admin', 'system_administrator', 'inventory_manager')
    and permission_row.permission_key in (
      'inventory.stock_check', 'inventory.view', 'inventory.create',
      'inventory.update', 'inventory.move', 'inventory.allocate'
    )
  ) or (
    new.role_key = 'inventory_executive'
    and permission_row.permission_key in (
      'inventory.stock_check', 'inventory.view', 'inventory.create',
      'inventory.update', 'document.upload', 'document.download'
    )
  ) or (
    new.role_key = 'sales_consultant'
    and permission_row.permission_key = 'inventory.stock_check'
  )
  on conflict do nothing;

  return new;
end;
$$;

-- Keep future tenant provisioning aligned without copying the whole function
-- and accidentally restoring a permission narrowed by a later migration.
do $migration$
declare
  definition text;
  updated_definition text;
  manager_row_pattern constant text :=
    '(\(target_organization_id, ''Inventory Manager'', ''inventory_manager'', 450, true, false\),)';
begin
  select pg_catalog.pg_get_functiondef(
    'public.provision_default_roles(uuid)'::regprocedure
  ) into definition;

  if position('''inventory_executive''' in definition) > 0 then
    return;
  end if;
  if substring(definition from manager_row_pattern) is null then
    raise exception using
      errcode = 'P0001',
      message = 'INVENTORY_EXECUTIVE_PROVISIONING_TARGET_NOT_FOUND';
  end if;

  updated_definition := regexp_replace(
    definition,
    manager_row_pattern,
    E'\\1\n    (target_organization_id, ''Inventory Executive'', ''inventory_executive'', 400, true, false),'
  );
  if position('''inventory_executive''' in updated_definition) = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'INVENTORY_EXECUTIVE_PROVISIONING_PATCH_FAILED';
  end if;

  execute updated_definition;
end;
$migration$;

alter table public.role_permissions enable trigger enforce_role_permission_write_security;
alter table public.roles enable trigger enforce_role_write_security;

commit;
