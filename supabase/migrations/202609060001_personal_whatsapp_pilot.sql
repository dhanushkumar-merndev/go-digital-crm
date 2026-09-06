begin;

-- Personal message bodies deliberately never enter the legacy conversation tables:
-- executive SECURITY DEFINER reports read those tables without owner filtering.
alter table public.connected_accounts add column owner_user_id uuid;
alter table public.connected_accounts add constraint personal_connection_owner_fk
  foreign key (organization_id, owner_user_id) references public.profiles(organization_id, id);
alter table public.connected_accounts drop constraint connected_accounts_auth_type_check;
alter table public.connected_accounts add constraint connected_accounts_auth_type_check
  check (auth_type in ('OAUTH2','API_KEY','WEBHOOK_SECRET','BASIC_AUTH','QR_SESSION'));
alter table public.connected_accounts add constraint personal_connection_identity check (
  (provider_key = 'whatsapp_personal_baileys' and owner_user_id is not null and auth_type = 'QR_SESSION'
    and external_account_id is null)
  or (provider_key <> 'whatsapp_personal_baileys' and owner_user_id is null and auth_type <> 'QR_SESSION')
);
create unique index personal_connection_owner_idx on public.connected_accounts(organization_id, owner_user_id)
  where provider_key = 'whatsapp_personal_baileys' and deleted_at is null;

create table public.personal_whatsapp_sessions (
  connection_id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  owner_user_id uuid not null,
  branch_id uuid not null,
  generation uuid not null default gen_random_uuid(),
  enabled boolean not null default true,
  status text not null default 'CONNECTING' check (status in ('CONNECTING','QR_READY','CONNECTED','RECONNECTING','DISCONNECTED','LOGGED_OUT','ERROR')),
  masked_phone text,
  account_hash text,
  linked_at timestamptz,
  requested_at timestamptz not null default now(),
  lease_owner uuid,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  paused_until timestamptz,
  safe_error_code text,
  discarded_message_count bigint not null default 0,
  foreign key (organization_id, connection_id) references public.connected_accounts(organization_id,id),
  foreign key (organization_id, owner_user_id) references public.profiles(organization_id,id),
  foreign key (organization_id, branch_id) references public.branches(organization_id,id),
  unique (organization_id, connection_id)
);
create unique index personal_whatsapp_number_idx on public.personal_whatsapp_sessions(account_hash)
  where enabled and account_hash is not null;
create index personal_whatsapp_session_owner_idx on public.personal_whatsapp_sessions(organization_id,owner_user_id);

create table public.personal_whatsapp_qr_attempts (
  connection_id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  generation uuid not null,
  qr text check (length(qr) <= 4096),
  expires_at timestamptz not null default now(),
  foreign key (organization_id, connection_id) references public.personal_whatsapp_sessions(organization_id,connection_id)
);
create table public.personal_whatsapp_keys (
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null,
  key_id text not null check (length(key_id) <= 1024),
  ciphertext text not null check (length(ciphertext) <= 1048576),
  primary key (connection_id, key_id),
  foreign key (organization_id, connection_id) references public.personal_whatsapp_sessions(organization_id,connection_id)
);
create table public.personal_whatsapp_nonces (
  nonce uuid primary key,
  expires_at timestamptz not null
);
create table public.personal_whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null,
  branch_id uuid not null,
  owner_user_id uuid not null,
  normalized_contact text not null check (normalized_contact ~ '^[0-9]{7,15}$'),
  lead_id uuid,
  customer_id uuid,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (organization_id, connection_id) references public.personal_whatsapp_sessions(organization_id,connection_id),
  foreign key (organization_id, branch_id) references public.branches(organization_id,id),
  foreign key (organization_id, owner_user_id) references public.profiles(organization_id,id),
  foreign key (organization_id, lead_id) references public.leads(organization_id,id),
  foreign key (organization_id, customer_id) references public.customers(organization_id,id),
  unique (organization_id, id),
  unique (connection_id, normalized_contact)
);
create index personal_whatsapp_conversations_page_idx on public.personal_whatsapp_conversations(organization_id,owner_user_id,last_message_at desc,id desc);
create table public.personal_whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  conversation_id uuid not null,
  connection_id uuid not null,
  provider_message_id text,
  application_message_id uuid,
  direction text not null check (direction in ('INBOUND','OUTBOUND')),
  body text check (length(body) <= 65535),
  delivery_status text not null,
  message_type text not null default 'text',
  origin text not null check (origin in ('CRM','PHONE','CUSTOMER')),
  sent_at timestamptz not null,
  created_at timestamptz not null default now(),
  failed_at timestamptz,
  safe_error_code text,
  deleted_at timestamptz,
  foreign key (organization_id, conversation_id) references public.personal_whatsapp_conversations(organization_id,id),
  foreign key (organization_id, connection_id) references public.personal_whatsapp_sessions(organization_id,connection_id),
  unique (connection_id, provider_message_id),
  unique (connection_id, application_message_id)
);
create index personal_whatsapp_messages_page_idx on public.personal_whatsapp_messages(organization_id,conversation_id,sent_at desc,id desc);
create index personal_whatsapp_send_limit_idx on public.personal_whatsapp_messages(connection_id,created_at desc) where origin = 'CRM';
create unique index personal_whatsapp_one_pending_idx on public.personal_whatsapp_messages(connection_id)
  where delivery_status in ('PENDING','SENDING','UNKNOWN') and origin = 'CRM';

create function app_private.personal_whatsapp_eligible(actor uuid, org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.actor_has_tenant_operation_context(actor,org,'message.view')
    and app_private.actor_has_tenant_operation_context(actor,org,'message.send')
    and (select r.role_key from public.user_role_assignments a join public.roles r on r.id=a.role_id and r.organization_id=a.organization_id
      where a.user_id=actor and a.organization_id=org and a.active
      order by r.authority_level desc limit 1) in ('telecaller_bdc','sales_consultant');
$$;
create function app_private.personal_whatsapp_owner(org uuid, actor uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select actor=auth.uid() and app_private.personal_whatsapp_eligible(actor,org)
    and public.get_access_context()->>'destination'='CRM'
    and public.get_access_context()->>'role_key' in ('telecaller','sales-consultant')
    and app_private.has_permission(org,'message.view');
$$;
-- Background sockets have no browser JWT/session. Resolve current actor scope
-- explicitly; never manufacture an MFA/session claim or weaken browser gates.
create function app_private.personal_whatsapp_actor_branch(actor uuid, org uuid, bid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.personal_whatsapp_eligible(actor,org) and exists (
    select 1 from public.branches b where b.id=bid and b.organization_id=org and b.active and b.deleted_at is null
  ) and exists (
    select 1 from public.user_role_assignments a where a.organization_id=org and a.user_id=actor and a.active and (
      a.data_scope in ('ORGANIZATION','ALL_BRANCHES')
      or (a.data_scope='ONE_BRANCH' and a.scope_branch_id=bid)
      or (a.data_scope='SELECTED_BRANCHES' and bid=any(a.selected_branch_ids))
      or exists(select 1 from public.user_branch_access ba where ba.organization_id=org and ba.user_id=actor and ba.branch_id=bid and ba.active)
      or exists(select 1 from public.team_members tm join public.teams t on t.id=tm.team_id
        where tm.organization_id=org and tm.user_id=actor and tm.active and t.organization_id=org and t.active and t.branch_id=bid)
    )
  );
$$;
create function app_private.personal_whatsapp_actor_record(actor uuid, org uuid, lid uuid, cust uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.personal_whatsapp_eligible(actor,org) and exists (
    select 1 from public.user_role_assignments a
    join public.role_permissions rp on rp.role_id=a.role_id
    join public.permissions p on p.id=rp.permission_id
    where a.organization_id=org and a.user_id=actor and a.active
      and p.permission_key=case when lid is not null then 'lead.view' else 'customer.view' end
      and (lid is not null or exists(select 1 from public.customers c where c.id=cust and c.organization_id=org and c.deleted_at is null))
      and (
        (lid is null and a.data_scope in ('ORGANIZATION','ALL_BRANCHES'))
        or exists (
          select 1 from public.leads l where l.organization_id=org and l.deleted_at is null
            and ((lid is not null and l.id=lid) or (lid is null and l.customer_id=cust))
            and app_private.personal_whatsapp_actor_branch(actor,org,l.branch_id)
            and (
              a.data_scope in ('ORGANIZATION','ALL_BRANCHES')
              or (a.data_scope='ONE_BRANCH' and a.scope_branch_id=l.branch_id)
              or (a.data_scope='SELECTED_BRANCHES' and l.branch_id=any(a.selected_branch_ids))
              or (a.data_scope='OWN_TEAM' and exists(select 1 from public.team_members tm
                where tm.organization_id=org and tm.user_id=actor and tm.team_id=l.team_id and tm.active))
              or (a.data_scope='OWN_RECORDS' and (l.assigned_user_id=actor or (lid is null and (
                exists(select 1 from public.lead_assignments la where la.organization_id=org and la.lead_id=l.id and la.assigned_user_id=actor)
                or exists(select 1 from public.lead_assignment_history h where h.organization_id=org and h.lead_id=l.id and actor in(h.previous_owner_id,h.new_owner_id))
              ))))
            )
        )
      )
  );
$$;
create function app_private.personal_whatsapp_contact_candidates(actor uuid, org uuid, contact_number text)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select array_agg(distinct identity_id) from (
    select coalesce(l.customer_id,l.id) identity_id from public.leads l
      where l.organization_id=org and l.deleted_at is null and l.normalized_phone in(contact_number,'+'||contact_number)
        and app_private.personal_whatsapp_actor_record(actor,org,l.id,null)
    union select c.id from public.customers c where c.organization_id=org and c.deleted_at is null
      and c.normalized_phone in(contact_number,'+'||contact_number) and app_private.personal_whatsapp_actor_record(actor,org,null,c.id)
  ) matches;
$$;
create function app_private.personal_whatsapp_conversation_access(org uuid, conversation uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.personal_whatsapp_conversations c
    where c.organization_id=org and c.id=conversation and c.deleted_at is null
      and app_private.personal_whatsapp_owner(org,c.owner_user_id)
      and app_private.can_access_branch(org,c.branch_id)
      and ((c.lead_id is not null and app_private.can_access_lead(c.lead_id))
        or (c.customer_id is not null and app_private.can_access_customer(org,c.customer_id))));
$$;

-- Preserve the existing actor validator for every other provider.
alter function app_private.validate_connected_account_actor() rename to validate_official_connected_account_actor;
create function app_private.validate_connected_account_actor()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.provider_key='whatsapp_personal_baileys' then
    if auth.role() is distinct from 'service_role' or new.created_by is distinct from new.owner_user_id then
      raise exception 'PERSONAL_WHATSAPP_SERVER_REQUIRED';
    end if;
    if tg_op='INSERT' and not app_private.personal_whatsapp_eligible(new.owner_user_id,new.organization_id) then
      raise exception 'PERSONAL_WHATSAPP_ROLE_REQUIRED';
    end if;
    if tg_op='UPDATE' and (new.id,new.organization_id,new.owner_user_id,new.created_by,new.created_at,new.provider_key)
      is distinct from (old.id,old.organization_id,old.owner_user_id,old.created_by,old.created_at,old.provider_key) then
      raise exception 'CONNECTED_ACCOUNT_IDENTITY_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$$;
drop trigger enforce_connected_account_actor on public.connected_accounts;
create trigger enforce_connected_account_actor before insert or update on public.connected_accounts
  for each row when (new.provider_key='whatsapp_personal_baileys') execute function app_private.validate_connected_account_actor();
create trigger enforce_official_connected_account_actor before insert or update on public.connected_accounts
  for each row when (new.provider_key<>'whatsapp_personal_baileys') execute function app_private.validate_official_connected_account_actor();

do $$ declare t text; begin
  foreach t in array array['personal_whatsapp_sessions','personal_whatsapp_qr_attempts','personal_whatsapp_keys',
    'personal_whatsapp_nonces','personal_whatsapp_conversations','personal_whatsapp_messages'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
grant select on public.personal_whatsapp_conversations,public.personal_whatsapp_messages to authenticated;
create policy personal_conversations_owner on public.personal_whatsapp_conversations for select to authenticated
  using (app_private.personal_whatsapp_conversation_access(organization_id,id));
create policy personal_messages_owner on public.personal_whatsapp_messages for select to authenticated
  using (deleted_at is null and app_private.personal_whatsapp_conversation_access(organization_id,conversation_id));
-- QR and session reads use the status RPC, which masks expired QR values at read time.

create function public.personal_whatsapp_link_authorize(target_actor uuid, target_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cid uuid; bid uuid; s public.personal_whatsapp_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not app_private.personal_whatsapp_eligible(target_actor,target_org) then raise exception 'PERSONAL_WHATSAPP_ROLE_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('personal-whatsapp-capacity',0));
  select c.id into cid from public.connected_accounts c where c.organization_id=target_org
    and c.owner_user_id=target_actor and c.provider_key='whatsapp_personal_baileys' and c.deleted_at is null;
  select * into s from public.personal_whatsapp_sessions where connection_id=cid for update;
  if s.enabled and (s.linked_at is not null or s.requested_at>now()-interval '2 minutes') then
    return jsonb_build_object('connection_id',cid,'generation',s.generation);
  end if;
  if (select count(*) from public.personal_whatsapp_sessions where enabled
      and (linked_at is not null or requested_at>now()-interval '2 minutes')) >= 5 then
    raise exception 'PERSONAL_WHATSAPP_CAPACITY';
  end if;
  select b.id into bid from public.branches b where b.organization_id=target_org
    and app_private.personal_whatsapp_actor_branch(target_actor,target_org,b.id)
    order by b.id limit 1;
  if bid is null then raise exception 'PERSONAL_WHATSAPP_BRANCH_REQUIRED'; end if;
  if cid is null then
    insert into public.connected_accounts(organization_id,provider_key,display_name,scope_mode,status,created_by,owner_user_id,auth_type)
      values(target_org,'whatsapp_personal_baileys','Personal WhatsApp','ONE_BRANCH','PENDING',target_actor,target_actor,'QR_SESSION') returning id into cid;
    insert into public.integration_branch_mappings(organization_id,connected_account_id,branch_id,external_resource_type,external_resource_id)
      values(target_org,cid,bid,'PERSONAL_WHATSAPP_USER',target_actor::text);
  end if;
  insert into public.personal_whatsapp_sessions(connection_id,organization_id,owner_user_id,branch_id)
    values(cid,target_org,target_actor,bid)
    on conflict(connection_id) do update set enabled=true,status='CONNECTING',generation=gen_random_uuid(),branch_id=excluded.branch_id,
      requested_at=now(),linked_at=null,masked_phone=null,account_hash=null,lease_owner=null,lease_until=null,heartbeat_at=null,safe_error_code=null
    returning * into s;
  delete from public.personal_whatsapp_keys where connection_id=cid;
  delete from public.personal_whatsapp_qr_attempts where connection_id=cid;
  update public.connected_accounts set status='PENDING' where id=cid;
  update public.integration_branch_mappings set branch_id=bid where connected_account_id=cid and organization_id=target_org and external_resource_type='PERSONAL_WHATSAPP_USER';
  -- A rescan can link a different phone number. An inbound to the previous
  -- number must never authorize first contact from the replacement number.
  update public.personal_whatsapp_conversations set last_inbound_at=null where connection_id=cid;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
    values(target_org,target_actor,'personal_whatsapp.link_requested','connected_account',cid::text,'{"consent_version":"pilot-v1"}');
  return jsonb_build_object('connection_id',cid,'generation',s.generation);
end;
$$;

create function public.personal_whatsapp_disconnect(target_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype;
begin
  select * into s from public.personal_whatsapp_sessions where connection_id=target_connection_id for update;
  if not found or not app_private.personal_whatsapp_owner(s.organization_id,s.owner_user_id) then raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'; end if;
  update public.personal_whatsapp_sessions set enabled=false,status='DISCONNECTED',generation=gen_random_uuid(),
    lease_until=null,lease_owner=null,account_hash=null,masked_phone=null where connection_id=target_connection_id;
  delete from public.personal_whatsapp_keys where connection_id=target_connection_id;
  delete from public.personal_whatsapp_qr_attempts where connection_id=target_connection_id;
  update public.personal_whatsapp_messages set delivery_status='UNKNOWN',safe_error_code='DISCONNECTED_DURING_SEND'
    where connection_id=target_connection_id and delivery_status in ('PENDING','SENDING');
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id)
    values(s.organization_id,auth.uid(),'personal_whatsapp.disconnected','connected_account',target_connection_id::text);
  return jsonb_build_object('connection_id',target_connection_id);
end;
$$;

create function public.personal_whatsapp_gateway(target_connection_id uuid,target_generation uuid,target_worker uuid,target_operation text,target_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype; kv record; result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into s from public.personal_whatsapp_sessions where connection_id=target_connection_id for update;
  if not found or not s.enabled or s.generation<>target_generation or target_worker is null
    or not app_private.personal_whatsapp_eligible(s.owner_user_id,s.organization_id)
    or (s.linked_at is null and s.requested_at<now()-interval '2 minutes') then raise exception 'PERSONAL_WHATSAPP_SESSION_REVOKED'; end if;
  if target_operation='acquire' then
    if s.lease_owner is not null and s.lease_owner<>target_worker and s.lease_until>now() then raise exception 'PERSONAL_WHATSAPP_LEASE_HELD'; end if;
    update public.personal_whatsapp_sessions set lease_owner=target_worker,lease_until=now()+interval '45 seconds',heartbeat_at=now() where connection_id=s.connection_id;
    return to_jsonb(s)-'account_hash';
  end if;
  if s.lease_owner is distinct from target_worker or s.lease_until is null or s.lease_until<=now() then raise exception 'PERSONAL_WHATSAPP_LEASE_LOST'; end if;
  if target_operation='heartbeat' then
    update public.personal_whatsapp_sessions set heartbeat_at=now(),lease_until=now()+interval '45 seconds' where connection_id=s.connection_id;
    update public.personal_whatsapp_qr_attempts set qr=null where connection_id=s.connection_id and expires_at<=now();
  elsif target_operation='release' then
    update public.personal_whatsapp_sessions set lease_owner=null,lease_until=null,status='RECONNECTING' where connection_id=s.connection_id;
  elsif target_operation='qr' then
    insert into public.personal_whatsapp_qr_attempts(connection_id,organization_id,generation,qr,expires_at)
      values(s.connection_id,s.organization_id,s.generation,target_data->>'qr',least(now()+interval '45 seconds',s.requested_at+interval '2 minutes'))
      on conflict(connection_id) do update set qr=excluded.qr,expires_at=excluded.expires_at,generation=excluded.generation;
    update public.personal_whatsapp_sessions set status='QR_READY' where connection_id=s.connection_id;
  elsif target_operation='connected' then
    if target_data->>'masked_phone' !~ '^\*+[0-9]{4}$' or length(target_data->>'account_hash')<>64 then raise exception 'INVALID_PERSONAL_ACCOUNT'; end if;
    update public.personal_whatsapp_sessions set status='CONNECTED',linked_at=coalesce(linked_at,now()),masked_phone=target_data->>'masked_phone',
      account_hash=target_data->>'account_hash',safe_error_code=null where connection_id=s.connection_id;
    delete from public.personal_whatsapp_qr_attempts where connection_id=s.connection_id;
    update public.connected_accounts set status='CONNECTED',connected_at=coalesce(connected_at,now()) where id=s.connection_id;
    insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id)
      values(s.organization_id,s.owner_user_id,'personal_whatsapp.connected','connected_account',s.connection_id::text);
  elsif target_operation in ('reconnecting','logged_out','error') then
    update public.personal_whatsapp_sessions set status=upper(target_operation),safe_error_code='PERSONAL_WHATSAPP_'||upper(target_operation),
      enabled=case when target_operation in ('logged_out','error') then false else enabled end where connection_id=s.connection_id;
    delete from public.personal_whatsapp_qr_attempts where connection_id=s.connection_id;
    if target_operation in ('logged_out','error') then
      delete from public.personal_whatsapp_keys where connection_id=s.connection_id;
      update public.connected_accounts set status='DISCONNECTED' where id=s.connection_id;
    end if;
  elsif target_operation='keys_get' then
    select coalesce(jsonb_object_agg(key_id,ciphertext),'{}') into result from public.personal_whatsapp_keys
      where connection_id=s.connection_id and key_id in (select jsonb_array_elements_text(target_data->'ids'));
    return result;
  elsif target_operation='keys_set' then
    if pg_column_size(target_data)>2097152 then raise exception 'KEY_BATCH_TOO_LARGE'; end if;
    for kv in select * from jsonb_each_text(target_data) loop
      if kv.value is null then delete from public.personal_whatsapp_keys where connection_id=s.connection_id and key_id=kv.key;
      else insert into public.personal_whatsapp_keys(organization_id,connection_id,key_id,ciphertext) values(s.organization_id,s.connection_id,kv.key,kv.value)
        on conflict(connection_id,key_id) do update set ciphertext=excluded.ciphertext;
      end if;
    end loop;
  else raise exception 'INVALID_GATEWAY_OPERATION';
  end if;
  return '{}'::jsonb;
end;
$$;

create function public.personal_whatsapp_nonce(target_nonce uuid,target_expires timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if target_expires<=now() or target_expires>now()+interval '2 minutes' then return false; end if;
  delete from public.personal_whatsapp_nonces where expires_at<now();
  insert into public.personal_whatsapp_nonces values(target_nonce,target_expires) on conflict do nothing;
  return found;
end;
$$;

-- Only current, permission-bound actor scope is used by this server-only worker.
create function public.personal_whatsapp_ingest(target_connection_id uuid,target_generation uuid,target_worker uuid,target_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype; contact_phone text; candidates uuid[]; lid uuid; cust uuid; bid uuid;
  cid uuid; sent timestamptz; mid uuid; direction_value text; body_value text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.personal_whatsapp_gateway(target_connection_id,target_generation,target_worker,'heartbeat');
  select * into s from public.personal_whatsapp_sessions where connection_id=target_connection_id;
  contact_phone:=target_data->>'phone'; sent:=(target_data->>'sent_at')::timestamptz;
  if contact_phone is null or contact_phone!~'^[0-9]{7,15}$' or sent is null or sent<coalesce(s.linked_at,s.requested_at) or sent>now()+interval '1 minute'
    or length(coalesce(target_data->>'provider_message_id','')) not between 1 and 200 then return jsonb_build_object('ignored',true); end if;
  candidates:=app_private.personal_whatsapp_contact_candidates(s.owner_user_id,s.organization_id,contact_phone);
  if cardinality(candidates)=1 then
    select l.id,l.customer_id,l.branch_id into lid,cust,bid from public.leads l
      where l.organization_id=s.organization_id and l.deleted_at is null and coalesce(l.customer_id,l.id)=candidates[1]
        and app_private.personal_whatsapp_actor_record(s.owner_user_id,s.organization_id,l.id,null) order by (l.normalized_phone in(contact_phone,'+'||contact_phone)) desc,l.created_at desc,l.id limit 1;
    if bid is null then
      select c.id into cust from public.customers c where c.id=candidates[1] and c.organization_id=s.organization_id
        and app_private.personal_whatsapp_actor_record(s.owner_user_id,s.organization_id,null,c.id);
      if app_private.personal_whatsapp_actor_branch(s.owner_user_id,s.organization_id,s.branch_id) then bid:=s.branch_id; end if;
    end if;
  end if;
  if cardinality(candidates) is distinct from 1 or bid is null then
    update public.personal_whatsapp_sessions set discarded_message_count=discarded_message_count+1,
      safe_error_code=case when cardinality(candidates)>1 then 'PERSONAL_WHATSAPP_AMBIGUOUS_CONTACT' else 'PERSONAL_WHATSAPP_UNMATCHED_CONTACT' end
      where connection_id=s.connection_id;
    return jsonb_build_object('ignored',true);
  end if;
  if exists(select 1 from public.personal_whatsapp_conversations c where c.connection_id=s.connection_id and c.normalized_contact=contact_phone
    and coalesce(c.customer_id,c.lead_id) is distinct from candidates[1]) then
    update public.personal_whatsapp_sessions set discarded_message_count=discarded_message_count+1,safe_error_code='PERSONAL_WHATSAPP_CONTACT_CHANGED' where connection_id=s.connection_id;
    return jsonb_build_object('ignored',true);
  end if;
  direction_value:=case when target_data->>'from_me'='true' then 'OUTBOUND' else 'INBOUND' end;
  body_value:=left(target_data->>'body',65535);
  insert into public.personal_whatsapp_conversations(organization_id,connection_id,branch_id,owner_user_id,normalized_contact,lead_id,customer_id,last_message_at,last_inbound_at)
    values(s.organization_id,s.connection_id,bid,s.owner_user_id,contact_phone,lid,cust,sent,case when direction_value='INBOUND' then sent end)
    on conflict(connection_id,normalized_contact) do update set last_message_at=greatest(personal_whatsapp_conversations.last_message_at,excluded.last_message_at),
      last_inbound_at=greatest(personal_whatsapp_conversations.last_inbound_at,excluded.last_inbound_at)
    returning id into cid;
  insert into public.personal_whatsapp_messages(organization_id,conversation_id,connection_id,provider_message_id,direction,body,delivery_status,message_type,origin,sent_at)
    values(s.organization_id,cid,s.connection_id,target_data->>'provider_message_id',direction_value,body_value,
      case when direction_value='INBOUND' then 'RECEIVED' else 'SENT' end,left(coalesce(target_data->>'message_type','text'),64),
      case when direction_value='INBOUND' then 'CUSTOMER' else 'PHONE' end,sent)
    on conflict(connection_id,provider_message_id) do nothing returning id into mid;
  if direction_value='OUTBOUND' then
    perform public.personal_whatsapp_receipt(s.connection_id,target_data->>'provider_message_id','SENT');
  end if;
  return jsonb_build_object('conversation_id',cid,'message_id',mid);
end;
$$;

create function public.personal_whatsapp_send_prepare(target_conversation_id uuid,target_application_message_id uuid,target_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.personal_whatsapp_conversations%rowtype; s public.personal_whatsapp_sessions%rowtype; m public.personal_whatsapp_messages%rowtype; ten integer; day_count integer; recipient_count integer; last_send timestamptz;
begin
  select * into c from public.personal_whatsapp_conversations where id=target_conversation_id;
  if not found or not app_private.personal_whatsapp_conversation_access(c.organization_id,c.id)
    or not app_private.has_permission(c.organization_id,'message.send') then raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'; end if;
  if target_application_message_id is null or length(btrim(coalesce(target_body,''))) not between 1 and 1500 then raise exception 'PERSONAL_WHATSAPP_INVALID_MESSAGE'; end if;
  select * into s from public.personal_whatsapp_sessions where connection_id=c.connection_id for update;
  select * into m from public.personal_whatsapp_messages where connection_id=c.connection_id and application_message_id=target_application_message_id;
  if found then
    if m.body<>btrim(target_body) or m.conversation_id<>c.id then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return jsonb_build_object('message_id',m.id,'connection_id',s.connection_id,'generation',s.generation,'status',m.delivery_status,'duplicate',true);
  end if;
  if not s.enabled or s.status<>'CONNECTED' or s.lease_until is null or s.lease_until<=now() then raise exception 'PERSONAL_WHATSAPP_DISCONNECTED'; end if;
  if s.paused_until>now() then raise exception 'PERSONAL_WHATSAPP_PAUSED'; end if;
  if c.last_inbound_at is null or c.last_inbound_at<=now()-interval '24 hours' then raise exception 'PERSONAL_WHATSAPP_REPLY_WINDOW_CLOSED'; end if;
  select count(*) filter(where created_at>now()-interval '10 minutes'),count(*),
    count(*) filter(where conversation_id=c.id),max(created_at) into ten,day_count,recipient_count,last_send
    from public.personal_whatsapp_messages where connection_id=s.connection_id and origin='CRM' and created_at>now()-interval '24 hours';
  if last_send>now()-interval '5 seconds' or ten>=10 or day_count>=50 or recipient_count>=20 then raise exception 'PERSONAL_WHATSAPP_RATE_LIMITED'; end if;
  if exists(select 1 from public.personal_whatsapp_messages where connection_id=s.connection_id and origin='CRM' and delivery_status in ('PENDING','SENDING','UNKNOWN')) then raise exception 'PERSONAL_WHATSAPP_SEND_UNRESOLVED'; end if;
  insert into public.personal_whatsapp_messages(organization_id,conversation_id,connection_id,application_message_id,direction,body,delivery_status,origin,sent_at)
    values(c.organization_id,c.id,s.connection_id,target_application_message_id,'OUTBOUND',btrim(target_body),'PENDING','CRM',now()) returning * into m;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id)
    values(c.organization_id,auth.uid(),'personal_whatsapp.reply_requested','personal_whatsapp_message',m.id::text);
  return jsonb_build_object('message_id',m.id,'connection_id',s.connection_id,'generation',s.generation,'status',m.delivery_status,'duplicate',false);
end;
$$;

create function public.personal_whatsapp_send_claim(target_connection_id uuid,target_generation uuid,target_worker uuid,target_message_id uuid,target_provider_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype; m public.personal_whatsapp_messages%rowtype; c public.personal_whatsapp_conversations%rowtype; permitted boolean;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.personal_whatsapp_gateway(target_connection_id,target_generation,target_worker,'heartbeat');
  select * into s from public.personal_whatsapp_sessions where connection_id=target_connection_id;
  select * into m from public.personal_whatsapp_messages where id=target_message_id and connection_id=s.connection_id for update;
  if not found or m.delivery_status<>'PENDING' or m.created_at<now()-interval '1 minute' then raise exception 'PERSONAL_WHATSAPP_NOT_CLAIMABLE'; end if;
  select * into c from public.personal_whatsapp_conversations where id=m.conversation_id;
  permitted:=c.deleted_at is null and c.owner_user_id=s.owner_user_id
    and app_private.personal_whatsapp_contact_candidates(s.owner_user_id,s.organization_id,c.normalized_contact)=array[coalesce(c.customer_id,c.lead_id)]
    and app_private.personal_whatsapp_actor_branch(s.owner_user_id,s.organization_id,c.branch_id)
    and (app_private.personal_whatsapp_actor_record(s.owner_user_id,s.organization_id,c.lead_id,null)
      or app_private.personal_whatsapp_actor_record(s.owner_user_id,s.organization_id,null,c.customer_id));
  if not coalesce(permitted,false) or s.status<>'CONNECTED' or s.paused_until>now() or c.last_inbound_at is null or c.last_inbound_at<=now()-interval '24 hours' then raise exception 'PERSONAL_WHATSAPP_SEND_DENIED'; end if;
  if length(coalesce(target_provider_id,'')) not between 1 and 200 then raise exception 'INVALID_PROVIDER_ID'; end if;
  update public.personal_whatsapp_messages set delivery_status='SENDING',provider_message_id=target_provider_id where id=m.id;
  return jsonb_build_object('phone',c.normalized_contact,'body',m.body,'provider_message_id',target_provider_id);
end;
$$;

create function public.personal_whatsapp_send_result(target_connection_id uuid,target_message_id uuid,target_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype; m public.personal_whatsapp_messages%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into s from public.personal_whatsapp_sessions where connection_id=target_connection_id for update;
  select * into m from public.personal_whatsapp_messages where id=target_message_id and connection_id=target_connection_id for update;
  if not found then return; end if;
  if target_status not in ('SENT','DELIVERED','READ','FAILED','UNKNOWN') then raise exception 'INVALID_SEND_STATUS'; end if;
  if m.delivery_status='READ' or (m.delivery_status='DELIVERED' and target_status<>'READ')
    or (m.delivery_status='SENT' and target_status in ('FAILED','UNKNOWN')) then return; end if;
  update public.personal_whatsapp_messages set delivery_status=target_status,
    failed_at=case when target_status in ('FAILED','UNKNOWN') then coalesce(failed_at,now()) else failed_at end,
    safe_error_code=case when target_status in ('FAILED','UNKNOWN') then 'PERSONAL_WHATSAPP_SEND_'||target_status end where id=m.id;
  update public.personal_whatsapp_conversations set last_message_at=greatest(last_message_at,m.sent_at) where id=m.conversation_id;
  if (select count(*) from public.personal_whatsapp_messages where connection_id=target_connection_id and failed_at>now()-interval '10 minutes')>=3 then
    update public.personal_whatsapp_sessions set paused_until=now()+interval '30 minutes' where connection_id=target_connection_id;
  end if;
end;
$$;

create function public.personal_whatsapp_receipt(target_connection_id uuid,target_provider_id text,target_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare mid uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select id into mid from public.personal_whatsapp_messages where connection_id=target_connection_id and provider_message_id=target_provider_id and origin='CRM';
  if mid is not null then perform public.personal_whatsapp_send_result(target_connection_id,mid,target_status); end if;
end;
$$;

create function public.personal_whatsapp_reconcile()
returns void language plpgsql security definer set search_path = '' as $$
declare row_data record;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  for row_data in select m.id,m.connection_id,m.delivery_status from public.personal_whatsapp_messages m
    where m.delivery_status in ('PENDING','SENDING') and m.created_at<now()-interval '2 minutes' limit 100 loop
    perform public.personal_whatsapp_send_result(row_data.connection_id,row_data.id,case when row_data.delivery_status='PENDING' then 'FAILED' else 'UNKNOWN' end);
  end loop;
  update public.personal_whatsapp_qr_attempts set qr=null where expires_at<=now() and qr is not null;
  update public.personal_whatsapp_sessions s set enabled=false,status='ERROR',lease_until=null,lease_owner=null,safe_error_code='PERSONAL_WHATSAPP_SESSION_REVOKED'
    where s.enabled and ((s.linked_at is null and s.requested_at<now()-interval '2 minutes') or not app_private.personal_whatsapp_eligible(s.owner_user_id,s.organization_id));
  delete from public.personal_whatsapp_keys k using public.personal_whatsapp_sessions s where s.connection_id=k.connection_id and not s.enabled;
  update public.connected_accounts c set status=case when not s.enabled then 'DISCONNECTED' when s.status='CONNECTED' and s.lease_until>now() then 'CONNECTED' else 'PENDING' end
    from public.personal_whatsapp_sessions s where c.id=s.connection_id and c.status is distinct from
      case when not s.enabled then 'DISCONNECTED' when s.status='CONNECTED' and s.lease_until>now() then 'CONNECTED' else 'PENDING' end;
end;
$$;

create function public.personal_whatsapp_resolve_unknown(target_message_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare m public.personal_whatsapp_messages%rowtype;
begin
  select * into m from public.personal_whatsapp_messages where id=target_message_id;
  if not found or not app_private.personal_whatsapp_conversation_access(m.organization_id,m.conversation_id) then raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'; end if;
  update public.personal_whatsapp_messages set delivery_status='UNCONFIRMED',safe_error_code='USER_ACKNOWLEDGED_UNKNOWN_RESULT' where id=m.id and delivery_status='UNKNOWN';
  if found then insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id)
    values(m.organization_id,auth.uid(),'personal_whatsapp.unknown_result_acknowledged','personal_whatsapp_message',m.id::text); end if;
end;
$$;

create function public.get_personal_whatsapp_status(target_conversation_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype; c public.personal_whatsapp_conversations%rowtype; daily integer; recent integer; recipient integer; next_at timestamptz; reason text; qr_data jsonb;
begin
  select ps.* into s from public.personal_whatsapp_sessions ps where ps.owner_user_id=auth.uid()
    and app_private.personal_whatsapp_owner(ps.organization_id,ps.owner_user_id) limit 1;
  if not found then return null; end if;
  if target_conversation_id is not null then
    select * into c from public.personal_whatsapp_conversations where id=target_conversation_id and connection_id=s.connection_id
      and app_private.personal_whatsapp_conversation_access(organization_id,id);
    if not found then raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'; end if;
  end if;
  select count(*),count(*) filter(where created_at>now()-interval '10 minutes'),count(*) filter(where conversation_id=c.id),
    greatest(max(created_at)+interval '5 seconds',
      case when count(*)>=50 then min(created_at)+interval '24 hours' end,
      case when count(*) filter(where created_at>now()-interval '10 minutes')>=10 then min(created_at) filter(where created_at>now()-interval '10 minutes')+interval '10 minutes' end,
      case when count(*) filter(where conversation_id=c.id)>=20 then min(created_at) filter(where conversation_id=c.id)+interval '24 hours' end)
    into daily,recent,recipient,next_at from public.personal_whatsapp_messages where connection_id=s.connection_id and origin='CRM' and created_at>now()-interval '24 hours';
  reason:=case when not s.enabled or s.status<>'CONNECTED' or s.lease_until is null or s.lease_until<=now() then 'PERSONAL_WHATSAPP_DISCONNECTED'
    when s.paused_until>now() then 'PERSONAL_WHATSAPP_PAUSED'
    when c.id is not null and (c.last_inbound_at is null or c.last_inbound_at<=now()-interval '24 hours') then 'PERSONAL_WHATSAPP_REPLY_WINDOW_CLOSED'
    when exists(select 1 from public.personal_whatsapp_messages where connection_id=s.connection_id and origin='CRM' and delivery_status in ('PENDING','SENDING','UNKNOWN')) then 'PERSONAL_WHATSAPP_SEND_UNRESOLVED'
    when next_at>now() then 'PERSONAL_WHATSAPP_RATE_LIMITED' end;
  select jsonb_build_object('qr',case when expires_at>now() then qr end,'expires_at',expires_at) into qr_data
    from public.personal_whatsapp_qr_attempts where connection_id=s.connection_id and generation=s.generation;
  return jsonb_build_object('connection_id',s.connection_id,'status',case when not s.enabled then s.status when s.lease_until<now() then 'RECONNECTING' else s.status end,
    'enabled',s.enabled,'masked_phone',s.masked_phone,'heartbeat_at',s.heartbeat_at,'daily_sent',daily,'daily_limit',50,
    'paused_until',s.paused_until,'next_send_at',next_at,'reply_window_expires_at',c.last_inbound_at+interval '24 hours',
    'send_disabled_reason',reason,'qr',qr_data->'qr','qr_expires_at',qr_data->'expires_at','attempt_expires_at',s.requested_at+interval '2 minutes');
end;
$$;

-- Extend the bounded inbox with a union of owner-filtered personal records.
do $$ declare definition text; begin
  select pg_get_functiondef('public.get_inbox_conversation_page(text,text,integer,integer)'::regprocedure) into definition;
  definition:=replace(definition,'''ALL'', ''WHATSAPP_BUSINESS''','''ALL'', ''WHATSAPP_PERSONAL'', ''WHATSAPP_BUSINESS''');
  definition:=replace(definition,'from public.conversations conversation_row',
    'from (select id,organization_id,branch_id,lead_id,customer_id,channel,status,assigned_user_id,external_contact,last_message_at,created_at
      from public.conversations where app_private.can_access_conversation(organization_id,id)
      union all select id,organization_id,branch_id,lead_id,customer_id,''WHATSAPP_PERSONAL'',''OPEN'',owner_user_id,normalized_contact,last_message_at,created_at
      from public.personal_whatsapp_conversations where app_private.personal_whatsapp_conversation_access(organization_id,id)) conversation_row');
  definition:=replace(definition,'and app_private.can_access_conversation(current_organization_id, conversation_row.id)','');
  definition:=replace(definition,'from public.conversation_messages message_row',
    'from (select id,organization_id,conversation_id,body,direction,sent_at from public.conversation_messages
      union all select id,organization_id,conversation_id,body,direction,sent_at from public.personal_whatsapp_messages
        where deleted_at is null and app_private.personal_whatsapp_conversation_access(organization_id,conversation_id)) message_row');
  execute definition;
end $$;

alter function public.get_inbox_message_page(uuid,timestamptz,uuid,integer) rename to get_official_inbox_message_page;
revoke all on function public.get_official_inbox_message_page(uuid,timestamptz,uuid,integer) from public,anon,authenticated;
create function public.get_inbox_message_page(target_conversation_id uuid,target_before_at timestamptz default null,target_before_id uuid default null,target_page_size integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid; result jsonb;
begin
  select organization_id into org from public.personal_whatsapp_conversations where id=target_conversation_id;
  if org is null then return public.get_official_inbox_message_page(target_conversation_id,target_before_at,target_before_id,target_page_size); end if;
  if not app_private.personal_whatsapp_conversation_access(org,target_conversation_id) then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if target_page_size not in (25,50,100) or (target_before_at is null)<>(target_before_id is null) then raise exception 'INVALID_INBOX_MESSAGE_PAGE'; end if;
  with rows as materialized (
    select * from public.personal_whatsapp_messages where conversation_id=target_conversation_id and deleted_at is null
      and (target_before_at is null or (sent_at,id)<(target_before_at,target_before_id)) order by sent_at desc,id desc limit target_page_size+1
  ), visible as materialized (select * from rows order by sent_at desc,id desc limit target_page_size)
  select jsonb_build_object('records',coalesce((select jsonb_agg(jsonb_build_object('id',id,'direction',direction,'body',body,'delivery_status',delivery_status,'sent_at',sent_at,
    'metadata',jsonb_build_object('message_type',message_type,'origin',origin)) order by sent_at,id) from visible),'[]'),
    'has_more',(select count(*)>target_page_size from rows),'next_before_at',(select sent_at from visible order by sent_at,id limit 1),
    'next_before_id',(select id from visible order by sent_at,id limit 1)) into result;
  return result;
end;
$$;

-- Minimal invalidations carry no message body or QR and reuse communications scope.
insert into app_private.retention_table_allowlist(table_name,disposition,delete_order) values
  ('personal_whatsapp_messages','DELETE',101),
  ('personal_whatsapp_conversations','DELETE',102),
  ('personal_whatsapp_keys','DELETE',103),
  ('personal_whatsapp_qr_attempts','DELETE',104),
  ('personal_whatsapp_sessions','DELETE',105);

create trigger personal_whatsapp_message_invalidation after insert or update on public.personal_whatsapp_messages
  for each row execute function app_private.broadcast_tenant_invalidation('communications');

do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app_private') and (p.proname like 'personal_whatsapp_%' or p.proname='get_personal_whatsapp_status') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
grant execute on function app_private.personal_whatsapp_owner(uuid,uuid),app_private.personal_whatsapp_conversation_access(uuid,uuid) to authenticated;
grant execute on function public.personal_whatsapp_disconnect(uuid),public.personal_whatsapp_send_prepare(uuid,uuid,text),public.get_personal_whatsapp_status(uuid),public.get_inbox_message_page(uuid,timestamptz,uuid,integer) to authenticated;
grant execute on function public.personal_whatsapp_resolve_unknown(uuid) to authenticated;
revoke all on function public.get_inbox_message_page(uuid,timestamptz,uuid,integer) from public,anon;

commit;
