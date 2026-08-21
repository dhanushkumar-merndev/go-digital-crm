begin;

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
  org_id uuid;
  user_id uuid := auth.uid();
  today_local date;
  start_day date;
begin
  if user_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_days not in (7, 14, 30) or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_PERFORMANCE_QUERY';
  end if;

  org_id := app_private.current_tenant_organization();
  if org_id is null or not (
    app_private.has_permission(org_id, 'lead.view')
    or app_private.has_permission(org_id, 'call.view')
  ) then
    raise exception using errcode = '42501', message = 'PERFORMANCE_ACCESS_REQUIRED';
  end if;

  today_local := timezone(target_timezone, now())::date;
  start_day := today_local - (target_days - 1);

  return jsonb_build_object(
    'days', target_days,
    'generated_at', now(),
    'kpis', jsonb_build_object(
      'leads', (select count(*) from public.leads x where x.organization_id = org_id and x.assigned_user_id = user_id and x.deleted_at is null and timezone(target_timezone, x.created_at)::date between start_day and today_local),
      'contacted', (select count(*) from public.leads x where x.organization_id = org_id and x.assigned_user_id = user_id and x.deleted_at is null and x.first_contacted_at is not null and timezone(target_timezone, x.created_at)::date between start_day and today_local),
      'calls', (select count(*) from public.calls x where x.organization_id = org_id and x.assigned_user_id = user_id and timezone(target_timezone, x.started_at)::date between start_day and today_local),
      'connected_calls', (select count(*) from public.calls x where x.organization_id = org_id and x.assigned_user_id = user_id and upper(coalesce(x.outcome, '')) = 'CONNECTED' and timezone(target_timezone, x.started_at)::date between start_day and today_local),
      'talk_seconds', (select coalesce(sum(x.duration_seconds), 0) from public.calls x where x.organization_id = org_id and x.assigned_user_id = user_id and timezone(target_timezone, x.started_at)::date between start_day and today_local),
      'appointments', (select count(*) from public.appointments x where x.organization_id = org_id and x.assigned_user_id = user_id and timezone(target_timezone, x.scheduled_at)::date between start_day and today_local and x.status <> 'CANCELLED'),
      'test_drives', (select count(*) from public.test_drive_appointments x where x.organization_id = org_id and x.assigned_user_id = user_id and timezone(target_timezone, x.scheduled_at)::date between start_day and today_local and x.status <> 'CANCELLED'),
      'bookings', (select count(*) from public.bookings x where x.organization_id = org_id and x.assigned_user_id = user_id and x.deleted_at is null and x.status <> 'CANCELLED' and timezone(target_timezone, x.created_at)::date between start_day and today_local),
      'average_response_seconds', (
        select coalesce(round(avg(extract(epoch from (x.first_contacted_at - x.created_at))))::bigint, 0)
        from public.leads x
        where x.organization_id = org_id
          and x.assigned_user_id = user_id
          and x.deleted_at is null
          and x.first_contacted_at is not null
          and x.first_contacted_at >= x.created_at
          and timezone(target_timezone, x.created_at)::date between start_day and today_local
      )
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', to_char(d.day_value, 'DD Mon'),
        'calls', coalesce(c.total, 0),
        'connected', coalesce(c.connected, 0),
        'appointments', coalesce(w.appointments, 0),
        'test_drives', coalesce(w.test_drives, 0)
      ) order by d.day_value), '[]'::jsonb)
      from generate_series(start_day, today_local, '1 day') d(day_value)
      left join (
        select timezone(target_timezone, started_at)::date day_value,
          count(*) total,
          count(*) filter (where upper(coalesce(outcome, '')) = 'CONNECTED') connected
        from public.calls
        where organization_id = org_id and assigned_user_id = user_id
        group by 1
      ) c on c.day_value = d.day_value
      left join (
        select day_value, sum(appointments) appointments, sum(test_drives) test_drives
        from (
          select timezone(target_timezone, scheduled_at)::date day_value, count(*) appointments, 0::bigint test_drives
          from public.appointments
          where organization_id = org_id and assigned_user_id = user_id and status <> 'CANCELLED'
          group by 1
          union all
          select timezone(target_timezone, scheduled_at)::date, 0::bigint, count(*)
          from public.test_drive_appointments
          where organization_id = org_id and assigned_user_id = user_id and status <> 'CANCELLED'
          group by 1
        ) s
        group by day_value
      ) w on w.day_value = d.day_value
    ),
    'targets', (
      select coalesce(jsonb_object_agg(lower(metric), target_value), '{}'::jsonb)
      from public.targets t
      where t.organization_id = org_id
        and t.user_id = user_id
        and t.period_start <= today_local
        and t.period_end >= start_day
    )
  );
end;
$$;

revoke all on function public.get_sales_consultant_performance(integer, text) from public, anon;
grant execute on function public.get_sales_consultant_performance(integer, text) to authenticated;

commit;
