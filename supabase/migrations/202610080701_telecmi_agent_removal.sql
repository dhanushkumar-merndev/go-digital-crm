begin;

-- Keep a durable, audited request rather than deleting CRM users or history.
create table public.telecmi_agent_removal_requests (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  external_account_id text not null,
  agent_id text not null,
  phone text,
  actor_id uuid not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'COMPLETED', 'FAILED')),
  error_code text,
  lease_expires_at timestamptz not null default (now() + interval '2 minutes'),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  recreated_at timestamptz
);
alter table public.telecmi_agent_removal_requests enable row level security;
revoke all on public.telecmi_agent_removal_requests from public, anon, authenticated;
grant select, insert, update on public.telecmi_agent_removal_requests to service_role;
create index telecmi_agent_removal_app_idx on public.telecmi_agent_removal_requests
  (organization_id, external_account_id, lease_expires_at) where status in ('PENDING', 'COMPLETED');

create or replace function public.get_telecmi_agent_reservations(
  target_organization_id uuid, target_external_account_id text, excluded_connection_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'phone', phone)), '[]'::jsonb)
    from (
      select agent ->> 'user_id' as user_id,
        app_private.telecmi_mapping_phone(agent ->> 'phone') as phone
      from public.connected_accounts connection_row
      cross join lateral jsonb_array_elements(case
        when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
          then connection_row.connection_config -> 'parallel_agents' else '[]'::jsonb end) agent
      where connection_row.organization_id = target_organization_id
        and connection_row.provider_key = 'telecmi'
        and connection_row.external_account_id = target_external_account_id
        and connection_row.deleted_at is null
        and connection_row.id is distinct from excluded_connection_id
      union
      select connection_config ->> 'default_user_id', null::text
      from public.connected_accounts
      where organization_id = target_organization_id and provider_key = 'telecmi'
        and external_account_id = target_external_account_id and deleted_at is null
        and id is distinct from excluded_connection_id
        and nullif(connection_config ->> 'default_user_id', '') is not null
      union
      select agent_id, case when status='PENDING' then phone else null::text end from public.telecmi_agent_removal_requests
      where organization_id = target_organization_id and external_account_id = target_external_account_id
        and status in ('PENDING', 'COMPLETED') and recreated_at is null
    ) reservations
  );
end;
$$;
revoke all on function public.get_telecmi_agent_reservations(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.get_telecmi_agent_reservations(uuid,text,uuid) to service_role;

create or replace function public.begin_telecmi_agent_removal(
  target_organization_id uuid, target_external_account_id text, target_agent_id text,
  target_phone text, target_actor_id uuid, target_request_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  previous public.telecmi_agent_removal_requests%rowtype;
  normalized_phone text := nullif(app_private.telecmi_mapping_phone(target_phone), '');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_actor_id is null or target_request_id is null
    or target_agent_id !~ '^\d{1,12}_\d{1,12}$'
    or split_part(target_agent_id, '_', 2) <> target_external_account_id then
    raise exception using errcode = '22023', message = 'INVALID_TELECMI_AGENT_REMOVAL';
  end if;
  if not app_private.telecmi_actor_is_client_admin(target_actor_id, target_organization_id) then
    raise exception using errcode = '42501', message = 'CLIENT_ADMIN_REQUIRED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    target_organization_id::text || ':telecmi:' || target_external_account_id, 0));
  select * into previous from public.telecmi_agent_removal_requests where id = target_request_id;
  if found then
    if previous.organization_id <> target_organization_id or previous.agent_id <> target_agent_id
      or previous.actor_id <> target_actor_id or previous.external_account_id <> target_external_account_id then
      raise exception using errcode = '22023', message = 'REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object('claimed', false, 'status', previous.status, 'request_id', previous.id);
  end if;
  if exists (select 1 from jsonb_array_elements(public.get_telecmi_agent_reservations(
    target_organization_id, target_external_account_id, null)) reserved
    where reserved ->> 'user_id' = target_agent_id
      or (normalized_phone is not null and reserved ->> 'phone' = normalized_phone)) then
    raise exception using errcode = '22023', message = 'TELECMI_AGENT_IN_USE';
  end if;
  insert into public.telecmi_agent_removal_requests(id, organization_id, external_account_id, agent_id, phone, actor_id)
    values(target_request_id, target_organization_id, target_external_account_id, target_agent_id, normalized_phone, target_actor_id);
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,request_id,metadata)
    values(target_organization_id,target_actor_id,'integration.telecmi_agent_removal_started',
      'telecmi_agent',target_agent_id,target_request_id,jsonb_build_object('app_id',target_external_account_id));
  return jsonb_build_object('claimed',true,'status','PENDING','request_id',target_request_id);
end;
$$;
revoke all on function public.begin_telecmi_agent_removal(uuid,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_telecmi_agent_removal(uuid,text,text,text,uuid,uuid) to service_role;

create or replace function public.finish_telecmi_agent_removal(
  target_organization_id uuid, target_request_id uuid, target_actor_id uuid,
  target_status text, target_error_code text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  removal public.telecmi_agent_removal_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_status not in ('COMPLETED','FAILED') or
    (target_error_code is not null and target_error_code !~ '^[A-Z0-9_]{1,80}$') then
    raise exception using errcode = '22023', message = 'INVALID_REMOVAL_OUTCOME';
  end if;
  select * into removal from public.telecmi_agent_removal_requests
    where id = target_request_id and organization_id = target_organization_id and actor_id = target_actor_id for update;
  if not found then raise exception using errcode = '22023', message = 'REMOVAL_REQUEST_NOT_FOUND'; end if;
  if removal.status <> 'PENDING' then return; end if;
  update public.telecmi_agent_removal_requests set status=target_status,
    finished_at=now(),error_code=target_error_code where id=removal.id;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,request_id,metadata)
    values(target_organization_id,target_actor_id,'integration.telecmi_agent_removal_' || lower(target_status),
      'telecmi_agent',removal.agent_id,target_request_id,jsonb_build_object('app_id',removal.external_account_id,'error_code',target_error_code));
end;
$$;
revoke all on function public.finish_telecmi_agent_removal(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.finish_telecmi_agent_removal(uuid,uuid,uuid,text,text) to service_role;

create or replace function app_private.guard_telecmi_agent_removal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.provider_key <> 'telecmi' or new.deleted_at is not null then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    new.organization_id::text || ':telecmi:' || coalesce(new.external_account_id,''), 0));
  if exists (select 1 from public.telecmi_agent_removal_requests removal
    where removal.organization_id=new.organization_id and removal.external_account_id=new.external_account_id
      and removal.status in ('PENDING','COMPLETED') and removal.recreated_at is null
      and (removal.agent_id = new.connection_config ->> 'default_user_id' or exists (
        select 1 from jsonb_array_elements(case
          when jsonb_typeof(new.connection_config -> 'parallel_agents')='array'
          then new.connection_config -> 'parallel_agents' else '[]'::jsonb end) agent
        where agent ->> 'user_id'=removal.agent_id or
          (removal.status='PENDING' and removal.phone is not null and app_private.telecmi_mapping_phone(agent ->> 'phone')=removal.phone)
      ))) then
    raise exception using errcode='23505',message='TELECMI_AGENT_REMOVAL_IN_PROGRESS';
  end if;
  -- Defaults reserve the same agent as employee mappings, including on writes
  -- that bypass the dropdown. The existing trigger still protects duplicate phones.
  if exists (
    select 1 from public.connected_accounts other
    where other.organization_id=new.organization_id and other.provider_key='telecmi'
      and other.external_account_id=new.external_account_id and other.deleted_at is null
      and other.id<>new.id and (
        (nullif(new.connection_config ->> 'default_user_id','') is not null and (
          other.connection_config ->> 'default_user_id'=new.connection_config ->> 'default_user_id'
          or exists (select 1 from jsonb_array_elements(case
            when jsonb_typeof(other.connection_config -> 'parallel_agents')='array'
            then other.connection_config -> 'parallel_agents' else '[]'::jsonb end) old_agent
            where old_agent ->> 'user_id'=new.connection_config ->> 'default_user_id')
        )) or exists (select 1 from jsonb_array_elements(case
          when jsonb_typeof(new.connection_config -> 'parallel_agents')='array'
          then new.connection_config -> 'parallel_agents' else '[]'::jsonb end) new_agent
          where new_agent ->> 'user_id'=other.connection_config ->> 'default_user_id')
      )
  ) then
    raise exception using errcode='23505',message='TELECMI_AGENT_MAPPING_CONFLICT';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_telecmi_agent_removal() from public,anon,authenticated;
create trigger guard_telecmi_agent_removal before insert or update of connection_config,external_account_id,provider_key,deleted_at
  on public.connected_accounts for each row execute function app_private.guard_telecmi_agent_removal();

-- A successful provider create can reuse a removed extension immediately.
-- Only the authenticated, authorized Edge/worker that just created it calls this.
create or replace function public.record_telecmi_agent_recreated(
  target_organization_id uuid,target_agent_id text,target_actor_id uuid
)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501',message='SERVICE_ROLE_REQUIRED';
  end if;
  if not app_private.telecmi_actor_is_client_admin(target_actor_id,target_organization_id) then
    raise exception using errcode='42501',message='CLIENT_ADMIN_REQUIRED';
  end if;
  if target_agent_id is null or target_agent_id !~ '^\d{1,12}_\d{1,12}$' then
    raise exception using errcode='22023',message='INVALID_TELECMI_AGENT_REMOVAL';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    target_organization_id::text || ':telecmi:' || split_part(target_agent_id,'_',2),0));
  -- Provider creation proves this extension is now a new agent. It can succeed
  -- after deletion but before the removal's completion write reaches the database.
  update public.telecmi_agent_removal_requests set recreated_at=now()
    where organization_id=target_organization_id and agent_id=target_agent_id
      and status in ('PENDING','COMPLETED') and recreated_at is null;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
    values(target_organization_id,target_actor_id,'integration.telecmi_agent_recreated',
      'telecmi_agent',target_agent_id,jsonb_build_object('app_id',split_part(target_agent_id,'_',2)));
end;
$$;
revoke all on function public.record_telecmi_agent_recreated(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.record_telecmi_agent_recreated(uuid,text,uuid) to service_role;

-- A timeout leaves a pending reservation. A later authenticated refresh checks
-- the provider again after the request lease, rather than releasing it blindly.
create or replace function public.reconcile_telecmi_agent_removals(
  target_organization_id uuid,target_external_account_id text,target_agent_ids text[],target_actor_id uuid,
  target_observed_at timestamptz
)
returns void language plpgsql security definer set search_path='' as $$
declare removal public.telecmi_agent_removal_requests%rowtype; outcome text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501',message='SERVICE_ROLE_REQUIRED';
  end if;
  if not app_private.telecmi_actor_is_client_admin(target_actor_id,target_organization_id) then
    raise exception using errcode='42501',message='CLIENT_ADMIN_REQUIRED';
  end if;
  if target_agent_ids is null or target_observed_at is null then raise exception using errcode='22023',message='PROVIDER_AGENT_LIST_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    target_organization_id::text || ':telecmi:' || target_external_account_id,0));
  for removal in select * from public.telecmi_agent_removal_requests
    where organization_id=target_organization_id and external_account_id=target_external_account_id
      and status='PENDING' and recreated_at is null and lease_expires_at<least(target_observed_at,now()) for update
  loop
    outcome := case when removal.agent_id=any(target_agent_ids) then 'FAILED' else 'COMPLETED' end;
    update public.telecmi_agent_removal_requests set status=outcome,finished_at=now(),
      error_code=case when outcome='FAILED' then 'TELECMI_REMOVAL_NOT_APPLIED' else null end where id=removal.id;
    insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,request_id,metadata)
      values(target_organization_id,target_actor_id,'integration.telecmi_agent_removal_reconciled',
        'telecmi_agent',removal.agent_id,removal.id,jsonb_build_object('app_id',target_external_account_id,'status',outcome));
  end loop;
end;
$$;
revoke all on function public.reconcile_telecmi_agent_removals(uuid,text,text[],uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.reconcile_telecmi_agent_removals(uuid,text,text[],uuid,timestamptz) to service_role;

commit;
