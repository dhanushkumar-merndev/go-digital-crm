-- Inventory dashboard: resolve the caller's branches once.
--
-- get_inventory_dashboard called app_private.can_access_branch for every stock
-- unit and every open allocation -- about 1,000 helper calls (1.2-1.6 s) for
-- the demo dealership. The result depends only on the branch, so the
-- accessible branches are computed once (4 calls) and rows are filtered
-- against that set. Output is identical (checked as inventory manager and
-- executive in two dealerships); time drops to about 45 ms.
--
-- Patched from the deployed definition (pg_get_functiondef, 2026-10-28).

CREATE OR REPLACE FUNCTION public.get_inventory_dashboard()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_organization_id uuid;
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.view')
  then
    raise exception using errcode = '42501', message = 'INVENTORY_VIEW_REQUIRED';
  end if;

  -- The caller's branches are resolved once: can_access_branch per stock and
  -- allocation row was about 1,000 helper calls (1.6 s) for one dashboard.
  with accessible_branches as materialized (
    select branch_row.id
    from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and branch_row.deleted_at is null
      and app_private.can_access_branch(current_organization_id, branch_row.id)
  ), scoped_units as materialized (
    select
      stock_row.id,
      stock_row.branch_id,
      stock_row.variant_id,
      stock_row.status,
      greatest(
        0,
        current_date - coalesce(stock_row.received_at::date, stock_row.created_at::date)
      )::integer as days_in_stock,
      branch_row.name as branch_name,
      model_row.name as model_name
    from public.stock_units stock_row
    join public.branches branch_row
      on branch_row.organization_id = stock_row.organization_id
     and branch_row.id = stock_row.branch_id
     and branch_row.deleted_at is null
    join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = stock_row.organization_id
     and model_row.id = variant_row.model_id
    where stock_row.organization_id = current_organization_id
      and stock_row.deleted_at is null
      and stock_row.branch_id in (select accessible_row.id from accessible_branches accessible_row)
  ), model_rows as (
    select
      scoped_row.model_name as name,
      count(*) filter (where scoped_row.status <> 'DELIVERED')::integer as value
    from scoped_units scoped_row
    group by scoped_row.model_name
    having count(*) filter (where scoped_row.status <> 'DELIVERED') > 0
    order by value desc, scoped_row.model_name
    limit 8
  ), branch_rows as (
    select
      scoped_row.branch_name as name,
      count(*) filter (where scoped_row.status <> 'DELIVERED')::integer as value,
      count(*) filter (where scoped_row.status = 'AVAILABLE')::integer as secondary
    from scoped_units scoped_row
    group by scoped_row.branch_name
    order by value desc, scoped_row.branch_name
    limit 12
  ), variant_availability as (
    select
      scoped_row.variant_id,
      count(*) filter (where scoped_row.status = 'AVAILABLE') as available_units
    from scoped_units scoped_row
    group by scoped_row.variant_id
  )
  select jsonb_build_object(
    'kpis', jsonb_build_object(
      'total_stock', count(*) filter (where scoped_row.status <> 'DELIVERED'),
      'available', count(*) filter (where scoped_row.status = 'AVAILABLE'),
      'reserved', count(*) filter (where scoped_row.status = 'RESERVED'),
      'allocated', count(*) filter (where scoped_row.status = 'ALLOCATED'),
      'in_transit', count(*) filter (where scoped_row.status = 'IN_TRANSIT'),
      'ageing_stock', count(*) filter (
        where scoped_row.status <> 'DELIVERED' and scoped_row.days_in_stock > 60
      ),
      'ready_for_delivery', count(*) filter (
        where scoped_row.status = 'READY_FOR_DELIVERY'
      ),
      'low_stock_models', (
        select count(*) from variant_availability where available_units between 0 and 2
      )
    ),
    'model_distribution', coalesce((
      select jsonb_agg(
        jsonb_build_object('name', model_row.name, 'value', model_row.value)
        order by model_row.value desc, model_row.name
      ) from model_rows model_row
    ), '[]'::jsonb),
    'branch_distribution', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', branch_row.name,
          'value', branch_row.value,
          'secondary', branch_row.secondary
        ) order by branch_row.value desc, branch_row.name
      ) from branch_rows branch_row
    ), '[]'::jsonb),
    'attention', jsonb_build_object(
      'ageing_90_plus', count(*) filter (
        where scoped_row.status <> 'DELIVERED' and scoped_row.days_in_stock > 90
      ),
      'on_hold', count(*) filter (where scoped_row.status = 'HOLD'),
      'incoming', count(*) filter (where scoped_row.status = 'INCOMING'),
      'allocation_pending', (
        select count(*)
        from public.stock_allocations allocation_row
        where allocation_row.organization_id = current_organization_id
          and allocation_row.status in ('ACTIVE', 'PENDING', 'SUGGESTED')
          and allocation_row.branch_id in (
            select accessible_row.id from accessible_branches accessible_row
          )
      )
    )
  ) into result
  from scoped_units scoped_row;

  return result;
end;
$function$;
