begin;

-- Only Inventory had an executive tier. Every other operations desk had a
-- manager and nobody beneath them, so the person doing the daily work signed in
-- as a manager. These six mirror inventory_executive: authority 400, branch
-- work, and no report export.
--
-- A note on how far "operate, not approve" can go here. finance, insurance,
-- rto, exchange and delivery expose only `<module>.view` and `<module>.manage`
-- -- there is no `<module>.update` to grant instead. So an executive holds the
-- same module rights as its manager; what it does not hold is `report.export`,
-- which the report trigger grants to managers only and withholds from every
-- other role by default. Splitting `.manage` into update-versus-approve would
-- mean re-auditing every enforcement site of those permissions, and is
-- deliberately not attempted here.

alter table public.roles disable trigger enforce_role_write_security;
alter table public.role_permissions disable trigger enforce_role_permission_write_security;

insert into public.roles (
  organization_id, name, role_key, authority_level, system_role, mfa_required
)
select organization_row.id, executive.name, executive.role_key, 400, true, false
from public.organizations organization_row
cross join (values
  ('Finance Executive', 'finance_executive'),
  ('Insurance Executive', 'insurance_executive'),
  ('RTO Executive', 'rto_executive'),
  ('Used Car / Exchange Executive', 'exchange_executive'),
  ('Delivery Executive', 'delivery_executive'),
  ('Customer Relationship Executive', 'customer_relationship_executive')
) as executive(name, role_key)
where organization_row.deleted_at is null
on conflict (organization_id, role_key) do update
set name = excluded.name,
    authority_level = excluded.authority_level,
    system_role = excluded.system_role,
    mfa_required = excluded.mfa_required;

-- Exact preset. Stated as a whitelist and applied as delete-then-insert so a
-- rerun cannot leave a permission behind that this migration does not name.
create or replace function app_private.operations_executive_permissions(target_role_key text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case target_role_key
    when 'finance_executive' then array['finance.view', 'finance.manage']
    when 'insurance_executive' then array['insurance.view', 'insurance.manage']
    when 'rto_executive' then array['rto.view', 'rto.manage']
    when 'exchange_executive'
      then array['exchange.view', 'exchange.request', 'exchange.manage']
    when 'delivery_executive' then array['delivery.view', 'delivery.manage']
    when 'customer_relationship_executive' then array[]::text[]
    else array[]::text[]
  end || array['customer.view', 'document.upload', 'document.download', 'email.send']
$$;

delete from public.role_permissions role_permission_row
using public.roles role_row, public.permissions permission_row
where role_permission_row.role_id = role_row.id
  and role_permission_row.permission_id = permission_row.id
  and role_row.role_key in (
    'finance_executive', 'insurance_executive', 'rto_executive',
    'exchange_executive', 'delivery_executive', 'customer_relationship_executive'
  )
  -- report.view is granted by the report trigger and is intentionally kept.
  and permission_row.permission_key <> 'report.view'
  and not (
    permission_row.permission_key = any(
      app_private.operations_executive_permissions(role_row.role_key)
    )
  );

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.role_key in (
    'finance_executive', 'insurance_executive', 'rto_executive',
    'exchange_executive', 'delivery_executive', 'customer_relationship_executive'
  )
  and permission_row.permission_key = any(
    app_private.operations_executive_permissions(role_row.role_key)
  )
on conflict do nothing;

-- New tenants provision roles through a trigger on public.roles, so the preset
-- has to be reachable there too rather than only from this one-off backfill.
create or replace function app_private.apply_default_operations_executive_permissions()
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
  where new.role_key in (
      'finance_executive', 'insurance_executive', 'rto_executive',
      'exchange_executive', 'delivery_executive', 'customer_relationship_executive'
    )
    and permission_row.permission_key = any(
      app_private.operations_executive_permissions(new.role_key)
    )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists apply_default_operations_executive_permissions on public.roles;
create trigger apply_default_operations_executive_permissions
  after insert on public.roles
  for each row execute function app_private.apply_default_operations_executive_permissions();

-- Patch the provisioning function in place rather than restating it, so a
-- permission narrowed by a later migration is not silently restored.
do $migration$
declare
  definition text;
  updated_definition text;
  anchor constant text :=
    '(\(target_organization_id, ''Customer Relationship Manager'', ''customer_relationship_manager'', 450, true, false\),)';
begin
  select pg_catalog.pg_get_functiondef(
    'public.provision_default_roles(uuid)'::regprocedure
  ) into definition;

  if position('''finance_executive''' in definition) > 0 then
    return;
  end if;
  if substring(definition from anchor) is null then
    raise exception using
      errcode = 'P0001',
      message = 'OPERATIONS_EXECUTIVE_PROVISIONING_TARGET_NOT_FOUND';
  end if;

  updated_definition := regexp_replace(
    definition,
    anchor,
    E'\\1\n    (target_organization_id, ''Finance Executive'', ''finance_executive'', 400, true, false),'
    || E'\n    (target_organization_id, ''Insurance Executive'', ''insurance_executive'', 400, true, false),'
    || E'\n    (target_organization_id, ''RTO Executive'', ''rto_executive'', 400, true, false),'
    || E'\n    (target_organization_id, ''Used Car / Exchange Executive'', ''exchange_executive'', 400, true, false),'
    || E'\n    (target_organization_id, ''Delivery Executive'', ''delivery_executive'', 400, true, false),'
    || E'\n    (target_organization_id, ''Customer Relationship Executive'', ''customer_relationship_executive'', 400, true, false),'
  );
  if position('''finance_executive''' in updated_definition) = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'OPERATIONS_EXECUTIVE_PROVISIONING_PATCH_FAILED';
  end if;

  execute updated_definition;
end;
$migration$;

alter table public.role_permissions enable trigger enforce_role_permission_write_security;
alter table public.roles enable trigger enforce_role_write_security;

commit;
