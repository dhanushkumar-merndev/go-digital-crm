-- The accessories page showed "OEM certified 100%" as a fixed string. Return
-- the real OEM count with the other catalog KPIs, read in one pass with
-- FILTER aggregates instead of a scan per KPI, and bound the page size to the
-- 25 / 50 / 100 the table offers so a caller cannot ask for an unbounded page.

begin;

create or replace function public.get_accessories_catalog(
  target_category text default null,
  target_search text default null,
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  search_term text := left(trim(coalesce(target_search, '')), 100);
  category_filter text := nullif(trim(coalesce(target_category, '')), '');
  page_size integer := case when target_page_size in (25, 50, 100) then target_page_size else 25 end;
  offset_rows integer;
  records jsonb;
  total_count integer;
  catalog_kpis jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  offset_rows := greatest(0, (greatest(coalesce(target_page, 1), 1) - 1) * page_size);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'name', a.name,
    'part_number', a.part_number,
    'category', a.category,
    'price', a.price,
    'stock_quantity', a.stock_quantity,
    'oem', a.oem,
    'active', a.active,
    'created_at', a.created_at
  ) order by a.name, a.id), '[]'::jsonb)
  into records
  from (
    select id, name, part_number, category, price, stock_quantity, oem, active, created_at
    from public.accessories
    where organization_id = current_organization_id
      and (category_filter is null or category = category_filter)
      and (search_term = '' or name ilike '%' || search_term || '%' or part_number ilike '%' || search_term || '%')
    order by name, id
    limit page_size offset offset_rows
  ) a;

  select count(*)::integer into total_count
  from public.accessories
  where organization_id = current_organization_id
    and (category_filter is null or category = category_filter)
    and (search_term = '' or name ilike '%' || search_term || '%' or part_number ilike '%' || search_term || '%');

  select jsonb_build_object(
    'total_items', count(*)::integer,
    'active_items', (count(*) filter (where active))::integer,
    'low_stock', (count(*) filter (where active and stock_quantity <= 3))::integer,
    'oem_items', (count(*) filter (where active and oem))::integer
  )
  into catalog_kpis
  from public.accessories
  where organization_id = current_organization_id;

  return jsonb_build_object('records', records, 'total', total_count, 'kpis', catalog_kpis);
end;
$$;

revoke all on function public.get_accessories_catalog(text, text, integer, integer) from public, anon;
grant execute on function public.get_accessories_catalog(text, text, integer, integer) to authenticated;

commit;
