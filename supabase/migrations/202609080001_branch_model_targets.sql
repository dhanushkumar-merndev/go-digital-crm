-- Unit targets are independent of historical monetary/team/user targets.
create table public.branch_model_targets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  model_id uuid not null references public.vehicle_models(id),
  month date not null check (extract(day from month) = 1),
  target_units integer not null check (target_units between 0 and 1000000),
  updated_at timestamptz not null default clock_timestamp(),
  unique (organization_id, branch_id, month, model_id)
);
alter table public.branch_model_targets enable row level security;
-- All access goes through the scoped RPCs; clients cannot bypass validation.
revoke all on public.branch_model_targets from anon, authenticated;
insert into app_private.retention_table_allowlist(table_name,disposition,delete_order)
values('branch_model_targets','DELETE',691);

create function app_private.model_target_organization(writing boolean default false)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare org uuid := app_private.current_tenant_organization();
begin
  if auth.uid() is null or org is null
    or not app_private.mfa_policy_satisfied(org)
    or not app_private.has_organization_wide_scope(org)
    or not exists (
      select 1 from public.user_role_assignments a
      join public.roles r on r.id=a.role_id and r.organization_id=a.organization_id
      where a.organization_id=org and a.user_id=auth.uid() and a.active
        and a.data_scope in ('ORGANIZATION','ALL_BRANCHES')
        and ((r.role_key='client_admin' and app_private.has_permission(org,'user.manage'))
          or (not writing and r.role_key='business_owner'))
    ) then
    raise exception using errcode='42501', message='TENANT_TARGET_CONFIGURATION_REQUIRED';
  end if;
  return org;
end $$;
revoke all on function app_private.model_target_organization(boolean) from public, anon, authenticated;

create function public.get_branch_model_targets(
  target_month date, target_branch_id uuid default null,
  target_search text default '', target_page integer default 1, target_page_size integer default 25
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  org uuid := app_private.model_target_organization();
  branch uuid := target_branch_id;
  result jsonb;
begin
  if target_month is null or extract(day from target_month)<>1
    or target_page is null or target_page<1 or target_page>100000
    or target_page_size is null or target_page_size not in (25,50,100)
    or length(coalesce(target_search,''))>120 then
    raise exception using errcode='22023',message='INVALID_MODEL_TARGET_QUERY';
  end if;
  if branch is null then
    select id into branch from public.branches
    where organization_id=org and active and deleted_at is null order by name,id limit 1;
  elsif not exists(select 1 from public.branches where id=branch and organization_id=org and active and deleted_at is null) then
    raise exception using errcode='42501',message='TARGET_BRANCH_DENIED';
  end if;
  with booking_models as materialized (
    select b.id, coalesce(allocated.model_id, named.model_id) as model_id
    from public.bookings b
    left join public.leads l on l.id=b.lead_id and l.organization_id=b.organization_id
    left join lateral (
      select v.model_id from public.stock_allocations a
      join public.stock_units s on s.id=a.stock_unit_id and s.organization_id=a.organization_id
      join public.vehicle_variants v on v.id=s.variant_id and v.organization_id=s.organization_id
      where a.organization_id=org and a.booking_id=b.id
        and a.status in ('ACTIVE','RESERVED','ALLOCATED')
      order by a.allocated_at desc,a.id desc limit 1
    ) allocated on true
    left join lateral (
      select split_part(i.description,' · ',1) as name
      from public.quotation_items i where i.organization_id=org and i.quotation_id=b.quotation_id
        and i.item_type='VEHICLE' order by i.id limit 1
    ) quoted on allocated.model_id is null
    left join lateral (
      -- Legacy quotations carry names. Only an unambiguous exact match counts.
      select (array_agg(m.id))[1] as model_id
      from public.vehicle_models m
      join public.vehicle_brands br on br.id=m.brand_id and br.organization_id=m.organization_id
      where m.organization_id=org and lower(btrim(coalesce(quoted.name,l.interested_model,'')))
        in (lower(m.name),lower(br.name||' '||m.name))
      having count(*)=1
    ) named on allocated.model_id is null
    where b.organization_id=org and b.branch_id=branch and b.deleted_at is null
      and b.status<>'CANCELLED'
      and b.created_at>=timezone('Asia/Kolkata',target_month::timestamp)
      and b.created_at<timezone('Asia/Kolkata',(target_month+interval '1 month')::timestamp)
  ), model_rows as materialized (
    select m.id, br.name||' '||m.name as name, m.active and br.active as active,
      coalesce(t.target_units,0) as target_units,t.updated_at,
      (select count(*) from booking_models b where b.model_id=m.id) as booked_units
    from public.vehicle_models m
    join public.vehicle_brands br on br.id=m.brand_id and br.organization_id=m.organization_id
    left join public.branch_model_targets t on t.organization_id=org and t.branch_id=branch
      and t.month=target_month and t.model_id=m.id
    where m.organization_id=org and ((m.active and br.active) or t.id is not null
      or exists(select 1 from booking_models b where b.model_id=m.id))
  ), filtered as (
    select * from model_rows where position(lower(btrim(coalesce(target_search,''))) in lower(name))>0
  ), paged as (
    select * from filtered order by name,id limit target_page_size offset (target_page-1)*target_page_size
  ) select jsonb_build_object(
    'branch_id',branch,'month',target_month,
    'branches',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name,id)
      from public.branches where organization_id=org and active and deleted_at is null),'[]'::jsonb),
    'records',coalesce((select jsonb_agg(to_jsonb(p) order by name,id) from paged p),'[]'::jsonb),
    'total',(select count(*) from filtered),
    'target_units',coalesce((select sum(target_units) from model_rows),0),
    'booked_units',(select count(*) from booking_models where model_id is not null),
    'unmatched_units',(select count(*) from booking_models where model_id is null)
  ) into result;
  return result;
end $$;

create function public.save_branch_model_target(
  target_branch_id uuid,target_month date,target_model_id uuid,target_units integer,
  expected_updated_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  org uuid := app_private.model_target_organization(true);
  previous public.branch_model_targets;
  saved public.branch_model_targets;
begin
  if target_month is null or extract(day from target_month)<>1
    or target_units is null or target_units<0 or target_units>1000000 then
    raise exception using errcode='22023',message='INVALID_MODEL_TARGET';
  end if;
  if not exists(select 1 from public.branches where organization_id=org and id=target_branch_id and active and deleted_at is null) then
    raise exception using errcode='42501',message='TARGET_BRANCH_DENIED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(org::text||target_branch_id::text||target_month::text||target_model_id::text,0));
  select * into previous from public.branch_model_targets
    where organization_id=org and branch_id=target_branch_id and month=target_month and model_id=target_model_id;
  if previous.updated_at is distinct from expected_updated_at then
    raise exception using errcode='40001',message='MODEL_TARGET_VERSION_CONFLICT';
  end if;
  if not exists(select 1 from public.vehicle_models m join public.vehicle_brands b
    on b.id=m.brand_id and b.organization_id=m.organization_id
    where m.organization_id=org and m.id=target_model_id
      and ((m.active and b.active) or (previous.id is not null and target_units=0))) then
    raise exception using errcode='42501',message='TARGET_MODEL_DENIED';
  end if;
  insert into public.branch_model_targets(organization_id,branch_id,month,model_id,target_units)
    values(org,target_branch_id,target_month,target_model_id,target_units)
    on conflict(organization_id,branch_id,month,model_id) do update
      set target_units=excluded.target_units,updated_at=clock_timestamp()
    returning * into saved;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
    values(org,auth.uid(),'branch_model_target.saved','branch_model_target',saved.id::text,
      jsonb_build_object('old',to_jsonb(previous),'new',to_jsonb(saved)));
  return to_jsonb(saved);
end $$;
revoke all on function public.get_branch_model_targets(date,uuid,text,integer,integer) from public,anon;
revoke all on function public.save_branch_model_target(uuid,date,uuid,integer,timestamptz) from public,anon;
grant execute on function public.get_branch_model_targets(date,uuid,text,integer,integer) to authenticated;
grant execute on function public.save_branch_model_target(uuid,date,uuid,integer,timestamptz) to authenticated;
