begin;

-- Colours belong to the dealership catalog. Existing stock/quote colour strings
-- remain snapshots: renaming/deactivating a master never rewrites sold vehicles.
create table public.vehicle_colours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null check (length(trim(name)) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
create index vehicle_colours_catalog_idx on public.vehicle_colours (organization_id, active, name, id);
insert into app_private.retention_table_allowlist(table_name,disposition,delete_order)
values ('vehicle_colours','DELETE',705);
alter table public.vehicle_colours enable row level security;
create policy vehicle_colours_read on public.vehicle_colours for select to authenticated
using (organization_id = app_private.current_tenant_organization() and (
  app_private.has_permission(organization_id, 'integration.manage')
  or app_private.has_permission(organization_id, 'inventory.view')
  or app_private.has_permission(organization_id, 'inventory.stock_check')
));
revoke all on public.vehicle_colours from anon, authenticated;
grant select on public.vehicle_colours to authenticated;
grant all on public.vehicle_colours to service_role;

-- Dynamic identifiers only come from this fixed allowlist, never request text.
create function app_private.master_data_table(category text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  case category
    when 'BRANDS' then return 'vehicle_brands';
    when 'MODELS' then return 'vehicle_models';
    when 'VARIANTS' then return 'vehicle_variants';
    when 'COLOURS' then return 'vehicle_colours';
    when 'LEAD_SOURCES' then return 'lead_sources';
    else raise exception using errcode = '22023', message = 'INVALID_MASTER_DATA_CATEGORY';
  end case;
end; $$;
revoke all on function app_private.master_data_table(text) from public, anon, authenticated;

create or replace function public.get_master_data_workspace(
  target_category text default 'MODELS', target_page integer default 1,
  target_page_size integer default 25, target_search text default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  org uuid := app_private.current_tenant_organization();
  category text := upper(trim(coalesce(target_category, 'MODELS')));
  table_name text;
  search_term text := left(trim(coalesce(target_search, '')), 100);
  projection text := 'r.id, r.name, r.active, r.created_at';
  joins text := '';
  search_predicate text := '($2='''' or r.name ilike ''%%''||$2||''%%'')';
  records jsonb;
  total bigint;
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org, 'integration.manage') then
    raise exception using errcode = '42501', message = 'MASTER_DATA_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_page is null or target_page not between 1 and 100000
    or target_page_size is null or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_MASTER_DATA_QUERY';
  end if;
  table_name := app_private.master_data_table(category);
  if category = 'MODELS' then
    projection := projection || ', r.brand_id, b.name as brand_name';
    joins := ' join public.vehicle_brands b on b.id=r.brand_id and b.organization_id=r.organization_id';
  elsif category = 'VARIANTS' then
    projection := projection || ', r.model_id, m.name as model_name, b.name as brand_name, r.specifications';
    joins := ' join public.vehicle_models m on m.id=r.model_id and m.organization_id=r.organization_id join public.vehicle_brands b on b.id=m.brand_id and b.organization_id=r.organization_id';
  elsif category = 'LEAD_SOURCES' then
    projection := projection || ', r.canonical_source';
    search_predicate := '($2='''' or r.name ilike ''%%''||$2||''%%'' or r.canonical_source ilike ''%%''||$2||''%%'')';
  end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(p) order by p.name,p.id), ''[]''::jsonb)
    from (select %s from public.%I r %s where r.organization_id=$1
    and %s order by r.name,r.id limit $3 offset $4) p', projection, table_name, joins, search_predicate)
    into records using org, search_term, target_page_size, (target_page-1)*target_page_size;
  execute format('select count(*) from public.%I r %s where r.organization_id=$1
    and %s', table_name, joins, search_predicate)
    into total using org, search_term;
  return jsonb_build_object('records', records, 'total', total, 'kpis', jsonb_build_object(
    'brands', (select count(*) from public.vehicle_brands where organization_id=org),
    'models', (select count(*) from public.vehicle_models where organization_id=org),
    'variants', (select count(*) from public.vehicle_variants where organization_id=org),
    'colours', (select count(*) from public.vehicle_colours where organization_id=org),
    'lead_sources', (select count(*) from public.lead_sources where organization_id=org)
  ));
end; $$;

-- Shared write boundary, including legacy model/variant RPCs. Validate parents
-- before touching a row; a UUID foreign key alone does not enforce tenant scope.
create function public.save_vehicle_master(
  target_category text, target_id uuid default null, target_parent_id uuid default null,
  target_name text default null, target_specifications jsonb default '{}'::jsonb,
  target_active boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  org uuid := app_private.current_tenant_organization();
  category text := upper(trim(target_category));
  table_name text;
  before_row jsonb;
  after_row jsonb;
  record_id uuid := coalesce(target_id, gen_random_uuid());
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org, 'integration.manage') then
    raise exception using errcode = '42501', message = 'MASTER_DATA_MANAGE_PERMISSION_REQUIRED';
  end if;
  if category is null or category not in ('BRANDS','MODELS','VARIANTS','COLOURS') then
    raise exception using errcode = '22023', message = 'INVALID_MASTER_DATA_CATEGORY';
  end if;
  table_name := app_private.master_data_table(category);
  if length(trim(coalesce(target_name,''))) not between 1 and 80 or target_active is null
    or target_specifications is null or jsonb_typeof(target_specifications) <> 'object'
    or octet_length(target_specifications::text) > 16384 then
    raise exception using errcode = '22023', message = 'INVALID_MASTER_DATA';
  end if;
  if target_id is not null then
    execute format('select to_jsonb(r) from public.%I r where id=$1 and organization_id=$2 for update', table_name)
      into before_row using target_id, org;
    if before_row is null then
      raise exception using errcode = 'P0002', message = 'MASTER_DATA_RECORD_NOT_FOUND';
    end if;
  end if;
  if category='MODELS' then
    perform 1 from public.vehicle_brands where id=target_parent_id and organization_id=org for share;
    if not found then raise exception using errcode='22023', message='MASTER_DATA_PARENT_NOT_FOUND'; end if;
  elsif category='VARIANTS' then
    perform 1 from public.vehicle_models m join public.vehicle_brands b on b.id=m.brand_id and b.organization_id=org
      where m.id=target_parent_id and m.organization_id=org for share of m,b;
    if not found then raise exception using errcode='22023', message='MASTER_DATA_PARENT_NOT_FOUND'; end if;
  end if;
  if target_id is null then
    case category
      when 'MODELS' then
        insert into public.vehicle_models(id,organization_id,brand_id,name,active)
          values(record_id,org,target_parent_id,trim(target_name),target_active);
      when 'VARIANTS' then
        insert into public.vehicle_variants(id,organization_id,model_id,name,specifications,active)
          values(record_id,org,target_parent_id,trim(target_name),target_specifications,target_active);
      else
        execute format('insert into public.%I(id,organization_id,name,active) values($1,$2,$3,$4)', table_name)
          using record_id,org,trim(target_name),target_active;
    end case;
  else
    execute format('update public.%I set name=$1,active=$2 where id=$3 and organization_id=$4',table_name)
      using trim(target_name),target_active,record_id,org;
    if category='MODELS' then
      update public.vehicle_models set brand_id=target_parent_id where id=record_id and organization_id=org;
    elsif category='VARIANTS' then
      update public.vehicle_variants set model_id=target_parent_id,specifications=target_specifications
        where id=record_id and organization_id=org;
    end if;
  end if;
  execute format('select to_jsonb(r) from public.%I r where id=$1 and organization_id=$2', table_name)
    into after_row using record_id,org;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
    values(org,auth.uid(),'master_data.saved',table_name,record_id::text,
      jsonb_build_object('old',before_row,'new',after_row));
  return after_row;
end; $$;

create or replace function public.upsert_master_model(
  target_id uuid default null, target_brand_id uuid default null,
  target_name text default null, target_active boolean default true
) returns jsonb language sql security definer set search_path = '' as $$
  select public.save_vehicle_master('MODELS',target_id,target_brand_id,target_name,'{}'::jsonb,target_active);
$$;
create or replace function public.upsert_master_variant(
  target_id uuid default null, target_model_id uuid default null, target_name text default null,
  target_specifications jsonb default '{}'::jsonb, target_active boolean default true
) returns jsonb language sql security definer set search_path = '' as $$
  select public.save_vehicle_master('VARIANTS',target_id,target_model_id,target_name,target_specifications,target_active);
$$;

create or replace function public.set_master_data_active(target_category text, target_id uuid, target_active boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare org uuid := app_private.current_tenant_organization(); table_name text; before_row jsonb;
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org,'integration.manage') then
    raise exception using errcode='42501',message='MASTER_DATA_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_active is null then raise exception using errcode='22023',message='INVALID_MASTER_DATA'; end if;
  table_name := app_private.master_data_table(upper(trim(target_category)));
  execute format('select to_jsonb(r) from public.%I r where id=$1 and organization_id=$2 for update',table_name)
    into before_row using target_id,org;
  if before_row is null then raise exception using errcode='P0002',message='MASTER_DATA_RECORD_NOT_FOUND'; end if;
  execute format('update public.%I set active=$1 where id=$2 and organization_id=$3',table_name)
    using target_active,target_id,org;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
    values(org,auth.uid(),'master_data.active_changed',table_name,target_id::text,
      jsonb_build_object('old',before_row,'new',before_row || jsonb_build_object('active',target_active)));
  return true;
end; $$;

revoke all on function public.save_vehicle_master(text,uuid,uuid,text,jsonb,boolean) from public,anon;
revoke all on function public.upsert_master_model(uuid,uuid,text,boolean) from public,anon;
revoke all on function public.upsert_master_variant(uuid,uuid,text,jsonb,boolean) from public,anon;
revoke all on function public.get_master_data_workspace(text,integer,integer,text) from public,anon;
revoke all on function public.set_master_data_active(text,uuid,boolean) from public,anon;
grant execute on function public.save_vehicle_master(text,uuid,uuid,text,jsonb,boolean) to authenticated;
grant execute on function public.upsert_master_model(uuid,uuid,text,boolean) to authenticated;
grant execute on function public.upsert_master_variant(uuid,uuid,text,jsonb,boolean) to authenticated;
grant execute on function public.get_master_data_workspace(text,integer,integer,text) to authenticated;
grant execute on function public.set_master_data_active(text,uuid,boolean) to authenticated;

commit;
