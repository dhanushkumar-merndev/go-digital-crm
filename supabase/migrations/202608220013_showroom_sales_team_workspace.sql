-- Showroom-wide consultant reporting is separate from the Team Manager RPC.
-- It is deliberately constrained to the single authorized showroom branch.

create index if not exists leads_showroom_team_workspace_idx
  on public.leads (organization_id, branch_id, assigned_user_id, created_at desc)
  where deleted_at is null;

create index if not exists calls_showroom_team_workspace_idx
  on public.calls (organization_id, branch_id, assigned_user_id, started_at desc);

create or replace function public.get_showroom_sales_team_workspace(
  target_days integer default 30,
  target_page integer default 1,
  target_page_size integer default 25,
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
  resolved_branch_id uuid;
  branch_count integer;
  local_today date;
  range_start timestamptz;
  range_end timestamptz;
  month_start date;
  month_end date;
  can_view_calls boolean;
  can_view_drives boolean;
  can_view_quotations boolean;
  can_view_bookings boolean;
begin
  if target_days not in (7, 30)
    or target_page < 1
    or target_page_size not in (25, 50, 100)
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_SHOWROOM_TEAM_QUERY';
  end if;

  access_context := public.get_access_context();
  if auth.uid() is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'showroom-manager'
    or access_context->>'organization_id' is null
    or not app_private.has_permission((access_context->>'organization_id')::uuid, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'SHOWROOM_TEAM_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  select count(*), (array_agg(branch_row.id order by branch_row.id))[1]
    into branch_count, resolved_branch_id
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and branch_row.active
    and app_private.can_access_branch(current_organization_id, branch_row.id);
  if branch_count <> 1 then
    raise exception using errcode = '22023', message = 'SHOWROOM_TEAM_BRANCH_REQUIRED';
  end if;

  local_today := timezone(target_timezone, now())::date;
  range_start := timezone(target_timezone, (local_today - (target_days - 1))::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);
  month_start := date_trunc('month', local_today)::date;
  month_end := (month_start + interval '1 month')::date;
  can_view_calls := app_private.has_permission(current_organization_id, 'call.view');
  can_view_drives := app_private.has_permission(current_organization_id, 'test_drive.view')
    or app_private.has_permission(current_organization_id, 'test_drive.manage');
  can_view_quotations := app_private.has_permission(current_organization_id, 'quotation.view')
    or app_private.has_permission(current_organization_id, 'quotation.manage');
  can_view_bookings := app_private.has_permission(current_organization_id, 'booking.view')
    or app_private.has_permission(current_organization_id, 'booking.manage');

  return (
    with members as (
      select distinct on (member_row.user_id)
        member_row.user_id, member_row.member_type, profile_row.full_name
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
        and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
      order by member_row.user_id, member_row.team_id
    ), lead_stats as (
      select lead_row.assigned_user_id as user_id, count(*)::bigint as active_leads
      from public.leads lead_row
      join members member_row on member_row.user_id = lead_row.assigned_user_id
      where lead_row.organization_id = current_organization_id
        and lead_row.branch_id = resolved_branch_id
        and lead_row.deleted_at is null
        and lead_row.lifecycle_status <> 'Lost'
      group by lead_row.assigned_user_id
    ), call_stats as (
      select call_row.assigned_user_id as user_id, count(*)::bigint as calls
      from public.calls call_row
      join members member_row on member_row.user_id = call_row.assigned_user_id
      where can_view_calls
        and call_row.organization_id = current_organization_id
        and call_row.branch_id = resolved_branch_id
        and call_row.started_at >= range_start and call_row.started_at < range_end
      group by call_row.assigned_user_id
    ), drive_stats as (
      select drive_row.assigned_user_id as user_id, count(*)::bigint as test_drives
      from public.test_drive_appointments drive_row
      join members member_row on member_row.user_id = drive_row.assigned_user_id
      where can_view_drives
        and drive_row.organization_id = current_organization_id
        and drive_row.branch_id = resolved_branch_id
        and drive_row.status <> 'CANCELLED'
        and drive_row.scheduled_at >= range_start and drive_row.scheduled_at < range_end
      group by drive_row.assigned_user_id
    ), quotation_stats as (
      select quotation_row.assigned_user_id as user_id, count(*)::bigint as quotations
      from public.quotations quotation_row
      join members member_row on member_row.user_id = quotation_row.assigned_user_id
      where can_view_quotations
        and quotation_row.organization_id = current_organization_id
        and quotation_row.branch_id = resolved_branch_id
        and quotation_row.created_at >= range_start and quotation_row.created_at < range_end
      group by quotation_row.assigned_user_id
    ), booking_stats as (
      select booking_row.assigned_user_id as user_id,
        count(*)::bigint as bookings,
        coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)::numeric as sales_value
      from public.bookings booking_row
      join members member_row on member_row.user_id = booking_row.assigned_user_id
      where can_view_bookings
        and booking_row.organization_id = current_organization_id
        and booking_row.branch_id = resolved_branch_id
        and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start and booking_row.created_at < range_end
      group by booking_row.assigned_user_id
    ), target_stats as (
      select target_row.user_id,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('SALES_VALUE', 'SALES_AMOUNT', 'REVENUE')), 0)::numeric as sales_target
      from public.targets target_row
      join members member_row on member_row.user_id = target_row.user_id
      where target_row.organization_id = current_organization_id
        and target_row.branch_id = resolved_branch_id
        and target_row.period_start <= month_start and target_row.period_end >= month_end - 1
      group by target_row.user_id
    ), rows as (
      select member_row.user_id, member_row.full_name, member_row.member_type,
        coalesce(lead_row.active_leads, 0)::bigint as active_leads,
        coalesce(call_row.calls, 0)::bigint as calls,
        coalesce(drive_row.test_drives, 0)::bigint as test_drives,
        coalesce(quotation_row.quotations, 0)::bigint as quotations,
        coalesce(booking_row.bookings, 0)::bigint as bookings,
        coalesce(booking_row.sales_value, 0)::numeric as sales_value,
        coalesce(target_row.sales_target, 0)::numeric as sales_target
      from members member_row
      left join lead_stats lead_row on lead_row.user_id = member_row.user_id
      left join call_stats call_row on call_row.user_id = member_row.user_id
      left join drive_stats drive_row on drive_row.user_id = member_row.user_id
      left join quotation_stats quotation_row on quotation_row.user_id = member_row.user_id
      left join booking_stats booking_row on booking_row.user_id = member_row.user_id
      left join target_stats target_row on target_row.user_id = member_row.user_id
    ), numbered_rows as (
      select rows.*, row_number() over (order by bookings desc, sales_value desc, full_name) as rank
      from rows
    ), page_rows as (
      select * from numbered_rows
      order by rank
      limit target_page_size offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'days', target_days,
      'branch', (select jsonb_build_object('id', id, 'name', name) from public.branches where id = resolved_branch_id),
      'total', (select count(*) from rows),
      'kpis', jsonb_build_object(
        'consultants', (select count(*) from rows),
        'active_in_period', (select count(*) from rows where calls + test_drives + quotations + bookings > 0),
        'active_leads', (select coalesce(sum(active_leads), 0) from rows),
        'test_drives', (select coalesce(sum(test_drives), 0) from rows),
        'bookings', (select coalesce(sum(bookings), 0) from rows),
        'conversion', (select coalesce(round(sum(bookings)::numeric * 100 / nullif(sum(active_leads), 0), 1), 0) from rows)
      ),
      'distribution', coalesce((select jsonb_agg(jsonb_build_object('name', member_type, 'value', count) order by member_type) from (select member_type, count(*)::bigint as count from rows group by member_type) distribution_row), '[]'::jsonb),
      'workload', jsonb_build_object(
        'up_to_10', (select count(*) from rows where active_leads <= 10),
        'up_to_20', (select count(*) from rows where active_leads between 11 and 20),
        'up_to_30', (select count(*) from rows where active_leads between 21 and 30),
        'over_30', (select count(*) from rows where active_leads > 30)
      ),
      'records', coalesce((select jsonb_agg(jsonb_build_object(
        'rank', rank, 'user_id', user_id, 'full_name', full_name, 'member_type', member_type,
        'active_leads', active_leads, 'calls', calls, 'test_drives', test_drives,
        'quotations', quotations, 'bookings', bookings, 'sales_value', sales_value,
        'sales_target', sales_target
      ) order by rank) from page_rows), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.get_showroom_sales_team_workspace(integer, integer, integer, text) from public;
grant execute on function public.get_showroom_sales_team_workspace(integer, integer, integer, text) to authenticated;
