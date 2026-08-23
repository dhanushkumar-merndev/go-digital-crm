-- Team Manager performance is deliberately separate from personal reporting.
-- It is bounded to teams actually managed by the authenticated user, and all
-- fact-table reads stay on the team_id + assigned_user_id access path.

create index if not exists leads_team_performance_idx
  on public.leads (organization_id, team_id, assigned_user_id, created_at desc)
  where deleted_at is null;
create index if not exists calls_team_performance_idx
  on public.calls (organization_id, team_id, assigned_user_id, started_at desc);
create index if not exists test_drive_appointments_team_performance_idx
  on public.test_drive_appointments (organization_id, team_id, assigned_user_id, scheduled_at desc)
  where status <> 'CANCELLED';
create index if not exists quotations_team_performance_idx
  on public.quotations (organization_id, team_id, assigned_user_id, created_at desc);
create index if not exists bookings_team_performance_idx
  on public.bookings (organization_id, team_id, assigned_user_id, created_at desc)
  where deleted_at is null and status <> 'CANCELLED';

create or replace function public.get_team_manager_performance(
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
  if target_days not in (7, 14, 30)
    or target_timezone not in ('Asia/Kolkata', 'UTC')
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
  local_today := timezone(target_timezone, now())::date;
  start_day := local_today - (target_days - 1);
  range_start := timezone(target_timezone, start_day::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);

  with members as (
    select distinct on (member_row.user_id)
      member_row.user_id,
      member_row.team_id,
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
    select member_row.user_id, member_row.full_name,
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
      count(*)::bigint as calls
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
$$;

revoke all on function public.get_team_manager_performance(integer, text) from public, anon;
grant execute on function public.get_team_manager_performance(integer, text) to authenticated;
