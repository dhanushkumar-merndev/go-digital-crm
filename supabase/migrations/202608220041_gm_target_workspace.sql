-- GM Sales Executives need target attainment across their authorized showrooms.
-- The function returns aggregate-only branch metrics; it never expands the GM's
-- branch/record scope or exposes per-customer booking data.

create or replace function public.get_gm_target_workspace(
  target_month date default date_trunc('month', timezone('Asia/Kolkata', now()))::date,
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
  month_start date;
  month_end date;
  range_start timestamptz;
  range_end timestamptz;
begin
  if target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_GM_TARGET_TIMEZONE';
  end if;

  access_context := public.get_access_context();
  if auth.uid() is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'gm-sales'
    or access_context->>'organization_id' is null
    or not app_private.has_permission((access_context->>'organization_id')::uuid, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'GM_TARGET_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  local_today := timezone(target_timezone, now())::date;
  month_start := date_trunc('month', target_month)::date;
  month_end := (month_start + interval '1 month')::date;
  if target_month <> month_start
    or month_start < date_trunc('month', local_today - interval '12 months')::date
    or month_start > date_trunc('month', local_today + interval '12 months')::date
  then
    raise exception using errcode = '22023', message = 'INVALID_GM_TARGET_MONTH';
  end if;

  range_start := timezone(target_timezone, month_start::timestamp);
  range_end := timezone(target_timezone, month_end::timestamp);

  return (
    with accessible_branches as materialized (
      select branch_row.id, branch_row.name
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
        and app_private.can_access_branch(current_organization_id, branch_row.id)
    ), branch_targets as materialized (
      select target_row.branch_id,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('SALES_VALUE', 'SALES_AMOUNT', 'REVENUE')), 0)::numeric as sales_target,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('BOOKINGS', 'SALES_BOOKINGS')), 0)::numeric as booking_target,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('TEST_DRIVES', 'TEST_DRIVE')), 0)::numeric as drive_target
      from public.targets target_row
      join accessible_branches branch_row on branch_row.id = target_row.branch_id
      where target_row.organization_id = current_organization_id
        and target_row.team_id is null
        and target_row.user_id is null
        and target_row.period_start <= month_start
        and target_row.period_end >= month_end - 1
      group by target_row.branch_id
    ), branch_bookings as materialized (
      select booking_row.branch_id,
        coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)::numeric as sales_value,
        count(*)::bigint as bookings
      from public.bookings booking_row
      join accessible_branches branch_row on branch_row.id = booking_row.branch_id
      where booking_row.organization_id = current_organization_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start
        and booking_row.created_at < range_end
        and app_private.can_access_record(
          booking_row.organization_id, booking_row.branch_id, booking_row.team_id, booking_row.assigned_user_id
        )
      group by booking_row.branch_id
    ), branch_drives as materialized (
      select drive_row.branch_id, count(*)::bigint as test_drives
      from public.test_drive_appointments drive_row
      join accessible_branches branch_row on branch_row.id = drive_row.branch_id
      where drive_row.organization_id = current_organization_id
        and drive_row.status <> 'CANCELLED'
        and drive_row.scheduled_at >= range_start
        and drive_row.scheduled_at < range_end
        and app_private.can_access_record(
          drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
        )
      group by drive_row.branch_id
    ), branch_rows as (
      select branch_row.id, branch_row.name,
        coalesce(target_row.sales_target, 0)::numeric as sales_target,
        coalesce(booking_row.sales_value, 0)::numeric as sales_value,
        coalesce(target_row.booking_target, 0)::numeric as booking_target,
        coalesce(booking_row.bookings, 0)::bigint as bookings,
        coalesce(target_row.drive_target, 0)::numeric as drive_target,
        coalesce(drive_row.test_drives, 0)::bigint as test_drives
      from accessible_branches branch_row
      left join branch_targets target_row on target_row.branch_id = branch_row.id
      left join branch_bookings booking_row on booking_row.branch_id = branch_row.id
      left join branch_drives drive_row on drive_row.branch_id = branch_row.id
    )
    select jsonb_build_object(
      'month', month_start,
      'kpis', jsonb_build_object(
        'sales_target', coalesce((select sum(sales_target) from branch_rows), 0),
        'sales_value', coalesce((select sum(sales_value) from branch_rows), 0),
        'booking_target', coalesce((select sum(booking_target) from branch_rows), 0),
        'bookings', coalesce((select sum(bookings) from branch_rows), 0),
        'drive_target', coalesce((select sum(drive_target) from branch_rows), 0),
        'test_drives', coalesce((select sum(test_drives) from branch_rows), 0)
      ),
      'branches', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'sales_target', sales_target, 'sales_value', sales_value,
        'booking_target', booking_target, 'bookings', bookings,
        'drive_target', drive_target, 'test_drives', test_drives
      ) order by sales_value desc, bookings desc, name) from branch_rows), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.get_gm_target_workspace(date, text) from public, anon;
grant execute on function public.get_gm_target_workspace(date, text) to authenticated;
