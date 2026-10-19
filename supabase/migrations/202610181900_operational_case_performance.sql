-- Personal "My Performance" for the operations desks (Finance, Insurance, RTO,
-- Exchange, Delivery and their executives). Until now the page re-rendered the
-- case list with status ALL. This returns the caller's own numbers instead:
-- cases assigned to them, what they closed in the chosen range, and one
-- per-day series.
--
-- Cost scales with the caller's own assigned cases, not with the range width:
-- the per-day series is one GROUP BY joined onto generate_series, and the range
-- is capped at 366 days. Rows come off the existing
-- *_cases_owner_updated_page_idx (organization_id, assigned_user_id,
-- updated_at desc) partial indexes from 202608240006.

begin;

create or replace function public.get_operational_case_performance(
  target_department text,
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
  allowed_full_branch_ids uuid[] := '{}'::uuid[];
  allowed_own_record_branch_ids uuid[] := '{}'::uuid[];
  normalized_department text := upper(btrim(coalesce(target_department, '')));
  from_timestamp timestamptz;
  to_timestamp_exclusive timestamptz;
  result jsonb;
begin
  if normalized_department not in ('FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY')
    or target_from_date is null
    or target_to_date is null
    or target_from_date > target_to_date
    or target_to_date > target_from_date + 366
    or target_timezone is null
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_PERFORMANCE_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.operational_case_permission(
      current_organization_id, normalized_department, 'VIEW'
    )
  then
    raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_VIEW_PERMISSION_REQUIRED';
  end if;

  select scope_row.actor_id, scope_row.full_branch_ids, scope_row.own_record_branch_ids
  into current_actor_id, allowed_full_branch_ids, allowed_own_record_branch_ids
  from app_private.operational_case_actor_scope(
    current_organization_id, normalized_department
  ) scope_row;

  from_timestamp := pg_catalog.timezone(target_timezone, target_from_date::timestamp);
  to_timestamp_exclusive := pg_catalog.timezone(target_timezone, (target_to_date + 1)::timestamp);

  with mine as materialized (
    select case_row.status, case_row.due_at, case_row.created_at, case_row.updated_at
    from public.finance_cases case_row
    where normalized_department = 'FINANCE'
      and case_row.organization_id = current_organization_id
      and case_row.assigned_user_id = current_actor_id
      and case_row.deleted_at is null
      and case_row.branch_id = any(allowed_full_branch_ids || allowed_own_record_branch_ids)
    union all
    select case_row.status, case_row.due_at, case_row.created_at, case_row.updated_at
    from public.insurance_cases case_row
    where normalized_department = 'INSURANCE'
      and case_row.organization_id = current_organization_id
      and case_row.assigned_user_id = current_actor_id
      and case_row.deleted_at is null
      and case_row.branch_id = any(allowed_full_branch_ids || allowed_own_record_branch_ids)
    union all
    select case_row.status, case_row.due_at, case_row.created_at, case_row.updated_at
    from public.rto_cases case_row
    where normalized_department = 'RTO'
      and case_row.organization_id = current_organization_id
      and case_row.assigned_user_id = current_actor_id
      and case_row.deleted_at is null
      and case_row.branch_id = any(allowed_full_branch_ids || allowed_own_record_branch_ids)
    union all
    select case_row.status, case_row.due_at, case_row.created_at, case_row.updated_at
    from public.exchange_cases case_row
    where normalized_department = 'EXCHANGE'
      and case_row.organization_id = current_organization_id
      and case_row.assigned_user_id = current_actor_id
      and case_row.deleted_at is null
      and case_row.branch_id = any(allowed_full_branch_ids || allowed_own_record_branch_ids)
    union all
    select case_row.status, case_row.due_at, case_row.created_at, case_row.updated_at
    from public.delivery_cases case_row
    where normalized_department = 'DELIVERY'
      and case_row.organization_id = current_organization_id
      and case_row.assigned_user_id = current_actor_id
      and case_row.deleted_at is null
      and case_row.branch_id = any(allowed_full_branch_ids || allowed_own_record_branch_ids)
  ),
  classified as materialized (
    select
      mine_row.*,
      app_private.operational_case_terminal(normalized_department, mine_row.status) as terminal,
      mine_row.updated_at >= from_timestamp
        and mine_row.updated_at < to_timestamp_exclusive as in_range
    from mine mine_row
  ),
  -- A cancelled case is closed but not completed work.
  completed as (
    select classified_row.*
    from classified classified_row
    where classified_row.terminal
      and classified_row.in_range
      and upper(classified_row.status) <> 'CANCELLED'
  ),
  daily as (
    select
      pg_catalog.timezone(target_timezone, classified_row.updated_at)::date as day,
      count(*) as handled,
      count(*) filter (
        where classified_row.terminal and upper(classified_row.status) <> 'CANCELLED'
      ) as completed
    from classified classified_row
    where classified_row.in_range
    group by 1
  )
  select jsonb_build_object(
    'department', normalized_department,
    'from', target_from_date,
    'to', target_to_date,
    'kpis', jsonb_build_object(
      'open', (select count(*) from classified where not terminal),
      'overdue', (
        select count(*) from classified where not terminal and due_at < now()
      ),
      'due_today', (
        select count(*) from classified
        where not terminal
          and due_at is not null
          and pg_catalog.timezone(target_timezone, due_at)::date
            = pg_catalog.timezone(target_timezone, now())::date
      ),
      'handled', (select count(*) from classified where in_range),
      'completed', (select count(*) from completed),
      'avg_close_hours', (
        select round(avg(extract(epoch from updated_at - created_at)) / 3600.0, 1)
        from completed
      )
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', series_row.day,
        'handled', coalesce(daily_row.handled, 0),
        'completed', coalesce(daily_row.completed, 0)
      ) order by series_row.day)
      from (
        select generated::date as day
        from pg_catalog.generate_series(
          target_from_date::timestamp, target_to_date::timestamp, interval '1 day'
        ) generated
      ) series_row
      left join daily daily_row on daily_row.day = series_row.day
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_operational_case_performance(text, date, date, text)
  from public, anon;
grant execute on function public.get_operational_case_performance(text, date, date, text)
  to authenticated;

commit;
