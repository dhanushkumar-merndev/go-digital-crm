begin;

-- The original dashboard queried the scoped leads table once for each chart day.
-- Keep the same permission boundary, but materialize each caller-visible dataset
-- once per RPC and aggregate from that bounded result.
create or replace function public.get_tenant_performance_dashboard(
  target_days integer default 14,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  local_today date;
  can_view_leads boolean;
  can_view_calls boolean;
  can_view_work boolean;
  can_view_followups boolean;
  can_view_appointments boolean;
  can_view_bookings boolean;
  can_view_inventory boolean;
  can_view_test_drives boolean;
  can_view_operations boolean;
  lead_open_count bigint := 0;
  lead_new_today_count bigint := 0;
  followup_due_today_count bigint := 0;
  followup_overdue_count bigint := 0;
  appointment_today_count bigint := 0;
  call_today_count bigint := 0;
  booking_month_count bigint := 0;
  booking_month_value numeric := 0;
  test_drive_today_count bigint := 0;
  available_stock_count bigint := 0;
  open_case_count bigint := 0;
  overdue_case_count bigint := 0;
  case_due_today_count bigint := 0;
  case_completed_month_count bigint := 0;
  activity_result jsonb := '[]'::jsonb;
  pipeline_result jsonb := '[]'::jsonb;
  attention_result jsonb := '[]'::jsonb;
  lead_preview_result jsonb := '[]'::jsonb;
begin
  if target_days is null or target_days not in (7, 14, 30)
    or target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_TENANT_DASHBOARD_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null then
    raise exception using errcode = '42501', message = 'TENANT_DASHBOARD_ACCESS_REQUIRED';
  end if;

  can_view_leads := app_private.has_permission(current_organization_id, 'lead.view');
  can_view_calls := app_private.has_permission(current_organization_id, 'call.view');
  can_view_followups := app_private.has_permission(current_organization_id, 'followup.view');
  can_view_appointments := app_private.has_permission(current_organization_id, 'appointment.view');
  can_view_work := can_view_followups or can_view_appointments;
  can_view_bookings := app_private.has_permission(current_organization_id, 'booking.view')
    or app_private.has_permission(current_organization_id, 'booking.manage');
  can_view_inventory := app_private.has_permission(current_organization_id, 'inventory.view')
    or app_private.has_permission(current_organization_id, 'inventory.stock_check');
  can_view_test_drives := app_private.has_permission(current_organization_id, 'test_drive.view')
    or app_private.has_permission(current_organization_id, 'test_drive.manage');
  can_view_operations := app_private.has_permission(current_organization_id, 'finance.view')
    or app_private.has_permission(current_organization_id, 'finance.manage')
    or app_private.has_permission(current_organization_id, 'insurance.view')
    or app_private.has_permission(current_organization_id, 'insurance.manage')
    or app_private.has_permission(current_organization_id, 'rto.view')
    or app_private.has_permission(current_organization_id, 'rto.manage')
    or app_private.has_permission(current_organization_id, 'exchange.view')
    or app_private.has_permission(current_organization_id, 'exchange.manage')
    or app_private.has_permission(current_organization_id, 'delivery.view')
    or app_private.has_permission(current_organization_id, 'delivery.manage');

  if not (
    can_view_leads or can_view_calls or can_view_work or can_view_bookings or can_view_inventory
    or can_view_test_drives or can_view_operations
  ) then
    raise exception using errcode = '42501', message = 'TENANT_DASHBOARD_PERMISSION_REQUIRED';
  end if;
  local_today := timezone(target_timezone, now())::date;

  if can_view_leads then
    with scoped_leads as materialized (
      select lead_row.id, lead_row.customer_name, lead_row.phone, lead_row.source,
        lead_row.interested_model, lead_row.lifecycle_status, lead_row.temperature,
        lead_row.first_contacted_at, lead_row.sla_due_at, lead_row.created_at,
        lead_row.next_followup_at, lead_row.updated_at
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and app_private.can_access_record(
          lead_row.organization_id, lead_row.branch_id,
          lead_row.team_id, lead_row.assigned_user_id
        )
    ), pipeline as (
      select lifecycle_status, count(*)::bigint as stage_count,
        case lifecycle_status
          when 'New' then 1 when 'Contacted' then 2 when 'Qualified' then 3
          when 'Appointment Scheduled' then 4 when 'Transferred to Sales' then 5 else 6
        end as stage_order
      from scoped_leads
      where lifecycle_status <> 'Lost'
      group by lifecycle_status
    ), preview as (
      select id, customer_name, phone, source, interested_model, lifecycle_status, temperature,
        case
          when first_contacted_at is null and sla_due_at is not null and now() > sla_due_at then 'SLA_RISK'
          when first_contacted_at is null and now() >= created_at + interval '24 hours' then 'PENDING'
          when first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state,
        next_followup_at, updated_at
      from scoped_leads
      order by updated_at desc, id desc
      limit 5
    )
    select
      count(*) filter (where lifecycle_status <> 'Lost'),
      count(*) filter (where timezone(target_timezone, created_at)::date = local_today),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', app_private.dashboard_lifecycle_label(lifecycle_status::text),
          'value', stage_count
        ) order by stage_order)
        from pipeline
      ), '[]'::jsonb),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'customer_name', customer_name, 'phone', phone, 'source', source,
          'interested_model', interested_model, 'lifecycle_status', lifecycle_status,
          'temperature', temperature, 'work_state', work_state,
          'next_followup_at', next_followup_at, 'updated_at', updated_at
        ) order by updated_at desc, id desc)
        from preview
      ), '[]'::jsonb)
    into lead_open_count, lead_new_today_count, pipeline_result, lead_preview_result
    from scoped_leads;
  end if;

  if can_view_followups then
    select count(*) filter (where timezone(target_timezone, due_at)::date = local_today),
      count(*) filter (where due_at < now())
    into followup_due_today_count, followup_overdue_count
    from public.followups followup_row
    where followup_row.organization_id = current_organization_id
      and followup_row.status in ('OPEN', 'OVERDUE')
      and app_private.can_access_record(followup_row.organization_id, followup_row.branch_id, followup_row.team_id, followup_row.assigned_user_id)
      and (followup_row.lead_id is null or app_private.can_access_lead(followup_row.lead_id))
      and (followup_row.customer_id is null or app_private.can_access_customer(followup_row.organization_id, followup_row.customer_id));
  end if;

  if can_view_appointments then
    select count(*) into appointment_today_count
    from public.appointments appointment_row
    where appointment_row.organization_id = current_organization_id
      and appointment_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
      and timezone(target_timezone, appointment_row.scheduled_at)::date = local_today
      and app_private.can_access_record(appointment_row.organization_id, appointment_row.branch_id, appointment_row.team_id, appointment_row.assigned_user_id)
      and (appointment_row.lead_id is null or app_private.can_access_lead(appointment_row.lead_id))
      and app_private.can_access_customer(appointment_row.organization_id, appointment_row.customer_id);
  end if;

  if can_view_calls then
    select count(*) into call_today_count
    from public.calls call_row
    where call_row.organization_id = current_organization_id
      and timezone(target_timezone, call_row.started_at)::date = local_today
      and app_private.can_access_record(call_row.organization_id, call_row.branch_id, call_row.team_id, call_row.assigned_user_id)
      and (call_row.lead_id is null or app_private.can_access_lead(call_row.lead_id))
      and (call_row.customer_id is null or app_private.can_access_customer(call_row.organization_id, call_row.customer_id));
  end if;

  if can_view_bookings then
    select count(*), coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)
    into booking_month_count, booking_month_value
    from public.bookings booking_row
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
      and date_trunc('month', timezone(target_timezone, booking_row.created_at)) = date_trunc('month', timezone(target_timezone, now()))
      and app_private.can_access_record(booking_row.organization_id, booking_row.branch_id, booking_row.team_id, booking_row.assigned_user_id)
      and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id);
  end if;

  if can_view_test_drives then
    select count(*) into test_drive_today_count
    from public.test_drive_appointments appointment_row
    where appointment_row.organization_id = current_organization_id
      and timezone(target_timezone, appointment_row.scheduled_at)::date = local_today
      and appointment_row.status <> 'CANCELLED'
      and app_private.can_access_record(appointment_row.organization_id, appointment_row.branch_id, appointment_row.team_id, appointment_row.assigned_user_id)
      and app_private.can_access_customer(appointment_row.organization_id, appointment_row.customer_id)
      and (appointment_row.lead_id is null or app_private.can_access_lead(appointment_row.lead_id));
  end if;

  if can_view_inventory then
    select count(*) into available_stock_count
    from public.stock_units stock_row
    where stock_row.organization_id = current_organization_id
      and stock_row.deleted_at is null and stock_row.status = 'AVAILABLE'
      and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id);
  end if;

  if can_view_operations then
    select count(*) filter (where not app_private.operational_case_terminal(department, status)),
      count(*) filter (where due_at < now() and not app_private.operational_case_terminal(department, status)),
      count(*) filter (where due_at is not null and timezone(target_timezone, due_at)::date = local_today and not app_private.operational_case_terminal(department, status)),
      count(*) filter (where app_private.operational_case_terminal(department, status) and date_trunc('month', timezone(target_timezone, updated_at)) = date_trunc('month', timezone(target_timezone, now())))
    into open_case_count, overdue_case_count, case_due_today_count, case_completed_month_count
    from (
      select case_row.status, case_row.due_at, case_row.updated_at, 'FINANCE'::text as department from app_private.operational_case_rows(current_organization_id, 'FINANCE') case_row where app_private.operational_case_permission(current_organization_id, 'FINANCE', 'VIEW')
      union all select case_row.status, case_row.due_at, case_row.updated_at, 'INSURANCE'::text from app_private.operational_case_rows(current_organization_id, 'INSURANCE') case_row where app_private.operational_case_permission(current_organization_id, 'INSURANCE', 'VIEW')
      union all select case_row.status, case_row.due_at, case_row.updated_at, 'RTO'::text from app_private.operational_case_rows(current_organization_id, 'RTO') case_row where app_private.operational_case_permission(current_organization_id, 'RTO', 'VIEW')
      union all select case_row.status, case_row.due_at, case_row.updated_at, 'EXCHANGE'::text from app_private.operational_case_rows(current_organization_id, 'EXCHANGE') case_row where app_private.operational_case_permission(current_organization_id, 'EXCHANGE', 'VIEW')
      union all select case_row.status, case_row.due_at, case_row.updated_at, 'DELIVERY'::text from app_private.operational_case_rows(current_organization_id, 'DELIVERY') case_row where app_private.operational_case_permission(current_organization_id, 'DELIVERY', 'VIEW')
    ) operation_row;
  end if;

  -- One scan per visible resource replaces the old 14 correlated scans for each trend.
  with scoped_leads as materialized (
    select created_at
    from public.leads lead_row
    where can_view_leads and lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and app_private.can_access_record(lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id)
  ), scoped_calls as materialized (
    select started_at
    from public.calls call_row
    where not can_view_leads and can_view_calls and call_row.organization_id = current_organization_id
      and app_private.can_access_record(call_row.organization_id, call_row.branch_id, call_row.team_id, call_row.assigned_user_id)
      and (call_row.lead_id is null or app_private.can_access_lead(call_row.lead_id))
      and (call_row.customer_id is null or app_private.can_access_customer(call_row.organization_id, call_row.customer_id))
  ), scoped_bookings as materialized (
    select created_at
    from public.bookings booking_row
    where can_view_bookings and booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
      and app_private.can_access_record(booking_row.organization_id, booking_row.branch_id, booking_row.team_id, booking_row.assigned_user_id)
      and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id)
  ), primary_daily as (
    select timezone(target_timezone, created_at)::date as day_value, count(*)::bigint as value
    from scoped_leads group by 1
    union all
    select timezone(target_timezone, started_at)::date, count(*)::bigint
    from scoped_calls group by 1
  ), secondary_daily as (
    select timezone(target_timezone, created_at)::date as day_value, count(*)::bigint as value
    from scoped_bookings group by 1
  ), primary_rollup as (
    select day_value, sum(value)::bigint as value from primary_daily group by day_value
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', to_char(day_row.day_value, 'DD Mon'),
    'value', coalesce(primary_rollup.value, 0),
    'secondary', coalesce(secondary_daily.value, 0)
  ) order by day_row.day_value), '[]'::jsonb)
  into activity_result
  from generate_series(local_today - (target_days - 1), local_today, interval '1 day') generated_day(day_timestamp)
  cross join lateral (select generated_day.day_timestamp::date as day_value) day_row
  left join primary_rollup on primary_rollup.day_value = day_row.day_value
  left join secondary_daily on secondary_daily.day_value = day_row.day_value;

  if can_view_followups then
    select coalesce(jsonb_agg(to_jsonb(attention_row) order by attention_row.sort_at, attention_row.id), '[]'::jsonb)
    into attention_result
    from (
      select followup_row.id, 'FOLLOWUP'::text as kind,
        coalesce(customer_row.full_name, lead_row.customer_name) as title,
        'Follow-up was due ' || to_char(timezone(target_timezone, followup_row.due_at), 'DD Mon, HH24:MI') as detail,
        case when followup_row.due_at < now() - interval '1 day' then 'HIGH' else 'MEDIUM' end as severity,
        followup_row.due_at as sort_at, followup_row.lead_id
      from public.followups followup_row
      left join public.leads lead_row on lead_row.organization_id = followup_row.organization_id and lead_row.id = followup_row.lead_id and lead_row.deleted_at is null
      left join public.customers customer_row on customer_row.organization_id = followup_row.organization_id and customer_row.id = followup_row.customer_id and customer_row.deleted_at is null
      where followup_row.organization_id = current_organization_id
        and followup_row.status in ('OPEN', 'OVERDUE') and followup_row.due_at < now()
        and app_private.can_access_record(followup_row.organization_id, followup_row.branch_id, followup_row.team_id, followup_row.assigned_user_id)
        and (followup_row.lead_id is null or app_private.can_access_lead(followup_row.lead_id))
        and (followup_row.customer_id is null or app_private.can_access_customer(followup_row.organization_id, followup_row.customer_id))
      order by followup_row.due_at, followup_row.id
      limit 12
    ) attention_row;
  end if;

  return jsonb_build_object(
    'organization_id', current_organization_id, 'generated_at', now(), 'days', target_days,
    'capabilities', jsonb_build_object(
      'leads', can_view_leads, 'calls', can_view_calls, 'work', can_view_work,
      'bookings', can_view_bookings, 'inventory', can_view_inventory,
      'test_drives', can_view_test_drives, 'operations', can_view_operations
    ),
    'kpis', jsonb_build_object(
      'open_leads', lead_open_count, 'new_leads_today', lead_new_today_count,
      'followups_due_today', followup_due_today_count, 'followups_overdue', followup_overdue_count,
      'appointments_today', appointment_today_count, 'calls_today', call_today_count,
      'bookings_month', booking_month_count, 'booking_value_month', booking_month_value,
      'test_drives_today', test_drive_today_count, 'available_stock', available_stock_count,
      'open_cases', open_case_count, 'overdue_cases', overdue_case_count,
      'cases_due_today', case_due_today_count, 'cases_completed_month', case_completed_month_count
    ),
    'activity', activity_result, 'pipeline', pipeline_result, 'attention', attention_result,
    'lead_preview', lead_preview_result,
    'activity_primary', case when can_view_leads then 'New leads' else 'Calls' end,
    'activity_secondary', case when can_view_bookings then 'Bookings' else 'Calls' end
  );
end;
$$;

revoke all on function public.get_tenant_performance_dashboard(integer, text) from public, anon;
grant execute on function public.get_tenant_performance_dashboard(integer, text) to authenticated;

commit;
