-- Production stock-check filters for branch-scoped, aggregate-only sales visibility.

create or replace function public.get_stock_check_filter_options(
  target_branch_id uuid default null
)
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

  with scoped_options as materialized (
    select distinct
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      nullif(btrim(variant_row.specifications->>'fuel'), '') as fuel,
      nullif(btrim(variant_row.specifications->>'transmission'), '') as transmission,
      nullif(btrim(stock_row.color), '') as color
    from public.stock_units stock_row
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
  )
  select jsonb_build_object(
    'brands', coalesce((
      select jsonb_agg(option_row.brand_name order by lower(option_row.brand_name))
      from (select distinct brand_name from scoped_options) option_row
    ), '[]'::jsonb),
    'models', coalesce((
      select jsonb_agg(option_row.model_name order by lower(option_row.model_name))
      from (select distinct model_name from scoped_options) option_row
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(option_row.variant_name order by lower(option_row.variant_name))
      from (select distinct variant_name from scoped_options) option_row
    ), '[]'::jsonb),
    'fuels', coalesce((
      select jsonb_agg(option_row.fuel order by lower(option_row.fuel))
      from (select distinct fuel from scoped_options where fuel is not null) option_row
    ), '[]'::jsonb),
    'transmissions', coalesce((
      select jsonb_agg(option_row.transmission order by lower(option_row.transmission))
      from (
        select distinct transmission from scoped_options where transmission is not null
      ) option_row
    ), '[]'::jsonb),
    'colors', coalesce((
      select jsonb_agg(option_row.color order by lower(option_row.color))
      from (select distinct color from scoped_options where color is not null) option_row
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_stock_check_filter_options(uuid) from public, anon;
grant execute on function public.get_stock_check_filter_options(uuid) to authenticated;

create or replace function public.get_stock_check_page_v2(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_availability text default 'ALL',
  target_branch_id uuid default null,
  target_sort text default 'model:asc',
  target_brand text default null,
  target_model text default null,
  target_variant text default null,
  target_fuel text default null,
  target_transmission text default null,
  target_color text default null
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
declare normalized_brand text := lower(btrim(coalesce(target_brand, '')));
declare normalized_model text := lower(btrim(coalesce(target_model, '')));
declare normalized_variant text := lower(btrim(coalesce(target_variant, '')));
declare normalized_fuel text := lower(btrim(coalesce(target_fuel, '')));
declare normalized_transmission text := lower(btrim(coalesce(target_transmission, '')));
declare normalized_color text := lower(btrim(coalesce(target_color, '')));
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
  if char_length(normalized_search) > 100
    or char_length(normalized_brand) > 100
    or char_length(normalized_model) > 100
    or char_length(normalized_variant) > 100
    or char_length(normalized_fuel) > 100
    or char_length(normalized_transmission) > 100
    or char_length(normalized_color) > 100
  then
    raise exception using errcode = '22023', message = 'STOCK_CHECK_FILTER_TOO_LONG';
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
      stock_row.branch_id,
      stock_row.variant_id,
      stock_row.color,
      stock_row.status,
      branch_row.name as branch_name,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      nullif(btrim(variant_row.specifications->>'fuel'), '') as fuel,
      nullif(btrim(variant_row.specifications->>'transmission'), '') as transmission
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
      scoped_row.branch_id, scoped_row.variant_id, scoped_row.branch_name,
      scoped_row.brand_name, scoped_row.model_name, scoped_row.variant_name,
      scoped_row.color, scoped_row.fuel, scoped_row.transmission
  ), filtered_stock as materialized (
    select grouped_row.*
    from grouped_stock grouped_row
    where (normalized_availability = 'ALL' or grouped_row.availability = normalized_availability)
      and (normalized_brand = '' or lower(grouped_row.brand_name) = normalized_brand)
      and (normalized_model = '' or lower(grouped_row.model_name) = normalized_model)
      and (normalized_variant = '' or lower(grouped_row.variant_name) = normalized_variant)
      and (normalized_fuel = '' or lower(coalesce(grouped_row.fuel, '')) = normalized_fuel)
      and (
        normalized_transmission = ''
        or lower(coalesce(grouped_row.transmission, '')) = normalized_transmission
      )
      and (normalized_color = '' or lower(coalesce(grouped_row.color, '')) = normalized_color)
      and (
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
      filtered_row.variant_id, filtered_row.branch_id, coalesce(filtered_row.color, '')
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
          page_row.variant_id, page_row.branch_id, coalesce(page_row.color, '')
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_stock),
    'kpis', jsonb_build_object(
      'available_units', count(*) filter (where scoped_row.status = 'AVAILABLE'),
      'limited_groups', (select count(*) from grouped_stock where availability = 'LIMITED'),
      'incoming_units', count(*) filter (where scoped_row.status in ('INCOMING', 'IN_TRANSIT')),
      'unavailable_groups', (select count(*) from grouped_stock where availability = 'UNAVAILABLE')
    )
  ) into result
  from scoped_units scoped_row;

  return result;
end;
$$;

revoke all on function public.get_stock_check_page_v2(
  text, integer, integer, text, uuid, text, text, text, text, text, text, text
) from public, anon;
grant execute on function public.get_stock_check_page_v2(
  text, integer, integer, text, uuid, text, text, text, text, text, text, text
) to authenticated;
