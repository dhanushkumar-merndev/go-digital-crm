-- Personal "My Performance" for the Inventory desk. The page re-rendered the
-- stock dashboard; this returns the caller's own work instead: vehicles they
-- allocated, stock movements they recorded (intake, transfers, status changes)
-- and one per-day series.
--
-- These are the caller's own actions, so the counts are bounded by their own
-- rows: the two new partial indexes lead with (organization_id, actor, time),
-- each daily series is one GROUP BY joined onto generate_series, and the range
-- is capped at 366 days.

begin;

-- Built inside the transaction: stock tables hold one dealership's vehicles,
-- so the brief write lock is cheaper than a concurrent build outside it.
create index if not exists stock_movements_org_actor_moved_idx
  on public.stock_movements (organization_id, moved_by, moved_at desc)
  where moved_by is not null;
create index if not exists stock_allocations_org_actor_allocated_idx
  on public.stock_allocations (organization_id, allocated_by, allocated_at desc)
  where allocated_by is not null;

create or replace function public.get_inventory_performance(
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
  current_actor_id uuid := auth.uid();
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
    raise exception using errcode = '22023', message = 'INVALID_INVENTORY_PERFORMANCE_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_actor_id is null
    or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.view')
  then
    raise exception using errcode = '42501', message = 'INVENTORY_VIEW_REQUIRED';
  end if;

  from_timestamp := pg_catalog.timezone(target_timezone, target_from_date::timestamp);
  to_timestamp_exclusive := pg_catalog.timezone(target_timezone, (target_to_date + 1)::timestamp);

  with my_allocations as materialized (
    select allocation_row.status, allocation_row.allocated_at
    from public.stock_allocations allocation_row
    where allocation_row.organization_id = current_organization_id
      and allocation_row.allocated_by = current_actor_id
  ),
  my_movements as materialized (
    select movement_row.movement_type, movement_row.moved_at
    from public.stock_movements movement_row
    where movement_row.organization_id = current_organization_id
      and movement_row.moved_by = current_actor_id
      and movement_row.moved_at >= from_timestamp
      and movement_row.moved_at < to_timestamp_exclusive
  ),
  allocations_daily as (
    select pg_catalog.timezone(target_timezone, allocated_at)::date as day, count(*) as allocations
    from my_allocations
    where allocated_at >= from_timestamp and allocated_at < to_timestamp_exclusive
    group by 1
  ),
  movements_daily as (
    select pg_catalog.timezone(target_timezone, moved_at)::date as day, count(*) as movements
    from my_movements
    group by 1
  )
  select jsonb_build_object(
    'from', target_from_date,
    'to', target_to_date,
    'kpis', jsonb_build_object(
      'allocations', (
        select count(*) from my_allocations
        where allocated_at >= from_timestamp and allocated_at < to_timestamp_exclusive
      ),
      'active_allocations', (
        select count(*) from my_allocations
        where status in ('ACTIVE', 'RESERVED', 'ALLOCATED')
      ),
      'movements', (select count(*) from my_movements),
      'transfers', (select count(*) from my_movements where movement_type = 'BRANCH_TRANSFER'),
      'intakes', (select count(*) from my_movements where movement_type = 'INTAKE')
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', series_row.day,
        'allocations', coalesce(allocation_row.allocations, 0),
        'movements', coalesce(movement_row.movements, 0)
      ) order by series_row.day)
      from (
        select generated::date as day
        from pg_catalog.generate_series(
          target_from_date::timestamp, target_to_date::timestamp, interval '1 day'
        ) generated
      ) series_row
      left join allocations_daily allocation_row on allocation_row.day = series_row.day
      left join movements_daily movement_row on movement_row.day = series_row.day
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_inventory_performance(date, date, text) from public, anon;
grant execute on function public.get_inventory_performance(date, date, text) to authenticated;

commit;
