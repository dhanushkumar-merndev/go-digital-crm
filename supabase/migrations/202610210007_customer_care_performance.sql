-- Personal "My Performance" for Customer Care and Customer Relationship
-- executives. The page re-rendered the dashboard; this returns the caller's own
-- numbers in the same shape as get_operational_case_performance: cases assigned
-- to them, what they resolved in the chosen range, and one per-day series.
--
-- Cost scales with the caller's own assigned cases, not with the range width:
-- each daily series is one GROUP BY joined onto generate_series, the range is
-- capped at 366 days, and rows come off
-- customer_care_org_owner_status_updated_page_idx
-- (organization_id, assigned_user_id, status, updated_at desc).

begin;

create or replace function public.get_customer_care_performance(
  target_from_date date,
  target_to_date date,
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
  current_actor_id uuid;
  scope_organization_wide boolean := false;
  scope_branch_ids uuid[] := '{}'::uuid[];
  scope_own_records boolean := false;
  scope_own_record_branch_ids uuid[] := '{}'::uuid[];
  from_timestamp timestamptz;
  to_timestamp_exclusive timestamptz;
  result jsonb;
begin
  if target_from_date is null
    or target_to_date is null
    or target_from_date > target_to_date
    or target_to_date > target_from_date + 366
    or target_timezone is null
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_PERFORMANCE_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_CARE_VIEW_PERMISSION_REQUIRED';
  end if;

  select scope_row.actor_id, scope_row.organization_wide, scope_row.branch_ids,
    scope_row.own_records, scope_row.own_record_branch_ids
  into current_actor_id, scope_organization_wide, scope_branch_ids,
    scope_own_records, scope_own_record_branch_ids
  from app_private.customer_care_actor_scope(
    current_organization_id, 'customer_care.view'
  ) scope_row;

  from_timestamp := pg_catalog.timezone(target_timezone, target_from_date::timestamp);
  to_timestamp_exclusive := pg_catalog.timezone(target_timezone, (target_to_date + 1)::timestamp);

  with mine as materialized (
    select
      case_row.status in ('RESOLVED', 'CLOSED') as terminal,
      case_row.sla_due_at as due_at,
      case_row.created_at,
      case_row.updated_at,
      case_row.resolved_at
    from public.customer_care_cases case_row
    where case_row.organization_id = current_organization_id
      and case_row.assigned_user_id = current_actor_id
      and case_row.deleted_at is null
      and (
        scope_organization_wide
        or case_row.branch_id = any(scope_branch_ids)
        or (scope_own_records and case_row.branch_id = any(scope_own_record_branch_ids))
      )
  ),
  completed as (
    select mine_row.*
    from mine mine_row
    where mine_row.resolved_at >= from_timestamp
      and mine_row.resolved_at < to_timestamp_exclusive
  ),
  handled_daily as (
    select pg_catalog.timezone(target_timezone, mine_row.updated_at)::date as day, count(*) as handled
    from mine mine_row
    where mine_row.updated_at >= from_timestamp
      and mine_row.updated_at < to_timestamp_exclusive
    group by 1
  ),
  completed_daily as (
    select pg_catalog.timezone(target_timezone, completed_row.resolved_at)::date as day,
      count(*) as completed
    from completed completed_row
    group by 1
  )
  select jsonb_build_object(
    'department', 'CUSTOMER_CARE',
    'from', target_from_date,
    'to', target_to_date,
    'kpis', jsonb_build_object(
      'open', (select count(*) from mine where not terminal),
      'overdue', (select count(*) from mine where not terminal and due_at < now()),
      'due_today', (
        select count(*) from mine
        where not terminal
          and pg_catalog.timezone(target_timezone, due_at)::date
            = pg_catalog.timezone(target_timezone, now())::date
      ),
      'handled', (
        select count(*) from mine
        where updated_at >= from_timestamp and updated_at < to_timestamp_exclusive
      ),
      'completed', (select count(*) from completed),
      'avg_close_hours', (
        select round(avg(extract(epoch from resolved_at - created_at)) / 3600.0, 1)
        from completed
      )
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', series_row.day,
        'handled', coalesce(handled_row.handled, 0),
        'completed', coalesce(completed_row.completed, 0)
      ) order by series_row.day)
      from (
        select generated::date as day
        from pg_catalog.generate_series(
          target_from_date::timestamp, target_to_date::timestamp, interval '1 day'
        ) generated
      ) series_row
      left join handled_daily handled_row on handled_row.day = series_row.day
      left join completed_daily completed_row on completed_row.day = series_row.day
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_customer_care_performance(date, date, text)
  from public, anon;
grant execute on function public.get_customer_care_performance(date, date, text)
  to authenticated;

commit;
