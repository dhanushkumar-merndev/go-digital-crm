-- Accessories Management: Catalog, Stock Tracking, and Booking Fitment
create table if not exists public.accessories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  part_number text not null,
  category text not null check (category in ('EXTERIOR', 'INTERIOR', 'ELECTRICAL', 'CAR_CARE', 'SAFETY_UTILITY')),
  price numeric(12,2) not null check (price >= 0),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  oem boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, part_number)
);

create table if not exists public.booking_accessories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  accessory_id uuid not null references public.accessories(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  status text not null default 'ORDERED' check (status in ('ORDERED', 'ALLOCATED', 'FITTED')),
  fitted_by uuid references public.profiles(id),
  fitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.accessories enable row level security;
alter table public.booking_accessories enable row level security;

create policy accessories_tenant_isolation on public.accessories
  for all using (organization_id = app_private.current_tenant_organization())
  with check (organization_id = app_private.current_tenant_organization());

create policy booking_accessories_tenant_isolation on public.booking_accessories
  for all using (organization_id = app_private.current_tenant_organization())
  with check (organization_id = app_private.current_tenant_organization());

create index if not exists idx_accessories_catalog
  on public.accessories (organization_id, category, active, name);

create index if not exists idx_booking_accessories_booking
  on public.booking_accessories (organization_id, booking_id, status);

create or replace function public.get_accessories_catalog(
  target_category text default null,
  target_search text default null,
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
  current_organization_id uuid;
  search_term text := left(trim(coalesce(target_search, '')), 100);
  category_filter text := nullif(trim(coalesce(target_category, '')), '');
  offset_rows integer;
  records jsonb;
  total_count integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  offset_rows := greatest(0, (target_page - 1) * target_page_size);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'name', a.name,
    'part_number', a.part_number,
    'category', a.category,
    'price', a.price,
    'stock_quantity', a.stock_quantity,
    'oem', a.oem,
    'active', a.active,
    'created_at', a.created_at
  ) order by a.name, a.id), '[]'::jsonb)
  into records
  from (
    select * from public.accessories
    where organization_id = current_organization_id
      and (category_filter is null or category = category_filter)
      and (search_term = '' or name ilike '%' || search_term || '%' or part_number ilike '%' || search_term || '%')
    order by name, id
    limit target_page_size offset offset_rows
  ) a;

  select count(*)::integer into total_count
  from public.accessories
  where organization_id = current_organization_id
    and (category_filter is null or category = category_filter)
    and (search_term = '' or name ilike '%' || search_term || '%' or part_number ilike '%' || search_term || '%');

  return jsonb_build_object(
    'records', records,
    'total', total_count,
    'kpis', jsonb_build_object(
      'total_items', (select count(*)::integer from public.accessories where organization_id = current_organization_id),
      'active_items', (select count(*)::integer from public.accessories where organization_id = current_organization_id and active = true),
      'low_stock', (select count(*)::integer from public.accessories where organization_id = current_organization_id and active = true and stock_quantity <= 3)
    )
  );
end;
$$;

create or replace function public.upsert_accessory(
  target_id uuid default null,
  target_name text default null,
  target_part_number text default null,
  target_category text default null,
  target_price numeric default 0,
  target_stock integer default 0,
  target_oem boolean default true,
  target_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  accessory_record public.accessories%rowtype;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not (
      app_private.has_permission(current_organization_id, 'inventory.manage')
      or app_private.has_permission(current_organization_id, 'integration.manage')
    ) then
    raise exception using errcode = '42501', message = 'INVENTORY_MANAGE_PERMISSION_REQUIRED';
  end if;

  if trim(coalesce(target_name, '')) = '' or trim(coalesce(target_part_number, '')) = '' then
    raise exception using errcode = '22023', message = 'INVALID_ACCESSORY_DATA';
  end if;

  if target_id is not null then
    update public.accessories set
      name = trim(target_name),
      part_number = upper(trim(target_part_number)),
      category = upper(trim(target_category)),
      price = target_price,
      stock_quantity = target_stock,
      oem = target_oem,
      active = target_active,
      updated_at = now()
    where id = target_id and organization_id = current_organization_id
    returning * into accessory_record;

    if not found then
      raise exception using errcode = 'P0002', message = 'ACCESSORY_NOT_FOUND';
    end if;
  else
    insert into public.accessories (
      organization_id, name, part_number, category, price, stock_quantity, oem, active
    ) values (
      current_organization_id, trim(target_name), upper(trim(target_part_number)),
      upper(trim(target_category)), target_price, target_stock, target_oem, target_active
    )
    returning * into accessory_record;
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'accessory.saved', 'accessory', accessory_record.id::text,
    jsonb_build_object('name', accessory_record.name, 'part_number', accessory_record.part_number)
  );

  return jsonb_build_object(
    'id', accessory_record.id,
    'name', accessory_record.name,
    'part_number', accessory_record.part_number,
    'category', accessory_record.category,
    'price', accessory_record.price,
    'stock_quantity', accessory_record.stock_quantity,
    'oem', accessory_record.oem,
    'active', accessory_record.active
  );
end;
$$;

create or replace function public.get_booking_accessories(target_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  items jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ba.id,
    'booking_id', ba.booking_id,
    'accessory_id', ba.accessory_id,
    'name', a.name,
    'part_number', a.part_number,
    'category', a.category,
    'quantity', ba.quantity,
    'unit_price', ba.unit_price,
    'status', ba.status,
    'fitted_by', ba.fitted_by,
    'fitted_at', ba.fitted_at
  ) order by ba.created_at), '[]'::jsonb)
  into items
  from public.booking_accessories ba
  join public.accessories a on a.id = ba.accessory_id
  where ba.booking_id = target_booking_id and ba.organization_id = current_organization_id;

  return items;
end;
$$;

create or replace function public.add_booking_accessory(
  target_booking_id uuid,
  target_accessory_id uuid,
  target_quantity integer default 1,
  target_unit_price numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  accessory_row public.accessories%rowtype;
  new_item public.booking_accessories%rowtype;
  final_price numeric;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select * into accessory_row from public.accessories
  where id = target_accessory_id and organization_id = current_organization_id and active = true;
  if not found then
    raise exception using errcode = 'P0002', message = 'ACCESSORY_NOT_FOUND_OR_INACTIVE';
  end if;

  final_price := coalesce(target_unit_price, accessory_row.price);

  insert into public.booking_accessories (
    organization_id, booking_id, accessory_id, quantity, unit_price, status
  ) values (
    current_organization_id, target_booking_id, target_accessory_id,
    greatest(1, coalesce(target_quantity, 1)), final_price, 'ORDERED'
  )
  returning * into new_item;

  return jsonb_build_object(
    'id', new_item.id,
    'booking_id', new_item.booking_id,
    'accessory_id', new_item.accessory_id,
    'name', accessory_row.name,
    'quantity', new_item.quantity,
    'unit_price', new_item.unit_price,
    'status', new_item.status
  );
end;
$$;

create or replace function public.set_booking_accessory_status(
  target_booking_accessory_id uuid,
  target_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  status_val text := upper(trim(target_status));
  updated_item public.booking_accessories%rowtype;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if status_val not in ('ORDERED', 'ALLOCATED', 'FITTED') then
    raise exception using errcode = '22023', message = 'INVALID_ACCESSORY_STATUS';
  end if;

  update public.booking_accessories set
    status = status_val,
    fitted_by = case when status_val = 'FITTED' then auth.uid() else null end,
    fitted_at = case when status_val = 'FITTED' then now() else null end,
    updated_at = now()
  where id = target_booking_accessory_id and organization_id = current_organization_id
  returning * into updated_item;

  if not found then
    raise exception using errcode = 'P0002', message = 'BOOKING_ACCESSORY_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'id', updated_item.id,
    'booking_id', updated_item.booking_id,
    'status', updated_item.status,
    'fitted_at', updated_item.fitted_at
  );
end;
$$;

grant execute on function public.get_accessories_catalog(text, text, integer, integer) to authenticated;
grant execute on function public.upsert_accessory(uuid, text, text, text, numeric, integer, boolean, boolean) to authenticated;
grant execute on function public.get_booking_accessories(uuid) to authenticated;
grant execute on function public.add_booking_accessory(uuid, uuid, integer, numeric) to authenticated;
grant execute on function public.set_booking_accessory_status(uuid, text) to authenticated;
