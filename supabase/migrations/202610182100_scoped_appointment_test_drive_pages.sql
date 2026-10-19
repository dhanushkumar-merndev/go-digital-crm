-- Manager Appointments and Test Drives pages timed out (57014 after 8 s) on the
-- demo tenant with only ~1,600 appointments and ~1,400 test drives. The manager
-- path of both RPCs (the *_legacy functions; Sales Consultants take a separate
-- fast path) called can_access_record, can_access_customer and can_access_lead
-- for every row in the organization before any tab, date or page filter, about
-- 3 ms each per row, plus has_permission and can_access_record per quotation in
-- the test-drive conversion lookup. Cost grew with the size of the tables, not
-- with the page being read: 8 s for a Team Manager, 14-17 s for a Sales Manager
-- or Client Admin.
--
-- The caller's scope is now resolved once per request with the same resolvers
-- the Customers, Follow-ups and Calls pages use, and rows are filtered on
-- arrays:
--   * appointment / test-drive / quotation rows: resolve_permission_record_scope
--     for the page's permission, plus the active-branch check can_access_record
--     made;
--   * the lead behind a row: resolve_permission_record_scope('lead.view');
--   * the customer: can_access_customer's rule exactly, via
--     resolve_customer_access_scope and actor_owned_lead_ids.
-- Bodies are the deployed definitions with only those predicates replaced.
-- Verified against the live demo tenant in a rolled-back transaction: byte-for-
-- byte identical JSON for Team Manager, Sales Manager and Client Admin over 8
-- parameter sets (tabs, pages, sorts, search), and unchanged denials for a
-- Telecaller; 8-17 s became 50-340 ms.

begin;

CREATE OR REPLACE FUNCTION public.get_appointment_workspace_page_legacy(target_search text DEFAULT ''::text, target_status text DEFAULT 'all'::text, target_appointment_type text DEFAULT 'all'::text, target_branch_id uuid DEFAULT NULL::uuid, target_team_id uuid DEFAULT NULL::uuid, target_owner_id uuid DEFAULT NULL::uuid, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25, target_sort text DEFAULT 'scheduled:asc'::text, target_timezone text DEFAULT 'Asia/Kolkata'::text)
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
  day_start timestamptz;
  day_end timestamptz;
  result jsonb;
  actor_id uuid;
  record_scope record;
  lead_scope record;
  customer_scope record;
  owned_lead_ids uuid[] := array[]::uuid[];
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if target_status not in (
    'all', 'today', 'upcoming', 'confirmed', 'arrived', 'completed',
    'no-show', 'rescheduled', 'cancelled'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_FILTER';
  end if;
  if target_appointment_type not in ('all', 'Showroom Visit', 'Video Call', 'Test Drive', 'Consultant Call') then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TYPE_FILTER';
  end if;
  if target_sort not in (
    'scheduled:asc', 'scheduled:desc', 'updated:desc',
    'updated:asc', 'customer:asc', 'customer:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_WORK_SORT';
  end if;
  if not app_private.is_valid_timezone(target_timezone) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.phone_search_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', now() at time zone target_timezone) at time zone target_timezone;
  day_end := day_start + interval '1 day';

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'appointment.view')
    or not app_private.has_permission(current_organization_id, 'customer.view')
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

  -- Resolved once per request; the rows below are filtered on arrays instead
  -- of calling a SECURITY DEFINER access helper per row.
  actor_id := auth.uid();
  select * into record_scope
  from app_private.resolve_permission_record_scope(current_organization_id, array['appointment.view']);
  select * into lead_scope
  from app_private.resolve_permission_record_scope(current_organization_id, array['lead.view']);
  select * into customer_scope
  from app_private.resolve_customer_access_scope(current_organization_id);
  if customer_scope.own_records then
    owned_lead_ids := app_private.actor_owned_lead_ids(current_organization_id);
  end if;

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
    join public.branches branch_row
      on branch_row.id = appointment_row.branch_id
     and branch_row.organization_id = appointment_row.organization_id
    left join public.teams team_row
      on team_row.id = appointment_row.team_id
     and team_row.organization_id = appointment_row.organization_id
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
    where appointment_row.organization_id = current_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and (
        record_scope.organization_wide
        or appointment_row.branch_id = any(record_scope.branch_scope_ids)
        or appointment_row.team_id = any(record_scope.team_scope_ids)
        or (
          record_scope.own_records
          and appointment_row.assigned_user_id = actor_id
          and appointment_row.branch_id = any(record_scope.own_record_branch_ids)
        )
      )
      and customer_scope.organization_access
      and (
        customer_scope.customer_ids_all
        or exists (
          select 1
          from public.leads scope_lead_row
          where scope_lead_row.organization_id = appointment_row.organization_id
            and scope_lead_row.customer_id = appointment_row.customer_id
            and scope_lead_row.deleted_at is null
            and (
              scope_lead_row.branch_id = any(customer_scope.branch_ids)
              or scope_lead_row.team_id = any(customer_scope.team_ids)
              or (
                customer_scope.own_records
                and (
                  scope_lead_row.assigned_user_id = actor_id
                  or scope_lead_row.id = any(owned_lead_ids)
                )
              )
            )
        )
      )
      and (
        appointment_row.lead_id is null
        or (
          lead_row.id is not null
          and lead_scope.granted
          and (
        lead_scope.organization_wide
        or lead_row.branch_id = any(lead_scope.branch_scope_ids)
        or lead_row.team_id = any(lead_scope.team_scope_ids)
        or (
          lead_scope.own_records
          and lead_row.assigned_user_id = actor_id
          and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
        )
      )
        )
      )
  ), scope_filtered as materialized (
    select record_row.*
    from accessible_records record_row
    where (target_branch_id is null or record_row.branch_id = target_branch_id)
      and (target_team_id is null or record_row.team_id = target_team_id)
      and (target_owner_id is null or record_row.assigned_user_id = target_owner_id)
      and (
        target_appointment_type = 'all'
        or record_row.appointment_type = target_appointment_type
      )
  ), filtered_records as materialized (
    select record_row.*
    from scope_filtered record_row
    where (
      normalized_search = ''
      or record_row.id = search_uuid
      or record_row.lead_id = search_uuid
      or lower(record_row.customer_name) ilike '%' || normalized_search || '%'
      or (
        search_phone_digits <> ''
        and app_private.normalize_phone_digits(record_row.phone) like search_phone_digits || '%'
      )
    )
    and case target_status
      when 'today' then record_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
        and record_row.scheduled_at >= day_start and record_row.scheduled_at < day_end
      when 'upcoming' then record_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
        and record_row.scheduled_at >= day_end
      when 'confirmed' then record_row.status = 'CONFIRMED'
      when 'arrived' then record_row.attendance_status = 'ARRIVED'
      when 'completed' then record_row.status = 'COMPLETED'
      when 'no-show' then record_row.status = 'NO_SHOW'
      when 'rescheduled' then record_row.status = 'RESCHEDULED'
      when 'cancelled' then record_row.status = 'CANCELLED'
      else true
    end
  ), page_rows as (
    select record_row.*
    from filtered_records record_row
    order by
      case when target_sort = 'scheduled:asc' then record_row.scheduled_at end asc,
      case when target_sort = 'scheduled:desc' then record_row.scheduled_at end desc,
      case when target_sort = 'updated:desc' then record_row.updated_at end desc,
      case when target_sort = 'updated:asc' then record_row.updated_at end asc,
      case when target_sort = 'customer:asc' then lower(record_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(record_row.customer_name) end desc,
      record_row.id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(to_jsonb(page_row) order by
        case when target_sort = 'scheduled:asc' then page_row.scheduled_at end asc,
        case when target_sort = 'scheduled:desc' then page_row.scheduled_at end desc,
        case when target_sort = 'updated:desc' then page_row.updated_at end desc,
        case when target_sort = 'updated:asc' then page_row.updated_at end asc,
        case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
        case when target_sort = 'customer:desc' then lower(page_row.customer_name) end desc,
        page_row.id asc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_records),
    'kpis', jsonb_build_object(
      'today', (
        select count(*) from scope_filtered
        where status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
          and scheduled_at >= day_start and scheduled_at < day_end
      ),
      'upcoming', (
        select count(*) from scope_filtered
        where status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW') and scheduled_at >= day_end
      ),
      'confirmed', (select count(*) from scope_filtered where status = 'CONFIRMED'),
      'completed', (select count(*) from scope_filtered where status = 'COMPLETED'),
      'no_show', (select count(*) from scope_filtered where status = 'NO_SHOW'),
      'arrived', (select count(*) from scope_filtered where attendance_status = 'ARRIVED')
    ),
    'filters', jsonb_build_object(
      'branches', coalesce((
        select jsonb_agg(jsonb_build_object('id', branch_id, 'name', branch_name) order by branch_name)
        from (select distinct branch_id, branch_name from accessible_records) branch_filter
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object('id', team_id, 'name', team_name, 'branch_id', branch_id) order by team_name)
        from (
          select distinct team_id, team_name, branch_id from accessible_records where team_id is not null
        ) team_filter
      ), '[]'::jsonb),
      'owners', coalesce((
        select jsonb_agg(jsonb_build_object('id', assigned_user_id, 'name', assigned_user_name) order by assigned_user_name)
        from (select distinct assigned_user_id, assigned_user_name from accessible_records) owner_filter
      ), '[]'::jsonb)
    ),
    'timezone', target_timezone
  ) into result;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_test_drive_workspace_page_legacy(target_view text DEFAULT 'TODAY'::text, target_search text DEFAULT ''::text, target_model text DEFAULT ''::text, target_from_date date DEFAULT NULL::date, target_to_date date DEFAULT NULL::date, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25, target_sort text DEFAULT 'scheduled:asc'::text, target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_model text := lower(btrim(coalesce(target_model, '')));
  search_uuid uuid;
  result jsonb;
  actor_id uuid;
  record_scope record;
  lead_scope record;
  customer_scope record;
  owned_lead_ids uuid[] := array[]::uuid[];
  quotation_scope record;
  quotation_access boolean;
  organization_wide_drive_view boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if upper(coalesce(target_view, '')) not in ('ALL', 'TODAY', 'UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED')
    or char_length(normalized_search) > 160
    or char_length(normalized_model) > 120
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort is null
    or target_sort not in ('scheduled:asc', 'scheduled:desc', 'updated:desc', 'customer:asc')
    or target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC')
    or (target_from_date is not null and target_to_date is not null and target_from_date > target_to_date)
    or (target_from_date is not null and target_to_date is not null and target_to_date > target_from_date + 366)
  then
    raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_QUERY';
  end if;
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not (
      app_private.has_permission(current_organization_id, 'test_drive.view')
      or app_private.has_permission(current_organization_id, 'test_drive.manage')
    )
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'TEST_DRIVE_VIEW_PERMISSION_REQUIRED';
  end if;

  -- Resolved once per request; the rows below are filtered on arrays instead
  -- of calling a SECURITY DEFINER access helper per row.
  actor_id := auth.uid();
  select * into record_scope
  from app_private.resolve_permission_record_scope(current_organization_id, array['test_drive.view', 'test_drive.manage']);
  select * into lead_scope
  from app_private.resolve_permission_record_scope(current_organization_id, array['lead.view']);
  select * into customer_scope
  from app_private.resolve_customer_access_scope(current_organization_id);
  if customer_scope.own_records then
    owned_lead_ids := app_private.actor_owned_lead_ids(current_organization_id);
  end if;
  quotation_access :=
    app_private.has_permission(current_organization_id, 'quotation.view')
    or app_private.has_permission(current_organization_id, 'quotation.manage');
  select * into quotation_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id, array['quotation.view', 'quotation.manage']
  );
  organization_wide_drive_view :=
    app_private.has_permission(current_organization_id, 'test_drive.view')
    and app_private.has_organization_wide_scope(current_organization_id);

  with authorized as materialized (
    select
      drive_row.id,
      drive_row.organization_id,
      drive_row.appointment_id,
      drive_row.customer_id,
      drive_row.lead_id,
      drive_row.branch_id,
      drive_row.team_id,
      drive_row.assigned_user_id,
      drive_row.status,
      drive_row.version,
      appointment_row.scheduled_at,
      appointment_row.expected_duration_minutes,
      appointment_row.stock_unit_id,
      appointment_row.vehicle_registration,
      appointment_row.start_location,
      appointment_row.destination,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as assigned_user_name,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      stock_row.vin,
      stock_row.chassis_number,
      stock_row.color,
      drive_row.started_at,
      drive_row.reached_at,
      drive_row.completed_at,
      drive_row.start_odometer,
      drive_row.end_odometer,
      drive_row.distance_meters,
      drive_row.duration_seconds,
      drive_row.start_anchor,
      drive_row.reached_anchor,
      drive_row.end_anchor,
      drive_row.route_finalized_at,
      summary_row.id as route_summary_id,
      summary_row.point_count,
      feedback_row.id as feedback_id,
      feedback_row.overall_rating,
      feedback_row.purchase_intent,
      drive_row.cancelled_at,
      drive_row.cancellation_reason,
      drive_row.updated_at,
      case
        when drive_row.status = 'ACTIVE' then 'ANCHORS_ONLY_ACTIVE'
        when drive_row.status = 'COMPLETED' and summary_row.id is null then 'ROUTE_UPLOAD_PENDING'
        when summary_row.id is not null then 'ROUTE_FINALIZED'
        else 'NOT_STARTED'
      end as gps_status,
      case
        when quotation_access
        then (
          select quotation_row.status
          from public.quotations quotation_row
          where quotation_row.organization_id = drive_row.organization_id
            and quotation_row.lead_id = drive_row.lead_id
            and quotation_row.created_at >= coalesce(drive_row.completed_at, drive_row.created_at)
            and quotation_scope.granted
            and (
              quotation_scope.organization_wide
              or quotation_row.branch_id = any(quotation_scope.branch_scope_ids)
              or quotation_row.team_id = any(quotation_scope.team_scope_ids)
              or (
                quotation_scope.own_records
                and quotation_row.assigned_user_id = actor_id
                and quotation_row.branch_id = any(quotation_scope.own_record_branch_ids)
              )
            )
          order by quotation_row.created_at desc, quotation_row.id desc
          limit 1
        )
        else null
      end as quotation_status,
      case
        when drive_row.status = 'READY'
          and timezone(target_timezone, appointment_row.scheduled_at)::date
            < timezone(target_timezone, now())::date
          then 'OVERDUE'
        when drive_row.status = 'READY'
          and timezone(target_timezone, appointment_row.scheduled_at)::date
            = timezone(target_timezone, now())::date
          then 'TODAY'
        when drive_row.status = 'READY' then 'UPCOMING'
        else drive_row.status
      end as schedule_state
    from public.test_drives drive_row
    join public.test_drive_appointments appointment_row
      on appointment_row.id = drive_row.appointment_id
     and appointment_row.organization_id = drive_row.organization_id
    join public.customers customer_row
      on customer_row.id = drive_row.customer_id
     and customer_row.organization_id = drive_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = drive_row.branch_id
     and branch_row.organization_id = drive_row.organization_id
    left join public.teams team_row
      on team_row.id = drive_row.team_id
     and team_row.organization_id = drive_row.organization_id
    join public.profiles profile_row
      on profile_row.id = drive_row.assigned_user_id
     and profile_row.organization_id = drive_row.organization_id
    left join public.stock_units stock_row
      on stock_row.id = appointment_row.stock_unit_id
     and stock_row.organization_id = drive_row.organization_id
    left join public.vehicle_variants variant_row
      on variant_row.id = stock_row.variant_id
     and variant_row.organization_id = stock_row.organization_id
    left join public.vehicle_models model_row
      on model_row.id = variant_row.model_id
     and model_row.organization_id = variant_row.organization_id
    left join public.vehicle_brands brand_row
      on brand_row.id = model_row.brand_id
     and brand_row.organization_id = model_row.organization_id
    left join public.test_drive_route_summaries summary_row
      on summary_row.test_drive_id = drive_row.id
     and summary_row.organization_id = drive_row.organization_id
    left join public.leads lead_row
      on lead_row.id = drive_row.lead_id
     and lead_row.organization_id = drive_row.organization_id
     and lead_row.deleted_at is null
    left join public.test_drive_feedback feedback_row
      on feedback_row.test_drive_id = drive_row.id
     and feedback_row.organization_id = drive_row.organization_id
    where drive_row.organization_id = current_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and (
        record_scope.organization_wide
        or drive_row.branch_id = any(record_scope.branch_scope_ids)
        or drive_row.team_id = any(record_scope.team_scope_ids)
        or (
          record_scope.own_records
          and drive_row.assigned_user_id = actor_id
          and drive_row.branch_id = any(record_scope.own_record_branch_ids)
        )
      )
      and customer_scope.organization_access
      and (
        customer_scope.customer_ids_all
        or exists (
          select 1
          from public.leads scope_lead_row
          where scope_lead_row.organization_id = drive_row.organization_id
            and scope_lead_row.customer_id = drive_row.customer_id
            and scope_lead_row.deleted_at is null
            and (
              scope_lead_row.branch_id = any(customer_scope.branch_ids)
              or scope_lead_row.team_id = any(customer_scope.team_ids)
              or (
                customer_scope.own_records
                and (
                  scope_lead_row.assigned_user_id = actor_id
                  or scope_lead_row.id = any(owned_lead_ids)
                )
              )
            )
        )
      )
      and (
        drive_row.lead_id is null
        or organization_wide_drive_view
        or (
          lead_row.id is not null
          and lead_scope.granted
          and (
        lead_scope.organization_wide
        or lead_row.branch_id = any(lead_scope.branch_scope_ids)
        or lead_row.team_id = any(lead_scope.team_scope_ids)
        or (
          lead_scope.own_records
          and lead_row.assigned_user_id = actor_id
          and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
        )
      )
        )
      )
      and (target_from_date is null or timezone(target_timezone, appointment_row.scheduled_at)::date >= target_from_date)
      and (target_to_date is null or timezone(target_timezone, appointment_row.scheduled_at)::date <= target_to_date)
      and (
        normalized_model = ''
        or position(normalized_model in lower(coalesce(brand_row.name, ''))) > 0
        or position(normalized_model in lower(coalesce(model_row.name, ''))) > 0
        or position(normalized_model in lower(coalesce(variant_row.name, ''))) > 0
      )
      and (
        normalized_search = ''
        or drive_row.id = search_uuid
        or customer_row.normalized_name ilike '%' || normalized_search || '%'
        or position(normalized_search in lower(coalesce(stock_row.vin, ''))) > 0
        or position(normalized_search in lower(coalesce(appointment_row.vehicle_registration, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), filtered as materialized (
    select authorized_row.*
    from authorized authorized_row
    where case upper(target_view)
      when 'TODAY' then authorized_row.status = 'READY'
        and timezone(target_timezone, authorized_row.scheduled_at)::date
          <= timezone(target_timezone, now())::date
      when 'UPCOMING' then authorized_row.status = 'READY'
        and timezone(target_timezone, authorized_row.scheduled_at)::date
          > timezone(target_timezone, now())::date
      when 'ACTIVE' then authorized_row.status = 'ACTIVE'
      when 'COMPLETED' then authorized_row.status = 'COMPLETED'
      when 'CANCELLED' then authorized_row.status = 'CANCELLED'
      when 'ALL' then true
      else false
    end
  ), numbered as (
    select filtered_row.*,
      row_number() over (order by
        case when target_sort = 'scheduled:asc' then filtered_row.scheduled_at end asc,
        case when target_sort = 'scheduled:desc' then filtered_row.scheduled_at end desc,
        case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
        case when target_sort = 'customer:asc' then lower(filtered_row.customer_name) end asc,
        filtered_row.id desc
      ) as page_order
    from filtered filtered_row
  ), page_rows as (
    select numbered_row.*
    from numbered numbered_row
    order by numbered_row.page_order
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_row.page_order)
      from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'organization_id', current_organization_id,
    'timezone', target_timezone,
    'kpis', jsonb_build_object(
      'total', (select count(*) from authorized),
      'today', (select count(*) from authorized where status = 'READY'
        and timezone(target_timezone, scheduled_at)::date = timezone(target_timezone, now())::date),
      'overdue', (select count(*) from authorized where status = 'READY'
        and timezone(target_timezone, scheduled_at)::date < timezone(target_timezone, now())::date),
      'upcoming', (select count(*) from authorized where status = 'READY'
        and timezone(target_timezone, scheduled_at)::date > timezone(target_timezone, now())::date),
      'active', (select count(*) from authorized where status = 'ACTIVE'),
      'completed', (select count(*) from authorized where status = 'COMPLETED'),
      'completed_this_month', (select count(*) from authorized where status = 'COMPLETED'
        and date_trunc('month', timezone(target_timezone, completed_at))
          = date_trunc('month', timezone(target_timezone, now()))),
      'cancelled', (select count(*) from authorized where status = 'CANCELLED'),
      'converted', (select count(*) from authorized where status = 'COMPLETED' and quotation_status is not null)
    )
  ) into result;
  return result;
end;
$function$;

commit;
