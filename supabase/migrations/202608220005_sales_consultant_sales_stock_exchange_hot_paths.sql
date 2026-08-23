begin;

-- Keep the deployed behavior available for every non-Sales Consultant role.
-- Public wrappers below select the direct-owner fast path only after resolving
-- the authenticated CRM role; the legacy functions are not client-executable.
alter function public.get_quotation_workspace_page(
  text, text, integer, integer, text
) rename to get_quotation_workspace_page_legacy;
revoke all on function public.get_quotation_workspace_page_legacy(
  text, text, integer, integer, text
) from public, anon, authenticated;

alter function public.get_sales_booking_filter_options()
  rename to get_sales_booking_filter_options_legacy;
revoke all on function public.get_sales_booking_filter_options_legacy()
  from public, anon, authenticated;

alter function public.get_sales_booking_workspace_page(
  text, text, integer, integer, text, text, uuid, date, date
) rename to get_sales_booking_workspace_page_legacy;
revoke all on function public.get_sales_booking_workspace_page_legacy(
  text, text, integer, integer, text, text, uuid, date, date
) from public, anon, authenticated;

alter function public.get_stock_check_filter_options(uuid)
  rename to get_stock_check_filter_options_legacy;
revoke all on function public.get_stock_check_filter_options_legacy(uuid)
  from public, anon, authenticated;

alter function public.get_stock_check_page_v2(
  text, integer, integer, text, uuid, text,
  text, text, text, text, text, text
) rename to get_stock_check_page_v2_legacy;
revoke all on function public.get_stock_check_page_v2_legacy(
  text, integer, integer, text, uuid, text,
  text, text, text, text, text, text
) from public, anon, authenticated;

alter function public.get_sales_exchange_options(text, integer)
  rename to get_sales_exchange_options_legacy;
revoke all on function public.get_sales_exchange_options_legacy(text, integer)
  from public, anon, authenticated;

-- The owner/branch candidate set is filtered and paged before quotation item
-- JSON and display joins execute. The preceding soft-delete contract migration
-- provides the quotations.deleted_at predicate used by the partial indexes.
create or replace function app_private.get_sales_consultant_quotation_workspace_page(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_can_view_customer boolean,
  target_search text,
  target_status text,
  target_page integer,
  target_page_size integer,
  target_sort text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_phone_search text;
  search_uuid uuid;
  page_ids uuid[];
  result jsonb;
begin
  if target_organization_id is null
    or target_user_id is null
    or char_length(normalized_search) > 160
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
    or target_status not in (
      'ALL', 'DRAFT', 'PENDING_APPROVAL', 'SENT', 'ACCEPTED',
      'REJECTED', 'EXPIRED', 'CONVERTED'
    )
    or target_sort not in (
      'updated:desc', 'updated:asc', 'amount:desc', 'amount:asc',
      'customer:asc', 'customer:desc'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_QUOTATION_QUERY';
  end if;

  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  normalized_phone_search := app_private.normalize_phone_digits(normalized_search);

  -- Keep the default page path on the owner/updated index even after PL/pgSQL
  -- switches to a generic cached plan. Only the bounded IDs flow into display
  -- joins and quotation-item JSON below.
  if target_sort = 'updated:desc' and normalized_search = '' then
    select coalesce(array_agg(candidate_row.id), '{}'::uuid[])
      into page_ids
    from (
      select quotation_row.id
      from public.quotations quotation_row
      join public.customers customer_row
        on customer_row.organization_id = quotation_row.organization_id
       and customer_row.id = quotation_row.customer_id
       and customer_row.deleted_at is null
      where quotation_row.organization_id = target_organization_id
        and quotation_row.assigned_user_id = target_user_id
        and quotation_row.branch_id = any(target_branch_ids)
        and quotation_row.deleted_at is null
        and (target_status = 'ALL' or quotation_row.status = target_status)
      order by quotation_row.updated_at desc, quotation_row.id desc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    ) candidate_row;
  else
    select coalesce(array_agg(candidate_row.id), '{}'::uuid[])
      into page_ids
    from (
      select
        quotation_row.id,
        quotation_row.updated_at,
        quotation_row.total_amount,
        customer_row.normalized_name as customer_sort_name
      from public.quotations quotation_row
      join public.customers customer_row
        on customer_row.organization_id = quotation_row.organization_id
       and customer_row.id = quotation_row.customer_id
       and customer_row.deleted_at is null
      where quotation_row.organization_id = target_organization_id
        and quotation_row.assigned_user_id = target_user_id
        and quotation_row.branch_id = any(target_branch_ids)
        and quotation_row.deleted_at is null
        and (target_status = 'ALL' or quotation_row.status = target_status)
        and (
          normalized_search = ''
          or quotation_row.id = search_uuid
          or position(normalized_search in lower(quotation_row.quotation_number)) > 0
          or (
            target_can_view_customer
            and customer_row.normalized_name like '%' || normalized_search || '%'
          )
          or (
            target_can_view_customer
            and normalized_phone_search <> ''
            and customer_row.normalized_phone = normalized_phone_search
          )
        )
      order by
        case when target_sort = 'updated:desc' then quotation_row.updated_at end desc,
        case when target_sort = 'updated:asc' then quotation_row.updated_at end asc,
        case when target_sort = 'amount:desc' then quotation_row.total_amount end desc,
        case when target_sort = 'amount:asc' then quotation_row.total_amount end asc,
        case when target_sort = 'customer:asc' and target_can_view_customer
          then customer_row.normalized_name end asc nulls last,
        case when target_sort = 'customer:desc' and target_can_view_customer
          then customer_row.normalized_name end desc nulls last,
        quotation_row.id desc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    ) candidate_row;
  end if;

  with filtered_rows as materialized (
    select
      quotation_row.status,
      quotation_row.total_amount,
      coalesce(quotation_row.approval_status, 'NOT_REQUIRED') as approval_status
    from public.quotations quotation_row
    join public.customers customer_row
      on customer_row.organization_id = quotation_row.organization_id
     and customer_row.id = quotation_row.customer_id
     and customer_row.deleted_at is null
    where quotation_row.organization_id = target_organization_id
      and quotation_row.assigned_user_id = target_user_id
      and quotation_row.branch_id = any(target_branch_ids)
      and quotation_row.deleted_at is null
      and (target_status = 'ALL' or quotation_row.status = target_status)
      and (
        normalized_search = ''
        or quotation_row.id = search_uuid
        or position(normalized_search in lower(quotation_row.quotation_number)) > 0
        or (
          target_can_view_customer
          and customer_row.normalized_name like '%' || normalized_search || '%'
        )
        or (
          target_can_view_customer
          and normalized_phone_search <> ''
          and customer_row.normalized_phone = normalized_phone_search
        )
      )
  ), page_rows as materialized (
    select
      quotation_row.id,
      quotation_row.organization_id,
      quotation_row.branch_id,
      quotation_row.team_id,
      quotation_row.customer_id,
      quotation_row.lead_id,
      quotation_row.assigned_user_id,
      quotation_row.quotation_number,
      quotation_row.status,
      quotation_row.current_version,
      quotation_row.version,
      quotation_row.total_amount,
      coalesce(quotation_row.approval_status, 'NOT_REQUIRED') as approval_status,
      quotation_row.created_at,
      quotation_row.updated_at,
      case when target_can_view_customer then customer_row.normalized_name end
        as customer_sort_name
    from public.quotations quotation_row
    join public.customers customer_row
      on customer_row.organization_id = quotation_row.organization_id
     and customer_row.id = quotation_row.customer_id
     and customer_row.deleted_at is null
    where quotation_row.organization_id = target_organization_id
      and quotation_row.assigned_user_id = target_user_id
      and quotation_row.branch_id = any(target_branch_ids)
      and quotation_row.id = any(page_ids)
      and quotation_row.deleted_at is null
      and (target_status = 'ALL' or quotation_row.status = target_status)
  ), enriched_page as (
    select
      page_row.*,
      case when target_can_view_customer
        then customer_row.full_name else 'Restricted' end as customer_name,
      case when target_can_view_customer
        then customer_row.primary_phone else null end as phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as assigned_user_name,
      lead_row.interested_model,
      coalesce(item_data.items, '[]'::jsonb) as items
    from page_rows page_row
    join public.customers customer_row
      on customer_row.organization_id = page_row.organization_id
     and customer_row.id = page_row.customer_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.organization_id = page_row.organization_id
     and branch_row.id = page_row.branch_id
    left join public.teams team_row
      on team_row.organization_id = page_row.organization_id
     and team_row.id = page_row.team_id
    join public.profiles profile_row
      on profile_row.organization_id = page_row.organization_id
     and profile_row.id = page_row.assigned_user_id
    left join public.leads lead_row
      on lead_row.organization_id = page_row.organization_id
     and lead_row.id = page_row.lead_id
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'item_type', item_row.item_type,
        'description', item_row.description,
        'quantity', item_row.quantity,
        'unit_price', item_row.unit_price,
        'adjustment', item_row.adjustment
      ) order by item_row.created_at, item_row.id) as items
      from public.quotation_items item_row
      where item_row.organization_id = page_row.organization_id
        and item_row.quotation_id = page_row.id
        and item_row.deleted_at is null
    ) item_data on true
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', page_row.id,
        'organization_id', page_row.organization_id,
        'branch_id', page_row.branch_id,
        'team_id', page_row.team_id,
        'customer_id', page_row.customer_id,
        'lead_id', page_row.lead_id,
        'assigned_user_id', page_row.assigned_user_id,
        'quotation_number', page_row.quotation_number,
        'status', page_row.status,
        'current_version', page_row.current_version,
        'version', page_row.version,
        'total_amount', page_row.total_amount,
        'approval_status', page_row.approval_status,
        'created_at', page_row.created_at,
        'updated_at', page_row.updated_at,
        'customer_name', page_row.customer_name,
        'phone', page_row.phone,
        'branch_name', page_row.branch_name,
        'team_name', page_row.team_name,
        'assigned_user_name', page_row.assigned_user_name,
        'interested_model', page_row.interested_model,
        'items', page_row.items
      ) order by
        case when target_sort = 'updated:desc' then page_row.updated_at end desc,
        case when target_sort = 'updated:asc' then page_row.updated_at end asc,
        case when target_sort = 'amount:desc' then page_row.total_amount end desc,
        case when target_sort = 'amount:asc' then page_row.total_amount end asc,
        case when target_sort = 'customer:asc'
          then page_row.customer_sort_name end asc nulls last,
        case when target_sort = 'customer:desc'
          then page_row.customer_sort_name end desc nulls last,
        page_row.id desc
      )
      from enriched_page page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_rows),
    'kpis', jsonb_build_object(
      'open', (select count(*) from filtered_rows
        where status in ('DRAFT', 'PENDING_APPROVAL', 'SENT')),
      'sent', (select count(*) from filtered_rows where status = 'SENT'),
      'approval_required', (select count(*) from filtered_rows
        where approval_status = 'PENDING'),
      'converted', (select count(*) from filtered_rows where status = 'CONVERTED'),
      'pipeline_value', (select coalesce(sum(total_amount), 0)
        from filtered_rows where status in ('SENT', 'ACCEPTED'))
    )
  ) into result;

  return result;
end;
$$;

revoke all on function app_private.get_sales_consultant_quotation_workspace_page(
  uuid, uuid, uuid[], boolean, text, text, integer, integer, text
) from public, anon, authenticated;

create or replace function public.get_quotation_workspace_page(
  target_search text default '',
  target_status text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'updated:desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb := public.get_access_context();
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  can_view_customer boolean;
begin
  if access_context->>'role_key' = 'sales-consultant' then
    if auth.uid() is null
      or access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'QUOTATION_VIEW_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(
      current_organization_id
    );
    if not (
      'quotation.view' = any(permission_keys)
      or 'quotation.manage' = any(permission_keys)
    ) then
      raise exception using errcode = '42501', message = 'QUOTATION_VIEW_PERMISSION_REQUIRED';
    end if;
    can_view_customer := 'customer.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    return app_private.get_sales_consultant_quotation_workspace_page(
      current_organization_id,
      auth.uid(),
      allowed_branch_ids,
      can_view_customer,
      target_search,
      target_status,
      target_page,
      target_page_size,
      target_sort
    );
  end if;

  return public.get_quotation_workspace_page_legacy(
    target_search,
    target_status,
    target_page,
    target_page_size,
    target_sort
  );
end;
$$;

revoke all on function public.get_quotation_workspace_page(
  text, text, integer, integer, text
) from public, anon;
grant execute on function public.get_quotation_workspace_page(
  text, text, integer, integer, text
) to authenticated;

-- Booking filter options stay aggregate-only. Direct ownership replaces the
-- non-inlinable per-row record helper, and allocation enrichment runs only for
-- the consultant's bounded tenant slice.
create or replace function app_private.get_sales_consultant_booking_filter_options(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with owned_bookings as materialized (
    select
      booking_row.id,
      booking_row.organization_id,
      booking_row.branch_id,
      booking_row.lead_id
    from public.bookings booking_row
    where booking_row.organization_id = target_organization_id
      and booking_row.assigned_user_id = target_user_id
      and booking_row.branch_id = any(target_branch_ids)
      and booking_row.deleted_at is null
  ), branch_options as (
    select distinct branch_row.id, branch_row.name
    from owned_bookings booking_row
    join public.branches branch_row
      on branch_row.organization_id = booking_row.organization_id
     and branch_row.id = booking_row.branch_id
     and branch_row.deleted_at is null
  ), latest_allocation_models as materialized (
    select distinct on (allocation_row.booking_id)
      allocation_row.booking_id,
      model_row.name as model_name
    from public.stock_allocations allocation_row
    join owned_bookings booking_row
      on booking_row.organization_id = allocation_row.organization_id
     and booking_row.id = allocation_row.booking_id
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
    where allocation_row.organization_id = target_organization_id
      and allocation_row.status in ('ACTIVE', 'RESERVED', 'ALLOCATED')
    order by
      allocation_row.booking_id,
      allocation_row.allocated_at desc,
      allocation_row.id desc
  ), model_options as (
    select distinct nullif(btrim(coalesce(
      allocation_row.model_name,
      lead_row.interested_model,
      ''
    )), '') as model_name
    from owned_bookings booking_row
    left join public.leads lead_row
      on lead_row.organization_id = booking_row.organization_id
     and lead_row.id = booking_row.lead_id
    left join latest_allocation_models allocation_row
      on allocation_row.booking_id = booking_row.id
  )
  select jsonb_build_object(
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', option_row.id, 'name', option_row.name)
        order by lower(option_row.name), option_row.id)
      from (
        select branch_row.*
        from branch_options branch_row
        order by lower(branch_row.name), branch_row.id
        limit 100
      ) option_row
    ), '[]'::jsonb),
    'models', coalesce((
      select jsonb_agg(option_row.model_name order by lower(option_row.model_name))
      from (
        select model_row.model_name
        from model_options model_row
        where model_row.model_name is not null
        order by lower(model_row.model_name)
        limit 100
      ) option_row
    ), '[]'::jsonb)
  );
$$;

revoke all on function app_private.get_sales_consultant_booking_filter_options(
  uuid, uuid, uuid[]
) from public, anon, authenticated;

create or replace function public.get_sales_booking_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb := public.get_access_context();
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
begin
  if access_context->>'role_key' = 'sales-consultant' then
    if auth.uid() is null
      or access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'BOOKING_VIEW_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(
      current_organization_id
    );
    if not (
      'booking.view' = any(permission_keys)
      or 'booking.manage' = any(permission_keys)
    ) then
      raise exception using errcode = '42501', message = 'BOOKING_VIEW_PERMISSION_REQUIRED';
    end if;
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    return app_private.get_sales_consultant_booking_filter_options(
      current_organization_id,
      auth.uid(),
      allowed_branch_ids
    );
  end if;

  return public.get_sales_booking_filter_options_legacy();
end;
$$;

revoke all on function public.get_sales_booking_filter_options()
  from public, anon;
grant execute on function public.get_sales_booking_filter_options()
  to authenticated;

-- For the booking list, date predicates stay sargable and active allocation /
-- quotation-item detail is evaluated after page selection unless a model or
-- search filter explicitly needs the latest allocation model.
create or replace function app_private.get_sales_consultant_booking_workspace_page(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_can_view_customer boolean,
  target_search text,
  target_status text,
  target_page integer,
  target_page_size integer,
  target_sort text,
  target_model text,
  target_branch_id uuid,
  target_from_date date,
  target_to_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_phone_search text;
  normalized_model text := lower(btrim(coalesce(target_model, '')));
  search_uuid uuid;
  page_ids uuid[];
  from_timestamp timestamptz;
  to_timestamp_exclusive timestamptz;
  month_start timestamptz := date_trunc('month', now());
  next_month_start timestamptz := date_trunc('month', now()) + interval '1 month';
  result jsonb;
begin
  if target_organization_id is null
    or target_user_id is null
    or char_length(normalized_search) > 160
    or char_length(normalized_model) > 120
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
    or (target_branch_id is not null and not (target_branch_id = any(target_branch_ids)))
  then
    raise exception using errcode = '22023', message = 'INVALID_BOOKING_QUERY';
  end if;

  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  normalized_phone_search := app_private.normalize_phone_digits(normalized_search);
  if target_from_date is not null then
    from_timestamp := target_from_date::timestamp;
  end if;
  if target_to_date is not null then
    to_timestamp_exclusive := (target_to_date + 1)::timestamp;
  end if;

  -- The default list never materializes the consultant's full booking history
  -- to discover a page. It stops on the owner/updated index, while KPI scans
  -- below remain independent and can use the narrower covering indexes.
  if target_sort = 'updated:desc'
    and normalized_search = ''
    and normalized_model = ''
  then
    select coalesce(array_agg(candidate_row.id), '{}'::uuid[])
      into page_ids
    from (
      select booking_row.id
      from public.bookings booking_row
      join public.customers customer_row
        on customer_row.organization_id = booking_row.organization_id
       and customer_row.id = booking_row.customer_id
       and customer_row.deleted_at is null
      where booking_row.organization_id = target_organization_id
        and booking_row.assigned_user_id = target_user_id
        and booking_row.branch_id = any(target_branch_ids)
        and booking_row.deleted_at is null
        and (target_status = 'ALL' or booking_row.status = target_status)
        and (target_branch_id is null or booking_row.branch_id = target_branch_id)
        and (from_timestamp is null or booking_row.created_at >= from_timestamp)
        and (to_timestamp_exclusive is null
          or booking_row.created_at < to_timestamp_exclusive)
      order by booking_row.updated_at desc, booking_row.id desc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    ) candidate_row;
  else
    select coalesce(array_agg(candidate_row.id), '{}'::uuid[])
      into page_ids
    from (
      select booking_row.id
      from public.bookings booking_row
      join public.customers customer_row
        on customer_row.organization_id = booking_row.organization_id
       and customer_row.id = booking_row.customer_id
       and customer_row.deleted_at is null
      left join public.quotations quotation_row
        on quotation_row.organization_id = booking_row.organization_id
       and quotation_row.id = booking_row.quotation_id
       and quotation_row.deleted_at is null
      left join public.leads lead_row
        on lead_row.organization_id = booking_row.organization_id
       and lead_row.id = booking_row.lead_id
      left join lateral (
        select model_row.name as model_name
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
      ) allocation_filter
        on normalized_model <> '' or normalized_search <> ''
      where booking_row.organization_id = target_organization_id
        and booking_row.assigned_user_id = target_user_id
        and booking_row.branch_id = any(target_branch_ids)
        and booking_row.deleted_at is null
        and (target_status = 'ALL' or booking_row.status = target_status)
        and (target_branch_id is null or booking_row.branch_id = target_branch_id)
        and (from_timestamp is null or booking_row.created_at >= from_timestamp)
        and (to_timestamp_exclusive is null
          or booking_row.created_at < to_timestamp_exclusive)
        and (
          normalized_model = ''
          or lower(coalesce(allocation_filter.model_name, lead_row.interested_model, ''))
            = normalized_model
        )
        and (
          normalized_search = ''
          or booking_row.id = search_uuid
          or position(normalized_search in lower(booking_row.booking_number)) > 0
          or position(normalized_search in lower(coalesce(quotation_row.quotation_number, ''))) > 0
          or position(normalized_search in lower(coalesce(
            allocation_filter.model_name,
            lead_row.interested_model,
            ''
          ))) > 0
          or (
            target_can_view_customer
            and customer_row.normalized_name like '%' || normalized_search || '%'
          )
          or (
            target_can_view_customer
            and normalized_phone_search <> ''
            and position(normalized_phone_search in coalesce(customer_row.normalized_phone, '')) > 0
          )
        )
      order by
        case when target_sort = 'updated:desc' then booking_row.updated_at end desc,
        case when target_sort = 'updated:asc' then booking_row.updated_at end asc,
        case when target_sort = 'amount:desc'
          then booking_row.total_value end desc nulls last,
        case when target_sort = 'amount:asc'
          then booking_row.total_value end asc nulls last,
        case when target_sort = 'delivery:asc'
          then booking_row.expected_delivery_date end asc nulls last,
        case when target_sort = 'delivery:desc'
          then booking_row.expected_delivery_date end desc nulls last,
        case when target_sort = 'customer:asc' and target_can_view_customer
          then customer_row.normalized_name end asc nulls last,
        case when target_sort = 'customer:desc' and target_can_view_customer
          then customer_row.normalized_name end desc nulls last,
        booking_row.id desc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    ) candidate_row;
  end if;

  with searched_rows as materialized (
    select
      booking_row.status,
      booking_row.total_value,
      booking_row.expected_delivery_date,
      booking_row.updated_at
    from public.bookings booking_row
    join public.customers customer_row
      on customer_row.organization_id = booking_row.organization_id
     and customer_row.id = booking_row.customer_id
     and customer_row.deleted_at is null
    left join public.quotations quotation_row
      on quotation_row.organization_id = booking_row.organization_id
     and quotation_row.id = booking_row.quotation_id
     and quotation_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.organization_id = booking_row.organization_id
     and lead_row.id = booking_row.lead_id
    left join lateral (
      select model_row.name as model_name
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
    ) allocation_filter
      on normalized_model <> '' or normalized_search <> ''
    where booking_row.organization_id = target_organization_id
      and booking_row.assigned_user_id = target_user_id
      and booking_row.branch_id = any(target_branch_ids)
      and booking_row.deleted_at is null
      and (target_branch_id is null or booking_row.branch_id = target_branch_id)
      and (from_timestamp is null or booking_row.created_at >= from_timestamp)
      and (to_timestamp_exclusive is null
        or booking_row.created_at < to_timestamp_exclusive)
      and (
        normalized_model = ''
        or lower(coalesce(allocation_filter.model_name, lead_row.interested_model, ''))
          = normalized_model
      )
      and (
        normalized_search = ''
        or booking_row.id = search_uuid
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or position(normalized_search in lower(coalesce(quotation_row.quotation_number, ''))) > 0
        or position(normalized_search in lower(coalesce(
          allocation_filter.model_name,
          lead_row.interested_model,
          ''
        ))) > 0
        or (
          target_can_view_customer
          and customer_row.normalized_name like '%' || normalized_search || '%'
        )
        or (
          target_can_view_customer
          and normalized_phone_search <> ''
          and position(normalized_phone_search in coalesce(customer_row.normalized_phone, '')) > 0
        )
      )
  ), filtered_rows as materialized (
    select searched_row.*
    from searched_rows searched_row
    where target_status = 'ALL' or searched_row.status = target_status
  ), page_rows as materialized (
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
      booking_row.status,
      booking_row.booking_amount,
      booking_row.total_value,
      booking_row.finance_required,
      booking_row.exchange_required,
      booking_row.expected_delivery_date,
      booking_row.version,
      booking_row.created_at,
      booking_row.updated_at,
      quotation_row.quotation_number,
      case when target_can_view_customer then customer_row.normalized_name end
        as customer_sort_name
    from public.bookings booking_row
    join public.customers customer_row
      on customer_row.organization_id = booking_row.organization_id
     and customer_row.id = booking_row.customer_id
     and customer_row.deleted_at is null
    left join public.quotations quotation_row
      on quotation_row.organization_id = booking_row.organization_id
     and quotation_row.id = booking_row.quotation_id
     and quotation_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.organization_id = booking_row.organization_id
     and lead_row.id = booking_row.lead_id
    left join lateral (
      select model_row.name as model_name
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
    ) allocation_filter
      on normalized_model <> '' or normalized_search <> ''
    where booking_row.organization_id = target_organization_id
      and booking_row.assigned_user_id = target_user_id
      and booking_row.branch_id = any(target_branch_ids)
      and booking_row.id = any(page_ids)
      and booking_row.deleted_at is null
      and (target_status = 'ALL' or booking_row.status = target_status)
      and (target_branch_id is null or booking_row.branch_id = target_branch_id)
      and (from_timestamp is null or booking_row.created_at >= from_timestamp)
      and (to_timestamp_exclusive is null
        or booking_row.created_at < to_timestamp_exclusive)
      and (
        normalized_model = ''
        or lower(coalesce(allocation_filter.model_name, lead_row.interested_model, ''))
          = normalized_model
      )
      and (
        normalized_search = ''
        or booking_row.id = search_uuid
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or position(normalized_search in lower(coalesce(quotation_row.quotation_number, ''))) > 0
        or position(normalized_search in lower(coalesce(
          allocation_filter.model_name,
          lead_row.interested_model,
          ''
        ))) > 0
        or (
          target_can_view_customer
          and customer_row.normalized_name like '%' || normalized_search || '%'
        )
        or (
          target_can_view_customer
          and normalized_phone_search <> ''
          and position(normalized_phone_search in coalesce(customer_row.normalized_phone, '')) > 0
        )
      )
    order by
      case when target_sort = 'updated:desc' then booking_row.updated_at end desc,
      case when target_sort = 'updated:asc' then booking_row.updated_at end asc,
      case when target_sort = 'amount:desc'
        then booking_row.total_value end desc nulls last,
      case when target_sort = 'amount:asc'
        then booking_row.total_value end asc nulls last,
      case when target_sort = 'delivery:asc'
        then booking_row.expected_delivery_date end asc nulls last,
      case when target_sort = 'delivery:desc'
        then booking_row.expected_delivery_date end desc nulls last,
      case when target_sort = 'customer:asc'
        and target_can_view_customer
        then customer_row.normalized_name end asc nulls last,
      case when target_sort = 'customer:desc'
        and target_can_view_customer
        then customer_row.normalized_name end desc nulls last,
      booking_row.id desc
    limit target_page_size
  ), enriched_page as (
    select
      page_row.*,
      case when target_can_view_customer
        then customer_row.full_name else 'Restricted' end as customer_name,
      case when target_can_view_customer
        then customer_row.primary_phone else null end as phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as assigned_user_name,
      coalesce(allocation_data.model_name, lead_row.interested_model)
        as interested_model,
      coalesce(allocation_data.variant_name, vehicle_item.description)
        as vehicle_variant,
      allocation_data.color as colour
    from page_rows page_row
    join public.customers customer_row
      on customer_row.organization_id = page_row.organization_id
     and customer_row.id = page_row.customer_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.organization_id = page_row.organization_id
     and branch_row.id = page_row.branch_id
     and branch_row.deleted_at is null
    left join public.teams team_row
      on team_row.organization_id = page_row.organization_id
     and team_row.id = page_row.team_id
    join public.profiles profile_row
      on profile_row.organization_id = page_row.organization_id
     and profile_row.id = page_row.assigned_user_id
    left join public.leads lead_row
      on lead_row.organization_id = page_row.organization_id
     and lead_row.id = page_row.lead_id
    left join lateral (
      select item_row.description
      from public.quotation_items item_row
      where item_row.organization_id = page_row.organization_id
        and item_row.quotation_id = page_row.quotation_id
        and item_row.item_type = 'VEHICLE'
        and item_row.deleted_at is null
      order by item_row.created_at, item_row.id
      limit 1
    ) vehicle_item on true
    left join lateral (
      select
        model_row.name as model_name,
        variant_row.name as variant_name,
        stock_row.color
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
      where allocation_row.organization_id = page_row.organization_id
        and allocation_row.booking_id = page_row.id
        and allocation_row.status in ('ACTIVE', 'RESERVED', 'ALLOCATED')
      order by allocation_row.allocated_at desc, allocation_row.id desc
      limit 1
    ) allocation_data on true
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', page_row.id,
        'organization_id', page_row.organization_id,
        'branch_id', page_row.branch_id,
        'team_id', page_row.team_id,
        'customer_id', page_row.customer_id,
        'lead_id', page_row.lead_id,
        'quotation_id', page_row.quotation_id,
        'assigned_user_id', page_row.assigned_user_id,
        'booking_number', page_row.booking_number,
        'quotation_number', page_row.quotation_number,
        'status', page_row.status,
        'booking_amount', page_row.booking_amount,
        'total_value', page_row.total_value,
        'finance_required', page_row.finance_required,
        'exchange_required', page_row.exchange_required,
        'expected_delivery_date', page_row.expected_delivery_date,
        'version', page_row.version,
        'created_at', page_row.created_at,
        'updated_at', page_row.updated_at,
        'customer_name', page_row.customer_name,
        'phone', page_row.phone,
        'branch_name', page_row.branch_name,
        'team_name', page_row.team_name,
        'assigned_user_name', page_row.assigned_user_name,
        'interested_model', page_row.interested_model,
        'vehicle_variant', page_row.vehicle_variant,
        'colour', page_row.colour
      ) order by
        case when target_sort = 'updated:desc' then page_row.updated_at end desc,
        case when target_sort = 'updated:asc' then page_row.updated_at end asc,
        case when target_sort = 'amount:desc'
          then page_row.total_value end desc nulls last,
        case when target_sort = 'amount:asc'
          then page_row.total_value end asc nulls last,
        case when target_sort = 'delivery:asc'
          then page_row.expected_delivery_date end asc nulls last,
        case when target_sort = 'delivery:desc'
          then page_row.expected_delivery_date end desc nulls last,
        case when target_sort = 'customer:asc'
          then page_row.customer_sort_name end asc nulls last,
        case when target_sort = 'customer:desc'
          then page_row.customer_sort_name end desc nulls last,
        page_row.id desc
      )
      from enriched_page page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_rows),
    'kpis', jsonb_build_object(
      'bookings', (select count(*) from searched_rows where status <> 'CANCELLED'),
      'booking_value', (select coalesce(sum(total_value), 0)
        from searched_rows where status <> 'CANCELLED'),
      'awaiting_allocation', (select count(*) from searched_rows
        where status = 'AWAITING_ALLOCATION'),
      'delivery_this_week', (select count(*) from searched_rows
        where status = 'READY_FOR_DELIVERY'
          and expected_delivery_date between current_date and current_date + 7),
      'delivered', (select count(*) from searched_rows where status = 'DELIVERED'),
      'pending', (select count(*) from searched_rows
        where status = 'AWAITING_ALLOCATION'),
      'confirmed', (select count(*) from searched_rows where status = 'CONFIRMED'),
      'ready_for_delivery', (select count(*) from searched_rows
        where status = 'READY_FOR_DELIVERY'),
      'delivered_this_month', (select count(*) from searched_rows
        where status = 'DELIVERED'
          and updated_at >= month_start
          and updated_at < next_month_start)
    )
  ) into result;

  return result;
end;
$$;

revoke all on function app_private.get_sales_consultant_booking_workspace_page(
  uuid, uuid, uuid[], boolean, text, text, integer, integer,
  text, text, uuid, date, date
) from public, anon, authenticated;

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
declare
  access_context jsonb := public.get_access_context();
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  can_view_customer boolean;
begin
  if access_context->>'role_key' = 'sales-consultant' then
    if auth.uid() is null
      or access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'BOOKING_VIEW_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(
      current_organization_id
    );
    if not (
      'booking.view' = any(permission_keys)
      or 'booking.manage' = any(permission_keys)
    ) then
      raise exception using errcode = '42501', message = 'BOOKING_VIEW_PERMISSION_REQUIRED';
    end if;
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    if target_branch_id is not null
      and not (target_branch_id = any(allowed_branch_ids))
    then
      raise exception using errcode = '42501', message = 'BOOKING_BRANCH_SCOPE_DENIED';
    end if;
    can_view_customer := 'customer.view' = any(permission_keys);
    return app_private.get_sales_consultant_booking_workspace_page(
      current_organization_id,
      auth.uid(),
      allowed_branch_ids,
      can_view_customer,
      target_search,
      target_status,
      target_page,
      target_page_size,
      target_sort,
      target_model,
      target_branch_id,
      target_from_date,
      target_to_date
    );
  end if;

  return public.get_sales_booking_workspace_page_legacy(
    target_search,
    target_status,
    target_page,
    target_page_size,
    target_sort,
    target_model,
    target_branch_id,
    target_from_date,
    target_to_date
  );
end;
$$;

revoke all on function public.get_sales_booking_workspace_page(
  text, text, integer, integer, text, text, uuid, date, date
) from public, anon;
grant execute on function public.get_sales_booking_workspace_page(
  text, text, integer, integer, text, text, uuid, date, date
) to authenticated;

-- Stock filter dimensions are joined after reducing the fact table to unique
-- variant/color keys. Branch access is resolved once, never once per stock row.
create or replace function app_private.get_sales_consultant_stock_filter_options(
  target_organization_id uuid,
  target_branch_ids uuid[],
  target_branch_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with stock_keys as materialized (
    select distinct
      stock_row.variant_id,
      nullif(btrim(stock_row.color), '') as color
    from public.stock_units stock_row
    where stock_row.organization_id = target_organization_id
      and stock_row.branch_id = any(target_branch_ids)
      and stock_row.deleted_at is null
      and stock_row.status <> 'DELIVERED'
      and (target_branch_id is null or stock_row.branch_id = target_branch_id)
  ), scoped_options as materialized (
    select
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      nullif(btrim(variant_row.specifications->>'fuel'), '') as fuel,
      nullif(btrim(variant_row.specifications->>'transmission'), '') as transmission,
      stock_row.color
    from stock_keys stock_row
    join public.vehicle_variants variant_row
      on variant_row.organization_id = target_organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = variant_row.organization_id
     and model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row
      on brand_row.organization_id = model_row.organization_id
     and brand_row.id = model_row.brand_id
  )
  select jsonb_build_object(
    'brands', coalesce((
      select jsonb_agg(option_row.brand_name order by lower(option_row.brand_name))
      from (
        select brand_name
        from scoped_options
        group by brand_name
        order by lower(brand_name)
        limit 100
      ) option_row
    ), '[]'::jsonb),
    'models', coalesce((
      select jsonb_agg(option_row.model_name order by lower(option_row.model_name))
      from (
        select model_name
        from scoped_options
        group by model_name
        order by lower(model_name)
        limit 100
      ) option_row
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(option_row.variant_name order by lower(option_row.variant_name))
      from (
        select variant_name
        from scoped_options
        group by variant_name
        order by lower(variant_name)
        limit 100
      ) option_row
    ), '[]'::jsonb),
    'fuels', coalesce((
      select jsonb_agg(option_row.fuel order by lower(option_row.fuel))
      from (
        select fuel
        from scoped_options
        where fuel is not null
        group by fuel
        order by lower(fuel)
        limit 100
      ) option_row
    ), '[]'::jsonb),
    'transmissions', coalesce((
      select jsonb_agg(option_row.transmission order by lower(option_row.transmission))
      from (
        select transmission
        from scoped_options
        where transmission is not null
        group by transmission
        order by lower(transmission)
        limit 100
      ) option_row
    ), '[]'::jsonb),
    'colors', coalesce((
      select jsonb_agg(option_row.color order by lower(option_row.color))
      from (
        select color
        from scoped_options
        where color is not null
        group by color
        order by lower(color)
        limit 100
      ) option_row
    ), '[]'::jsonb)
  );
$$;

revoke all on function app_private.get_sales_consultant_stock_filter_options(
  uuid, uuid[], uuid
) from public, anon, authenticated;

create or replace function public.get_stock_check_filter_options(
  target_branch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb := public.get_access_context();
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
begin
  if access_context->>'role_key' = 'sales-consultant' then
    if auth.uid() is null
      or access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'STOCK_CHECK_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(
      current_organization_id
    );
    if not (
      'inventory.stock_check' = any(permission_keys)
      or 'inventory.view' = any(permission_keys)
    ) then
      raise exception using errcode = '42501', message = 'STOCK_CHECK_PERMISSION_REQUIRED';
    end if;
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    if target_branch_id is not null
      and not (target_branch_id = any(allowed_branch_ids))
    then
      raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
    end if;
    return app_private.get_sales_consultant_stock_filter_options(
      current_organization_id,
      allowed_branch_ids,
      target_branch_id
    );
  end if;

  return public.get_stock_check_filter_options_legacy(target_branch_id);
end;
$$;

revoke all on function public.get_stock_check_filter_options(uuid)
  from public, anon;
grant execute on function public.get_stock_check_filter_options(uuid)
  to authenticated;

-- The stock list aggregates only fact keys/status first, joins catalog display
-- fields once per group, then pages before building the response JSON.
create or replace function app_private.get_sales_consultant_stock_check_page(
  target_organization_id uuid,
  target_branch_ids uuid[],
  target_search text,
  target_page integer,
  target_page_size integer,
  target_availability text,
  target_branch_id uuid,
  target_sort text,
  target_brand text,
  target_model text,
  target_variant text,
  target_fuel text,
  target_transmission text,
  target_color text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_availability text := upper(btrim(coalesce(target_availability, 'ALL')));
  normalized_brand text := lower(btrim(coalesce(target_brand, '')));
  normalized_model text := lower(btrim(coalesce(target_model, '')));
  normalized_variant text := lower(btrim(coalesce(target_variant, '')));
  normalized_fuel text := lower(btrim(coalesce(target_fuel, '')));
  normalized_transmission text := lower(btrim(coalesce(target_transmission, '')));
  normalized_color text := lower(btrim(coalesce(target_color, '')));
  result jsonb;
begin
  if target_organization_id is null
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
    or normalized_availability not in (
      'ALL', 'AVAILABLE', 'LIMITED', 'INCOMING', 'UNAVAILABLE'
    )
    or target_sort not in (
      'model:asc', 'available:desc', 'incoming:desc', 'branch:asc'
    )
    or char_length(normalized_search) > 100
    or char_length(normalized_brand) > 100
    or char_length(normalized_model) > 100
    or char_length(normalized_variant) > 100
    or char_length(normalized_fuel) > 100
    or char_length(normalized_transmission) > 100
    or char_length(normalized_color) > 100
    or (target_branch_id is not null and not (target_branch_id = any(target_branch_ids)))
  then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_CHECK_QUERY';
  end if;

  with grouped_keys as materialized (
    select
      stock_row.branch_id,
      stock_row.variant_id,
      stock_row.color,
      count(*) filter (where stock_row.status = 'AVAILABLE')::integer as available,
      count(*) filter (where stock_row.status = 'RESERVED')::integer as reserved,
      count(*) filter (where stock_row.status = 'ALLOCATED')::integer as allocated,
      count(*) filter (
        where stock_row.status in ('INCOMING', 'IN_TRANSIT')
      )::integer as incoming
    from public.stock_units stock_row
    where stock_row.organization_id = target_organization_id
      and stock_row.branch_id = any(target_branch_ids)
      and stock_row.deleted_at is null
      and stock_row.status <> 'DELIVERED'
      and (target_branch_id is null or stock_row.branch_id = target_branch_id)
    group by stock_row.branch_id, stock_row.variant_id, stock_row.color
  ), described_stock as materialized (
    select
      grouped_row.branch_id,
      grouped_row.variant_id,
      branch_row.name as branch_name,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      grouped_row.color,
      nullif(btrim(variant_row.specifications->>'fuel'), '') as fuel,
      nullif(btrim(variant_row.specifications->>'transmission'), '') as transmission,
      grouped_row.available,
      grouped_row.reserved,
      grouped_row.allocated,
      grouped_row.incoming,
      case
        when grouped_row.available > 2 then 'AVAILABLE'
        when grouped_row.available between 1 and 2 then 'LIMITED'
        when grouped_row.incoming > 0 then 'INCOMING'
        else 'UNAVAILABLE'
      end as availability
    from grouped_keys grouped_row
    join public.branches branch_row
      on branch_row.organization_id = target_organization_id
     and branch_row.id = grouped_row.branch_id
     and branch_row.deleted_at is null
    join public.vehicle_variants variant_row
      on variant_row.organization_id = target_organization_id
     and variant_row.id = grouped_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = variant_row.organization_id
     and model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row
      on brand_row.organization_id = model_row.organization_id
     and brand_row.id = model_row.brand_id
  ), filtered_stock as materialized (
    select described_row.*
    from described_stock described_row
    where (
      normalized_availability = 'ALL'
      or described_row.availability = normalized_availability
    )
      and (normalized_brand = '' or lower(described_row.brand_name) = normalized_brand)
      and (normalized_model = '' or lower(described_row.model_name) = normalized_model)
      and (normalized_variant = ''
        or lower(described_row.variant_name) = normalized_variant)
      and (normalized_fuel = ''
        or lower(coalesce(described_row.fuel, '')) = normalized_fuel)
      and (normalized_transmission = ''
        or lower(coalesce(described_row.transmission, '')) = normalized_transmission)
      and (normalized_color = ''
        or lower(coalesce(described_row.color, '')) = normalized_color)
      and (
        normalized_search = ''
        or lower(described_row.brand_name) like '%' || normalized_search || '%'
        or lower(described_row.model_name) like '%' || normalized_search || '%'
        or lower(described_row.variant_name) like '%' || normalized_search || '%'
        or lower(coalesce(described_row.color, '')) like '%' || normalized_search || '%'
        or lower(coalesce(described_row.fuel, '')) like '%' || normalized_search || '%'
        or lower(coalesce(described_row.transmission, '')) like '%' || normalized_search || '%'
      )
  ), page_rows as materialized (
    select filtered_row.*
    from filtered_stock filtered_row
    order by
      case when target_sort = 'model:asc'
        then lower(filtered_row.model_name) end asc,
      case when target_sort = 'available:desc'
        then filtered_row.available end desc,
      case when target_sort = 'incoming:desc'
        then filtered_row.incoming end desc,
      case when target_sort = 'branch:asc'
        then lower(filtered_row.branch_name) end asc,
      filtered_row.variant_id,
      filtered_row.branch_id,
      coalesce(filtered_row.color, '')
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
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
        case when target_sort = 'model:asc'
          then lower(page_row.model_name) end asc,
        case when target_sort = 'available:desc'
          then page_row.available end desc,
        case when target_sort = 'incoming:desc'
          then page_row.incoming end desc,
        case when target_sort = 'branch:asc'
          then lower(page_row.branch_name) end asc,
        page_row.variant_id,
        page_row.branch_id,
        coalesce(page_row.color, '')
      )
      from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_stock),
    'kpis', jsonb_build_object(
      'available_units', (select coalesce(sum(grouped_row.available), 0)
        from grouped_keys grouped_row),
      'limited_groups', (select count(*) from described_stock described_row
        where described_row.availability = 'LIMITED'),
      'incoming_units', (select coalesce(sum(grouped_row.incoming), 0)
        from grouped_keys grouped_row),
      'unavailable_groups', (select count(*) from described_stock described_row
        where described_row.availability = 'UNAVAILABLE')
    )
  ) into result;

  return result;
end;
$$;

revoke all on function app_private.get_sales_consultant_stock_check_page(
  uuid, uuid[], text, integer, integer, text, uuid, text,
  text, text, text, text, text, text
) from public, anon, authenticated;

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
declare
  access_context jsonb := public.get_access_context();
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
begin
  if access_context->>'role_key' = 'sales-consultant' then
    if auth.uid() is null
      or access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'STOCK_CHECK_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(
      current_organization_id
    );
    if not (
      'inventory.stock_check' = any(permission_keys)
      or 'inventory.view' = any(permission_keys)
    ) then
      raise exception using errcode = '42501', message = 'STOCK_CHECK_PERMISSION_REQUIRED';
    end if;
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    if target_branch_id is not null
      and not (target_branch_id = any(allowed_branch_ids))
    then
      raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
    end if;
    return app_private.get_sales_consultant_stock_check_page(
      current_organization_id,
      allowed_branch_ids,
      target_search,
      target_page,
      target_page_size,
      target_availability,
      target_branch_id,
      target_sort,
      target_brand,
      target_model,
      target_variant,
      target_fuel,
      target_transmission,
      target_color
    );
  end if;

  return public.get_stock_check_page_v2_legacy(
    target_search,
    target_page,
    target_page_size,
    target_availability,
    target_branch_id,
    target_sort,
    target_brand,
    target_model,
    target_variant,
    target_fuel,
    target_transmission,
    target_color
  );
end;
$$;

revoke all on function public.get_stock_check_page_v2(
  text, integer, integer, text, uuid, text,
  text, text, text, text, text, text
) from public, anon;
grant execute on function public.get_stock_check_page_v2(
  text, integer, integer, text, uuid, text,
  text, text, text, text, text, text
) to authenticated;

-- Exchange candidates are limited before addresses, vehicles, evaluations and
-- document JSON are read. This surface intentionally requires customer.view;
-- unlike quotation/booking lists, a redacted exchange editor is not useful.
create or replace function app_private.get_sales_consultant_exchange_options(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_search text,
  target_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_phone_search text;
  result jsonb;
begin
  if target_organization_id is null
    or target_user_id is null
    or char_length(normalized_search) > 160
    or target_limit not between 1 and 25
  then
    raise exception using errcode = '22023', message = 'INVALID_EXCHANGE_OPTION_QUERY';
  end if;
  normalized_phone_search := app_private.normalize_phone_digits(normalized_search);

  with page_rows as materialized (
    select
      booking_row.id as booking_id,
      booking_row.organization_id,
      booking_row.branch_id,
      booking_row.customer_id,
      booking_row.assigned_user_id,
      booking_row.booking_number,
      case_row.id as case_id,
      greatest(
        booking_row.updated_at,
        coalesce(case_row.updated_at, booking_row.updated_at)
      ) as sort_updated_at
    from public.bookings booking_row
    join public.customers customer_row
      on customer_row.organization_id = booking_row.organization_id
     and customer_row.id = booking_row.customer_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.organization_id = booking_row.organization_id
     and branch_row.id = booking_row.branch_id
     and branch_row.deleted_at is null
    left join lateral (
      select exchange_row.id, exchange_row.updated_at
      from public.exchange_cases exchange_row
      where exchange_row.organization_id = booking_row.organization_id
        and exchange_row.booking_id = booking_row.id
        and exchange_row.deleted_at is null
      order by exchange_row.updated_at desc, exchange_row.id desc
      limit 1
    ) case_row on true
    where booking_row.organization_id = target_organization_id
      and booking_row.assigned_user_id = target_user_id
      and booking_row.branch_id = any(target_branch_ids)
      and booking_row.deleted_at is null
      and booking_row.exchange_required
      and booking_row.status in (
        'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED', 'READY_FOR_DELIVERY'
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or customer_row.normalized_name like '%' || normalized_search || '%'
        or (
          normalized_phone_search <> ''
          and position(
            normalized_phone_search in coalesce(customer_row.normalized_phone, '')
          ) > 0
        )
      )
    order by greatest(
      booking_row.updated_at,
      coalesce(case_row.updated_at, booking_row.updated_at)
    ) desc, booking_row.id desc
    limit target_limit
  ), enriched_page as (
    select
      page_row.sort_updated_at,
      jsonb_build_object(
        'booking_id', page_row.booking_id,
        'booking_number', page_row.booking_number,
        'branch_id', page_row.branch_id,
        'branch_name', branch_row.name,
        'customer_id', customer_row.id,
        'customer_name', customer_row.full_name,
        'phone', customer_row.primary_phone,
        'email', customer_row.primary_email,
        'consultant_name', consultant_row.full_name,
        'case_id', case_row.id,
        'case_status', case_row.status,
        'case_version', case_row.version,
        'vehicle_id', case_row.vehicle_id,
        'fuel_type', case_row.fuel_type,
        'ownership', case_row.ownership,
        'odometer_km', case_row.odometer_km,
        'customer_expected_value', case_row.customer_expected_value,
        'estimated_value', case_row.estimated_value,
        'accepted_value', case_row.accepted_value,
        'notes', case_row.notes,
        'created_at', case_row.created_at,
        'updated_at', case_row.updated_at,
        'address', address_data.address,
        'vehicles', coalesce(vehicle_data.vehicles, '[]'::jsonb),
        'evaluation', evaluation_data.evaluation,
        'documents', coalesce(document_data.documents, '[]'::jsonb)
      ) as data
    from page_rows page_row
    join public.customers customer_row
      on customer_row.organization_id = page_row.organization_id
     and customer_row.id = page_row.customer_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.organization_id = page_row.organization_id
     and branch_row.id = page_row.branch_id
     and branch_row.deleted_at is null
    left join public.profiles consultant_row
      on consultant_row.organization_id = page_row.organization_id
     and consultant_row.id = page_row.assigned_user_id
    left join public.exchange_cases case_row
      on case_row.organization_id = page_row.organization_id
     and case_row.id = page_row.case_id
     and case_row.deleted_at is null
    left join lateral (
      select address_row.address
      from public.customer_addresses address_row
      where address_row.organization_id = page_row.organization_id
        and address_row.customer_id = page_row.customer_id
      order by
        (address_row.address_type = 'HOME') desc,
        address_row.created_at desc,
        address_row.id desc
      limit 1
    ) address_data on true
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'id', vehicle_row.id,
        'registration', vehicle_row.registration,
        'brand', vehicle_row.brand,
        'model', vehicle_row.model,
        'variant', vehicle_row.variant,
        'model_year', vehicle_row.model_year
      ) order by vehicle_row.created_at desc, vehicle_row.id) as vehicles
      from public.customer_vehicles vehicle_row
      where vehicle_row.organization_id = page_row.organization_id
        and vehicle_row.customer_id = page_row.customer_id
    ) vehicle_data on true
    left join lateral (
      select jsonb_build_object(
        'evaluator_name', evaluator_row.full_name,
        'inspection', evaluation_row.inspection,
        'quoted_value', evaluation_row.quoted_value,
        'created_at', evaluation_row.created_at
      ) as evaluation
      from public.exchange_evaluations evaluation_row
      left join public.profiles evaluator_row
        on evaluator_row.organization_id = evaluation_row.organization_id
       and evaluator_row.id = evaluation_row.evaluator_id
      where evaluation_row.organization_id = page_row.organization_id
        and evaluation_row.exchange_case_id = page_row.case_id
      order by evaluation_row.created_at desc, evaluation_row.id desc
      limit 1
    ) evaluation_data on true
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'id', file_row.id,
        'file_name', coalesce(file_row.original_file_name, 'Document'),
        'mime_type', file_row.mime_type,
        'size_bytes', file_row.size_bytes,
        'created_at', file_row.created_at
      ) order by file_row.created_at desc, file_row.id) as documents
      from public.object_files file_row
      where file_row.organization_id = page_row.organization_id
        and file_row.resource_type = 'exchange_case'
        and file_row.resource_id = page_row.case_id
        and file_row.deleted_at is null
    ) document_data on true
  )
  select coalesce(jsonb_agg(page_row.data
    order by page_row.sort_updated_at desc), '[]'::jsonb)
  into result
  from enriched_page page_row;

  return result;
end;
$$;

revoke all on function app_private.get_sales_consultant_exchange_options(
  uuid, uuid, uuid[], text, integer
) from public, anon, authenticated;

create or replace function public.get_sales_exchange_options(
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb := public.get_access_context();
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
begin
  if access_context->>'role_key' = 'sales-consultant' then
    if auth.uid() is null
      or access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'EXCHANGE_REQUEST_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(
      current_organization_id
    );
    if not ('exchange.request' = any(permission_keys))
      or not ('customer.view' = any(permission_keys))
    then
      raise exception using errcode = '42501', message = 'EXCHANGE_REQUEST_PERMISSION_REQUIRED';
    end if;
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    return app_private.get_sales_consultant_exchange_options(
      current_organization_id,
      auth.uid(),
      allowed_branch_ids,
      target_search,
      target_limit
    );
  end if;

  return public.get_sales_exchange_options_legacy(
    target_search,
    target_limit
  );
end;
$$;

revoke all on function public.get_sales_exchange_options(text, integer)
  from public, anon;
grant execute on function public.get_sales_exchange_options(text, integer)
  to authenticated;

commit;
