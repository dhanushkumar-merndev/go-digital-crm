begin;

-- Inventory permissions separate aggregate sales availability from physical
-- vehicle identity and each mutation authority.
insert into public.permissions (permission_key, module, description) values
  ('inventory.stock_check', 'inventory', 'View aggregate stock availability in authorized branches'),
  ('inventory.view', 'inventory', 'View VIN-level inventory, movement and allocation records in authorized branches'),
  ('inventory.create', 'inventory', 'Intake a physical stock unit in an authorized branch'),
  ('inventory.update', 'inventory', 'Update permitted stock metadata and lifecycle status'),
  ('inventory.move', 'inventory', 'Move stock between mutually authorized branches'),
  ('inventory.allocate', 'inventory', 'Allocate and release stock without mutating booking lifecycle')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.system_role
  and (
    (
      role_row.role_key in ('client_admin', 'system_administrator', 'inventory_manager')
      and permission_row.permission_key in (
        'inventory.stock_check', 'inventory.view', 'inventory.create',
        'inventory.update', 'inventory.move', 'inventory.allocate'
      )
    )
    or (
      role_row.role_key = 'sales_consultant'
      and permission_row.permission_key = 'inventory.stock_check'
    )
  )
on conflict do nothing;

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
    new.role_key = 'sales_consultant'
    and permission_row.permission_key = 'inventory.stock_check'
  )
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists roles_apply_default_inventory_permissions on public.roles;
create trigger roles_apply_default_inventory_permissions
after insert or update of role_key, system_role on public.roles
for each row execute function app_private.apply_default_inventory_role_permissions();

create or replace function app_private.normalize_inventory_identifier(target_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(pg_catalog.regexp_replace(btrim(coalesce(target_value, '')), '[^A-Za-z0-9]', '', 'g'));
$$;

alter table public.stock_units
  add column normalized_vin text generated always as (
    app_private.normalize_inventory_identifier(vin)
  ) stored,
  add column normalized_chassis_number text generated always as (
    app_private.normalize_inventory_identifier(chassis_number)
  ) stored,
  add column normalized_engine_number text generated always as (
    app_private.normalize_inventory_identifier(engine_number)
  ) stored,
  add column version bigint not null default 1 check (version > 0),
  add column created_by uuid references public.profiles(id),
  add column updated_by uuid references public.profiles(id),
  add column deleted_by uuid references public.profiles(id),
  add column deletion_reason text;

alter table public.stock_allocations
  add column version bigint not null default 1 check (version > 0),
  add column released_at timestamptz,
  add column released_by uuid references public.profiles(id),
  add column release_reason text,
  add column updated_at timestamptz not null default now();

alter table public.stock_units
  add constraint stock_units_vin_format
  check (normalized_vin ~ '^[A-HJ-NPR-Z0-9]{17}$') not valid,
  add constraint stock_units_chassis_format
  check (normalized_chassis_number ~ '^[A-Z0-9]{6,32}$') not valid,
  add constraint stock_units_engine_format
  check (
    engine_number is null
    or normalized_engine_number ~ '^[A-Z0-9]{4,32}$'
  ) not valid,
  add constraint stock_units_color_size
  check (color is null or char_length(color) between 1 and 80) not valid,
  add constraint stock_units_status_values
  check (status in (
    'INCOMING', 'AVAILABLE', 'RESERVED', 'ALLOCATED', 'IN_TRANSIT',
    'HOLD', 'READY_FOR_DELIVERY', 'DELIVERED'
  )) not valid,
  add constraint stock_units_deletion_metadata
  check (
    (deleted_at is null and deleted_by is null and deletion_reason is null)
    or (
      deleted_at is not null
      and deleted_by is not null
      and char_length(btrim(deletion_reason)) between 5 and 1000
    )
  ) not valid;

alter table public.stock_movements
  add constraint stock_movements_type_values
  check (movement_type in (
    'INTAKE', 'DETAIL_UPDATE', 'STATUS_CHANGE', 'BRANCH_TRANSFER',
    'ALLOCATION', 'ALLOCATION_RELEASE'
  )) not valid,
  add constraint stock_movements_reason_size
  check (reason is null or char_length(reason) <= 1000) not valid;

alter table public.stock_allocations
  add constraint stock_allocations_status_values
  check (status in (
    'ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED',
    'ON_HOLD', 'RELEASED', 'CANCELLED'
  )) not valid,
  add constraint stock_allocations_release_metadata
  check (
    (status not in ('RELEASED', 'CANCELLED'))
    or (
      released_at is not null
      and released_by is not null
      and char_length(btrim(release_reason)) between 5 and 1000
    )
  ) not valid;

-- Normalized vehicle identities are tenant-unique. Existing exact-case
-- constraints remain as defense in depth.
create unique index stock_units_org_normalized_vin_unique_idx
  on public.stock_units (organization_id, normalized_vin);
create unique index stock_units_org_normalized_chassis_unique_idx
  on public.stock_units (organization_id, normalized_chassis_number);
create unique index vehicle_brands_org_id_unique_idx
  on public.vehicle_brands (organization_id, id);
create unique index vehicle_models_org_id_unique_idx
  on public.vehicle_models (organization_id, id);
create unique index vehicle_variants_org_id_unique_idx
  on public.vehicle_variants (organization_id, id);
create unique index stock_units_org_id_unique_idx
  on public.stock_units (organization_id, id);
create unique index bookings_org_id_unique_idx
  on public.bookings (organization_id, id);

create index stock_units_org_status_received_page_idx
  on public.stock_units (organization_id, status, received_at desc, id)
  where deleted_at is null;
create index stock_units_org_branch_received_page_idx
  on public.stock_units (organization_id, branch_id, received_at desc, id)
  where deleted_at is null;
create index stock_units_org_variant_status_idx
  on public.stock_units (organization_id, variant_id, status, branch_id)
  where deleted_at is null;
create index stock_units_org_vin_prefix_idx
  on public.stock_units (organization_id, normalized_vin text_pattern_ops)
  where deleted_at is null;
create index stock_units_org_chassis_prefix_idx
  on public.stock_units (organization_id, normalized_chassis_number text_pattern_ops)
  where deleted_at is null;
create index stock_units_org_engine_prefix_idx
  on public.stock_units (organization_id, normalized_engine_number text_pattern_ops)
  where deleted_at is null and engine_number is not null;
create index stock_movements_org_moved_page_idx
  on public.stock_movements (organization_id, moved_at desc, id);
create index stock_movements_org_stock_moved_idx
  on public.stock_movements (organization_id, stock_unit_id, moved_at desc, id);
create index stock_allocations_org_status_page_idx
  on public.stock_allocations (organization_id, status, allocated_at desc, id);
create index stock_allocations_org_branch_page_idx
  on public.stock_allocations (organization_id, branch_id, allocated_at desc, id);
create unique index stock_allocations_active_stock_unique_idx
  on public.stock_allocations (organization_id, stock_unit_id)
  where status in ('ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED', 'ON_HOLD');
create unique index stock_allocations_active_booking_unique_idx
  on public.stock_allocations (organization_id, booking_id)
  where booking_id is not null
    and status in ('ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED', 'ON_HOLD');
create unique index inventory_mutation_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action like 'inventory.%';

alter table public.vehicle_models
  add constraint vehicle_models_brand_org_fk
  foreign key (organization_id, brand_id)
  references public.vehicle_brands (organization_id, id) not valid;
alter table public.vehicle_variants
  add constraint vehicle_variants_model_org_fk
  foreign key (organization_id, model_id)
  references public.vehicle_models (organization_id, id) not valid;
alter table public.stock_units
  add constraint stock_units_branch_org_fk
  foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid,
  add constraint stock_units_variant_org_fk
  foreign key (organization_id, variant_id)
  references public.vehicle_variants (organization_id, id) not valid,
  add constraint stock_units_created_by_org_fk
  foreign key (organization_id, created_by)
  references public.profiles (organization_id, id) not valid,
  add constraint stock_units_updated_by_org_fk
  foreign key (organization_id, updated_by)
  references public.profiles (organization_id, id) not valid,
  add constraint stock_units_deleted_by_org_fk
  foreign key (organization_id, deleted_by)
  references public.profiles (organization_id, id) not valid;
alter table public.stock_movements
  add constraint stock_movements_unit_org_fk
  foreign key (organization_id, stock_unit_id)
  references public.stock_units (organization_id, id) not valid,
  add constraint stock_movements_from_branch_org_fk
  foreign key (organization_id, from_branch_id)
  references public.branches (organization_id, id) not valid,
  add constraint stock_movements_to_branch_org_fk
  foreign key (organization_id, to_branch_id)
  references public.branches (organization_id, id) not valid,
  add constraint stock_movements_actor_org_fk
  foreign key (organization_id, moved_by)
  references public.profiles (organization_id, id) not valid;
alter table public.stock_allocations
  add constraint stock_allocations_unit_org_fk
  foreign key (organization_id, stock_unit_id)
  references public.stock_units (organization_id, id) not valid,
  add constraint stock_allocations_branch_org_fk
  foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid,
  add constraint stock_allocations_booking_org_fk
  foreign key (organization_id, booking_id)
  references public.bookings (organization_id, id) not valid,
  add constraint stock_allocations_actor_org_fk
  foreign key (organization_id, allocated_by)
  references public.profiles (organization_id, id) not valid,
  add constraint stock_allocations_releaser_org_fk
  foreign key (organization_id, released_by)
  references public.profiles (organization_id, id) not valid;

-- Preserve the branch at which an allocation was made while proving that new
-- allocation links point to a stock unit and booking in that same branch.
-- Released history may remain at its original branch if the unit later moves.
create or replace function app_private.validate_stock_allocation_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.stock_units stock_row
    where stock_row.organization_id = new.organization_id
      and stock_row.id = new.stock_unit_id
      and stock_row.branch_id = new.branch_id
  ) then
    raise exception using errcode = '23514', message = 'STOCK_ALLOCATION_BRANCH_MISMATCH';
  end if;
  if new.booking_id is not null and not exists (
    select 1
    from public.bookings booking_row
    where booking_row.organization_id = new.organization_id
      and booking_row.id = new.booking_id
      and booking_row.branch_id = new.branch_id
  ) then
    raise exception using errcode = '23514', message = 'BOOKING_ALLOCATION_BRANCH_MISMATCH';
  end if;
  return new;
end;
$$;

drop trigger if exists stock_allocations_validate_scope on public.stock_allocations;
create trigger stock_allocations_validate_scope
before insert or update of organization_id, branch_id, stock_unit_id, booking_id
on public.stock_allocations
for each row execute function app_private.validate_stock_allocation_scope();

create or replace function app_private.can_access_inventory_unit(
  target_organization_id uuid,
  target_stock_unit_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.has_permission(target_organization_id, 'inventory.view')
    and exists (
      select 1
      from public.stock_units stock_row
      where stock_row.organization_id = target_organization_id
        and stock_row.id = target_stock_unit_id
        and stock_row.deleted_at is null
        and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
    );
$$;

drop policy if exists vehicle_brands_inventory_read on public.vehicle_brands;
create policy vehicle_brands_inventory_read on public.vehicle_brands
for select to authenticated using (
  app_private.can_access_organization(organization_id)
  and (
    app_private.has_permission(organization_id, 'inventory.view')
    or app_private.has_permission(organization_id, 'inventory.stock_check')
  )
);
drop policy if exists vehicle_models_inventory_read on public.vehicle_models;
create policy vehicle_models_inventory_read on public.vehicle_models
for select to authenticated using (
  app_private.can_access_organization(organization_id)
  and (
    app_private.has_permission(organization_id, 'inventory.view')
    or app_private.has_permission(organization_id, 'inventory.stock_check')
  )
);
drop policy if exists vehicle_variants_inventory_read on public.vehicle_variants;
create policy vehicle_variants_inventory_read on public.vehicle_variants
for select to authenticated using (
  app_private.can_access_organization(organization_id)
  and (
    app_private.has_permission(organization_id, 'inventory.view')
    or app_private.has_permission(organization_id, 'inventory.stock_check')
  )
);
drop policy if exists stock_units_inventory_read on public.stock_units;
create policy stock_units_inventory_read on public.stock_units
for select to authenticated using (
  app_private.can_access_inventory_unit(organization_id, id)
);
drop policy if exists stock_movements_inventory_read on public.stock_movements;
create policy stock_movements_inventory_read on public.stock_movements
for select to authenticated using (
  app_private.has_permission(organization_id, 'inventory.view')
  and (
    (from_branch_id is not null and app_private.can_access_branch(organization_id, from_branch_id))
    or (to_branch_id is not null and app_private.can_access_branch(organization_id, to_branch_id))
    or app_private.can_access_inventory_unit(organization_id, stock_unit_id)
  )
);
drop policy if exists stock_allocations_inventory_read on public.stock_allocations;
create policy stock_allocations_inventory_read on public.stock_allocations
for select to authenticated using (
  app_private.has_permission(organization_id, 'inventory.view')
  and app_private.can_access_branch(organization_id, branch_id)
  and app_private.can_access_inventory_unit(organization_id, stock_unit_id)
);

revoke insert, update, delete on public.vehicle_brands from anon, authenticated;
revoke insert, update, delete on public.vehicle_models from anon, authenticated;
revoke insert, update, delete on public.vehicle_variants from anon, authenticated;
revoke insert, update, delete on public.stock_units from anon, authenticated;
revoke insert, update, delete on public.stock_movements from anon, authenticated;
revoke insert, update, delete on public.stock_allocations from anon, authenticated;

-- Reuse the tenant-private Realtime invalidation channel; payloads carry only
-- resource/action identifiers and clients always refetch through scoped RPCs.
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
    '^organization:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):(leads|customers|communications|work|notifications|integrations|support|administration|inventory)$'
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
    '^organization:[0-9a-fA-F-]{36}:(leads|customers|communications|work|notifications|integrations|support|administration|inventory)$'
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
            app_private.has_permission(app_private.realtime_topic_organization(), 'message.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'call.view')
          when 'work' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'lead.view')
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'test_drive.manage'
            )
          when 'notifications' then true
          when 'integrations' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'integration.view'
          )
          when 'support' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'support.request')
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'support.approve'
            )
          when 'administration' then
            app_private.tenant_user_mode_allowed(auth.uid(), 'CLIENT_ADMIN_BOOTSTRAP')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'branch.manage')
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'team.manage'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'user.manage'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'role.manage'
            )
          when 'inventory' then
            app_private.has_permission(
              app_private.realtime_topic_organization(), 'inventory.view'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'inventory.stock_check'
            )
          else false
        end
      )
    $policy$;
  end if;
end $$;

drop trigger if exists realtime_stock_units_invalidate on public.stock_units;
create trigger realtime_stock_units_invalidate
after insert or update on public.stock_units
for each row execute function app_private.broadcast_tenant_invalidation('inventory');
drop trigger if exists realtime_stock_movements_invalidate on public.stock_movements;
create trigger realtime_stock_movements_invalidate
after insert or update on public.stock_movements
for each row execute function app_private.broadcast_tenant_invalidation('inventory');
drop trigger if exists realtime_stock_allocations_invalidate on public.stock_allocations;
create trigger realtime_stock_allocations_invalidate
after insert or update on public.stock_allocations
for each row execute function app_private.broadcast_tenant_invalidation('inventory');

create or replace function app_private.inventory_request_fingerprint(payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(coalesce(payload, '{}'::jsonb)::text, 'UTF8')),
    'hex'
  );
$$;

create or replace function app_private.inventory_idempotent_replay(
  target_organization_id uuid,
  target_action text,
  target_request_id uuid,
  target_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare previous_action text;
declare previous_metadata jsonb;
begin
  select audit_row.action, audit_row.metadata
  into previous_action, previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action like 'inventory.%'
  limit 1;

  if previous_action is null then
    return null;
  end if;
  if previous_action <> target_action
    or previous_metadata->>'fingerprint' is distinct from target_fingerprint
  then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return coalesce(previous_metadata->'result', '{}'::jsonb)
    || jsonb_build_object('replayed', true);
end;
$$;

create or replace function public.get_inventory_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.view')
  then
    raise exception using errcode = '42501', message = 'INVENTORY_VIEW_REQUIRED';
  end if;

  with scoped_units as materialized (
    select
      stock_row.id,
      stock_row.branch_id,
      stock_row.variant_id,
      stock_row.status,
      greatest(
        0,
        current_date - coalesce(stock_row.received_at::date, stock_row.created_at::date)
      )::integer as days_in_stock,
      branch_row.name as branch_name,
      model_row.name as model_name
    from public.stock_units stock_row
    join public.branches branch_row
      on branch_row.organization_id = stock_row.organization_id
     and branch_row.id = stock_row.branch_id
     and branch_row.deleted_at is null
    join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = stock_row.organization_id
     and model_row.id = variant_row.model_id
    where stock_row.organization_id = current_organization_id
      and stock_row.deleted_at is null
      and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
  ), model_rows as (
    select
      scoped_row.model_name as name,
      count(*) filter (where scoped_row.status <> 'DELIVERED')::integer as value
    from scoped_units scoped_row
    group by scoped_row.model_name
    having count(*) filter (where scoped_row.status <> 'DELIVERED') > 0
    order by value desc, scoped_row.model_name
    limit 8
  ), branch_rows as (
    select
      scoped_row.branch_name as name,
      count(*) filter (where scoped_row.status <> 'DELIVERED')::integer as value,
      count(*) filter (where scoped_row.status = 'AVAILABLE')::integer as secondary
    from scoped_units scoped_row
    group by scoped_row.branch_name
    order by value desc, scoped_row.branch_name
    limit 12
  ), variant_availability as (
    select
      scoped_row.variant_id,
      count(*) filter (where scoped_row.status = 'AVAILABLE') as available_units
    from scoped_units scoped_row
    group by scoped_row.variant_id
  )
  select jsonb_build_object(
    'kpis', jsonb_build_object(
      'total_stock', count(*) filter (where scoped_row.status <> 'DELIVERED'),
      'available', count(*) filter (where scoped_row.status = 'AVAILABLE'),
      'reserved', count(*) filter (where scoped_row.status = 'RESERVED'),
      'allocated', count(*) filter (where scoped_row.status = 'ALLOCATED'),
      'in_transit', count(*) filter (where scoped_row.status = 'IN_TRANSIT'),
      'ageing_stock', count(*) filter (
        where scoped_row.status <> 'DELIVERED' and scoped_row.days_in_stock > 60
      ),
      'ready_for_delivery', count(*) filter (
        where scoped_row.status = 'READY_FOR_DELIVERY'
      ),
      'low_stock_models', (
        select count(*) from variant_availability where available_units between 0 and 2
      )
    ),
    'model_distribution', coalesce((
      select jsonb_agg(
        jsonb_build_object('name', model_row.name, 'value', model_row.value)
        order by model_row.value desc, model_row.name
      ) from model_rows model_row
    ), '[]'::jsonb),
    'branch_distribution', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', branch_row.name,
          'value', branch_row.value,
          'secondary', branch_row.secondary
        ) order by branch_row.value desc, branch_row.name
      ) from branch_rows branch_row
    ), '[]'::jsonb),
    'attention', jsonb_build_object(
      'ageing_90_plus', count(*) filter (
        where scoped_row.status <> 'DELIVERED' and scoped_row.days_in_stock > 90
      ),
      'on_hold', count(*) filter (where scoped_row.status = 'HOLD'),
      'incoming', count(*) filter (where scoped_row.status = 'INCOMING'),
      'allocation_pending', (
        select count(*)
        from public.stock_allocations allocation_row
        where allocation_row.organization_id = current_organization_id
          and allocation_row.status in ('ACTIVE', 'PENDING', 'SUGGESTED')
          and app_private.can_access_branch(
            allocation_row.organization_id,
            allocation_row.branch_id
          )
      )
    )
  ) into result
  from scoped_units scoped_row;

  return result;
end;
$$;

revoke all on function public.get_inventory_dashboard() from public, anon;
grant execute on function public.get_inventory_dashboard() to authenticated;

create or replace function public.get_stock_unit_page(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_status text default 'ALL',
  target_branch_id uuid default null,
  target_age text default 'ALL',
  target_sort text default 'received:desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare normalized_search text;
declare identifier_search text;
declare normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
declare normalized_age text := upper(btrim(coalesce(target_age, 'ALL')));
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_status not in (
    'ALL', 'INCOMING', 'AVAILABLE', 'RESERVED', 'ALLOCATED', 'IN_TRANSIT',
    'HOLD', 'READY_FOR_DELIVERY', 'DELIVERED'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_STATUS_FILTER';
  end if;
  if normalized_age not in ('ALL', '0_30', '31_60', '61_90', '90_PLUS') then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_AGE_FILTER';
  end if;
  if target_sort not in (
    'received:desc', 'received:asc', 'age:desc', 'vin:asc',
    'model:asc', 'status:asc', 'updated:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_SORT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 100 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  identifier_search := app_private.normalize_inventory_identifier(normalized_search);

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.view')
  then
    raise exception using errcode = '42501', message = 'INVENTORY_VIEW_REQUIRED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;

  with scoped_units as materialized (
    select
      stock_row.id,
      stock_row.organization_id,
      stock_row.branch_id,
      stock_row.variant_id,
      stock_row.vin,
      stock_row.chassis_number,
      stock_row.engine_number,
      stock_row.color,
      stock_row.status,
      stock_row.received_at,
      stock_row.created_at,
      stock_row.updated_at,
      stock_row.version,
      stock_row.normalized_vin,
      stock_row.normalized_chassis_number,
      stock_row.normalized_engine_number,
      greatest(
        0,
        current_date - coalesce(stock_row.received_at::date, stock_row.created_at::date)
      )::integer as days_in_stock,
      branch_row.name as branch_name,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name
    from public.stock_units stock_row
    join public.branches branch_row
      on branch_row.organization_id = stock_row.organization_id
     and branch_row.id = stock_row.branch_id
     and branch_row.deleted_at is null
    join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = stock_row.organization_id
     and model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row
      on brand_row.organization_id = stock_row.organization_id
     and brand_row.id = model_row.brand_id
    where stock_row.organization_id = current_organization_id
      and stock_row.deleted_at is null
      and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
  ), filtered_units as materialized (
    select scoped_row.*
    from scoped_units scoped_row
    where (normalized_status = 'ALL' or scoped_row.status = normalized_status)
      and (target_branch_id is null or scoped_row.branch_id = target_branch_id)
      and (
        normalized_age = 'ALL'
        or (normalized_age = '0_30' and scoped_row.days_in_stock between 0 and 30)
        or (normalized_age = '31_60' and scoped_row.days_in_stock between 31 and 60)
        or (normalized_age = '61_90' and scoped_row.days_in_stock between 61 and 90)
        or (normalized_age = '90_PLUS' and scoped_row.days_in_stock > 90)
      )
      and (
        normalized_search = ''
        or (
          identifier_search <> ''
          and (
            scoped_row.normalized_vin like identifier_search || '%'
            or scoped_row.normalized_chassis_number like identifier_search || '%'
            or scoped_row.normalized_engine_number like identifier_search || '%'
          )
        )
        or lower(scoped_row.brand_name) like '%' || normalized_search || '%'
        or lower(scoped_row.model_name) like '%' || normalized_search || '%'
        or lower(scoped_row.variant_name) like '%' || normalized_search || '%'
        or lower(coalesce(scoped_row.color, '')) like '%' || normalized_search || '%'
      )
  ), page_base as materialized (
    select filtered_row.*
    from filtered_units filtered_row
    order by
      case when target_sort = 'received:desc' then filtered_row.received_at end desc nulls last,
      case when target_sort = 'received:asc' then filtered_row.received_at end asc nulls last,
      case when target_sort = 'age:desc' then filtered_row.days_in_stock end desc,
      case when target_sort = 'vin:asc' then filtered_row.normalized_vin end asc,
      case when target_sort = 'model:asc' then lower(filtered_row.model_name) end asc,
      case when target_sort = 'status:asc' then filtered_row.status end asc,
      case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
      filtered_row.id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  ), page_rows as (
    select
      page_row.*,
      allocation_row.allocation_id,
      allocation_row.allocation_status,
      allocation_row.booking_id,
      allocation_row.booking_number
    from page_base page_row
    left join lateral (
      select
        allocation_source.id as allocation_id,
        allocation_source.status as allocation_status,
        allocation_source.booking_id,
        booking_row.booking_number
      from public.stock_allocations allocation_source
      left join public.bookings booking_row
        on booking_row.organization_id = allocation_source.organization_id
       and booking_row.id = allocation_source.booking_id
       and booking_row.deleted_at is null
      where allocation_source.organization_id = page_row.organization_id
        and allocation_source.stock_unit_id = page_row.id
        and allocation_source.status in (
          'ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED', 'ON_HOLD'
        )
      order by allocation_source.allocated_at desc, allocation_source.id
      limit 1
    ) allocation_row on true
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', page_row.id,
          'organization_id', page_row.organization_id,
          'branch_id', page_row.branch_id,
          'variant_id', page_row.variant_id,
          'vin', page_row.vin,
          'chassis_number', page_row.chassis_number,
          'engine_number', page_row.engine_number,
          'color', page_row.color,
          'status', page_row.status,
          'received_at', page_row.received_at,
          'created_at', page_row.created_at,
          'updated_at', page_row.updated_at,
          'version', page_row.version,
          'days_in_stock', page_row.days_in_stock,
          'branch_name', page_row.branch_name,
          'brand_name', page_row.brand_name,
          'model_name', page_row.model_name,
          'variant_name', page_row.variant_name,
          'allocation_id', page_row.allocation_id,
          'allocation_status', page_row.allocation_status,
          'booking_id', page_row.booking_id,
          'booking_number', page_row.booking_number
        ) order by
          case when target_sort = 'received:desc' then page_row.received_at end desc nulls last,
          case when target_sort = 'received:asc' then page_row.received_at end asc nulls last,
          case when target_sort = 'age:desc' then page_row.days_in_stock end desc,
          case when target_sort = 'vin:asc' then page_row.normalized_vin end asc,
          case when target_sort = 'model:asc' then lower(page_row.model_name) end asc,
          case when target_sort = 'status:asc' then page_row.status end asc,
          case when target_sort = 'updated:desc' then page_row.updated_at end desc,
          page_row.id asc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_units),
    'kpis', jsonb_build_object(
      'total_stock', count(*) filter (where scoped_row.status <> 'DELIVERED'),
      'available', count(*) filter (where scoped_row.status = 'AVAILABLE'),
      'reserved', count(*) filter (where scoped_row.status = 'RESERVED'),
      'allocated', count(*) filter (where scoped_row.status = 'ALLOCATED'),
      'ageing_60_plus', count(*) filter (
        where scoped_row.status <> 'DELIVERED' and scoped_row.days_in_stock > 60
      ),
      'on_hold', count(*) filter (where scoped_row.status = 'HOLD')
    )
  ) into result
  from scoped_units scoped_row;

  return result;
end;
$$;

revoke all on function public.get_stock_unit_page(text, integer, integer, text, uuid, text, text)
  from public, anon;
grant execute on function public.get_stock_unit_page(text, integer, integer, text, uuid, text, text)
  to authenticated;

create or replace function public.get_stock_check_page(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_availability text default 'ALL',
  target_branch_id uuid default null,
  target_sort text default 'model:asc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare normalized_search text;
declare normalized_availability text := upper(btrim(coalesce(target_availability, 'ALL')));
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_availability not in ('ALL', 'AVAILABLE', 'LIMITED', 'INCOMING', 'UNAVAILABLE') then
    raise exception using errcode = '22023', message = 'INVALID_AVAILABILITY_FILTER';
  end if;
  if target_sort not in ('model:asc', 'available:desc', 'incoming:desc', 'branch:asc') then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_CHECK_SORT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 100 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not (
      app_private.has_permission(current_organization_id, 'inventory.stock_check')
      or app_private.has_permission(current_organization_id, 'inventory.view')
    )
  then
    raise exception using errcode = '42501', message = 'STOCK_CHECK_PERMISSION_REQUIRED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;

  with scoped_units as materialized (
    select
      stock_row.id,
      stock_row.branch_id,
      stock_row.variant_id,
      stock_row.color,
      stock_row.status,
      branch_row.name as branch_name,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      variant_row.specifications->>'fuel' as fuel,
      variant_row.specifications->>'transmission' as transmission
    from public.stock_units stock_row
    join public.branches branch_row
      on branch_row.organization_id = stock_row.organization_id
     and branch_row.id = stock_row.branch_id
     and branch_row.deleted_at is null
    join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = stock_row.organization_id
     and model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row
      on brand_row.organization_id = stock_row.organization_id
     and brand_row.id = model_row.brand_id
    where stock_row.organization_id = current_organization_id
      and stock_row.deleted_at is null
      and stock_row.status <> 'DELIVERED'
      and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
      and (target_branch_id is null or stock_row.branch_id = target_branch_id)
  ), grouped_stock as materialized (
    select
      scoped_row.branch_id,
      scoped_row.variant_id,
      scoped_row.branch_name,
      scoped_row.brand_name,
      scoped_row.model_name,
      scoped_row.variant_name,
      scoped_row.color,
      scoped_row.fuel,
      scoped_row.transmission,
      count(*) filter (where scoped_row.status = 'AVAILABLE')::integer as available,
      count(*) filter (where scoped_row.status = 'RESERVED')::integer as reserved,
      count(*) filter (where scoped_row.status = 'ALLOCATED')::integer as allocated,
      count(*) filter (where scoped_row.status in ('INCOMING', 'IN_TRANSIT'))::integer as incoming,
      case
        when count(*) filter (where scoped_row.status = 'AVAILABLE') > 2 then 'AVAILABLE'
        when count(*) filter (where scoped_row.status = 'AVAILABLE') between 1 and 2 then 'LIMITED'
        when count(*) filter (where scoped_row.status in ('INCOMING', 'IN_TRANSIT')) > 0 then 'INCOMING'
        else 'UNAVAILABLE'
      end as availability
    from scoped_units scoped_row
    group by
      scoped_row.branch_id,
      scoped_row.variant_id,
      scoped_row.branch_name,
      scoped_row.brand_name,
      scoped_row.model_name,
      scoped_row.variant_name,
      scoped_row.color,
      scoped_row.fuel,
      scoped_row.transmission
  ), filtered_stock as materialized (
    select grouped_row.*
    from grouped_stock grouped_row
    where (
      normalized_availability = 'ALL'
      or grouped_row.availability = normalized_availability
    ) and (
      normalized_search = ''
      or lower(grouped_row.brand_name) like '%' || normalized_search || '%'
      or lower(grouped_row.model_name) like '%' || normalized_search || '%'
      or lower(grouped_row.variant_name) like '%' || normalized_search || '%'
      or lower(coalesce(grouped_row.color, '')) like '%' || normalized_search || '%'
      or lower(coalesce(grouped_row.fuel, '')) like '%' || normalized_search || '%'
      or lower(coalesce(grouped_row.transmission, '')) like '%' || normalized_search || '%'
    )
  ), page_rows as (
    select filtered_row.*
    from filtered_stock filtered_row
    order by
      case when target_sort = 'model:asc' then lower(filtered_row.model_name) end asc,
      case when target_sort = 'available:desc' then filtered_row.available end desc,
      case when target_sort = 'incoming:desc' then filtered_row.incoming end desc,
      case when target_sort = 'branch:asc' then lower(filtered_row.branch_name) end asc,
      filtered_row.variant_id,
      filtered_row.branch_id,
      coalesce(filtered_row.color, '')
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', page_row.variant_id::text || ':' || page_row.branch_id::text || ':'
            || coalesce(page_row.color, ''),
          'branch_id', page_row.branch_id,
          'variant_id', page_row.variant_id,
          'branch_name', page_row.branch_name,
          'brand_name', page_row.brand_name,
          'model_name', page_row.model_name,
          'variant_name', page_row.variant_name,
          'color', page_row.color,
          'fuel', page_row.fuel,
          'transmission', page_row.transmission,
          'available', page_row.available,
          'reserved', page_row.reserved,
          'allocated', page_row.allocated,
          'incoming', page_row.incoming,
          'availability', page_row.availability
        ) order by
          case when target_sort = 'model:asc' then lower(page_row.model_name) end asc,
          case when target_sort = 'available:desc' then page_row.available end desc,
          case when target_sort = 'incoming:desc' then page_row.incoming end desc,
          case when target_sort = 'branch:asc' then lower(page_row.branch_name) end asc,
          page_row.variant_id,
          page_row.branch_id,
          coalesce(page_row.color, '')
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_stock),
    'kpis', jsonb_build_object(
      'available_units', count(*) filter (where scoped_row.status = 'AVAILABLE'),
      'limited_groups', (
        select count(*) from grouped_stock where availability = 'LIMITED'
      ),
      'incoming_units', count(*) filter (
        where scoped_row.status in ('INCOMING', 'IN_TRANSIT')
      ),
      'unavailable_groups', (
        select count(*) from grouped_stock where availability = 'UNAVAILABLE'
      )
    )
  ) into result
  from scoped_units scoped_row;

  return result;
end;
$$;

revoke all on function public.get_stock_check_page(text, integer, integer, text, uuid, text)
  from public, anon;
grant execute on function public.get_stock_check_page(text, integer, integer, text, uuid, text)
  to authenticated;

create or replace function public.get_stock_allocation_page(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_status text default 'ALL',
  target_branch_id uuid default null,
  target_sort text default 'allocated:desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare normalized_search text;
declare identifier_search text;
declare normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_status not in (
    'ALL', 'ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED',
    'ON_HOLD', 'RELEASED', 'CANCELLED'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_STATUS_FILTER';
  end if;
  if target_sort not in ('allocated:desc', 'allocated:asc', 'booking:asc', 'vin:asc') then
    raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_SORT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 100 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  identifier_search := app_private.normalize_inventory_identifier(normalized_search);

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.view')
  then
    raise exception using errcode = '42501', message = 'INVENTORY_VIEW_REQUIRED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;

  with scoped_allocations as materialized (
    select
      allocation_row.id,
      allocation_row.organization_id,
      allocation_row.branch_id,
      allocation_row.stock_unit_id,
      allocation_row.booking_id,
      allocation_row.allocation_method,
      allocation_row.status,
      allocation_row.allocated_at,
      allocation_row.released_at,
      allocation_row.release_reason,
      allocation_row.updated_at,
      allocation_row.version,
      stock_row.version as stock_version,
      stock_row.vin,
      stock_row.normalized_vin,
      stock_row.status as stock_status,
      stock_row.color,
      branch_row.name as branch_name,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      booking_row.booking_number,
      actor_row.full_name as allocated_by_name
    from public.stock_allocations allocation_row
    join public.stock_units stock_row
      on stock_row.organization_id = allocation_row.organization_id
     and stock_row.id = allocation_row.stock_unit_id
     and stock_row.deleted_at is null
    join public.branches branch_row
      on branch_row.organization_id = allocation_row.organization_id
     and branch_row.id = allocation_row.branch_id
     and branch_row.deleted_at is null
    join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = stock_row.organization_id
     and model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row
      on brand_row.organization_id = stock_row.organization_id
     and brand_row.id = model_row.brand_id
    left join public.bookings booking_row
      on booking_row.organization_id = allocation_row.organization_id
     and booking_row.id = allocation_row.booking_id
    left join public.profiles actor_row
      on actor_row.organization_id = allocation_row.organization_id
     and actor_row.id = allocation_row.allocated_by
    where allocation_row.organization_id = current_organization_id
      and app_private.can_access_branch(
        allocation_row.organization_id,
        allocation_row.branch_id
      )
  ), filtered_allocations as materialized (
    select scoped_row.*
    from scoped_allocations scoped_row
    where (normalized_status = 'ALL' or scoped_row.status = normalized_status)
      and (target_branch_id is null or scoped_row.branch_id = target_branch_id)
      and (
        normalized_search = ''
        or (
          identifier_search <> ''
          and scoped_row.normalized_vin like identifier_search || '%'
        )
        or lower(coalesce(scoped_row.booking_number, '')) like '%' || normalized_search || '%'
        or lower(scoped_row.model_name) like '%' || normalized_search || '%'
        or lower(scoped_row.variant_name) like '%' || normalized_search || '%'
      )
  ), page_rows as (
    select filtered_row.*
    from filtered_allocations filtered_row
    order by
      case when target_sort = 'allocated:desc' then filtered_row.allocated_at end desc,
      case when target_sort = 'allocated:asc' then filtered_row.allocated_at end asc,
      case when target_sort = 'booking:asc' then lower(filtered_row.booking_number) end asc nulls last,
      case when target_sort = 'vin:asc' then filtered_row.normalized_vin end asc,
      filtered_row.id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(
        to_jsonb(page_row) - 'normalized_vin' - 'organization_id'
        order by
          case when target_sort = 'allocated:desc' then page_row.allocated_at end desc,
          case when target_sort = 'allocated:asc' then page_row.allocated_at end asc,
          case when target_sort = 'booking:asc' then lower(page_row.booking_number) end asc nulls last,
          case when target_sort = 'vin:asc' then page_row.normalized_vin end asc,
          page_row.id asc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_allocations),
    'kpis', jsonb_build_object(
      'active', count(*) filter (
        where scoped_row.status in ('ACTIVE', 'PENDING', 'SUGGESTED', 'ON_HOLD')
      ),
      'reserved', count(*) filter (where scoped_row.status = 'RESERVED'),
      'allocated', count(*) filter (where scoped_row.status = 'ALLOCATED'),
      'released', count(*) filter (where scoped_row.status = 'RELEASED')
    )
  ) into result
  from scoped_allocations scoped_row;

  return result;
end;
$$;

revoke all on function public.get_stock_allocation_page(text, integer, integer, text, uuid, text)
  from public, anon;
grant execute on function public.get_stock_allocation_page(text, integer, integer, text, uuid, text)
  to authenticated;

create or replace function public.get_stock_movement_page(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_movement_type text default 'ALL',
  target_branch_id uuid default null,
  target_sort text default 'moved:desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare normalized_search text;
declare identifier_search text;
declare normalized_movement_type text := upper(btrim(coalesce(target_movement_type, 'ALL')));
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_movement_type not in (
    'ALL', 'INTAKE', 'DETAIL_UPDATE', 'STATUS_CHANGE', 'BRANCH_TRANSFER',
    'ALLOCATION', 'ALLOCATION_RELEASE'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_MOVEMENT_TYPE_FILTER';
  end if;
  if target_sort not in ('moved:desc', 'moved:asc', 'vin:asc', 'type:asc') then
    raise exception using errcode = '22023', message = 'INVALID_MOVEMENT_SORT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 100 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  identifier_search := app_private.normalize_inventory_identifier(normalized_search);

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.view')
  then
    raise exception using errcode = '42501', message = 'INVENTORY_VIEW_REQUIRED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;

  with scoped_movements as materialized (
    select
      movement_row.id,
      movement_row.stock_unit_id,
      movement_row.from_branch_id,
      movement_row.to_branch_id,
      movement_row.movement_type,
      movement_row.reason,
      movement_row.moved_at,
      stock_row.vin,
      stock_row.normalized_vin,
      stock_row.status as stock_status,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      from_branch_row.name as from_branch_name,
      to_branch_row.name as to_branch_name,
      actor_row.full_name as moved_by_name
    from public.stock_movements movement_row
    join public.stock_units stock_row
      on stock_row.organization_id = movement_row.organization_id
     and stock_row.id = movement_row.stock_unit_id
    join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = stock_row.organization_id
     and model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row
      on brand_row.organization_id = stock_row.organization_id
     and brand_row.id = model_row.brand_id
    left join public.branches from_branch_row
      on from_branch_row.organization_id = movement_row.organization_id
     and from_branch_row.id = movement_row.from_branch_id
    left join public.branches to_branch_row
      on to_branch_row.organization_id = movement_row.organization_id
     and to_branch_row.id = movement_row.to_branch_id
    left join public.profiles actor_row
      on actor_row.organization_id = movement_row.organization_id
     and actor_row.id = movement_row.moved_by
    where movement_row.organization_id = current_organization_id
      and (
        (
          movement_row.from_branch_id is not null
          and app_private.can_access_branch(
            movement_row.organization_id,
            movement_row.from_branch_id
          )
        )
        or (
          movement_row.to_branch_id is not null
          and app_private.can_access_branch(
            movement_row.organization_id,
            movement_row.to_branch_id
          )
        )
      )
  ), filtered_movements as materialized (
    select scoped_row.*
    from scoped_movements scoped_row
    where (
      normalized_movement_type = 'ALL'
      or scoped_row.movement_type = normalized_movement_type
    )
      and (
        target_branch_id is null
        or scoped_row.from_branch_id = target_branch_id
        or scoped_row.to_branch_id = target_branch_id
      )
      and (
        normalized_search = ''
        or (
          identifier_search <> ''
          and scoped_row.normalized_vin like identifier_search || '%'
        )
        or lower(scoped_row.model_name) like '%' || normalized_search || '%'
        or lower(scoped_row.variant_name) like '%' || normalized_search || '%'
        or lower(coalesce(scoped_row.from_branch_name, '')) like '%' || normalized_search || '%'
        or lower(coalesce(scoped_row.to_branch_name, '')) like '%' || normalized_search || '%'
        or lower(coalesce(scoped_row.reason, '')) like '%' || normalized_search || '%'
      )
  ), page_rows as (
    select filtered_row.*
    from filtered_movements filtered_row
    order by
      case when target_sort = 'moved:desc' then filtered_row.moved_at end desc,
      case when target_sort = 'moved:asc' then filtered_row.moved_at end asc,
      case when target_sort = 'vin:asc' then filtered_row.normalized_vin end asc,
      case when target_sort = 'type:asc' then filtered_row.movement_type end asc,
      filtered_row.id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(
        to_jsonb(page_row) - 'normalized_vin'
        order by
          case when target_sort = 'moved:desc' then page_row.moved_at end desc,
          case when target_sort = 'moved:asc' then page_row.moved_at end asc,
          case when target_sort = 'vin:asc' then page_row.normalized_vin end asc,
          case when target_sort = 'type:asc' then page_row.movement_type end asc,
          page_row.id asc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_movements),
    'kpis', jsonb_build_object(
      'movements_today', count(*) filter (
        where scoped_row.moved_at >= date_trunc('day', now())
      ),
      'transfers', count(*) filter (
        where scoped_row.movement_type = 'BRANCH_TRANSFER'
      ),
      'intakes', count(*) filter (where scoped_row.movement_type = 'INTAKE'),
      'status_changes', count(*) filter (
        where scoped_row.movement_type = 'STATUS_CHANGE'
      )
    )
  ) into result
  from scoped_movements scoped_row;

  return result;
end;
$$;

revoke all on function public.get_stock_movement_page(text, integer, integer, text, uuid, text)
  from public, anon;
grant execute on function public.get_stock_movement_page(text, integer, integer, text, uuid, text)
  to authenticated;

create or replace function public.get_inventory_variant_options(
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare normalized_search text;
declare result jsonb;
begin
  if target_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_OPTION_LIMIT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 100 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not (
      app_private.has_permission(current_organization_id, 'inventory.create')
      or app_private.has_permission(current_organization_id, 'inventory.update')
    )
  then
    raise exception using errcode = '42501', message = 'INVENTORY_MUTATION_PERMISSION_REQUIRED';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', option_row.id,
      'label', option_row.brand_name || ' ' || option_row.model_name || ' · '
        || option_row.variant_name
    ) order by option_row.brand_name, option_row.model_name, option_row.variant_name
  ), '[]'::jsonb) into result
  from (
    select
      variant_row.id,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name
    from public.vehicle_variants variant_row
    join public.vehicle_models model_row
      on model_row.organization_id = variant_row.organization_id
     and model_row.id = variant_row.model_id
     and model_row.active
    join public.vehicle_brands brand_row
      on brand_row.organization_id = model_row.organization_id
     and brand_row.id = model_row.brand_id
     and brand_row.active
    where variant_row.organization_id = current_organization_id
      and variant_row.active
      and (
        normalized_search = ''
        or lower(brand_row.name) like '%' || normalized_search || '%'
        or lower(model_row.name) like '%' || normalized_search || '%'
        or lower(variant_row.name) like '%' || normalized_search || '%'
      )
    order by brand_row.name, model_row.name, variant_row.name, variant_row.id
    limit target_limit
  ) option_row;

  return result;
end;
$$;

revoke all on function public.get_inventory_variant_options(text, integer) from public, anon;
grant execute on function public.get_inventory_variant_options(text, integer) to authenticated;

create or replace function public.get_inventory_booking_options(
  target_branch_id uuid,
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare normalized_search text;
declare result jsonb;
begin
  if target_branch_id is null or target_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_BOOKING_OPTION_QUERY';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 100 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.allocate')
    or not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_ALLOCATION_PERMISSION_REQUIRED';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', option_row.id,
      'booking_number', option_row.booking_number,
      'customer_name', option_row.customer_name
    ) order by option_row.created_at desc, option_row.id
  ), '[]'::jsonb) into result
  from (
    select
      booking_row.id,
      booking_row.booking_number,
      case
        when app_private.has_permission(current_organization_id, 'customer.view')
          and app_private.can_access_customer(current_organization_id, customer_row.id)
          then customer_row.full_name
        else null
      end as customer_name,
      booking_row.created_at
    from public.bookings booking_row
    join public.customers customer_row
      on customer_row.organization_id = booking_row.organization_id
     and customer_row.id = booking_row.customer_id
     and customer_row.deleted_at is null
    where booking_row.organization_id = current_organization_id
      and booking_row.branch_id = target_branch_id
      and booking_row.deleted_at is null
      and upper(booking_row.status) not in ('CANCELLED', 'DELIVERED')
      and not exists (
        select 1
        from public.stock_allocations allocation_row
        where allocation_row.organization_id = booking_row.organization_id
          and allocation_row.booking_id = booking_row.id
          and allocation_row.status in (
            'ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED', 'ON_HOLD'
          )
      )
      and (
        normalized_search = ''
        or lower(booking_row.booking_number) like '%' || normalized_search || '%'
        or (
          app_private.has_permission(current_organization_id, 'customer.view')
          and app_private.can_access_customer(current_organization_id, customer_row.id)
          and lower(customer_row.full_name) like '%' || normalized_search || '%'
        )
      )
    order by booking_row.created_at desc, booking_row.id
    limit target_limit
  ) option_row;

  return result;
end;
$$;

revoke all on function public.get_inventory_booking_options(uuid, text, integer)
  from public, anon;
grant execute on function public.get_inventory_booking_options(uuid, text, integer)
  to authenticated;

create or replace function public.get_stock_unit_detail(target_stock_unit_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare stock_record public.stock_units%rowtype;
declare result jsonb;
begin
  if target_stock_unit_id is null then
    raise exception using errcode = '22023', message = 'STOCK_UNIT_ID_REQUIRED';
  end if;
  select * into stock_record
  from public.stock_units stock_row
  where stock_row.id = target_stock_unit_id;
  if not found or stock_record.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'STOCK_UNIT_NOT_FOUND';
  end if;
  if not app_private.can_access_inventory_unit(
    stock_record.organization_id,
    stock_record.id
  ) then
    raise exception using errcode = '42501', message = 'INVENTORY_UNIT_ACCESS_DENIED';
  end if;

  select jsonb_build_object(
    'id', stock_record.id,
    'organization_id', stock_record.organization_id,
    'branch_id', stock_record.branch_id,
    'variant_id', stock_record.variant_id,
    'vin', stock_record.vin,
    'chassis_number', stock_record.chassis_number,
    'engine_number', stock_record.engine_number,
    'color', stock_record.color,
    'status', stock_record.status,
    'received_at', stock_record.received_at,
    'created_at', stock_record.created_at,
    'updated_at', stock_record.updated_at,
    'version', stock_record.version,
    'branch_name', branch_row.name,
    'brand_name', brand_row.name,
    'model_name', model_row.name,
    'variant_name', variant_row.name,
    'movements', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', movement_row.id,
          'movement_type', movement_row.movement_type,
          'from_branch_name', from_branch_row.name,
          'to_branch_name', to_branch_row.name,
          'reason', movement_row.reason,
          'moved_by_name', actor_row.full_name,
          'moved_at', movement_row.moved_at
        ) order by movement_row.moved_at desc, movement_row.id
      )
      from (
        select movement_source.*
        from public.stock_movements movement_source
        where movement_source.organization_id = stock_record.organization_id
          and movement_source.stock_unit_id = stock_record.id
        order by movement_source.moved_at desc, movement_source.id
        limit 100
      ) movement_row
      left join public.branches from_branch_row
        on from_branch_row.organization_id = movement_row.organization_id
       and from_branch_row.id = movement_row.from_branch_id
      left join public.branches to_branch_row
        on to_branch_row.organization_id = movement_row.organization_id
       and to_branch_row.id = movement_row.to_branch_id
      left join public.profiles actor_row
        on actor_row.organization_id = movement_row.organization_id
       and actor_row.id = movement_row.moved_by
    ), '[]'::jsonb),
    'allocations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', allocation_row.id,
          'booking_id', allocation_row.booking_id,
          'booking_number', booking_row.booking_number,
          'allocation_method', allocation_row.allocation_method,
          'status', allocation_row.status,
          'allocated_at', allocation_row.allocated_at,
          'released_at', allocation_row.released_at,
          'release_reason', allocation_row.release_reason,
          'version', allocation_row.version
        ) order by allocation_row.allocated_at desc, allocation_row.id
      )
      from (
        select allocation_source.*
        from public.stock_allocations allocation_source
        where allocation_source.organization_id = stock_record.organization_id
          and allocation_source.stock_unit_id = stock_record.id
        order by allocation_source.allocated_at desc, allocation_source.id
        limit 50
      ) allocation_row
      left join public.bookings booking_row
        on booking_row.organization_id = allocation_row.organization_id
       and booking_row.id = allocation_row.booking_id
    ), '[]'::jsonb)
  ) into result
  from public.branches branch_row
  join public.vehicle_variants variant_row
    on variant_row.organization_id = stock_record.organization_id
   and variant_row.id = stock_record.variant_id
  join public.vehicle_models model_row
    on model_row.organization_id = stock_record.organization_id
   and model_row.id = variant_row.model_id
  join public.vehicle_brands brand_row
    on brand_row.organization_id = stock_record.organization_id
   and brand_row.id = model_row.brand_id
  where branch_row.organization_id = stock_record.organization_id
    and branch_row.id = stock_record.branch_id;

  return result;
end;
$$;

revoke all on function public.get_stock_unit_detail(uuid) from public, anon;
grant execute on function public.get_stock_unit_detail(uuid) to authenticated;

create or replace function app_private.inventory_status_transition_allowed(
  current_status text,
  next_status text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (current_status, next_status) in (
    ('INCOMING', 'AVAILABLE'),
    ('INCOMING', 'HOLD'),
    ('AVAILABLE', 'HOLD'),
    ('HOLD', 'AVAILABLE'),
    ('ALLOCATED', 'READY_FOR_DELIVERY'),
    ('READY_FOR_DELIVERY', 'DELIVERED')
  );
$$;

create or replace function public.create_stock_unit(
  target_organization_id uuid,
  target_branch_id uuid,
  target_variant_id uuid,
  target_vin text,
  target_chassis_number text,
  target_engine_number text,
  target_color text,
  target_status text,
  target_received_at timestamptz,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare actor_organization_id uuid;
declare normalized_vin text;
declare normalized_chassis text;
declare normalized_engine text;
declare normalized_color text := nullif(btrim(coalesce(target_color, '')), '');
declare normalized_status text := upper(btrim(coalesce(target_status, '')));
declare fingerprint text;
declare replay_result jsonb;
declare stock_record public.stock_units%rowtype;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null or target_organization_id is null
    or target_branch_id is null or target_variant_id is null
  then
    raise exception using errcode = '22023', message = 'REQUIRED_STOCK_FIELD_MISSING';
  end if;
  normalized_vin := app_private.normalize_inventory_identifier(target_vin);
  normalized_chassis := app_private.normalize_inventory_identifier(target_chassis_number);
  normalized_engine := app_private.normalize_inventory_identifier(target_engine_number);
  if normalized_vin !~ '^[A-HJ-NPR-Z0-9]{17}$' then
    raise exception using errcode = '22023', message = 'INVALID_VIN';
  end if;
  if normalized_chassis !~ '^[A-Z0-9]{6,32}$' then
    raise exception using errcode = '22023', message = 'INVALID_CHASSIS_NUMBER';
  end if;
  if target_engine_number is not null and normalized_engine !~ '^[A-Z0-9]{4,32}$' then
    raise exception using errcode = '22023', message = 'INVALID_ENGINE_NUMBER';
  end if;
  if normalized_color is not null and char_length(normalized_color) > 80 then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_COLOR';
  end if;
  if normalized_status not in ('INCOMING', 'AVAILABLE') then
    raise exception using errcode = '22023', message = 'INVALID_INTAKE_STATUS';
  end if;
  if target_received_at is not null and (
    target_received_at > now() + interval '1 day'
    or target_received_at < now() - interval '10 years'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_RECEIVED_TIME';
  end if;
  if normalized_status = 'AVAILABLE' and target_received_at is null then
    raise exception using errcode = '22023', message = 'RECEIVED_TIME_REQUIRED';
  end if;

  select profile_row.organization_id into actor_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if actor_organization_id is null
    or actor_organization_id <> target_organization_id
    or not app_private.has_permission(target_organization_id, 'inventory.create')
    or not app_private.can_access_branch(target_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_CREATE_DENIED';
  end if;
  fingerprint := app_private.inventory_request_fingerprint(jsonb_build_object(
    'organization_id', target_organization_id,
    'branch_id', target_branch_id,
    'variant_id', target_variant_id,
    'vin', normalized_vin,
    'chassis', normalized_chassis,
    'engine', nullif(normalized_engine, ''),
    'color', normalized_color,
    'status', normalized_status,
    'received_at', target_received_at
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    target_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text,
    0
  ));
  replay_result := app_private.inventory_idempotent_replay(
    target_organization_id,
    'inventory.stock_created',
    target_request_id,
    fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  if not exists (
    select 1
    from public.vehicle_variants variant_row
    join public.vehicle_models model_row
      on model_row.organization_id = variant_row.organization_id
     and model_row.id = variant_row.model_id
     and model_row.active
    join public.vehicle_brands brand_row
      on brand_row.organization_id = model_row.organization_id
     and brand_row.id = model_row.brand_id
     and brand_row.active
    where variant_row.organization_id = target_organization_id
      and variant_row.id = target_variant_id
      and variant_row.active
  ) then
    raise exception using errcode = '22023', message = 'INVENTORY_VARIANT_INVALID';
  end if;

  insert into public.stock_units (
    organization_id,
    branch_id,
    variant_id,
    vin,
    chassis_number,
    engine_number,
    color,
    status,
    received_at,
    created_by,
    updated_by
  ) values (
    target_organization_id,
    target_branch_id,
    target_variant_id,
    normalized_vin,
    normalized_chassis,
    nullif(normalized_engine, ''),
    normalized_color,
    normalized_status,
    target_received_at,
    auth.uid(),
    auth.uid()
  ) returning * into stock_record;

  insert into public.stock_movements (
    organization_id,
    stock_unit_id,
    from_branch_id,
    to_branch_id,
    movement_type,
    reason,
    moved_by,
    moved_at
  ) values (
    target_organization_id,
    stock_record.id,
    null,
    target_branch_id,
    'INTAKE',
    'Initial stock intake as ' || normalized_status,
    auth.uid(),
    coalesce(target_received_at, now())
  );

  result := jsonb_build_object(
    'stock_unit_id', stock_record.id,
    'version', stock_record.version,
    'status', stock_record.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    target_organization_id, auth.uid(), 'inventory.stock_created', 'stock_unit',
    stock_record.id::text, target_branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

revoke all on function public.create_stock_unit(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, uuid
) from public, anon;
grant execute on function public.create_stock_unit(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, uuid
) to authenticated;

create or replace function public.update_stock_unit(
  target_stock_unit_id uuid,
  expected_version bigint,
  target_engine_number text,
  target_color text,
  target_received_at timestamptz,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare stock_record public.stock_units%rowtype;
declare normalized_engine text;
declare normalized_color text := nullif(btrim(coalesce(target_color, '')), '');
declare normalized_reason text := btrim(coalesce(target_reason, ''));
declare fingerprint text;
declare replay_result jsonb;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_stock_unit_id is null or target_request_id is null
    or expected_version is null or expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_UPDATE_REQUEST';
  end if;
  normalized_engine := app_private.normalize_inventory_identifier(target_engine_number);
  if target_engine_number is not null and normalized_engine !~ '^[A-Z0-9]{4,32}$' then
    raise exception using errcode = '22023', message = 'INVALID_ENGINE_NUMBER';
  end if;
  if normalized_color is not null and char_length(normalized_color) > 80 then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_COLOR';
  end if;
  if char_length(normalized_reason) not between 5 and 1000 then
    raise exception using errcode = '22023', message = 'INVALID_UPDATE_REASON';
  end if;
  if target_received_at is not null and (
    target_received_at > now() + interval '1 day'
    or target_received_at < now() - interval '10 years'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_RECEIVED_TIME';
  end if;

  select * into stock_record
  from public.stock_units stock_row
  where stock_row.id = target_stock_unit_id
  for update;
  if not found or stock_record.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'STOCK_UNIT_NOT_FOUND';
  end if;
  if not app_private.has_permission(stock_record.organization_id, 'inventory.update')
    or not app_private.can_access_branch(stock_record.organization_id, stock_record.branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_UPDATE_DENIED';
  end if;
  fingerprint := app_private.inventory_request_fingerprint(jsonb_build_object(
    'stock_unit_id', target_stock_unit_id,
    'expected_version', expected_version,
    'engine', nullif(normalized_engine, ''),
    'color', normalized_color,
    'received_at', target_received_at,
    'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    stock_record.organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text,
    0
  ));
  replay_result := app_private.inventory_idempotent_replay(
    stock_record.organization_id,
    'inventory.stock_updated',
    target_request_id,
    fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  if stock_record.status = 'DELIVERED' then
    raise exception using errcode = '22023', message = 'DELIVERED_STOCK_IMMUTABLE';
  end if;
  if stock_record.status <> 'INCOMING' and target_received_at is null then
    raise exception using errcode = '22023', message = 'RECEIVED_TIME_REQUIRED';
  end if;
  if stock_record.version <> expected_version then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;
  if stock_record.engine_number is not distinct from nullif(normalized_engine, '')
    and stock_record.color is not distinct from normalized_color
    and stock_record.received_at is not distinct from target_received_at
  then
    raise exception using errcode = '22023', message = 'NO_STOCK_CHANGES';
  end if;

  update public.stock_units stock_row
  set engine_number = nullif(normalized_engine, ''),
      color = normalized_color,
      received_at = target_received_at,
      updated_by = auth.uid(),
      updated_at = now(),
      version = stock_row.version + 1
  where stock_row.id = stock_record.id
    and stock_row.organization_id = stock_record.organization_id
    and stock_row.version = expected_version
  returning * into stock_record;
  if not found then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;

  insert into public.stock_movements (
    organization_id, stock_unit_id, from_branch_id, to_branch_id,
    movement_type, reason, moved_by
  ) values (
    stock_record.organization_id, stock_record.id, stock_record.branch_id,
    stock_record.branch_id, 'DETAIL_UPDATE', normalized_reason, auth.uid()
  );
  result := jsonb_build_object(
    'stock_unit_id', stock_record.id,
    'version', stock_record.version,
    'status', stock_record.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    stock_record.organization_id, auth.uid(), 'inventory.stock_updated', 'stock_unit',
    stock_record.id::text, stock_record.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result, 'reason', normalized_reason)
  );
  return result;
end;
$$;

revoke all on function public.update_stock_unit(
  uuid, bigint, text, text, timestamptz, text, uuid
) from public, anon;
grant execute on function public.update_stock_unit(
  uuid, bigint, text, text, timestamptz, text, uuid
) to authenticated;

create or replace function public.set_stock_unit_status(
  target_stock_unit_id uuid,
  expected_version bigint,
  target_status text,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare stock_record public.stock_units%rowtype;
declare previous_status text;
declare normalized_status text := upper(btrim(coalesce(target_status, '')));
declare normalized_reason text := btrim(coalesce(target_reason, ''));
declare fingerprint text;
declare replay_result jsonb;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_stock_unit_id is null or target_request_id is null
    or expected_version is null or expected_version < 1
    or char_length(normalized_reason) not between 5 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_STATUS_REQUEST';
  end if;
  select * into stock_record
  from public.stock_units stock_row
  where stock_row.id = target_stock_unit_id
  for update;
  if not found or stock_record.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'STOCK_UNIT_NOT_FOUND';
  end if;
  if not app_private.has_permission(stock_record.organization_id, 'inventory.update')
    or not app_private.can_access_branch(stock_record.organization_id, stock_record.branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_UPDATE_DENIED';
  end if;
  fingerprint := app_private.inventory_request_fingerprint(jsonb_build_object(
    'stock_unit_id', target_stock_unit_id,
    'expected_version', expected_version,
    'status', normalized_status,
    'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    stock_record.organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text,
    0
  ));
  replay_result := app_private.inventory_idempotent_replay(
    stock_record.organization_id,
    'inventory.stock_status_changed',
    target_request_id,
    fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  if not app_private.inventory_status_transition_allowed(stock_record.status, normalized_status) then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_STATUS_TRANSITION';
  end if;
  if normalized_status = 'AVAILABLE' and stock_record.received_at is null then
    raise exception using errcode = '22023', message = 'RECEIVED_TIME_REQUIRED';
  end if;
  if normalized_status in ('READY_FOR_DELIVERY', 'DELIVERED')
    and not exists (
      select 1
      from public.stock_allocations allocation_row
      where allocation_row.organization_id = stock_record.organization_id
        and allocation_row.stock_unit_id = stock_record.id
        and allocation_row.status = 'ALLOCATED'
    )
  then
    raise exception using errcode = '22023', message = 'ALLOCATED_BOOKING_REQUIRED';
  end if;
  if stock_record.version <> expected_version then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;

  previous_status := stock_record.status;
  update public.stock_units stock_row
  set status = normalized_status,
      updated_by = auth.uid(),
      updated_at = now(),
      version = stock_row.version + 1
  where stock_row.id = stock_record.id
    and stock_row.organization_id = stock_record.organization_id
    and stock_row.version = expected_version
  returning * into stock_record;
  if not found then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;

  insert into public.stock_movements (
    organization_id, stock_unit_id, from_branch_id, to_branch_id,
    movement_type, reason, moved_by
  ) values (
    stock_record.organization_id, stock_record.id, stock_record.branch_id,
    stock_record.branch_id, 'STATUS_CHANGE',
    normalized_reason || ' (' || previous_status || ' to ' || normalized_status || ')', auth.uid()
  );
  result := jsonb_build_object(
    'stock_unit_id', stock_record.id,
    'version', stock_record.version,
    'status', stock_record.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    stock_record.organization_id, auth.uid(), 'inventory.stock_status_changed',
    'stock_unit', stock_record.id::text, stock_record.branch_id, target_request_id,
    jsonb_build_object(
      'fingerprint', fingerprint,
      'result', result,
      'from_status', previous_status,
      'reason', normalized_reason
    )
  );
  return result;
end;
$$;

revoke all on function public.set_stock_unit_status(uuid, bigint, text, text, uuid)
  from public, anon;
grant execute on function public.set_stock_unit_status(uuid, bigint, text, text, uuid)
  to authenticated;

create or replace function public.move_stock_unit(
  target_stock_unit_id uuid,
  expected_version bigint,
  target_to_branch_id uuid,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare stock_record public.stock_units%rowtype;
declare previous_branch_id uuid;
declare normalized_reason text := btrim(coalesce(target_reason, ''));
declare fingerprint text;
declare replay_result jsonb;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_stock_unit_id is null or target_to_branch_id is null
    or target_request_id is null or expected_version is null or expected_version < 1
    or char_length(normalized_reason) not between 5 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_MOVEMENT_REQUEST';
  end if;

  select * into stock_record
  from public.stock_units stock_row
  where stock_row.id = target_stock_unit_id
  for update;
  if not found or stock_record.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'STOCK_UNIT_NOT_FOUND';
  end if;
  if not app_private.has_permission(stock_record.organization_id, 'inventory.move')
    or not app_private.can_access_branch(stock_record.organization_id, stock_record.branch_id)
    or not app_private.can_access_branch(stock_record.organization_id, target_to_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_MOVE_DENIED';
  end if;
  fingerprint := app_private.inventory_request_fingerprint(jsonb_build_object(
    'stock_unit_id', target_stock_unit_id,
    'expected_version', expected_version,
    'to_branch_id', target_to_branch_id,
    'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    stock_record.organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text,
    0
  ));
  replay_result := app_private.inventory_idempotent_replay(
    stock_record.organization_id,
    'inventory.stock_moved',
    target_request_id,
    fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  if stock_record.branch_id = target_to_branch_id then
    raise exception using errcode = '22023', message = 'STOCK_ALREADY_IN_BRANCH';
  end if;
  if stock_record.version <> expected_version then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;
  if stock_record.status not in ('INCOMING', 'AVAILABLE', 'HOLD') then
    raise exception using errcode = '22023', message = 'STOCK_STATUS_NOT_MOVABLE';
  end if;
  if exists (
    select 1
    from public.stock_allocations allocation_row
    where allocation_row.organization_id = stock_record.organization_id
      and allocation_row.stock_unit_id = stock_record.id
      and allocation_row.status in (
        'ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED', 'ON_HOLD'
      )
  ) then
    raise exception using errcode = '22023', message = 'ACTIVE_ALLOCATION_PREVENTS_MOVE';
  end if;

  previous_branch_id := stock_record.branch_id;
  update public.stock_units stock_row
  set branch_id = target_to_branch_id,
      updated_by = auth.uid(),
      updated_at = now(),
      version = stock_row.version + 1
  where stock_row.id = stock_record.id
    and stock_row.organization_id = stock_record.organization_id
    and stock_row.version = expected_version
  returning * into stock_record;
  if not found then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;

  insert into public.stock_movements (
    organization_id, stock_unit_id, from_branch_id, to_branch_id,
    movement_type, reason, moved_by
  ) values (
    stock_record.organization_id, stock_record.id, previous_branch_id,
    target_to_branch_id, 'BRANCH_TRANSFER', normalized_reason, auth.uid()
  );
  result := jsonb_build_object(
    'stock_unit_id', stock_record.id,
    'version', stock_record.version,
    'status', stock_record.status,
    'branch_id', stock_record.branch_id,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    stock_record.organization_id, auth.uid(), 'inventory.stock_moved', 'stock_unit',
    stock_record.id::text, target_to_branch_id, target_request_id,
    jsonb_build_object(
      'fingerprint', fingerprint,
      'result', result,
      'from_branch_id', previous_branch_id,
      'reason', normalized_reason
    )
  );
  return result;
end;
$$;

revoke all on function public.move_stock_unit(uuid, bigint, uuid, text, uuid)
  from public, anon;
grant execute on function public.move_stock_unit(uuid, bigint, uuid, text, uuid)
  to authenticated;

create or replace function public.allocate_stock_unit(
  target_stock_unit_id uuid,
  expected_stock_version bigint,
  target_booking_id uuid,
  target_allocation_status text,
  target_existing_allocation_id uuid,
  expected_allocation_version bigint,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare stock_record public.stock_units%rowtype;
declare booking_record public.bookings%rowtype;
declare allocation_record public.stock_allocations%rowtype;
declare normalized_status text := upper(btrim(coalesce(target_allocation_status, '')));
declare fingerprint text;
declare replay_result jsonb;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_stock_unit_id is null or target_booking_id is null
    or target_request_id is null
    or expected_stock_version is null or expected_stock_version < 1
    or normalized_status not in ('RESERVED', 'ALLOCATED')
  then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_ALLOCATION_REQUEST';
  end if;
  if (target_existing_allocation_id is null) <> (expected_allocation_version is null) then
    raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_VERSION_REQUEST';
  end if;

  select * into stock_record
  from public.stock_units stock_row
  where stock_row.id = target_stock_unit_id
  for update;
  if not found or stock_record.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'STOCK_UNIT_NOT_FOUND';
  end if;
  if not app_private.has_permission(stock_record.organization_id, 'inventory.allocate')
    or not app_private.can_access_branch(stock_record.organization_id, stock_record.branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_ALLOCATION_DENIED';
  end if;
  fingerprint := app_private.inventory_request_fingerprint(jsonb_build_object(
    'stock_unit_id', target_stock_unit_id,
    'expected_stock_version', expected_stock_version,
    'booking_id', target_booking_id,
    'allocation_status', normalized_status,
    'existing_allocation_id', target_existing_allocation_id,
    'expected_allocation_version', expected_allocation_version
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    stock_record.organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text,
    0
  ));
  replay_result := app_private.inventory_idempotent_replay(
    stock_record.organization_id,
    'inventory.stock_allocated',
    target_request_id,
    fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  select * into booking_record
  from public.bookings booking_row
  where booking_row.id = target_booking_id
    and booking_row.organization_id = stock_record.organization_id
    and booking_row.branch_id = stock_record.branch_id
    and booking_row.deleted_at is null
    and upper(booking_row.status) not in ('CANCELLED', 'DELIVERED');
  if not found then
    raise exception using errcode = '22023', message = 'BOOKING_NOT_ELIGIBLE_FOR_ALLOCATION';
  end if;
  if target_existing_allocation_id is not null then
    select * into allocation_record
    from public.stock_allocations allocation_row
    where allocation_row.id = target_existing_allocation_id
      and allocation_row.organization_id = stock_record.organization_id
      and allocation_row.stock_unit_id = stock_record.id
      and allocation_row.booking_id = booking_record.id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'STOCK_ALLOCATION_NOT_FOUND';
    end if;
  end if;
  if stock_record.version <> expected_stock_version then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;

  if target_existing_allocation_id is null then
    if stock_record.status <> 'AVAILABLE' then
      raise exception using errcode = '22023', message = 'STOCK_NOT_AVAILABLE';
    end if;
    insert into public.stock_allocations (
      organization_id,
      branch_id,
      stock_unit_id,
      booking_id,
      allocation_method,
      status,
      allocated_by
    ) values (
      stock_record.organization_id,
      stock_record.branch_id,
      stock_record.id,
      booking_record.id,
      'MANUAL',
      normalized_status,
      auth.uid()
    ) returning * into allocation_record;
  else
    if expected_allocation_version is null or expected_allocation_version < 1
      or allocation_record.version <> expected_allocation_version
    then
      raise exception using errcode = '40001', message = 'ALLOCATION_VERSION_CONFLICT';
    end if;
    if allocation_record.status <> 'RESERVED'
      or stock_record.status <> 'RESERVED'
      or normalized_status <> 'ALLOCATED'
    then
      raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_TRANSITION';
    end if;
    update public.stock_allocations allocation_row
    set status = 'ALLOCATED',
        updated_at = now(),
        version = allocation_row.version + 1
    where allocation_row.id = allocation_record.id
      and allocation_row.organization_id = allocation_record.organization_id
      and allocation_row.version = expected_allocation_version
    returning * into allocation_record;
    if not found then
      raise exception using errcode = '40001', message = 'ALLOCATION_VERSION_CONFLICT';
    end if;
  end if;

  update public.stock_units stock_row
  set status = normalized_status,
      updated_by = auth.uid(),
      updated_at = now(),
      version = stock_row.version + 1
  where stock_row.id = stock_record.id
    and stock_row.organization_id = stock_record.organization_id
    and stock_row.version = expected_stock_version
  returning * into stock_record;
  if not found then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;

  insert into public.stock_movements (
    organization_id, stock_unit_id, from_branch_id, to_branch_id,
    movement_type, reason, moved_by
  ) values (
    stock_record.organization_id, stock_record.id, stock_record.branch_id,
    stock_record.branch_id, 'ALLOCATION',
    normalized_status || ' for booking ' || booking_record.booking_number,
    auth.uid()
  );
  result := jsonb_build_object(
    'stock_unit_id', stock_record.id,
    'stock_version', stock_record.version,
    'stock_status', stock_record.status,
    'allocation_id', allocation_record.id,
    'allocation_version', allocation_record.version,
    'allocation_status', allocation_record.status,
    'booking_id', booking_record.id,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    stock_record.organization_id, auth.uid(), 'inventory.stock_allocated',
    'stock_allocation', allocation_record.id::text, stock_record.branch_id,
    target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

revoke all on function public.allocate_stock_unit(
  uuid, bigint, uuid, text, uuid, bigint, uuid
) from public, anon;
grant execute on function public.allocate_stock_unit(
  uuid, bigint, uuid, text, uuid, bigint, uuid
) to authenticated;

create or replace function public.release_stock_allocation(
  target_allocation_id uuid,
  expected_allocation_version bigint,
  expected_stock_version bigint,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare allocation_record public.stock_allocations%rowtype;
declare stock_record public.stock_units%rowtype;
declare normalized_reason text := btrim(coalesce(target_reason, ''));
declare fingerprint text;
declare replay_result jsonb;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_allocation_id is null or target_request_id is null
    or expected_allocation_version is null or expected_allocation_version < 1
    or expected_stock_version is null or expected_stock_version < 1
    or char_length(normalized_reason) not between 5 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_RELEASE_REQUEST';
  end if;

  select * into allocation_record
  from public.stock_allocations allocation_row
  where allocation_row.id = target_allocation_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'STOCK_ALLOCATION_NOT_FOUND';
  end if;
  if not app_private.has_permission(allocation_record.organization_id, 'inventory.allocate')
    or not app_private.can_access_branch(
      allocation_record.organization_id,
      allocation_record.branch_id
    )
  then
    raise exception using errcode = '42501', message = 'INVENTORY_ALLOCATION_DENIED';
  end if;
  select * into stock_record
  from public.stock_units stock_row
  where stock_row.id = allocation_record.stock_unit_id
    and stock_row.organization_id = allocation_record.organization_id
  for update;
  if not found or stock_record.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'STOCK_UNIT_NOT_FOUND';
  end if;
  select * into allocation_record
  from public.stock_allocations allocation_row
  where allocation_row.id = target_allocation_id
    and allocation_row.organization_id = stock_record.organization_id
    and allocation_row.stock_unit_id = stock_record.id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'STOCK_ALLOCATION_NOT_FOUND';
  end if;

  fingerprint := app_private.inventory_request_fingerprint(jsonb_build_object(
    'allocation_id', target_allocation_id,
    'expected_allocation_version', expected_allocation_version,
    'expected_stock_version', expected_stock_version,
    'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    allocation_record.organization_id::text || ':' || auth.uid()::text || ':'
      || target_request_id::text,
    0
  ));
  replay_result := app_private.inventory_idempotent_replay(
    allocation_record.organization_id,
    'inventory.allocation_released',
    target_request_id,
    fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  if allocation_record.version <> expected_allocation_version then
    raise exception using errcode = '40001', message = 'ALLOCATION_VERSION_CONFLICT';
  end if;
  if stock_record.version <> expected_stock_version then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;
  if allocation_record.status not in ('RESERVED', 'ALLOCATED')
    or (
      allocation_record.status = 'RESERVED'
      and stock_record.status <> 'RESERVED'
    )
    or (
      allocation_record.status = 'ALLOCATED'
      and stock_record.status not in ('ALLOCATED', 'READY_FOR_DELIVERY')
    )
  then
    raise exception using errcode = '22023', message = 'ALLOCATION_NOT_RELEASABLE';
  end if;

  update public.stock_allocations allocation_row
  set status = 'RELEASED',
      released_at = now(),
      released_by = auth.uid(),
      release_reason = normalized_reason,
      updated_at = now(),
      version = allocation_row.version + 1
  where allocation_row.id = allocation_record.id
    and allocation_row.organization_id = allocation_record.organization_id
    and allocation_row.version = expected_allocation_version
  returning * into allocation_record;
  if not found then
    raise exception using errcode = '40001', message = 'ALLOCATION_VERSION_CONFLICT';
  end if;
  update public.stock_units stock_row
  set status = 'AVAILABLE',
      updated_by = auth.uid(),
      updated_at = now(),
      version = stock_row.version + 1
  where stock_row.id = stock_record.id
    and stock_row.organization_id = stock_record.organization_id
    and stock_row.version = expected_stock_version
  returning * into stock_record;
  if not found then
    raise exception using errcode = '40001', message = 'STOCK_VERSION_CONFLICT';
  end if;

  insert into public.stock_movements (
    organization_id, stock_unit_id, from_branch_id, to_branch_id,
    movement_type, reason, moved_by
  ) values (
    stock_record.organization_id, stock_record.id, stock_record.branch_id,
    stock_record.branch_id, 'ALLOCATION_RELEASE', normalized_reason, auth.uid()
  );
  result := jsonb_build_object(
    'allocation_id', allocation_record.id,
    'allocation_version', allocation_record.version,
    'allocation_status', allocation_record.status,
    'stock_unit_id', stock_record.id,
    'stock_version', stock_record.version,
    'stock_status', stock_record.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    allocation_record.organization_id, auth.uid(), 'inventory.allocation_released',
    'stock_allocation', allocation_record.id::text, allocation_record.branch_id,
    target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result, 'reason', normalized_reason)
  );
  return result;
end;
$$;

revoke all on function public.release_stock_allocation(uuid, bigint, bigint, text, uuid)
  from public, anon;
grant execute on function public.release_stock_allocation(uuid, bigint, bigint, text, uuid)
  to authenticated;

revoke all on function app_private.validate_stock_allocation_scope() from public, anon, authenticated;

commit;
