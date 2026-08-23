-- GM Sales Executive analytics stay server-side. Branch, consultant and model
-- aggregates are computed only for the caller's authorized branch/record scope.

create index if not exists leads_gm_analytics_branch_created_idx
  on public.leads (organization_id, branch_id, created_at desc)
  where deleted_at is null;
create index if not exists calls_gm_analytics_branch_started_idx
  on public.calls (organization_id, branch_id, started_at desc);
create index if not exists test_drive_appointments_gm_analytics_branch_scheduled_idx
  on public.test_drive_appointments (organization_id, branch_id, scheduled_at desc)
  where status <> 'CANCELLED';
create index if not exists quotations_gm_analytics_branch_created_idx
  on public.quotations (organization_id, branch_id, created_at desc);
create index if not exists bookings_gm_analytics_branch_created_idx
  on public.bookings (organization_id, branch_id, created_at desc)
  where deleted_at is null and status <> 'CANCELLED';

create or replace function public.get_gm_sales_analytics_workspace(
  target_days integer default 30,
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
  local_today date;
  start_day date;
  range_start timestamptz;
  range_end timestamptz;
  can_view_calls boolean;
  can_view_test_drives boolean;
  can_view_quotations boolean;
  can_view_bookings boolean;
  result jsonb;
begin
  if target_days not in (7, 14, 30)
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_GM_SALES_ANALYTICS_QUERY';
  end if;

  access_context := public.get_access_context();
  if auth.uid() is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'gm-sales'
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'GM_SALES_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  if not app_private.has_permission(current_organization_id, 'lead.view') then
    raise exception using errcode = '42501', message = 'GM_SALES_LEAD_VIEW_REQUIRED';
  end if;

  can_view_calls := app_private.has_permission(current_organization_id, 'call.view');
  can_view_test_drives := app_private.has_permission(current_organization_id, 'test_drive.view')
    or app_private.has_permission(current_organization_id, 'test_drive.manage');
  can_view_quotations := app_private.has_permission(current_organization_id, 'quotation.view')
    or app_private.has_permission(current_organization_id, 'quotation.manage');
  can_view_bookings := app_private.has_permission(current_organization_id, 'booking.view')
    or app_private.has_permission(current_organization_id, 'booking.manage');
  local_today := timezone(target_timezone, now())::date;
  start_day := local_today - (target_days - 1);
  range_start := timezone(target_timezone, start_day::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);

  with accessible_branches as materialized (
    select branch_row.id, branch_row.name
    from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and branch_row.active
      and app_private.can_access_branch(current_organization_id, branch_row.id)
  ), scoped_leads as materialized (
    select lead_row.id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id,
      lead_row.interested_model, lead_row.created_at
    from public.leads lead_row
    join accessible_branches branch_row on branch_row.id = lead_row.branch_id
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.created_at >= range_start
      and lead_row.created_at < range_end
      and app_private.can_access_record(
        lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
      )
  ), scoped_calls as materialized (
    select call_row.branch_id, call_row.team_id, call_row.assigned_user_id, call_row.started_at
    from public.calls call_row
    join accessible_branches branch_row on branch_row.id = call_row.branch_id
    where can_view_calls
      and call_row.organization_id = current_organization_id
      and call_row.started_at >= range_start
      and call_row.started_at < range_end
      and app_private.can_access_record(
        call_row.organization_id, call_row.branch_id, call_row.team_id, call_row.assigned_user_id
      )
  ), scoped_drives as materialized (
    select drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id, drive_row.scheduled_at
    from public.test_drive_appointments drive_row
    join accessible_branches branch_row on branch_row.id = drive_row.branch_id
    where can_view_test_drives
      and drive_row.organization_id = current_organization_id
      and drive_row.status <> 'CANCELLED'
      and drive_row.scheduled_at >= range_start
      and drive_row.scheduled_at < range_end
      and app_private.can_access_record(
        drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
      )
  ), scoped_quotations as materialized (
    select quotation_row.branch_id, quotation_row.team_id, quotation_row.assigned_user_id, quotation_row.created_at
    from public.quotations quotation_row
    join accessible_branches branch_row on branch_row.id = quotation_row.branch_id
    where can_view_quotations
      and quotation_row.organization_id = current_organization_id
      and quotation_row.created_at >= range_start
      and quotation_row.created_at < range_end
      and app_private.can_access_record(
        quotation_row.organization_id, quotation_row.branch_id, quotation_row.team_id, quotation_row.assigned_user_id
      )
  ), scoped_bookings as materialized (
    select booking_row.branch_id, booking_row.team_id, booking_row.assigned_user_id, booking_row.created_at
    from public.bookings booking_row
    join accessible_branches branch_row on branch_row.id = booking_row.branch_id
    where can_view_bookings
      and booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= range_start
      and booking_row.created_at < range_end
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id, booking_row.team_id, booking_row.assigned_user_id
      )
  ), branch_stats as (
    select branch_row.id, branch_row.name,
      (select count(*) from scoped_leads row where row.branch_id = branch_row.id)::bigint as leads,
      (select count(*) from scoped_calls row where row.branch_id = branch_row.id)::bigint as calls,
      (select count(*) from scoped_drives row where row.branch_id = branch_row.id)::bigint as test_drives,
      (select count(*) from scoped_quotations row where row.branch_id = branch_row.id)::bigint as quotations,
      (select count(*) from scoped_bookings row where row.branch_id = branch_row.id)::bigint as bookings
    from accessible_branches branch_row
  ), consultants as materialized (
    select distinct member_row.user_id, team_row.branch_id, profile_row.full_name
    from public.team_members member_row
    join public.teams team_row
      on team_row.organization_id = member_row.organization_id
     and team_row.id = member_row.team_id
     and team_row.active
    join accessible_branches branch_row on branch_row.id = team_row.branch_id
    join public.profiles profile_row
      on profile_row.organization_id = member_row.organization_id
     and profile_row.id = member_row.user_id
     and profile_row.active
    where member_row.organization_id = current_organization_id
      and member_row.active
      and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
      and app_private.can_access_team(current_organization_id, member_row.team_id)
  ), consultant_stats as (
    select consultant_row.user_id, consultant_row.full_name, branch_row.name as branch_name,
      (select count(*) from scoped_leads row where row.assigned_user_id = consultant_row.user_id)::bigint as leads,
      (select count(*) from scoped_calls row where row.assigned_user_id = consultant_row.user_id)::bigint as calls,
      (select count(*) from scoped_drives row where row.assigned_user_id = consultant_row.user_id)::bigint as test_drives,
      (select count(*) from scoped_quotations row where row.assigned_user_id = consultant_row.user_id)::bigint as quotations,
      (select count(*) from scoped_bookings row where row.assigned_user_id = consultant_row.user_id)::bigint as bookings
    from consultants consultant_row
    join accessible_branches branch_row on branch_row.id = consultant_row.branch_id
  ), model_stats as (
    select coalesce(nullif(btrim(interested_model), ''), 'Not specified') as name, count(*)::bigint as leads
    from scoped_leads
    group by 1
  ), daily_stats as (
    select timezone(target_timezone, created_at)::date as metric_day, count(*)::bigint as leads
    from scoped_leads group by 1
  ), booking_daily_stats as (
    select timezone(target_timezone, created_at)::date as metric_day, count(*)::bigint as bookings
    from scoped_bookings group by 1
  )
  select jsonb_build_object(
    'days', target_days,
    'generated_at', now(),
    'kpis', jsonb_build_object(
      'leads', coalesce((select sum(leads) from branch_stats), 0),
      'calls', coalesce((select sum(calls) from branch_stats), 0),
      'test_drives', coalesce((select sum(test_drives) from branch_stats), 0),
      'quotations', coalesce((select sum(quotations) from branch_stats), 0),
      'bookings', coalesce((select sum(bookings) from branch_stats), 0),
      'conversion', case when coalesce((select sum(leads) from branch_stats), 0) > 0
        then round(coalesce((select sum(bookings) from branch_stats), 0)::numeric * 100
          / (select sum(leads) from branch_stats), 2) else 0 end
    ),
    'branches', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'leads', leads, 'calls', calls, 'test_drives', test_drives,
      'quotations', quotations, 'bookings', bookings,
      'conversion', case when leads > 0 then round(bookings::numeric * 100 / leads, 2) else 0 end
    ) order by bookings desc, leads desc, name) from branch_stats), '[]'::jsonb),
    'consultants', coalesce((select jsonb_agg(jsonb_build_object(
      'user_id', user_id, 'full_name', full_name, 'branch_name', branch_name,
      'leads', leads, 'calls', calls, 'test_drives', test_drives, 'quotations', quotations,
      'bookings', bookings,
      'conversion', case when leads > 0 then round(bookings::numeric * 100 / leads, 2) else 0 end
    ) order by bookings desc, quotations desc, calls desc, full_name) from consultant_stats), '[]'::jsonb),
    'models', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'leads', leads)
      order by leads desc, name) from model_stats), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'name', to_char(day_row.metric_day, 'DD Mon'),
      'leads', coalesce(daily_row.leads, 0), 'bookings', coalesce(booking_row.bookings, 0)
    ) order by day_row.metric_day)
      from generate_series(start_day::timestamp, local_today::timestamp, interval '1 day') day_source(day_timestamp)
      cross join lateral (select day_source.day_timestamp::date as metric_day) day_row
      left join daily_stats daily_row on daily_row.metric_day = day_row.metric_day
      left join booking_daily_stats booking_row on booking_row.metric_day = day_row.metric_day), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_gm_sales_analytics_workspace(integer, text) from public, anon;
grant execute on function public.get_gm_sales_analytics_workspace(integer, text) to authenticated;
