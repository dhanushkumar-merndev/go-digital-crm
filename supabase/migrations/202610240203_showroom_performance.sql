-- Sales Manager Performance, Showroom Targets and Approvals.
--
-- Performance showed only the telecaller-to-sales handoff report; PRD 54.4 §49-52
-- wants every member of the showroom compared with a funnel. The Team Manager
-- RPC now also serves a Sales Manager over the active teams in branches they can
-- open, with an optional branch filter (checked against those teams), each
-- member's team, and leads reaching qualification. A Team Manager's result is
-- unchanged apart from the added fields.
-- Showroom Targets listed telecallers at a zero sales target; it now lists
-- consultants only. Approvals gets one summary call for its tiles.
-- Bodies are the deployed definitions with anchored edits.

begin;

drop function public.get_team_manager_performance(integer, text);

CREATE OR REPLACE FUNCTION public.get_team_manager_performance(target_days integer DEFAULT 7, target_timezone text DEFAULT 'Asia/Kolkata'::text, target_branch_id uuid DEFAULT NULL::uuid)
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
  scoped_team_ids uuid[];
  branch_options jsonb;
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
    or access_context->>'role_key' not in ('team-manager', 'showroom-manager')
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  if not app_private.has_permission(current_organization_id, 'lead.view') then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_LEAD_VIEW_REQUIRED';
  end if;

  -- A Team Manager reads the teams they manage; a Sales Manager every active
  -- team in a branch they can open (PRD 54.4 §49). The branch filter narrows
  -- that set and never widens it.
  select coalesce(array_agg(team_row.id order by team_row.id), array[]::uuid[])
  into scoped_team_ids
  from public.teams team_row
  where team_row.organization_id = current_organization_id
    and team_row.active
    and case when access_context->>'role_key' = 'showroom-manager'
      then app_private.can_access_branch(current_organization_id, team_row.branch_id)
      else team_row.manager_id = current_user_id end
    and app_private.can_access_team(current_organization_id, team_row.id);

  select coalesce(jsonb_agg(jsonb_build_object('id', branch_row.id, 'name', branch_row.name)
      order by lower(branch_row.name), branch_row.id), '[]'::jsonb)
  into branch_options
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and branch_row.active
    and exists (
      select 1 from public.teams team_row
      where team_row.id = any(scoped_team_ids) and team_row.branch_id = branch_row.id
    );

  if target_branch_id is not null and not exists (
    select 1 from public.teams team_row
    where team_row.id = any(scoped_team_ids) and team_row.branch_id = target_branch_id
  ) then
    raise exception using errcode = '42501', message = 'TEAM_PERFORMANCE_BRANCH_DENIED';
  end if;

  select coalesce(array_agg(team_row.id order by team_row.id), array[]::uuid[])
  into managed_team_ids
  from public.teams team_row
  where team_row.id = any(scoped_team_ids)
    and (target_branch_id is null or team_row.branch_id = target_branch_id);

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
      profile_row.full_name,
      member_team.name as team_name
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    join public.teams member_team
      on member_team.id = member_row.team_id
    where member_row.organization_id = current_organization_id
      and member_row.team_id = any(managed_team_ids)
      and member_row.active
      and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
      and profile_row.active
    order by member_row.user_id, member_row.team_id
  ), lead_stats as (
    select lead_row.assigned_user_id as user_id,
      count(*)::bigint as leads,
      count(*) filter (where lead_row.first_contacted_at is not null)::bigint as contacted,
      -- Reached qualification: there now, or history says so (a later loss keeps it).
      count(*) filter (where lead_row.lifecycle_status in ('Qualified', 'Appointment Scheduled', 'Transferred to Sales')
        or exists (
          select 1 from public.lead_stage_history history_row
          where history_row.organization_id = current_organization_id
            and history_row.lead_id = lead_row.id
            and history_row.to_status in ('Qualified', 'Transferred to Sales')
        ))::bigint as qualified
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
    select member_row.user_id, member_row.full_name, member_row.member_type, member_row.team_name,
      coalesce(lead_row.leads, 0)::bigint as leads,
      coalesce(lead_row.contacted, 0)::bigint as contacted,
      coalesce(lead_row.qualified, 0)::bigint as qualified,
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
      'team_name', member_row.team_name,
      'leads', member_row.leads,
      'contacted', member_row.contacted,
      'qualified', member_row.qualified,
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
      coalesce(sum(member_row.qualified), 0)::bigint as qualified,
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
    'branch_id', target_branch_id,
    'branches', branch_options,
    'kpis', jsonb_build_object(
      'leads', total_row.leads,
      'contacted', total_row.contacted,
      'qualified', total_row.qualified,
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

revoke all on function public.get_team_manager_performance(integer, text, uuid) from public, anon;
grant execute on function public.get_team_manager_performance(integer, text, uuid)
  to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_showroom_target_workspace(target_month date DEFAULT (date_trunc('month'::text, timezone('Asia/Kolkata'::text, now())))::date, target_branch_id uuid DEFAULT NULL::uuid, target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  access_context jsonb;
  current_organization_id uuid;
  resolved_branch_id uuid;
  branch_count integer;
  local_today date;
  month_start date;
  month_end date;
  range_start timestamptz;
  range_end timestamptz;
begin
  if target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_SHOWROOM_TARGET_TIMEZONE';
  end if;

  access_context := public.get_access_context();
  if auth.uid() is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'showroom-manager'
    or access_context->>'organization_id' is null
    or not app_private.has_permission((access_context->>'organization_id')::uuid, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'SHOWROOM_TARGET_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  local_today := timezone(target_timezone, now())::date;
  month_start := date_trunc('month', target_month)::date;
  month_end := (month_start + interval '1 month')::date;
  if target_month <> month_start
    or month_start < date_trunc('month', local_today - interval '12 months')::date
    or month_start > date_trunc('month', local_today + interval '12 months')::date
  then
    raise exception using errcode = '22023', message = 'INVALID_SHOWROOM_TARGET_MONTH';
  end if;

  if target_branch_id is not null then
    if not app_private.can_access_branch(current_organization_id, target_branch_id) then
      raise exception using errcode = '42501', message = 'SHOWROOM_TARGET_BRANCH_DENIED';
    end if;
    resolved_branch_id := target_branch_id;
  else
    -- A manager over several branches opens on the first by name and picks
    -- another from the page; this used to refuse with SHOWROOM_TARGET_BRANCH_REQUIRED.
    select branch_row.id
      into resolved_branch_id
    from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and app_private.can_access_branch(current_organization_id, branch_row.id)
    order by lower(branch_row.name), branch_row.id
    limit 1;
    if resolved_branch_id is null then
      raise exception using errcode = '22023', message = 'SHOWROOM_TARGET_BRANCH_REQUIRED';
    end if;
  end if;

  range_start := timezone(target_timezone, month_start::timestamp);
  range_end := timezone(target_timezone, month_end::timestamp);

  return (
    with branch_target as (
      select
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('SALES_VALUE', 'SALES_AMOUNT', 'REVENUE')), 0)::numeric as sales_target,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('BOOKINGS', 'SALES_BOOKINGS')), 0)::numeric as booking_target,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('TEST_DRIVES', 'TEST_DRIVE')), 0)::numeric as drive_target
      from public.targets target_row
      where target_row.organization_id = current_organization_id
        and target_row.branch_id = resolved_branch_id
        and target_row.user_id is null
        and target_row.team_id is null
        and target_row.period_start <= month_start
        and target_row.period_end >= month_end - 1
    ), monthly_actual as (
      select
        coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)::numeric as sales_value,
        count(*)::bigint as bookings
      from public.bookings booking_row
      where booking_row.organization_id = current_organization_id
        and booking_row.branch_id = resolved_branch_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start
        and booking_row.created_at < range_end
    ), drive_actual as (
      select count(*)::bigint as test_drives
      from public.test_drive_appointments drive_row
      where drive_row.organization_id = current_organization_id
        and drive_row.branch_id = resolved_branch_id
        and drive_row.status <> 'CANCELLED'
        and drive_row.scheduled_at >= range_start
        and drive_row.scheduled_at < range_end
    ), consultants as (
      select distinct on (member_row.user_id)
        member_row.user_id,
        profile_row.full_name
      from public.team_members member_row
      join public.teams team_row
        on team_row.id = member_row.team_id
       and team_row.organization_id = member_row.organization_id
       and team_row.active
      join public.profiles profile_row
        on profile_row.id = member_row.user_id
       and profile_row.organization_id = member_row.organization_id
       and profile_row.active
      where member_row.organization_id = current_organization_id
        and team_row.branch_id = resolved_branch_id
        and member_row.active
        -- Telecallers hand leads on; they carry no sales target.
        and member_row.member_type = 'SALES_CONSULTANT'
      order by member_row.user_id, member_row.team_id
    ), consultant_targets as (
      select target_row.user_id,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('SALES_VALUE', 'SALES_AMOUNT', 'REVENUE')), 0)::numeric as sales_target
      from public.targets target_row
      where target_row.organization_id = current_organization_id
        and target_row.branch_id = resolved_branch_id
        and target_row.user_id is not null
        and target_row.period_start <= month_start
        and target_row.period_end >= month_end - 1
      group by target_row.user_id
    ), consultant_sales as (
      select booking_row.assigned_user_id as user_id,
        coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)::numeric as sales_value,
        count(*)::bigint as bookings
      from public.bookings booking_row
      where booking_row.organization_id = current_organization_id
        and booking_row.branch_id = resolved_branch_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start
        and booking_row.created_at < range_end
      group by booking_row.assigned_user_id
    ), consultant_drives as (
      select drive_row.assigned_user_id as user_id, count(*)::bigint as test_drives
      from public.test_drive_appointments drive_row
      where drive_row.organization_id = current_organization_id
        and drive_row.branch_id = resolved_branch_id
        and drive_row.status <> 'CANCELLED'
        and drive_row.scheduled_at >= range_start
        and drive_row.scheduled_at < range_end
      group by drive_row.assigned_user_id
    ), consultant_rows as (
      select consultant_row.user_id, consultant_row.full_name,
        coalesce(target_row.sales_target, 0)::numeric as sales_target,
        coalesce(sales_row.sales_value, 0)::numeric as sales_value,
        coalesce(sales_row.bookings, 0)::bigint as bookings,
        coalesce(drive_row.test_drives, 0)::bigint as test_drives
      from consultants consultant_row
      left join consultant_targets target_row on target_row.user_id = consultant_row.user_id
      left join consultant_sales sales_row on sales_row.user_id = consultant_row.user_id
      left join consultant_drives drive_row on drive_row.user_id = consultant_row.user_id
    ), daily_sales as (
      select timezone(target_timezone, booking_row.created_at)::date as metric_day,
        coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)::numeric as sales_value
      from public.bookings booking_row
      where booking_row.organization_id = current_organization_id
        and booking_row.branch_id = resolved_branch_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start
        and booking_row.created_at < range_end
      group by timezone(target_timezone, booking_row.created_at)::date
    ), model_rows as (
      select coalesce(nullif(lead_row.interested_model, ''), 'Not specified') as model,
        count(*)::bigint as bookings,
        coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)::numeric as sales_value
      from public.bookings booking_row
      left join public.leads lead_row
        on lead_row.id = booking_row.lead_id
       and lead_row.organization_id = booking_row.organization_id
      where booking_row.organization_id = current_organization_id
        and booking_row.branch_id = resolved_branch_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start
        and booking_row.created_at < range_end
      group by coalesce(nullif(lead_row.interested_model, ''), 'Not specified')
      order by sales_value desc, model
      limit 8
    ), calendar as (
      select day::date as metric_day
      from generate_series(month_start, month_end - 1, interval '1 day') day
    ), branch_row as (
      select id, name from public.branches where id = resolved_branch_id
    )
    select jsonb_build_object(
      'month', month_start,
      'branch', (select jsonb_build_object('id', id, 'name', name) from branch_row),
      -- Every branch the caller can open, for the page's branch picker.
      'branches', coalesce((
        select jsonb_agg(jsonb_build_object('id', option_row.id, 'name', option_row.name)
          order by lower(option_row.name), option_row.id)
        from public.branches option_row
        where option_row.organization_id = current_organization_id
          and option_row.active
          and option_row.deleted_at is null
          and app_private.can_access_branch(current_organization_id, option_row.id)
      ), '[]'::jsonb),
      'kpis', jsonb_build_object(
        'sales_target', (select sales_target from branch_target),
        'sales_value', (select sales_value from monthly_actual),
        'booking_target', (select booking_target from branch_target),
        'bookings', (select bookings from monthly_actual),
        'drive_target', (select drive_target from branch_target),
        'test_drives', (select test_drives from drive_actual)
      ),
      'daily', coalesce((select jsonb_agg(jsonb_build_object(
        'day', to_char(calendar_row.metric_day, 'DD Mon'),
        'sales_value', coalesce(daily_row.sales_value, 0),
        'target_to_date', round((select sales_target from branch_target) * extract(day from calendar_row.metric_day)::numeric / extract(day from (month_end - 1))::numeric, 2)
      ) order by calendar_row.metric_day)
      from calendar calendar_row left join daily_sales daily_row on daily_row.metric_day = calendar_row.metric_day), '[]'::jsonb),
      'models', coalesce((select jsonb_agg(jsonb_build_object('model', model, 'bookings', bookings, 'sales_value', sales_value)) from model_rows), '[]'::jsonb),
      'consultants', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', user_id, 'full_name', full_name, 'sales_target', sales_target,
        'sales_value', sales_value, 'bookings', bookings, 'test_drives', test_drives
      ) order by sales_value desc, full_name) from consultant_rows), '[]'::jsonb)
    )
  );
end;
$function$;

-- Approvals tiles in one call: the queue, how long it has waited, what was
-- decided today and the discount asked for across every pending request (the
-- page used to sum only the rows on screen). Same scope as the quotation list.
create or replace function public.get_quotation_approval_summary(
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid;
  record_scope record;
  day_start timestamptz;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not (
    app_private.has_permission(current_organization_id, 'quotation.view')
    or app_private.has_permission(current_organization_id, 'quotation.manage')
  ) then
    raise exception using errcode = '42501', message = 'QUOTATION_VIEW_PERMISSION_REQUIRED';
  end if;
  select * into record_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['quotation.view', 'quotation.manage']::text[]
  );
  day_start := timezone(target_timezone, timezone(target_timezone, now())::date::timestamp);

  return (
    with scoped as materialized (
      select quotation_row.id, quotation_row.status
      from public.quotations quotation_row
      join public.customers customer_row
        on customer_row.id = quotation_row.customer_id
       and customer_row.organization_id = quotation_row.organization_id
       and customer_row.deleted_at is null
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
    ), pending as (
      select scoped_row.id,
        (select approval_row.created_at from public.approvals approval_row
          where approval_row.organization_id = current_organization_id
            and approval_row.resource_type = 'quotation'
            and approval_row.resource_id = scoped_row.id
            and approval_row.status = 'PENDING') as requested_at
      from scoped scoped_row
      where scoped_row.status = 'PENDING_APPROVAL'
    ), decided as (
      select approval_row.status
      from public.approvals approval_row
      join scoped scoped_row on scoped_row.id = approval_row.resource_id
      where approval_row.organization_id = current_organization_id
        and approval_row.resource_type = 'quotation'
        and approval_row.decided_at >= day_start
    )
    select jsonb_build_object(
      'pending', (select count(*) from pending),
      'waiting_over_day', (select count(*) from pending where requested_at < now() - interval '1 day'),
      'approved_today', (select count(*) from decided where status = 'APPROVED'),
      'rejected_today', (select count(*) from decided where status = 'REJECTED'),
      'discount_requested', coalesce((
        select sum(abs(least(item_row.adjustment, 0)))
        from public.quotation_items item_row
        join pending pending_row on pending_row.id = item_row.quotation_id
        where item_row.organization_id = current_organization_id
          and item_row.deleted_at is null
      ), 0)
    )
  );
end;
$function$;

revoke all on function public.get_quotation_approval_summary(text) from public, anon;
grant execute on function public.get_quotation_approval_summary(text) to authenticated;

commit;
