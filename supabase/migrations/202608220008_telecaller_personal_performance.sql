-- Telecaller reporting uses the same bounded personal-performance shape as the
-- Sales Consultant view, with an explicit own-records role gate.  Department
-- metrics that a Telecaller cannot access remain zero rather than exposing
-- another team's data.

create or replace function public.get_personal_sales_performance(
  target_days integer default 7,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  current_user_id uuid := auth.uid();
  allowed_branch_ids uuid[];
  local_today date;
  start_day date;
  range_start timestamptz;
  range_end timestamptz;
  permission_keys text[];
  can_view_calls boolean;
  can_view_appointments boolean;
  can_view_test_drives boolean;
  can_view_bookings boolean;
  result jsonb;
begin
  if target_days not in (7, 14, 30)
    or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_PERFORMANCE_QUERY';
  end if;

  access_context := public.get_access_context();
  if current_user_id is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' not in ('sales-consultant', 'telecaller')
    or access_context->>'data_scope' <> 'OWN_RECORDS'
    or access_context->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'PERSONAL_PERFORMANCE_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  if not app_private.has_permission(current_organization_id, 'lead.view') then
    raise exception using errcode = '42501', message = 'LEAD_VIEW_PERMISSION_REQUIRED';
  end if;

  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  if cardinality(coalesce(allowed_branch_ids, array[]::uuid[])) = 0 then
    raise exception using errcode = '42501', message = 'PERSONAL_PERFORMANCE_SCOPE_DENIED';
  end if;

  local_today := timezone(target_timezone, now())::date;
  start_day := local_today - (target_days - 1);
  range_start := timezone(target_timezone, start_day::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);
  permission_keys := app_private.sales_consultant_permissions(current_organization_id);
  can_view_calls := 'call.view' = any(permission_keys);
  can_view_appointments := 'appointment.view' = any(permission_keys);
  can_view_test_drives := 'test_drive.view' = any(permission_keys)
    or 'test_drive.manage' = any(permission_keys);
  can_view_bookings := 'booking.view' = any(permission_keys)
    or 'booking.manage' = any(permission_keys);

  with lead_stats as (
    select
      count(*)::bigint as lead_count,
      count(*) filter (where lead_row.first_contacted_at is not null)::bigint as contacted_count,
      coalesce(round(avg(extract(epoch from (
        lead_row.first_contacted_at - lead_row.created_at
      ))) filter (
        where lead_row.first_contacted_at is not null
          and lead_row.first_contacted_at >= lead_row.created_at
      ))::bigint, 0) as average_response_seconds
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.assigned_user_id = current_user_id
      and lead_row.branch_id = any(allowed_branch_ids)
      and lead_row.deleted_at is null
      and lead_row.created_at >= range_start
      and lead_row.created_at < range_end
  ), call_daily as (
    select timezone(target_timezone, call_row.started_at)::date as metric_day,
      count(*)::bigint as call_count,
      count(*) filter (where upper(coalesce(call_row.outcome, '')) = 'CONNECTED')::bigint
        as connected_count,
      coalesce(sum(call_row.duration_seconds), 0)::bigint as talk_seconds
    from public.calls call_row
    where can_view_calls
      and call_row.organization_id = current_organization_id
      and call_row.assigned_user_id = current_user_id
      and call_row.branch_id = any(allowed_branch_ids)
      and call_row.started_at >= range_start
      and call_row.started_at < range_end
    group by timezone(target_timezone, call_row.started_at)::date
  ), appointment_daily as (
    select timezone(target_timezone, appointment_row.scheduled_at)::date as metric_day,
      count(*)::bigint as appointment_count
    from public.appointments appointment_row
    where can_view_appointments
      and appointment_row.organization_id = current_organization_id
      and appointment_row.assigned_user_id = current_user_id
      and appointment_row.branch_id = any(allowed_branch_ids)
      and appointment_row.status <> 'CANCELLED'
      and appointment_row.scheduled_at >= range_start
      and appointment_row.scheduled_at < range_end
    group by timezone(target_timezone, appointment_row.scheduled_at)::date
  ), test_drive_daily as (
    select timezone(target_timezone, drive_row.scheduled_at)::date as metric_day,
      count(*)::bigint as test_drive_count
    from public.test_drive_appointments drive_row
    where can_view_test_drives
      and drive_row.organization_id = current_organization_id
      and drive_row.assigned_user_id = current_user_id
      and drive_row.branch_id = any(allowed_branch_ids)
      and drive_row.status <> 'CANCELLED'
      and drive_row.scheduled_at >= range_start
      and drive_row.scheduled_at < range_end
    group by timezone(target_timezone, drive_row.scheduled_at)::date
  ), booking_stats as (
    select count(*)::bigint as booking_count
    from public.bookings booking_row
    where can_view_bookings
      and booking_row.organization_id = current_organization_id
      and booking_row.assigned_user_id = current_user_id
      and booking_row.branch_id = any(allowed_branch_ids)
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= range_start
      and booking_row.created_at < range_end
  ), day_rows as (
    select generated_day.day_timestamp::date as metric_day
    from generate_series(start_day::timestamp, local_today::timestamp, interval '1 day')
      generated_day(day_timestamp)
  ), daily_result as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', to_char(day_row.metric_day, 'DD Mon'),
      'calls', coalesce(call_row.call_count, 0),
      'connected', coalesce(call_row.connected_count, 0),
      'appointments', coalesce(appointment_row.appointment_count, 0),
      'test_drives', coalesce(drive_row.test_drive_count, 0)
    ) order by day_row.metric_day), '[]'::jsonb) as data
    from day_rows day_row
    left join call_daily call_row on call_row.metric_day = day_row.metric_day
    left join appointment_daily appointment_row on appointment_row.metric_day = day_row.metric_day
    left join test_drive_daily drive_row on drive_row.metric_day = day_row.metric_day
  ), target_result as (
    select coalesce(jsonb_object_agg(lower(target_row.metric), target_row.target_value
      order by target_row.created_at), '{}'::jsonb) as data
    from public.targets target_row
    where target_row.organization_id = current_organization_id
      and target_row.user_id = current_user_id
      and target_row.period_start <= local_today
      and target_row.period_end >= start_day
  )
  select jsonb_build_object(
    'days', target_days,
    'generated_at', now(),
    'kpis', jsonb_build_object(
      'leads', lead_row.lead_count,
      'contacted', lead_row.contacted_count,
      'calls', coalesce((select sum(call_source.call_count) from call_daily call_source), 0),
      'connected_calls', coalesce((select sum(call_source.connected_count) from call_daily call_source), 0),
      'talk_seconds', coalesce((select sum(call_source.talk_seconds) from call_daily call_source), 0),
      'appointments', coalesce((select sum(appointment_source.appointment_count) from appointment_daily appointment_source), 0),
      'test_drives', coalesce((select sum(drive_source.test_drive_count) from test_drive_daily drive_source), 0),
      'bookings', booking_row.booking_count,
      'average_response_seconds', lead_row.average_response_seconds
    ),
    'daily', daily_row.data,
    'targets', target_row.data
  ) into result
  from lead_stats lead_row
  cross join booking_stats booking_row
  cross join daily_result daily_row
  cross join target_result target_row;

  return result;
end;
$$;

revoke all on function public.get_personal_sales_performance(integer, text) from public, anon;
grant execute on function public.get_personal_sales_performance(integer, text) to authenticated;
