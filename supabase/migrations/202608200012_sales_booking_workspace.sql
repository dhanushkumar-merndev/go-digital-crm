-- Reference-aligned Sales Consultant booking list with scoped server filters.

create or replace function public.get_sales_booking_filter_options()
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
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not (
    app_private.has_permission(current_organization_id, 'booking.view')
    or app_private.has_permission(current_organization_id, 'booking.manage')
  ) then
    raise exception using errcode = '42501', message = 'BOOKING_VIEW_PERMISSION_REQUIRED';
  end if;

  with scoped as materialized (
    select distinct
      branch_row.id as branch_id,
      branch_row.name as branch_name,
      nullif(btrim(coalesce(model_row.name, lead_row.interested_model, '')), '') as model_name
    from public.bookings booking_row
    join public.branches branch_row
      on branch_row.organization_id = booking_row.organization_id
     and branch_row.id = booking_row.branch_id
     and branch_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.organization_id = booking_row.organization_id
     and lead_row.id = booking_row.lead_id
    left join lateral (
      select stock_model.name
      from public.stock_allocations allocation_row
      join public.stock_units stock_row
        on stock_row.organization_id = allocation_row.organization_id
       and stock_row.id = allocation_row.stock_unit_id
       and stock_row.deleted_at is null
      join public.vehicle_variants variant_row
        on variant_row.organization_id = stock_row.organization_id
       and variant_row.id = stock_row.variant_id
      join public.vehicle_models stock_model
        on stock_model.organization_id = variant_row.organization_id
       and stock_model.id = variant_row.model_id
      where allocation_row.organization_id = booking_row.organization_id
        and allocation_row.booking_id = booking_row.id
        and allocation_row.status in ('ACTIVE', 'RESERVED', 'ALLOCATED')
      order by allocation_row.allocated_at desc, allocation_row.id desc
      limit 1
    ) model_row on true
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
  )
  select jsonb_build_object(
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', branch_id, 'name', branch_name)
        order by lower(branch_name), branch_id)
      from (select distinct branch_id, branch_name from scoped) branch_option
    ), '[]'::jsonb),
    'models', coalesce((
      select jsonb_agg(model_name order by lower(model_name))
      from (select distinct model_name from scoped where model_name is not null) model_option
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.get_sales_booking_workspace_page(
  target_search text default '',
  target_status text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'delivery:asc',
  target_model text default null,
  target_branch_id uuid default null,
  target_from_date date default null,
  target_to_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare normalized_search text := lower(btrim(coalesce(target_search, '')));
declare normalized_model text := lower(btrim(coalesce(target_model, '')));
declare search_uuid uuid;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160 or char_length(normalized_model) > 120
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
    or target_status not in (
      'ALL', 'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED',
      'READY_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'
    )
    or target_sort not in (
      'updated:desc', 'updated:asc', 'amount:desc', 'amount:asc',
      'delivery:asc', 'delivery:desc', 'customer:asc', 'customer:desc'
    )
    or (target_from_date is not null and target_to_date is not null
      and target_to_date < target_from_date)
    or (target_from_date is not null and target_from_date < current_date - 3650)
    or (target_to_date is not null and target_to_date > current_date + 3650)
  then
    raise exception using errcode = '22023', message = 'INVALID_BOOKING_QUERY';
  end if;
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not (
    app_private.has_permission(current_organization_id, 'booking.view')
    or app_private.has_permission(current_organization_id, 'booking.manage')
  ) then
    raise exception using errcode = '42501', message = 'BOOKING_VIEW_PERMISSION_REQUIRED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'BOOKING_BRANCH_SCOPE_DENIED';
  end if;

  with base_scope as materialized (
    select
      booking_row.id,
      booking_row.organization_id,
      booking_row.branch_id,
      booking_row.team_id,
      booking_row.customer_id,
      booking_row.lead_id,
      booking_row.quotation_id,
      booking_row.assigned_user_id,
      booking_row.booking_number,
      quotation_row.quotation_number,
      booking_row.status,
      booking_row.booking_amount,
      booking_row.total_value,
      booking_row.finance_required,
      booking_row.exchange_required,
      booking_row.expected_delivery_date,
      booking_row.version,
      booking_row.created_at,
      booking_row.updated_at,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as assigned_user_name,
      coalesce(allocation_data.model_name, lead_row.interested_model) as interested_model,
      coalesce(allocation_data.variant_name, vehicle_item.description) as vehicle_variant,
      allocation_data.color as colour
    from public.bookings booking_row
    join public.customers customer_row
      on customer_row.id = booking_row.customer_id
     and customer_row.organization_id = booking_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = booking_row.branch_id
     and branch_row.organization_id = booking_row.organization_id
     and branch_row.deleted_at is null
    left join public.teams team_row
      on team_row.id = booking_row.team_id
     and team_row.organization_id = booking_row.organization_id
    join public.profiles profile_row
      on profile_row.id = booking_row.assigned_user_id
     and profile_row.organization_id = booking_row.organization_id
    left join public.quotations quotation_row
      on quotation_row.id = booking_row.quotation_id
     and quotation_row.organization_id = booking_row.organization_id
    left join public.leads lead_row
      on lead_row.id = booking_row.lead_id
     and lead_row.organization_id = booking_row.organization_id
    left join lateral (
      select item_row.description
      from public.quotation_items item_row
      where item_row.organization_id = booking_row.organization_id
        and item_row.quotation_id = booking_row.quotation_id
        and item_row.item_type = 'VEHICLE'
        and item_row.deleted_at is null
      order by item_row.created_at, item_row.id
      limit 1
    ) vehicle_item on true
    left join lateral (
      select model_row.name as model_name, variant_row.name as variant_name, stock_row.color
      from public.stock_allocations allocation_row
      join public.stock_units stock_row
        on stock_row.organization_id = allocation_row.organization_id
       and stock_row.id = allocation_row.stock_unit_id
       and stock_row.deleted_at is null
      join public.vehicle_variants variant_row
        on variant_row.organization_id = stock_row.organization_id
       and variant_row.id = stock_row.variant_id
      join public.vehicle_models model_row
        on model_row.organization_id = variant_row.organization_id
       and model_row.id = variant_row.model_id
      where allocation_row.organization_id = booking_row.organization_id
        and allocation_row.booking_id = booking_row.id
        and allocation_row.status in ('ACTIVE', 'RESERVED', 'ALLOCATED')
      order by allocation_row.allocated_at desc, allocation_row.id desc
      limit 1
    ) allocation_data on true
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
      and (target_branch_id is null or booking_row.branch_id = target_branch_id)
      and (target_from_date is null or booking_row.created_at::date >= target_from_date)
      and (target_to_date is null or booking_row.created_at::date <= target_to_date)
  ), searched_scope as materialized (
    select base_row.*
    from base_scope base_row
    where (normalized_model = '' or lower(coalesce(base_row.interested_model, '')) = normalized_model)
      and (
        normalized_search = ''
        or base_row.id = search_uuid
        or position(normalized_search in lower(base_row.booking_number)) > 0
        or position(normalized_search in lower(coalesce(base_row.quotation_number, ''))) > 0
        or position(normalized_search in lower(base_row.customer_name)) > 0
        or position(normalized_search in lower(coalesce(base_row.interested_model, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and position(
            app_private.normalize_phone_digits(normalized_search)
            in app_private.normalize_phone_digits(base_row.phone)
          ) > 0
        )
      )
  ), filtered as materialized (
    select searched_row.* from searched_scope searched_row
    where target_status = 'ALL' or searched_row.status = target_status
  ), page_rows as (
    select filtered_row.*
    from filtered filtered_row
    order by
      case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
      case when target_sort = 'updated:asc' then filtered_row.updated_at end asc,
      case when target_sort = 'amount:desc' then filtered_row.total_value end desc nulls last,
      case when target_sort = 'amount:asc' then filtered_row.total_value end asc nulls last,
      case when target_sort = 'delivery:asc' then filtered_row.expected_delivery_date end asc nulls last,
      case when target_sort = 'delivery:desc' then filtered_row.expected_delivery_date end desc nulls last,
      case when target_sort = 'customer:asc' then lower(filtered_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(filtered_row.customer_name) end desc,
      filtered_row.id desc
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((select jsonb_agg(to_jsonb(page_row) order by
      case when target_sort = 'updated:desc' then page_row.updated_at end desc,
      case when target_sort = 'updated:asc' then page_row.updated_at end asc,
      case when target_sort = 'amount:desc' then page_row.total_value end desc nulls last,
      case when target_sort = 'amount:asc' then page_row.total_value end asc nulls last,
      case when target_sort = 'delivery:asc' then page_row.expected_delivery_date end asc nulls last,
      case when target_sort = 'delivery:desc' then page_row.expected_delivery_date end desc nulls last,
      case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(page_row.customer_name) end desc,
      page_row.id desc
    ) from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'kpis', jsonb_build_object(
      'bookings', (select count(*) from searched_scope where status <> 'CANCELLED'),
      'booking_value', (select coalesce(sum(total_value), 0) from searched_scope where status <> 'CANCELLED'),
      'awaiting_allocation', (select count(*) from searched_scope where status = 'AWAITING_ALLOCATION'),
      'delivery_this_week', (select count(*) from searched_scope where status = 'READY_FOR_DELIVERY'
        and expected_delivery_date between current_date and current_date + 7),
      'delivered', (select count(*) from searched_scope where status = 'DELIVERED'),
      'pending', (select count(*) from searched_scope where status = 'AWAITING_ALLOCATION'),
      'confirmed', (select count(*) from searched_scope where status = 'CONFIRMED'),
      'ready_for_delivery', (select count(*) from searched_scope where status = 'READY_FOR_DELIVERY'),
      'delivered_this_month', (select count(*) from searched_scope where status = 'DELIVERED'
        and date_trunc('month', updated_at) = date_trunc('month', now()))
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_sales_booking_filter_options() from public, anon;
grant execute on function public.get_sales_booking_filter_options() to authenticated;
revoke all on function public.get_sales_booking_workspace_page(
  text, text, integer, integer, text, text, uuid, date, date
) from public, anon;
grant execute on function public.get_sales_booking_workspace_page(
  text, text, integer, integer, text, text, uuid, date, date
) to authenticated;
