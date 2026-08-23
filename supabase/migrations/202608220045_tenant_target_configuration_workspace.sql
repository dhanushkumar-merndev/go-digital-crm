-- Client Admin target configuration is deliberately branch-level. Team and
-- individual targets remain separate operational records, so this workspace
-- cannot overwrite them by accident.

create or replace function public.get_tenant_target_configuration_workspace(
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
  current_organization_id uuid;
  local_today date;
  month_start date;
  month_end date;
  range_start timestamptz;
  range_end timestamptz;
begin
  if target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_TENANT_TARGET_TIMEZONE';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null
    or current_organization_id is null
    or not app_private.mfa_policy_satisfied(current_organization_id)
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.organization_id = current_organization_id
        and assignment_row.active
        and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
        and (
          (role_row.role_key = 'client_admin'
            and app_private.has_permission(current_organization_id, 'user.manage'))
          or role_row.role_key = 'business_owner'
        )
    )
  then
    raise exception using errcode = '42501', message = 'TENANT_TARGET_CONFIGURATION_REQUIRED';
  end if;

  local_today := timezone(target_timezone, now())::date;
  month_start := date_trunc('month', target_month)::date;
  month_end := (month_start + interval '1 month')::date;
  if target_month <> month_start
    or month_start < date_trunc('month', local_today - interval '12 months')::date
    or month_start > date_trunc('month', local_today + interval '12 months')::date
  then
    raise exception using errcode = '22023', message = 'INVALID_TENANT_TARGET_MONTH';
  end if;
  range_start := timezone(target_timezone, month_start::timestamp);
  range_end := timezone(target_timezone, month_end::timestamp);

  return (
    with active_branches as materialized (
      select branch_row.id, branch_row.name
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
    ), configured_targets as materialized (
      select target_row.branch_id,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('SALES_VALUE', 'SALES_AMOUNT', 'REVENUE')), 0)::numeric as sales_target,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('BOOKINGS', 'SALES_BOOKINGS')), 0)::numeric as booking_target,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('TEST_DRIVES', 'TEST_DRIVE')), 0)::numeric as drive_target
      from public.targets target_row
      join active_branches branch_row on branch_row.id = target_row.branch_id
      where target_row.organization_id = current_organization_id
        and target_row.team_id is null
        and target_row.user_id is null
        and target_row.period_start <= month_start
        and target_row.period_end >= month_end - 1
      group by target_row.branch_id
    ), booking_actuals as materialized (
      select booking_row.branch_id,
        coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)::numeric as sales_value,
        count(*)::bigint as bookings
      from public.bookings booking_row
      join active_branches branch_row on branch_row.id = booking_row.branch_id
      where booking_row.organization_id = current_organization_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start
        and booking_row.created_at < range_end
      group by booking_row.branch_id
    ), drive_actuals as materialized (
      select drive_row.branch_id, count(*)::bigint as test_drives
      from public.test_drive_appointments drive_row
      join active_branches branch_row on branch_row.id = drive_row.branch_id
      where drive_row.organization_id = current_organization_id
        and drive_row.status <> 'CANCELLED'
        and drive_row.scheduled_at >= range_start
        and drive_row.scheduled_at < range_end
      group by drive_row.branch_id
    ), branch_rows as (
      select branch_row.id, branch_row.name,
        coalesce(target_row.sales_target, 0)::numeric as sales_target,
        coalesce(booking_row.sales_value, 0)::numeric as sales_value,
        coalesce(target_row.booking_target, 0)::numeric as booking_target,
        coalesce(booking_row.bookings, 0)::bigint as bookings,
        coalesce(target_row.drive_target, 0)::numeric as drive_target,
        coalesce(drive_row.test_drives, 0)::bigint as test_drives
      from active_branches branch_row
      left join configured_targets target_row on target_row.branch_id = branch_row.id
      left join booking_actuals booking_row on booking_row.branch_id = branch_row.id
      left join drive_actuals drive_row on drive_row.branch_id = branch_row.id
    )
    select jsonb_build_object(
      'month', month_start,
      'kpis', jsonb_build_object(
        'branch_count', (select count(*)::bigint from branch_rows),
        'configured_branches', (select count(*)::bigint from branch_rows where sales_target > 0 or booking_target > 0 or drive_target > 0),
        'sales_target', coalesce((select sum(sales_target) from branch_rows), 0),
        'sales_value', coalesce((select sum(sales_value) from branch_rows), 0)
      ),
      'branches', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'sales_target', sales_target, 'sales_value', sales_value,
        'booking_target', booking_target, 'bookings', bookings,
        'drive_target', drive_target, 'test_drives', test_drives
      ) order by name) from branch_rows), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function public.save_branch_target_configuration(
  target_branch_id uuid,
  target_month date,
  target_sales_value numeric,
  target_booking_count numeric,
  target_test_drive_count numeric,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  month_start date;
  month_end date;
  result jsonb;
begin
  if target_branch_id is null or target_month is null or target_request_id is null
    or target_sales_value is null or target_sales_value < 0
    or target_booking_count is null or target_booking_count < 0 or target_booking_count <> trunc(target_booking_count)
    or target_test_drive_count is null or target_test_drive_count < 0 or target_test_drive_count <> trunc(target_test_drive_count)
  then
    raise exception using errcode = '22023', message = 'INVALID_BRANCH_TARGET_CONFIGURATION';
  end if;
  month_start := date_trunc('month', target_month)::date;
  month_end := (month_start + interval '1 month')::date;
  if target_month <> month_start then
    raise exception using errcode = '22023', message = 'INVALID_BRANCH_TARGET_MONTH';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null
    or current_organization_id is null
    or not app_private.mfa_policy_satisfied(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'user.manage')
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.organization_id = current_organization_id
        and assignment_row.active
        and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
        and role_row.role_key = 'client_admin'
    )
  then
    raise exception using errcode = '42501', message = 'TENANT_TARGET_CONFIGURATION_REQUIRED';
  end if;
  if not exists (
    select 1 from public.branches branch_row
    where branch_row.id = target_branch_id
      and branch_row.organization_id = current_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'TARGET_BRANCH_DENIED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_organization_id::text || ':' || target_branch_id::text || ':' || month_start::text, 0)
  );
  delete from public.targets target_row
  where target_row.organization_id = current_organization_id
    and target_row.branch_id = target_branch_id
    and target_row.team_id is null
    and target_row.user_id is null
    and upper(target_row.metric) in ('SALES_VALUE', 'SALES_AMOUNT', 'REVENUE', 'BOOKINGS', 'SALES_BOOKINGS', 'TEST_DRIVES', 'TEST_DRIVE')
    and target_row.period_start = month_start
    and target_row.period_end = month_end - 1;

  insert into public.targets (
    organization_id, branch_id, metric, period_start, period_end, target_value, assigned_by
  ) values
    (current_organization_id, target_branch_id, 'SALES_VALUE', month_start, month_end - 1, target_sales_value, auth.uid()),
    (current_organization_id, target_branch_id, 'BOOKINGS', month_start, month_end - 1, target_booking_count, auth.uid()),
    (current_organization_id, target_branch_id, 'TEST_DRIVES', month_start, month_end - 1, target_test_drive_count, auth.uid());

  result := jsonb_build_object(
    'branch_id', target_branch_id,
    'month', month_start,
    'sales_target', target_sales_value,
    'booking_target', target_booking_count,
    'drive_target', target_test_drive_count
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'tenant_target_configuration.saved',
    'branch_target', target_branch_id::text, target_request_id, result
  );
  return result;
end;
$$;

revoke all on function public.get_tenant_target_configuration_workspace(date, text) from public, anon;
grant execute on function public.get_tenant_target_configuration_workspace(date, text) to authenticated;
revoke all on function public.save_branch_target_configuration(uuid, date, numeric, numeric, numeric, uuid) from public, anon;
grant execute on function public.save_branch_target_configuration(uuid, date, numeric, numeric, numeric, uuid) to authenticated;
