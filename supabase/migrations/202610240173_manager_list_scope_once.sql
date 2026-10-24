-- Manager list pages: resolve the caller's record scope once.
--
-- Every role but Sales Consultant reaches these through the *_legacy paths,
-- which called app_private.can_access_record (and, for the calendar,
-- can_access_customer and can_access_lead) once per row before filtering. On
-- the demo dealership that was 7-12 s for the Team Manager appointment
-- calendar, 3-5 s for quotations, 2.5-3 s for bookings and 2-3 s for the
-- booking filter options. Each now reads app_private.resolve_permission_record_scope
-- (and resolve_customer_access_scope for the calendar) once and filters on its
-- arrays, the pattern of app_private.scoped_lead_option_page. Results were
-- compared byte for byte against the live functions for 8 roles x 24 cases
-- (192 identical, permission errors included) before this was written.
--
-- Also:
-- - the calendar checks only the requested month's appointments;
-- - quotation line items are read for the visible page, not every row;
-- - bookings KPIs gain `cancelled` (manager extra on the Bookings page);
-- - get_team_manager_performance adds each member's `member_type` and a per-day
--   `connected_calls`, so telecallers are not ranked on bookings;
-- - new public.get_lost_lead_summary for the Lost Leads tiles and reason chart.
--
-- The function bodies below are the deployed definitions (pg_get_functiondef)
-- with anchored edits, not re-emitted from older migrations.

begin;

CREATE OR REPLACE FUNCTION public.get_appointment_calendar_legacy(target_month date, target_day date DEFAULT NULL::date, target_search text DEFAULT ''::text, target_status text DEFAULT 'all'::text, target_appointment_type text DEFAULT 'all'::text, target_branch_id uuid DEFAULT NULL::uuid, target_team_id uuid DEFAULT NULL::uuid, target_owner_id uuid DEFAULT NULL::uuid, target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  local_today date;
  month_start timestamptz;
  month_end timestamptz;
  day_start timestamptz;
  day_end timestamptz;
  result jsonb;
  record_scope record;
  lead_scope record;
  customer_scope record;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not app_private.is_valid_timezone(target_timezone) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  if target_status not in (
    'all','today','upcoming','confirmed','arrived','completed','no-show','rescheduled','cancelled'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_FILTER';
  end if;
  if target_appointment_type not in (
    'all','Showroom Visit','Video Call','Test Drive','Consultant Call'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TYPE_FILTER';
  end if;
  local_today := (now() at time zone target_timezone)::date;
  if target_month < date_trunc('month', local_today)::date - interval '1 year'
    or target_month > date_trunc('month', local_today)::date + interval '2 years'
  then
    raise exception using errcode = '22023', message = 'APPOINTMENT_MONTH_OUT_OF_RANGE';
  end if;
  if target_day is not null
    and (target_day < target_month or target_day >= (target_month + interval '1 month')::date)
  then
    raise exception using errcode = '22023', message = 'APPOINTMENT_DAY_OUT_OF_RANGE';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.phone_search_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'appointment.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if target_team_id is not null
    and not app_private.can_access_team(current_organization_id, target_team_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  -- Resolve the caller's scope once instead of can_access_record per row.
  select * into record_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['appointment.view']::text[]
  );
  select * into lead_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['lead.view']::text[]
  );
  select * into customer_scope
  from app_private.resolve_customer_access_scope(current_organization_id);
  month_start := target_month::timestamp at time zone target_timezone;
  month_end := (target_month + interval '1 month')::timestamp at time zone target_timezone;
  day_start := local_today::timestamp at time zone target_timezone;
  day_end := (local_today + 1)::timestamp at time zone target_timezone;

  with accessible_records as materialized (
    select
      appointment_row.id,
      appointment_row.version,
      appointment_row.lead_id,
      appointment_row.customer_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model,
      appointment_row.appointment_type,
      appointment_row.scheduled_at,
      appointment_row.status,
      coalesce(appointment_row.attendance_status, 'NOT_ARRIVED') as attendance_status,
      appointment_row.notes,
      appointment_row.assigned_user_id,
      assigned_profile.full_name as assigned_user_name,
      appointment_row.created_by,
      creator_profile.full_name as created_by_name,
      appointment_row.branch_id,
      branch_row.name as branch_name,
      appointment_row.team_id,
      team_row.name as team_name,
      appointment_row.confirmed_at,
      appointment_row.arrived_at,
      appointment_row.completed_at,
      appointment_row.cancelled_at,
      appointment_row.updated_at
    from public.appointments appointment_row
    join public.customers customer_row
      on customer_row.id = appointment_row.customer_id
     and customer_row.organization_id = appointment_row.organization_id
     and customer_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.id = appointment_row.lead_id
     and lead_row.organization_id = appointment_row.organization_id
     and lead_row.deleted_at is null
    join public.profiles assigned_profile
      on assigned_profile.id = appointment_row.assigned_user_id
     and assigned_profile.organization_id = appointment_row.organization_id
    left join public.profiles creator_profile
      on creator_profile.id = appointment_row.created_by
     and creator_profile.organization_id = appointment_row.organization_id
    join public.branches branch_row
      on branch_row.id = appointment_row.branch_id
     and branch_row.organization_id = appointment_row.organization_id
    left join public.teams team_row
      on team_row.id = appointment_row.team_id
     and team_row.organization_id = appointment_row.organization_id
    where appointment_row.organization_id = current_organization_id
      -- Only the requested month is returned, so only its rows are checked.
      and appointment_row.scheduled_at >= month_start
      and appointment_row.scheduled_at < month_end
      and coalesce(record_scope.granted, false)
      and (
        record_scope.organization_wide
        or appointment_row.branch_id = any(record_scope.branch_scope_ids)
        or appointment_row.team_id = any(record_scope.team_scope_ids)
        or (
          record_scope.own_records
          and appointment_row.assigned_user_id = auth.uid()
          and appointment_row.branch_id = any(record_scope.own_record_branch_ids)
        )
      )
      -- can_access_customer, from the customer scope resolved once above.
      and customer_scope.organization_access
      and (
        customer_scope.customer_ids_all
        or exists (
          select 1
          from public.leads customer_lead
          where customer_lead.organization_id = appointment_row.organization_id
            and customer_lead.customer_id = appointment_row.customer_id
            and customer_lead.deleted_at is null
            and (
              customer_lead.branch_id = any(customer_scope.branch_ids)
              or customer_lead.team_id = any(customer_scope.team_ids)
              or (
                customer_scope.own_records
                and (
                  customer_lead.assigned_user_id = auth.uid()
                  or app_private.has_owned_lead(customer_lead.organization_id, customer_lead.id)
                )
              )
            )
        )
      )
      -- can_access_lead: lead.view scope over the lead's own branch, team and owner.
      and (
        appointment_row.lead_id is null
        or (
          lead_row.id is not null
          and coalesce(lead_scope.granted, false)
          and (
            lead_scope.organization_wide
            or lead_row.branch_id = any(lead_scope.branch_scope_ids)
            or lead_row.team_id = any(lead_scope.team_scope_ids)
            or (
              lead_scope.own_records
              and lead_row.assigned_user_id = auth.uid()
              and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
            )
          )
        )
      )
  ), filtered_records as materialized (
    select record_row.*
    from accessible_records record_row
    where (target_branch_id is null or record_row.branch_id = target_branch_id)
      and (target_team_id is null or record_row.team_id = target_team_id)
      and (target_owner_id is null or record_row.assigned_user_id = target_owner_id)
      and (target_appointment_type = 'all' or record_row.appointment_type = target_appointment_type)
      and (
        normalized_search = ''
        or record_row.id = search_uuid
        or record_row.lead_id = search_uuid
        or lower(record_row.customer_name) ilike '%' || normalized_search || '%'
        or (search_phone_digits <> '' and app_private.normalize_phone_digits(record_row.phone) like search_phone_digits || '%')
      )
      and case target_status
        when 'today' then record_row.scheduled_at >= day_start and record_row.scheduled_at < day_end
        when 'upcoming' then record_row.scheduled_at >= day_end and record_row.status not in ('COMPLETED','CANCELLED','NO_SHOW')
        when 'confirmed' then record_row.status = 'CONFIRMED'
        when 'arrived' then record_row.attendance_status = 'ARRIVED'
        when 'completed' then record_row.status = 'COMPLETED'
        when 'no-show' then record_row.status = 'NO_SHOW' or record_row.attendance_status = 'NO_SHOW'
        when 'rescheduled' then record_row.status = 'RESCHEDULED'
        when 'cancelled' then record_row.status = 'CANCELLED'
        else true
      end
  ), month_records as materialized (
    select record_row.*, (record_row.scheduled_at at time zone target_timezone)::date as local_date
    from filtered_records record_row
    where record_row.scheduled_at >= month_start and record_row.scheduled_at < month_end
  ), ranked_records as (
    select record_row.*,
      row_number() over (partition by record_row.local_date order by record_row.scheduled_at, record_row.id) as day_rank,
      count(*) over (partition by record_row.local_date) as day_total
    from month_records record_row
  ), day_rows as (
    select record_row.local_date,
      max(record_row.day_total)::integer as total,
      jsonb_agg(to_jsonb(record_row) - 'local_date' - 'day_rank' - 'day_total'
        order by record_row.scheduled_at, record_row.id)
        filter (where target_day is not null or record_row.day_rank <= 3) as items
    from ranked_records record_row
    where target_day is null or record_row.local_date = target_day
    group by record_row.local_date
  )
  select jsonb_build_object(
    'month', target_month,
    'month_total', (select count(*) from month_records),
    'days', coalesce((select jsonb_agg(
      jsonb_build_object('date', day_row.local_date, 'total', day_row.total, 'items', day_row.items)
      order by day_row.local_date) from day_rows day_row), '[]'::jsonb),
    'timezone', target_timezone
  ) into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_quotation_workspace_page_legacy(target_search text DEFAULT ''::text, target_status text DEFAULT 'ALL'::text, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25, target_sort text DEFAULT 'updated:desc'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  search_uuid uuid;
  result jsonb;
  record_scope record;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160
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
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not (
    app_private.has_permission(current_organization_id, 'quotation.view')
    or app_private.has_permission(current_organization_id, 'quotation.manage')
  ) then
    raise exception using errcode = '42501', message = 'QUOTATION_VIEW_PERMISSION_REQUIRED';
  end if;
  -- Resolve the caller's scope once instead of can_access_record per quotation.
  select * into record_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['quotation.view', 'quotation.manage']::text[]
  );

  with authorized as materialized (
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
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as assigned_user_name,
      lead_row.interested_model
    from public.quotations quotation_row
    join public.customers customer_row
      on customer_row.id = quotation_row.customer_id
     and customer_row.organization_id = quotation_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = quotation_row.branch_id
     and branch_row.organization_id = quotation_row.organization_id
    left join public.teams team_row
      on team_row.id = quotation_row.team_id
     and team_row.organization_id = quotation_row.organization_id
    join public.profiles profile_row
      on profile_row.id = quotation_row.assigned_user_id
     and profile_row.organization_id = quotation_row.organization_id
    left join public.leads lead_row
      on lead_row.id = quotation_row.lead_id
     and lead_row.organization_id = quotation_row.organization_id
    where quotation_row.organization_id = current_organization_id
      and coalesce(record_scope.granted, false)
      and (
        record_scope.organization_wide
        or quotation_row.branch_id = any(record_scope.branch_scope_ids)
        or quotation_row.team_id = any(record_scope.team_scope_ids)
        or (
          record_scope.own_records
          and quotation_row.assigned_user_id = auth.uid()
          and quotation_row.branch_id = any(record_scope.own_record_branch_ids)
        )
      )
      and (target_status = 'ALL' or quotation_row.status = target_status)
      and (
        normalized_search = ''
        or quotation_row.id = search_uuid
        or position(normalized_search in lower(quotation_row.quotation_number)) > 0
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), page_rows as (
    -- Line items are read for the visible page only, not every authorized row.
    select limited_row.*, coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_type', item_row.item_type,
        'description', item_row.description,
        'quantity', item_row.quantity,
        'unit_price', item_row.unit_price,
        'adjustment', item_row.adjustment
      ) order by item_row.created_at, item_row.id)
      from public.quotation_items item_row
      where item_row.organization_id = limited_row.organization_id
        and item_row.quotation_id = limited_row.id
        and item_row.deleted_at is null
    ), '[]'::jsonb) as items
    from (
    select authorized_row.*
    from authorized authorized_row
    order by
      case when target_sort = 'updated:desc' then authorized_row.updated_at end desc,
      case when target_sort = 'updated:asc' then authorized_row.updated_at end asc,
      case when target_sort = 'amount:desc' then authorized_row.total_amount end desc,
      case when target_sort = 'amount:asc' then authorized_row.total_amount end asc,
      case when target_sort = 'customer:asc' then lower(authorized_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(authorized_row.customer_name) end desc,
      authorized_row.id desc
    limit target_page_size offset (target_page - 1) * target_page_size
    ) limited_row
  )
  select jsonb_build_object(
    'records', coalesce((select jsonb_agg(to_jsonb(page_row) order by
      case when target_sort = 'updated:desc' then page_row.updated_at end desc,
      case when target_sort = 'updated:asc' then page_row.updated_at end asc,
      case when target_sort = 'amount:desc' then page_row.total_amount end desc,
      case when target_sort = 'amount:asc' then page_row.total_amount end asc,
      case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(page_row.customer_name) end desc,
      page_row.id desc
    ) from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from authorized),
    'kpis', jsonb_build_object(
      'open', (select count(*) from authorized where status in ('DRAFT', 'PENDING_APPROVAL', 'SENT')),
      'sent', (select count(*) from authorized where status = 'SENT'),
      'approval_required', (select count(*) from authorized where approval_status = 'PENDING'),
      'converted', (select count(*) from authorized where status = 'CONVERTED'),
      'pipeline_value', (select coalesce(sum(total_amount), 0) from authorized where status in ('SENT', 'ACCEPTED'))
    )
  ) into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_booking_workspace_page_legacy(target_search text DEFAULT ''::text, target_status text DEFAULT 'ALL'::text, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25, target_sort text DEFAULT 'delivery:asc'::text, target_model text DEFAULT NULL::text, target_branch_id uuid DEFAULT NULL::uuid, target_from_date date DEFAULT NULL::date, target_to_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_organization_id uuid;
declare normalized_search text := lower(btrim(coalesce(target_search, '')));
declare normalized_model text := lower(btrim(coalesce(target_model, '')));
declare search_uuid uuid;
declare result jsonb;
declare record_scope record;
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
  -- Resolve the caller's scope once instead of can_access_record per booking.
  select * into record_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['booking.view', 'booking.manage']::text[]
  );

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
      and coalesce(record_scope.granted, false)
      and (
        record_scope.organization_wide
        or booking_row.branch_id = any(record_scope.branch_scope_ids)
        or booking_row.team_id = any(record_scope.team_scope_ids)
        or (
          record_scope.own_records
          and booking_row.assigned_user_id = auth.uid()
          and booking_row.branch_id = any(record_scope.own_record_branch_ids)
        )
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
        and date_trunc('month', updated_at) = date_trunc('month', now())),
      'cancelled', (select count(*) from searched_scope where status = 'CANCELLED')
    )
  ) into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_booking_filter_options_legacy()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_organization_id uuid;
declare result jsonb;
declare record_scope record;
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
  -- Resolve the caller's scope once and filter on it, instead of
  -- can_access_record per booking (about 3 ms a row).
  select * into record_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['booking.view', 'booking.manage']::text[]
  );

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
      and coalesce(record_scope.granted, false)
      and (
        record_scope.organization_wide
        or booking_row.branch_id = any(record_scope.branch_scope_ids)
        or booking_row.team_id = any(record_scope.team_scope_ids)
        or (
          record_scope.own_records
          and booking_row.assigned_user_id = auth.uid()
          and booking_row.branch_id = any(record_scope.own_record_branch_ids)
        )
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
$function$;

CREATE OR REPLACE FUNCTION public.get_team_manager_performance(target_days integer DEFAULT 7, target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  access_context jsonb;
  current_organization_id uuid;
  current_user_id uuid := auth.uid();
  managed_team_ids uuid[];
  local_today date;
  start_day date;
  range_start timestamptz;
  range_end timestamptz;
  permission_keys text[];
  can_view_calls boolean;
  can_view_test_drives boolean;
  can_view_quotations boolean;
  can_view_bookings boolean;
  result jsonb;
begin
  if target_days is null or target_days < 1 or target_days > 9999
    or target_timezone is null or target_timezone !~ '^(Asia/Kolkata|UTC)(\|[0-9]{4}-[0-9]{2}-[0-9]{2})?$'
  then
    raise exception using errcode = '22023', message = 'INVALID_TEAM_PERFORMANCE_QUERY';
  end if;

  access_context := public.get_access_context();
  if current_user_id is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'team-manager'
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  if not app_private.has_permission(current_organization_id, 'lead.view') then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_LEAD_VIEW_REQUIRED';
  end if;

  select coalesce(array_agg(team_row.id order by team_row.id), array[]::uuid[])
  into managed_team_ids
  from public.teams team_row
  where team_row.organization_id = current_organization_id
    and team_row.active
    and team_row.manager_id = current_user_id
    and app_private.can_access_team(current_organization_id, team_row.id);

  if cardinality(managed_team_ids) = 0 then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_TEAM_REQUIRED';
  end if;

  select coalesce(array_agg(distinct permission_row.permission_key), array[]::text[])
  into permission_keys
  from public.user_role_assignments assignment_row
  join public.role_permissions role_permission_row
    on role_permission_row.role_id = assignment_row.role_id
  join public.permissions permission_row
    on permission_row.id = role_permission_row.permission_id
  where assignment_row.organization_id = current_organization_id
    and assignment_row.user_id = current_user_id
    and assignment_row.active;

  can_view_calls := 'call.view' = any(permission_keys);
  can_view_test_drives :=
    'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys);
  can_view_quotations :=
    'quotation.view' = any(permission_keys) or 'quotation.manage' = any(permission_keys);
  can_view_bookings :=
    'booking.view' = any(permission_keys) or 'booking.manage' = any(permission_keys);
  local_today := coalesce(nullif(split_part(target_timezone, '|', 2), '')::date, timezone(split_part(target_timezone, '|', 1), now())::date); target_timezone := split_part(target_timezone, '|', 1);
  start_day := local_today - (target_days - 1);
  range_start := timezone(target_timezone, start_day::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);

  with members as (
    select distinct on (member_row.user_id)
      member_row.user_id,
      member_row.team_id,
      member_row.member_type,
      profile_row.full_name
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = current_organization_id
      and member_row.team_id = any(managed_team_ids)
      and member_row.active
      and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
      and profile_row.active
    order by member_row.user_id, member_row.team_id
  ), lead_stats as (
    select lead_row.assigned_user_id as user_id,
      count(*)::bigint as leads,
      count(*) filter (where lead_row.first_contacted_at is not null)::bigint as contacted
    from public.leads lead_row
    join members member_row
      on member_row.user_id = lead_row.assigned_user_id
     and member_row.team_id = lead_row.team_id
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.created_at >= range_start
      and lead_row.created_at < range_end
    group by lead_row.assigned_user_id
  ), call_stats as (
    select call_row.assigned_user_id as user_id,
      count(*)::bigint as calls,
      count(*) filter (where upper(coalesce(call_row.outcome, '')) = 'CONNECTED')::bigint as connected,
      coalesce(sum(call_row.duration_seconds), 0)::bigint as talk_seconds
    from public.calls call_row
    join members member_row
      on member_row.user_id = call_row.assigned_user_id
     and member_row.team_id = call_row.team_id
    where can_view_calls
      and call_row.organization_id = current_organization_id
      and call_row.started_at >= range_start
      and call_row.started_at < range_end
    group by call_row.assigned_user_id
  ), drive_stats as (
    select drive_row.assigned_user_id as user_id,
      count(*)::bigint as test_drives
    from public.test_drive_appointments drive_row
    join members member_row
      on member_row.user_id = drive_row.assigned_user_id
     and member_row.team_id = drive_row.team_id
    where can_view_test_drives
      and drive_row.organization_id = current_organization_id
      and drive_row.status <> 'CANCELLED'
      and drive_row.scheduled_at >= range_start
      and drive_row.scheduled_at < range_end
    group by drive_row.assigned_user_id
  ), quotation_stats as (
    select quotation_row.assigned_user_id as user_id,
      count(*)::bigint as quotations
    from public.quotations quotation_row
    join members member_row
      on member_row.user_id = quotation_row.assigned_user_id
     and member_row.team_id = quotation_row.team_id
    where can_view_quotations
      and quotation_row.organization_id = current_organization_id
      and quotation_row.created_at >= range_start
      and quotation_row.created_at < range_end
    group by quotation_row.assigned_user_id
  ), booking_stats as (
    select booking_row.assigned_user_id as user_id,
      count(*)::bigint as bookings
    from public.bookings booking_row
    join members member_row
      on member_row.user_id = booking_row.assigned_user_id
     and member_row.team_id = booking_row.team_id
    where can_view_bookings
      and booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= range_start
      and booking_row.created_at < range_end
    group by booking_row.assigned_user_id
  ), member_stats as (
    select member_row.user_id, member_row.full_name, member_row.member_type,
      coalesce(lead_row.leads, 0)::bigint as leads,
      coalesce(lead_row.contacted, 0)::bigint as contacted,
      coalesce(call_row.calls, 0)::bigint as calls,
      coalesce(call_row.connected, 0)::bigint as connected,
      coalesce(call_row.talk_seconds, 0)::bigint as talk_seconds,
      coalesce(drive_row.test_drives, 0)::bigint as test_drives,
      coalesce(quotation_row.quotations, 0)::bigint as quotations,
      coalesce(booking_row.bookings, 0)::bigint as bookings
    from members member_row
    left join lead_stats lead_row on lead_row.user_id = member_row.user_id
    left join call_stats call_row on call_row.user_id = member_row.user_id
    left join drive_stats drive_row on drive_row.user_id = member_row.user_id
    left join quotation_stats quotation_row on quotation_row.user_id = member_row.user_id
    left join booking_stats booking_row on booking_row.user_id = member_row.user_id
  ), call_daily as (
    select timezone(target_timezone, call_row.started_at)::date as metric_day,
      count(*)::bigint as calls,
      count(*) filter (where upper(coalesce(call_row.outcome, '')) = 'CONNECTED')::bigint as connected
    from public.calls call_row
    join members member_row
      on member_row.user_id = call_row.assigned_user_id
     and member_row.team_id = call_row.team_id
    where can_view_calls
      and call_row.organization_id = current_organization_id
      and call_row.started_at >= range_start
      and call_row.started_at < range_end
    group by timezone(target_timezone, call_row.started_at)::date
  ), drive_daily as (
    select timezone(target_timezone, drive_row.scheduled_at)::date as metric_day,
      count(*)::bigint as test_drives
    from public.test_drive_appointments drive_row
    join members member_row
      on member_row.user_id = drive_row.assigned_user_id
     and member_row.team_id = drive_row.team_id
    where can_view_test_drives
      and drive_row.organization_id = current_organization_id
      and drive_row.status <> 'CANCELLED'
      and drive_row.scheduled_at >= range_start
      and drive_row.scheduled_at < range_end
    group by timezone(target_timezone, drive_row.scheduled_at)::date
  ), quotation_daily as (
    select timezone(target_timezone, quotation_row.created_at)::date as metric_day,
      count(*)::bigint as quotations
    from public.quotations quotation_row
    join members member_row
      on member_row.user_id = quotation_row.assigned_user_id
     and member_row.team_id = quotation_row.team_id
    where can_view_quotations
      and quotation_row.organization_id = current_organization_id
      and quotation_row.created_at >= range_start
      and quotation_row.created_at < range_end
    group by timezone(target_timezone, quotation_row.created_at)::date
  ), booking_daily as (
    select timezone(target_timezone, booking_row.created_at)::date as metric_day,
      count(*)::bigint as bookings
    from public.bookings booking_row
    join members member_row
      on member_row.user_id = booking_row.assigned_user_id
     and member_row.team_id = booking_row.team_id
    where can_view_bookings
      and booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= range_start
      and booking_row.created_at < range_end
    group by timezone(target_timezone, booking_row.created_at)::date
  ), daily as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', to_char(day_row.metric_day, 'DD Mon'),
      'calls', coalesce(call_row.calls, 0),
      'connected_calls', coalesce(call_row.connected, 0),
      'test_drives', coalesce(drive_row.test_drives, 0),
      'quotations', coalesce(quotation_row.quotations, 0),
      'bookings', coalesce(booking_row.bookings, 0)
    ) order by day_row.metric_day), '[]'::jsonb) as records
    from generate_series(start_day::timestamp, local_today::timestamp, interval '1 day')
      as day_source(day_timestamp)
    cross join lateral (select day_source.day_timestamp::date as metric_day) day_row
    left join call_daily call_row on call_row.metric_day = day_row.metric_day
    left join drive_daily drive_row on drive_row.metric_day = day_row.metric_day
    left join quotation_daily quotation_row on quotation_row.metric_day = day_row.metric_day
    left join booking_daily booking_row on booking_row.metric_day = day_row.metric_day
  ), leaderboard as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', member_row.user_id,
      'full_name', member_row.full_name,
      'member_type', member_row.member_type,
      'leads', member_row.leads,
      'contacted', member_row.contacted,
      'calls', member_row.calls,
      'connected_calls', member_row.connected,
      'talk_seconds', member_row.talk_seconds,
      'test_drives', member_row.test_drives,
      'quotations', member_row.quotations,
      'bookings', member_row.bookings,
      'conversion', case when member_row.leads > 0
        then round(member_row.bookings::numeric * 100 / member_row.leads, 2) else 0 end
    ) order by member_row.bookings desc, member_row.quotations desc, member_row.calls desc, member_row.full_name), '[]'::jsonb) as records
    from member_stats member_row
  ), totals as (
    select coalesce(sum(member_row.leads), 0)::bigint as leads,
      coalesce(sum(member_row.contacted), 0)::bigint as contacted,
      coalesce(sum(member_row.calls), 0)::bigint as calls,
      coalesce(sum(member_row.connected), 0)::bigint as connected_calls,
      coalesce(sum(member_row.talk_seconds), 0)::bigint as talk_seconds,
      coalesce(sum(member_row.test_drives), 0)::bigint as test_drives,
      coalesce(sum(member_row.quotations), 0)::bigint as quotations,
      coalesce(sum(member_row.bookings), 0)::bigint as bookings
    from member_stats member_row
  )
  select jsonb_build_object(
    'days', target_days,
    'generated_at', now(),
    'team_ids', to_jsonb(managed_team_ids),
    'kpis', jsonb_build_object(
      'leads', total_row.leads,
      'contacted', total_row.contacted,
      'calls', total_row.calls,
      'connected_calls', total_row.connected_calls,
      'talk_seconds', total_row.talk_seconds,
      'test_drives', total_row.test_drives,
      'quotations', total_row.quotations,
      'bookings', total_row.bookings,
      'conversion', case when total_row.leads > 0
        then round(total_row.bookings::numeric * 100 / total_row.leads, 2) else 0 end
    ),
    'daily', daily_row.records,
    'leaderboard', leaderboard_row.records
  ) into result
  from totals total_row
  cross join daily daily_row
  cross join leaderboard leaderboard_row;

  return result;
end;
$function$;

-- Lost Leads summary for the manager pages: how many leads in the caller's lead
-- scope are lost, when, and why. One call returns the tiles and the reason chart.
create or replace function public.get_lost_lead_summary(
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  current_organization_id uuid;
  lead_scope record;
  local_today date;
  month_start timestamptz;
  week_start timestamptz;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not app_private.is_valid_timezone(target_timezone) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  -- Scope is resolved once and the leads filtered on it, not checked per row.
  select * into lead_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['lead.view']::text[]
  );
  local_today := (now() at time zone target_timezone)::date;
  month_start := date_trunc('month', local_today)::timestamp at time zone target_timezone;
  week_start := (local_today - 6)::timestamp at time zone target_timezone;

  with lost as materialized (
    select
      coalesce(nullif(btrim(lead_row.lost_reason), ''), 'Not recorded') as reason,
      -- When it was marked lost; updated_at only for a lead with no stage history.
      coalesce(
        (
          select max(history_row.created_at)
          from public.lead_stage_history history_row
          where history_row.organization_id = lead_row.organization_id
            and history_row.lead_id = lead_row.id
            and history_row.to_status = 'Lost'
        ),
        lead_row.updated_at
      ) as lost_at
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.lifecycle_status = 'Lost'
      and coalesce(lead_scope.granted, false)
      and (
        lead_scope.organization_wide
        or lead_row.branch_id = any(lead_scope.branch_scope_ids)
        or lead_row.team_id = any(lead_scope.team_scope_ids)
        or (
          lead_scope.own_records
          and lead_row.assigned_user_id = auth.uid()
          and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
        )
      )
  ), reasons as (
    select lost_row.reason, count(*)::bigint as lead_count
    from lost lost_row
    group by lost_row.reason
  )
  select jsonb_build_object(
    'generated_at', now(),
    'total', (select count(*) from lost),
    'this_month', (select count(*) from lost where lost_at >= month_start),
    'last_7_days', (select count(*) from lost where lost_at >= week_start),
    'competitor', (select count(*) from lost where reason = 'Chose Competitor'),
    'reasons', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('name', reason_row.reason, 'value', reason_row.lead_count)
          order by reason_row.lead_count desc, reason_row.reason
        )
        from reasons reason_row
      ),
      '[]'::jsonb
    )
  ) into result;
  return result;
end;
$function$;

revoke all on function public.get_lost_lead_summary(text) from public, anon;
grant execute on function public.get_lost_lead_summary(text) to authenticated;

commit;
