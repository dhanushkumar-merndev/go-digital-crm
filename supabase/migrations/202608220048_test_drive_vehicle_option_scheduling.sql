-- Keep the vehicle picker consistent with create_test_drive: a stock unit that
-- already has a scheduled drive must not be offered for another drive.
create or replace function public.get_test_drive_vehicle_options(
  target_branch_id uuid,
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if target_branch_id is null or char_length(normalized_search) > 120
    or target_limit is null or target_limit not between 1 and 25
  then
    raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_VEHICLE_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'TEST_DRIVE_VEHICLE_SCOPE_DENIED';
  end if;

  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.received_at desc nulls last), '[]'::jsonb)
    into result
  from (
    select stock_row.id as stock_unit_id,
      stock_row.branch_id,
      stock_row.vin,
      stock_row.chassis_number,
      stock_row.color,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      stock_row.received_at
    from public.stock_units stock_row
    join public.vehicle_variants variant_row
      on variant_row.id = stock_row.variant_id
     and variant_row.organization_id = stock_row.organization_id
     and variant_row.active
    join public.vehicle_models model_row
      on model_row.id = variant_row.model_id
     and model_row.organization_id = stock_row.organization_id
     and model_row.active
    join public.vehicle_brands brand_row
      on brand_row.id = model_row.brand_id
     and brand_row.organization_id = stock_row.organization_id
     and brand_row.active
    where stock_row.organization_id = current_organization_id
      and stock_row.branch_id = target_branch_id
      and stock_row.status = 'AVAILABLE'
      and stock_row.deleted_at is null
      and not exists (
        select 1
        from public.test_drive_appointments appointment_row
        where appointment_row.organization_id = stock_row.organization_id
          and appointment_row.stock_unit_id = stock_row.id
          and appointment_row.status in ('SCHEDULED', 'ACTIVE')
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(stock_row.vin)) > 0
        or position(normalized_search in lower(stock_row.chassis_number)) > 0
        or position(normalized_search in lower(model_row.name)) > 0
        or position(normalized_search in lower(variant_row.name)) > 0
      )
    order by stock_row.received_at desc nulls last, stock_row.id desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

revoke all on function public.get_test_drive_vehicle_options(uuid, text, integer) from public, anon;
grant execute on function public.get_test_drive_vehicle_options(uuid, text, integer) to authenticated;
