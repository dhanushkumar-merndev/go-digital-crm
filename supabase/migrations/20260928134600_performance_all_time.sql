create or replace function public.get_sales_consultant_performance(
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
  if target_days not in (7, 14, 30, 9999)
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_PERFORMANCE_QUERY';
  end if;

  current_organization_id := app_private.sales_consultant_organization();
  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  local_today := timezone(target_timezone, now())::date;
  start_day := local_today - (target_days - 1);
  range_start := timezone(target_timezone, start_day::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);
  permission_keys := app_private.sales_consultant_permissions(current_organization_id);
  can_view_calls := 'call.view' = any(permission_keys);
  can_view_appointments := 'appointment.view' = any(permission_keys);
  can_view_test_drives :=
    'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys);
  can_view_bookings :=
    'booking.view' = any(permission_keys) or 'booking.manage' = any(permission_keys);

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
      count(*) filter (
        where upper(coalesce(call_row.outcome, '')) = 'CONNECTED'
      )::bigint as connected_count,
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
    from generate_series(
      start_day::timestamp,
      local_today::timestamp,
      interval '1 day'
    ) generated_day(day_timestamp)
  ), daily_result as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', to_char(day_row.metric_day, 'DD Mon'),
      'calls', coalesce(call_row.call_count, 0),
      'connected', coalesce(call_row.connected_count, 0),
      'appointments', coalesce(appointment_row.appointment_count, 0),
      'test_drives', coalesce(drive_row.test_drive_count, 0)
    ) order by day_row.metric_day), '[]'::jsonb) as data
    from day_rows day_row
    left join call_daily call_row
      on call_row.metric_day = day_row.metric_day
    left join appointment_daily appointment_row
      on appointment_row.metric_day = day_row.metric_day
    left join test_drive_daily drive_row
      on drive_row.metric_day = day_row.metric_day
  ), target_result as (
    select coalesce(jsonb_object_agg(
      lower(target_row.metric), target_row.target_value
      order by target_row.created_at
    ), '{}'::jsonb) as data
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
  )
  into result
  from lead_stats lead_row
  cross join booking_stats booking_row
  cross join daily_result daily_row
  cross join target_result target_row;

  return result;
end;
$$;

revoke all on function public.get_sales_consultant_performance(integer, text)
  from public, anon;
grant execute on function public.get_sales_consultant_performance(integer, text) to authenticated;

create or replace function public.get_telecaller_performance(
  target_days integer default 7,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  ctx jsonb := public.get_access_context();
  org uuid;
  actor uuid := auth.uid();
  branches uuid[];
  today date;
  first_day date;
  range_start timestamptz;
  range_end timestamptz;
  result jsonb;
begin
  if target_days is null or target_days not in (7,14,30)
    or target_timezone is null or target_timezone not in ('Asia/Kolkata','UTC') then
    raise exception using errcode = '22023', message = 'INVALID_PERFORMANCE_QUERY';
  end if;
  if actor is null or ctx->>'destination' is distinct from 'CRM'
    or ctx->>'role_key' is distinct from 'telecaller'
    or ctx->>'data_scope' is distinct from 'OWN_RECORDS'
    or ctx->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'PERSONAL_PERFORMANCE_ACCESS_REQUIRED';
  end if;
  org := (ctx->>'organization_id')::uuid;
  if not app_private.has_permission(org, 'lead.view') then
    raise exception using errcode = '42501', message = 'LEAD_VIEW_PERMISSION_REQUIRED';
  end if;
  branches := app_private.sales_consultant_allowed_branches(org);
  if coalesce(cardinality(branches),0) = 0 then
    raise exception using errcode = '42501', message = 'PERSONAL_PERFORMANCE_SCOPE_DENIED';
  end if;
  today := timezone(target_timezone, now())::date;
  first_day := today - (target_days - 1);
  range_start := timezone(target_timezone, first_day::timestamp);
  range_end := least(now(), timezone(target_timezone, (today + 1)::timestamp));

  with call_events as materialized (
    select c.lead_id, c.started_at, upper(coalesce(c.outcome,'')) = 'CONNECTED' as connected,
      coalesce(c.duration_seconds,0) as seconds
    from public.calls c
    where c.organization_id = org and c.assigned_user_id = actor
      and c.branch_id = any(branches)
      and app_private.has_permission(org, 'call.view')
      and c.started_at >= range_start and c.started_at <= range_end
  ), stage_events as materialized (
    select h.lead_id, h.to_status, h.created_at
    from public.lead_stage_history h
    join public.leads l on l.id = h.lead_id and l.organization_id = h.organization_id
    where h.organization_id = org and h.changed_by = actor
      and l.branch_id = any(branches) and l.deleted_at is null
      and h.created_at >= range_start and h.created_at <= range_end
  ), contact_ids as (
    select c.lead_id from call_events c
    join public.leads l on l.id = c.lead_id and l.organization_id = org
    where c.connected and l.deleted_at is null and l.branch_id = any(branches)
    union
    select lead_id from stage_events where to_status = 'Contacted'
    union
    select a.lead_id from public.activities a
    join public.leads l on l.id = a.lead_id and l.organization_id = a.organization_id
    where a.organization_id = org and a.actor_id = actor
      and a.activity_type = 'TELECALLER_CONTACTED'
      and l.branch_id = any(branches) and l.deleted_at is null
      and a.occurred_at >= range_start and a.occurred_at <= range_end
  ), assigned_ids as (
    select h.lead_id from public.lead_assignment_history h
    join public.leads l on l.id = h.lead_id and l.organization_id = h.organization_id
    where h.organization_id = org and h.new_owner_id = actor
      and h.branch_id = any(branches) and l.branch_id = any(branches) and l.deleted_at is null
      and h.created_at >= range_start and h.created_at <= range_end
    union
    -- Legacy/directly-created leads can lack an initial assignment event.
    select l.id from public.leads l
    where l.organization_id = org and l.assigned_user_id = actor
      and l.branch_id = any(branches) and l.deleted_at is null
      and l.created_at >= range_start and l.created_at <= range_end
      and not exists (select 1 from public.lead_assignment_history h
        where h.organization_id = org and h.lead_id = l.id)
    union
    -- Preserve that initial owner after the first handoff/reassignment as well.
    select l.id from public.leads l
    join lateral (
      select h.previous_owner_id from public.lead_assignment_history h
      where h.organization_id = org and h.lead_id = l.id
      order by h.created_at, h.id limit 1
    ) initial on initial.previous_owner_id = actor
    where l.organization_id = org and l.branch_id = any(branches) and l.deleted_at is null
      and l.created_at >= range_start and l.created_at <= range_end
  ), followup_events as materialized (
    select distinct f.id, f.completed_at
    from public.activities a
    join public.followups f on f.id::text = a.metadata->>'followup_id'
      and f.organization_id = a.organization_id
    where a.organization_id = org and a.actor_id = actor
      and a.activity_type = 'FOLLOWUP_COMPLETED'
      and app_private.has_permission(org, 'followup.view')
      and f.branch_id = any(branches) and f.status = 'COMPLETED'
      and f.completed_at >= range_start and f.completed_at <= range_end
      and a.occurred_at >= range_start and a.occurred_at <= range_end
  ), daily as (
    select day::date as metric_day from generate_series(first_day::timestamp, today::timestamp, interval '1 day') day
  ), daily_calls as (
    select timezone(target_timezone, started_at)::date as metric_day,
      count(*) as calls, count(*) filter (where connected) as connected
    from call_events group by 1
  ), daily_followups as (
    select timezone(target_timezone, completed_at)::date as metric_day, count(*) as completed
    from followup_events group by 1
  ), daily_handoffs as (
    select timezone(target_timezone, created_at)::date as metric_day, count(distinct lead_id) as transferred
    from stage_events where to_status = 'Transferred to Sales' group by 1
  ), matching_targets as (
    -- Do not compare a rolling week against a full monthly target or silently
    -- choose one of several overlapping periods. Only exact periods are comparable.
    select distinct on (lower(t.metric)) lower(t.metric) as metric, t.target_value
    from public.targets t
    where t.organization_id = org and t.user_id = actor
      and (t.branch_id is null or t.branch_id = any(branches))
      and t.period_start = first_day and t.period_end = today
    order by lower(t.metric), t.created_at desc, t.id desc
  )
  select jsonb_build_object(
    'days', target_days, 'generated_at', now(),
    'kpis', jsonb_build_object(
      'leads', (select count(*) from assigned_ids),
      'contacted', (select count(*) from contact_ids),
      'calls', (select count(*) from call_events),
      'connected_calls', (select count(*) from call_events where connected),
      'talk_seconds', (select coalesce(sum(seconds) filter (where connected),0) from call_events),
      'qualified', (select count(distinct lead_id) from stage_events where to_status in ('Qualified','Transferred to Sales')),
      'transferred', (select count(distinct lead_id) from stage_events where to_status = 'Transferred to Sales'),
      'followups_completed', (select count(*) from followup_events)
    ),
    'daily', (select jsonb_agg(jsonb_build_object(
      'name', to_char(d.metric_day,'DD Mon'),
      'calls', coalesce(c.calls,0), 'connected', coalesce(c.connected,0),
      'followups_completed', coalesce(f.completed,0), 'transferred', coalesce(h.transferred,0)
    ) order by d.metric_day) from daily d
      left join daily_calls c using (metric_day)
      left join daily_followups f using (metric_day)
      left join daily_handoffs h using (metric_day)),
    'targets', (select coalesce(jsonb_object_agg(metric,target_value),'{}'::jsonb) from matching_targets)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_telecaller_performance(integer,text) from public, anon;
grant execute on function public.get_telecaller_performance(integer,text) to authenticated;
