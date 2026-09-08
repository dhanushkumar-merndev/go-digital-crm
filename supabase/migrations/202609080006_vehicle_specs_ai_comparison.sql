begin;

-- Existing incomplete variants remain readable; editing specifications requires
-- an explicit value or NOT_AVAILABLE for every standard comparison field.
create function app_private.validate_comparison_specifications()
returns trigger language plpgsql set search_path='' as $$
declare key text;
begin
  if tg_op='UPDATE' and new.specifications is not distinct from old.specifications then return new; end if;
  if jsonb_typeof(new.specifications)<>'object' or octet_length(new.specifications::text)>16384
    or (select count(*) from jsonb_object_keys(new.specifications))>50 then
    raise exception using errcode='22023',message='INVALID_VEHICLE_SPECIFICATIONS'; end if;
  foreach key in array array['battery_capacity','fast_charging','power','range','torque','warranty'] loop
    if jsonb_typeof(new.specifications->key) is distinct from 'string'
      or length(btrim(new.specifications->>key)) not between 1 and 500 then
      raise exception using errcode='22023',message='COMPLETE_STANDARD_SPECIFICATIONS_OR_MARK_NOT_AVAILABLE'; end if;
  end loop;
  if exists(select 1 from jsonb_each(new.specifications) e where length(btrim(e.key)) not between 1 and 80) then
    raise exception using errcode='22023',message='INVALID_SPECIFICATION_NAME'; end if;
  return new;
end $$;
create trigger validate_comparison_specifications before insert or update of specifications on public.vehicle_variants
for each row execute function app_private.validate_comparison_specifications();

-- A balance-only projection for every authenticated tenant role. It does not
-- grant ledger/billing access or credit allocation/consumption permissions.
create function public.get_my_credit_balance()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare org uuid := app_private.current_tenant_organization();
begin
  if auth.uid() is null or org is null or not app_private.can_access_organization(org)
    or not app_private.mfa_policy_satisfied(org)
    or not exists(select 1 from public.user_role_assignments where organization_id=org and user_id=auth.uid() and active)
    then raise exception using errcode='42501',message='CREDIT_BALANCE_ACCESS_REQUIRED'; end if;
  return jsonb_build_object('ai',coalesce((select balance from public.credit_balances where organization_id=org and ledger_kind='AI'),0),
    'tracking',coalesce((select balance from public.credit_balances where organization_id=org and ledger_kind='TRACKING'),0));
end $$;

create table public.vehicle_comparison_ai_requests (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  actor_id uuid not null references public.profiles(id),
  our_id uuid not null references public.vehicle_variants(id),
  other_id uuid not null references public.vehicle_variants(id),
  status text not null check(status in ('RUNNING','COMPLETED','FAILED')),
  summary text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.vehicle_comparison_ai_requests enable row level security;
alter table public.vehicle_comparison_ai_requests force row level security;
revoke all on public.vehicle_comparison_ai_requests from public,anon,authenticated;
create index vehicle_comparison_ai_requests_org_idx on public.vehicle_comparison_ai_requests(organization_id,created_at desc);
insert into app_private.retention_table_allowlist(table_name,disposition,delete_order)
values('vehicle_comparison_ai_requests','DELETE',693);

create function public.finish_vehicle_comparison_ai(target_request_id uuid, target_summary text default null)
returns void language plpgsql security definer set search_path='' as $$
declare r public.vehicle_comparison_ai_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='SERVICE_ROLE_REQUIRED'; end if;
  select * into r from public.vehicle_comparison_ai_requests where id=target_request_id for update;
  if not found or r.status<>'RUNNING' then return; end if;
  if target_summary is not null and length(btrim(target_summary)) not between 1 and 6000 then
    raise exception using errcode='22023',message='INVALID_AI_COMPARISON'; end if;
  if target_summary is null then
    insert into public.credit_ledger(organization_id,ledger_kind,transaction_type,amount,feature,reference_id,reason,user_id)
    values(r.organization_id,'AI','REVERSAL',1,'VEHICLE_COMPARISON','comparison-refund:'||r.id,'AI comparison failed or expired',r.actor_id)
    on conflict(organization_id,ledger_kind,reference_id) do nothing;
  end if;
  update public.vehicle_comparison_ai_requests set status=case when target_summary is null then 'FAILED' else 'COMPLETED' end,
    summary=target_summary,finished_at=now() where id=r.id;
end $$;

create function public.begin_vehicle_comparison_ai(target_actor uuid,target_our_id uuid,target_other_id uuid,target_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; r public.vehicle_comparison_ai_requests%rowtype; expired uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='SERVICE_ROLE_REQUIRED'; end if;
  select organization_id into org from public.profiles where id=target_actor and active and deleted_at is null;
  if org is null or target_request_id is null then raise exception using errcode='42501',message='COMPARISON_ACCESS_REQUIRED'; end if;
  -- Edge calls the authenticated comparison RPC before entering this service-only boundary.
  if not exists(select 1 from app_private.comparison_vehicles where id=target_our_id and organization_id=org)
    or not exists(select 1 from app_private.comparison_vehicles v where id=target_other_id and (v.organization_id=org or (
      exists(select 1 from public.vehicle_catalog_sharing where organization_id=org and enabled)
      and exists(select 1 from public.vehicle_catalog_sharing where organization_id=v.organization_id and enabled)))) then
    raise exception using errcode='42501',message='COMPARISON_VEHICLE_NOT_ACCESSIBLE'; end if;
  perform pg_advisory_xact_lock(hashtextextended(org::text||':vehicle-comparison-ai',0));
  for expired in select id from public.vehicle_comparison_ai_requests where organization_id=org and status='RUNNING' and created_at<now()-interval '2 minutes' loop
    perform public.finish_vehicle_comparison_ai(expired,null);
  end loop;
  select * into r from public.vehicle_comparison_ai_requests where id=target_request_id;
  if found then
    if r.actor_id<>target_actor or r.organization_id<>org or r.our_id<>target_our_id or r.other_id<>target_other_id then
      raise exception using errcode='22023',message='IDEMPOTENCY_KEY_REUSED'; end if;
    return jsonb_build_object('status',r.status,'summary',r.summary,'replayed',true);
  end if;
  if (select count(*) from public.vehicle_comparison_ai_requests where organization_id=org and actor_id=target_actor and created_at>now()-interval '1 minute')>=3 then
    raise exception using errcode='P0001',message='AI_COMPARISON_RATE_LIMIT'; end if;
  perform public.consume_platform_ai_credits(org,1,'VEHICLE_COMPARISON','comparison:'||target_request_id);
  insert into public.vehicle_comparison_ai_requests(id,organization_id,actor_id,our_id,other_id,status)
  values(target_request_id,org,target_actor,target_our_id,target_other_id,'RUNNING');
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
  values(org,target_actor,'vehicle_comparison.ai_requested','vehicle_comparison_ai_requests',target_request_id::text,
    jsonb_build_object('our_id',target_our_id,'other_id',target_other_id,'credits',1));
  return jsonb_build_object('status','RUNNING','summary',null,'replayed',false);
end $$;

create function public.expire_vehicle_comparison_ai()
returns integer language plpgsql security definer set search_path='' as $$
declare expired uuid; total integer:=0;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='SERVICE_ROLE_REQUIRED'; end if;
  for expired in select id from public.vehicle_comparison_ai_requests
    where status='RUNNING' and created_at<now()-interval '2 minutes'
    order by created_at,id limit 100 for update skip locked loop
    perform public.finish_vehicle_comparison_ai(expired,null); total:=total+1;
  end loop;
  return total;
end $$;
create index vehicle_comparison_ai_expiry_idx on public.vehicle_comparison_ai_requests(created_at,id) where status='RUNNING';
revoke all on function public.expire_vehicle_comparison_ai() from public,anon,authenticated;
grant execute on function public.expire_vehicle_comparison_ai() to service_role;
revoke all on function public.get_my_credit_balance() from public,anon;
grant execute on function public.get_my_credit_balance() to authenticated;
revoke all on function public.begin_vehicle_comparison_ai(uuid,uuid,uuid,uuid),public.finish_vehicle_comparison_ai(uuid,text) from public,anon,authenticated;
grant execute on function public.begin_vehicle_comparison_ai(uuid,uuid,uuid,uuid),public.finish_vehicle_comparison_ai(uuid,text) to service_role;
commit;
