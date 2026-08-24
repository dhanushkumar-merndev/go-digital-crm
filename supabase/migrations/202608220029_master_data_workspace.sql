-- Master-data records predate the generic timestamp convention. Keep the
-- workspace response consistent without requiring a destructive table rebuild.
alter table public.vehicle_brands
  add column if not exists created_at timestamptz not null default now();

alter table public.vehicle_models
  add column if not exists created_at timestamptz not null default now();

alter table public.lead_sources
  add column if not exists created_at timestamptz not null default now();

create index if not exists vehicle_models_master_data_idx
  on public.vehicle_models (organization_id, active, name, id);
create index if not exists vehicle_brands_master_data_idx
  on public.vehicle_brands (organization_id, active, name, id);
create index if not exists lead_sources_master_data_idx
  on public.lead_sources (organization_id, active, name, id);

create or replace function public.get_master_data_workspace(
  target_category text default 'MODELS',
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  category_key text := upper(trim(coalesce(target_category, 'MODELS')));
  search_term text := left(trim(coalesce(target_search, '')), 100);
  offset_rows integer;
  records jsonb;
  total_count integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage') then
    raise exception using errcode = '42501', message = 'MASTER_DATA_MANAGE_PERMISSION_REQUIRED';
  end if;
  if category_key not in ('MODELS', 'BRANDS', 'LEAD_SOURCES')
    or target_page not between 1 and 100000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_MASTER_DATA_QUERY';
  end if;
  offset_rows := (target_page - 1) * target_page_size;
  if category_key = 'MODELS' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', model_row.id, 'name', model_row.name, 'active', model_row.active,
      'brand_id', brand_row.id, 'brand_name', brand_row.name, 'created_at', model_row.created_at
    ) order by model_row.name, model_row.id), '[]'::jsonb), count(*)::integer into records, total_count
    from (select * from public.vehicle_models where organization_id = current_organization_id
      and (search_term = '' or name ilike '%' || search_term || '%') order by name, id limit target_page_size offset offset_rows) model_row
    join public.vehicle_brands brand_row on brand_row.id = model_row.brand_id;
    select count(*)::integer into total_count from public.vehicle_models model_row
      where model_row.organization_id = current_organization_id and (search_term = '' or model_row.name ilike '%' || search_term || '%');
  elsif category_key = 'BRANDS' then
    select coalesce(jsonb_agg(jsonb_build_object('id', brand_row.id, 'name', brand_row.name, 'active', brand_row.active, 'created_at', brand_row.created_at) order by brand_row.name, brand_row.id), '[]'::jsonb) into records
    from (select * from public.vehicle_brands where organization_id = current_organization_id and (search_term = '' or name ilike '%' || search_term || '%') order by name, id limit target_page_size offset offset_rows) brand_row;
    select count(*)::integer into total_count from public.vehicle_brands where organization_id = current_organization_id and (search_term = '' or name ilike '%' || search_term || '%');
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', source_row.id, 'name', source_row.name, 'canonical_source', source_row.canonical_source, 'active', source_row.active, 'created_at', source_row.created_at) order by source_row.name, source_row.id), '[]'::jsonb) into records
    from (select * from public.lead_sources where organization_id = current_organization_id and (search_term = '' or name ilike '%' || search_term || '%' or canonical_source ilike '%' || search_term || '%') order by name, id limit target_page_size offset offset_rows) source_row;
    select count(*)::integer into total_count from public.lead_sources where organization_id = current_organization_id and (search_term = '' or name ilike '%' || search_term || '%' or canonical_source ilike '%' || search_term || '%');
  end if;
  return jsonb_build_object('records', records, 'total', total_count, 'kpis', jsonb_build_object(
    'brands', (select count(*)::integer from public.vehicle_brands where organization_id = current_organization_id),
    'models', (select count(*)::integer from public.vehicle_models where organization_id = current_organization_id),
    'variants', (select count(*)::integer from public.vehicle_variants where organization_id = current_organization_id),
    'lead_sources', (select count(*)::integer from public.lead_sources where organization_id = current_organization_id)
  ));
end;
$$;

create or replace function public.set_master_data_active(target_category text, target_id uuid, target_active boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_organization_id uuid; updated_rows integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null or not app_private.has_permission(current_organization_id, 'integration.manage') then raise exception using errcode = '42501', message = 'MASTER_DATA_MANAGE_PERMISSION_REQUIRED'; end if;
  case upper(trim(target_category))
    when 'MODELS' then update public.vehicle_models set active = target_active where id = target_id and organization_id = current_organization_id;
    when 'BRANDS' then update public.vehicle_brands set active = target_active where id = target_id and organization_id = current_organization_id;
    when 'LEAD_SOURCES' then update public.lead_sources set active = target_active where id = target_id and organization_id = current_organization_id;
    else raise exception using errcode = '22023', message = 'INVALID_MASTER_DATA_CATEGORY';
  end case;
  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then raise exception using errcode = 'P0002', message = 'MASTER_DATA_RECORD_NOT_FOUND'; end if;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata) values (current_organization_id, auth.uid(), 'master_data.active_changed', lower(target_category), target_id::text, jsonb_build_object('active', target_active));
  return true;
end; $$;

revoke all on function public.get_master_data_workspace(text, integer, integer, text) from public, anon;
grant execute on function public.get_master_data_workspace(text, integer, integer, text) to authenticated;
revoke all on function public.set_master_data_active(text, uuid, boolean) from public, anon;
grant execute on function public.set_master_data_active(text, uuid, boolean) to authenticated;
