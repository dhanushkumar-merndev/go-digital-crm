begin;

-- Consent is organization-wide. No vehicle-level sharing flag or copied tenant rows.
create table public.vehicle_catalog_sharing (
  organization_id uuid primary key references public.organizations(id),
  enabled boolean not null default false,
  version integer not null default 0,
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now(),
  consent_version text
);
alter table public.vehicle_catalog_sharing enable row level security;
alter table public.vehicle_catalog_sharing force row level security;
revoke all on public.vehicle_catalog_sharing from public, anon, authenticated;
insert into app_private.retention_table_allowlist(table_name,disposition,delete_order)
values ('vehicle_catalog_sharing','DELETE',694);

create function app_private.comparison_organization(owner_only boolean default false)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare org uuid := app_private.current_tenant_organization();
begin
  if auth.uid() is null or org is null
    or not app_private.can_access_organization(org)
    or not app_private.mfa_policy_satisfied(org)
    or not exists (
      select 1 from public.user_role_assignments a
      join public.roles r on r.id=a.role_id and r.organization_id=a.organization_id
      where a.organization_id=org and a.user_id=auth.uid() and a.active
      and ((r.role_key='business_owner' and a.data_scope in ('ORGANIZATION','ALL_BRANCHES'))
        or (not owner_only and (
          (r.role_key='sales_consultant' and app_private.has_permission(org,'test_drive.manage'))
          or (r.role_key='client_admin' and app_private.has_permission(org,'user.manage')))))
    ) then raise exception using errcode='42501', message='VEHICLE_COMPARISON_ACCESS_REQUIRED'; end if;
  return org;
end $$;

create function public.get_vehicle_catalog_sharing()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid := app_private.comparison_organization(); can_manage boolean;
begin
  select exists(select 1 from public.user_role_assignments a
    join public.roles r on r.id=a.role_id and r.organization_id=a.organization_id
    where a.organization_id=org and a.user_id=auth.uid() and a.active
      and a.data_scope in ('ORGANIZATION','ALL_BRANCHES') and r.role_key='business_owner') into can_manage;
  return jsonb_build_object('enabled',coalesce((select enabled from public.vehicle_catalog_sharing where organization_id=org),false),
    'version',coalesce((select version from public.vehicle_catalog_sharing where organization_id=org),0),
    'can_manage',can_manage);
end $$;

create function public.set_vehicle_catalog_sharing(target_enabled boolean, expected_version integer, accepted_consent text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare org uuid := app_private.comparison_organization(true); previous public.vehicle_catalog_sharing%rowtype;
begin
  if target_enabled is null or expected_version is null or expected_version < 0
    or (target_enabled and accepted_consent is distinct from 'vehicle-catalog-v1')
    then raise exception using errcode='22023', message='EXPLICIT_CATALOG_CONSENT_REQUIRED'; end if;
  insert into public.vehicle_catalog_sharing(organization_id) values(org) on conflict do nothing;
  select * into previous from public.vehicle_catalog_sharing where organization_id=org for update;
  if previous.version<>expected_version then
    raise exception using errcode='40001', message='CATALOG_SHARING_CHANGED_REFRESH'; end if;
  if previous.enabled=target_enabled then return public.get_vehicle_catalog_sharing(); end if;
  update public.vehicle_catalog_sharing set enabled=target_enabled, version=version+1,
    changed_by=auth.uid(), changed_at=clock_timestamp(),
    consent_version=case when target_enabled then accepted_consent else consent_version end
    where organization_id=org;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
  values(org,auth.uid(),'vehicle_catalog.sharing_changed','vehicle_catalog_sharing',org::text,
    jsonb_build_object('old_enabled',previous.enabled,'enabled',target_enabled,'consent_version',accepted_consent,
      'consent','Share all current and future active vehicle model and variant specifications and dealership name with opted-in dealerships for comparison.',
      'version',previous.version+1));
  return public.get_vehicle_catalog_sharing();
end $$;

-- This projection is the ONLY cross-tenant boundary. Never expose whole rows,
-- stock, quotation pricing defaults, leads, contacts or private competitor notes.
create view app_private.comparison_vehicles as
select v.id,v.organization_id,o.name as dealership_name,b.name as manufacturer,m.name as model,v.name as variant,
  (v.specifications - array['ex_showroom_price','insurance_amount','registration_amount','cost_price','margin','discount'])
    || jsonb_build_object('ex_showroom_price',v.ex_showroom_price) as specifications
from public.vehicle_variants v
join public.vehicle_models m on m.id=v.model_id and m.organization_id=v.organization_id
join public.vehicle_brands b on b.id=m.brand_id and b.organization_id=v.organization_id
join public.organizations o on o.id=v.organization_id
where v.active and m.active and b.active and o.status='ACTIVE' and o.deleted_at is null;
revoke all on app_private.comparison_vehicles from public,anon,authenticated;

create function public.search_comparison_vehicles(target_search text default '', own_only boolean default false, target_page integer default 1, target_page_size integer default 25)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid := app_private.comparison_organization(); shared boolean; result jsonb;
begin
  if target_page is null or target_page<1 or target_page>10000 or target_page_size is null
    or target_page_size not in (25,50,100) or own_only is null or length(coalesce(target_search,''))>120 then
    raise exception using errcode='22023', message='INVALID_COMPARISON_SEARCH'; end if;
  select coalesce((select enabled from public.vehicle_catalog_sharing where organization_id=org),false) into shared;
  with eligible as (
    select v.id,v.manufacturer,v.model,v.variant,v.dealership_name,(v.organization_id=org) as is_own
    from app_private.comparison_vehicles v
    where (v.organization_id=org or (not own_only and shared and exists(
      select 1 from public.vehicle_catalog_sharing s where s.organization_id=v.organization_id and s.enabled)))
    and (coalesce(btrim(target_search),'')='' or strpos(lower(concat_ws(' ',v.manufacturer,v.model,v.variant,v.dealership_name)),lower(btrim(target_search)))>0)
  ), page as (select * from eligible order by manufacturer,model,variant,dealership_name,id
    limit target_page_size offset (target_page-1)*target_page_size)
  select jsonb_build_object('records',coalesce((select jsonb_agg(to_jsonb(p) order by manufacturer,model,variant,dealership_name,id) from page p),'[]'::jsonb),
    'total',(select count(*) from eligible),'sharing_enabled',shared) into result;
  return result;
end $$;

create function public.get_vehicle_comparison(target_our_id uuid, target_other_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid := app_private.comparison_organization(); ours jsonb; other jsonb;
begin
  select jsonb_build_object('id',v.id,'manufacturer',v.manufacturer,'model',v.model,'variant',v.variant,
    'dealership_name',v.dealership_name,'specifications',v.specifications,'is_own',true) into ours
    from app_private.comparison_vehicles v where v.id=target_our_id and v.organization_id=org;
  select jsonb_build_object('id',v.id,'manufacturer',v.manufacturer,'model',v.model,'variant',v.variant,
    'dealership_name',v.dealership_name,'specifications',v.specifications,'is_own',v.organization_id=org) into other
    from app_private.comparison_vehicles v where v.id=target_other_id and (v.organization_id=org or (
      exists(select 1 from public.vehicle_catalog_sharing s where s.organization_id=org and s.enabled)
      and exists(select 1 from public.vehicle_catalog_sharing s where s.organization_id=v.organization_id and s.enabled)));
  if ours is null or other is null then raise exception using errcode='42501', message='COMPARISON_VEHICLE_NOT_ACCESSIBLE'; end if;
  return jsonb_build_object('ours',ours,'other',other);
end $$;

-- Close legacy sales endpoints too: private orgs must not use a stale client
-- to compare privately maintained third-party competitor profiles.
create or replace function public.list_sales_competitor_profiles()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.search_comparison_vehicles()->'records';
$$;
create or replace function public.get_sales_competitor_comparison_options()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('our_variants',public.search_comparison_vehicles('',true)->'records',
    'competitors',public.search_comparison_vehicles()->'records');
$$;

revoke all on function app_private.comparison_organization(boolean) from public,anon,authenticated;
revoke all on function public.get_vehicle_catalog_sharing() from public,anon;
revoke all on function public.set_vehicle_catalog_sharing(boolean,integer,text) from public,anon;
revoke all on function public.search_comparison_vehicles(text,boolean,integer,integer) from public,anon;
revoke all on function public.get_vehicle_comparison(uuid,uuid) from public,anon;
grant execute on function public.get_vehicle_catalog_sharing(),public.set_vehicle_catalog_sharing(boolean,integer,text),
  public.search_comparison_vehicles(text,boolean,integer,integer),public.get_vehicle_comparison(uuid,uuid) to authenticated;
commit;
