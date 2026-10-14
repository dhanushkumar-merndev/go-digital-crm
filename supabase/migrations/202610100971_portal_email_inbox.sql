begin;

-- Justdial, CarWale, CarDekho and IndiaMART leads read from the dealership's
-- own mailbox. A portal connection with connection_config.ingest_mode =
-- 'EMAIL_INBOX' is polled every 10, 20 or 30 minutes by the Trigger.dev
-- portal-inbox-sync task; legacy webhook connections of the same providers are
-- untouched and keep receiving pushes.

create table public.portal_inbox_sync_state (
  connection_id uuid primary key references public.connected_accounts(id),
  organization_id uuid not null references public.organizations(id),
  poll_interval_minutes integer not null check (poll_interval_minutes in (10, 20, 30)),
  next_poll_at timestamptz not null default now(),
  last_claimed_at timestamptz,
  last_polled_at timestamptz,
  last_success_at timestamptz,
  last_manual_request_at timestamptz,
  -- IMAP UIDs are only comparable while UIDVALIDITY is unchanged; bigint
  -- because UIDVALIDITY is an unsigned 32-bit value.
  uid_validity bigint,
  last_uid bigint,
  last_error_code text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  messages_seen bigint not null default 0 check (messages_seen >= 0),
  leads_created bigint not null default 0 check (leads_created >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_inbox_sync_state_connection_org_fk
    foreign key (organization_id, connection_id)
    references public.connected_accounts (organization_id, id)
);
create index portal_inbox_sync_state_due_idx on public.portal_inbox_sync_state (next_poll_at);

-- One row per portal email seen. The body is never stored, only what the
-- keyword rules extracted from it, so a bad rule can be diagnosed without
-- keeping the customer's full email.
create table public.portal_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.connected_accounts(id),
  message_id text not null check (char_length(message_id) between 1 and 512),
  received_at timestamptz,
  from_address text,
  subject text,
  status text not null check (status in ('INGESTED', 'DUPLICATE', 'PARSE_FAILED', 'FAILED')),
  lead_id uuid references public.leads(id),
  failure_code text,
  extracted jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (connection_id, message_id),
  constraint portal_inbox_messages_connection_org_fk
    foreign key (organization_id, connection_id)
    references public.connected_accounts (organization_id, id)
);
create index portal_inbox_messages_connection_created_idx
  on public.portal_inbox_messages (organization_id, connection_id, created_at desc, id desc);

alter table public.portal_inbox_sync_state enable row level security;
alter table public.portal_inbox_sync_state force row level security;
alter table public.portal_inbox_messages enable row level security;
alter table public.portal_inbox_messages force row level security;
revoke all on public.portal_inbox_sync_state from public, anon, authenticated;
revoke all on public.portal_inbox_messages from public, anon, authenticated;
grant select on public.portal_inbox_sync_state to authenticated;
grant select on public.portal_inbox_messages to authenticated;

create policy portal_inbox_sync_state_read on public.portal_inbox_sync_state
  for select to authenticated
  using (app_private.can_access_connection(organization_id, connection_id));
create policy portal_inbox_messages_read on public.portal_inbox_messages
  for select to authenticated
  using (app_private.can_access_connection(organization_id, connection_id));

-- Save an email-inbox portal connection, its encrypted mailbox credential,
-- branch scope, poll schedule and audit row in one transaction. The Edge
-- Function has already checked the caller's integration scope (and, for a
-- shared inbox, their authority over the source connection).
create or replace function public.save_portal_inbox_connection(
  target_organization_id uuid,
  target_actor_id uuid,
  target_connection_id uuid,
  target_provider_key text,
  target_display_name text,
  target_scope_mode text,
  target_branch_ids uuid[],
  target_default_team_id uuid,
  target_mailbox_address text,
  target_encrypted_payload bytea,
  target_mailbox_source_connection_id uuid,
  target_poll_interval_minutes integer,
  target_connection_config jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved_connection_id uuid := coalesce(target_connection_id, gen_random_uuid());
  mailbox text := lower(btrim(coalesce(target_mailbox_address, '')));
  previous_row public.connected_accounts%rowtype;
  mailbox_changed boolean := true;
  config jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (select 1 from public.profiles where id = target_actor_id
    and organization_id = target_organization_id and active and deleted_at is null) then
    raise exception using errcode = '42501', message = 'INTEGRATION_ACTOR_DENIED';
  end if;
  if target_request_id is null
    or target_provider_key is null
    or target_provider_key not in ('justdial', 'carwale', 'cardekho', 'indiamart')
    or char_length(btrim(coalesce(target_display_name, ''))) not between 2 and 120
    or target_poll_interval_minutes is null or target_poll_interval_minutes not in (10, 20, 30)
    or mailbox !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(mailbox) > 254
    or jsonb_typeof(coalesce(target_connection_config, 'null'::jsonb)) <> 'object'
    or target_scope_mode is null or target_scope_mode not in ('ONE_BRANCH','SELECTED_BRANCHES','ALL_BRANCHES')
    or target_branch_ids is null
    or (target_scope_mode = 'ONE_BRANCH' and cardinality(target_branch_ids) <> 1)
    or (target_scope_mode = 'SELECTED_BRANCHES' and cardinality(target_branch_ids) not between 1 and 100)
    or (target_scope_mode = 'ALL_BRANCHES' and cardinality(target_branch_ids) <> 0)
    or cardinality(target_branch_ids) <> (select count(distinct branch_id) from unnest(target_branch_ids) branch_id)
    or exists (select 1 from unnest(target_branch_ids) branch_id where not exists (
      select 1 from public.branches where id = branch_id and organization_id = target_organization_id
        and active and deleted_at is null
    ))
    -- The team decides the branch a lead lands in, so it must sit inside the scope.
    or (target_default_team_id is not null and not exists (
      select 1 from public.teams where id = target_default_team_id
        and organization_id = target_organization_id
        and (target_scope_mode = 'ALL_BRANCHES' or branch_id = any(target_branch_ids))
    ))
    or (target_mailbox_source_connection_id is not null and target_encrypted_payload is not null)
    or target_mailbox_source_connection_id = saved_connection_id then
    raise exception using errcode = '22023', message = 'INVALID_PORTAL_INBOX_CONNECTION';
  end if;

  if target_connection_id is not null then
    select * into previous_row from public.connected_accounts
    where id = saved_connection_id and organization_id = target_organization_id
      and provider_key = target_provider_key and deleted_at is null
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'PORTAL_INBOX_CONNECTION_NOT_FOUND';
    end if;
    mailbox_changed := previous_row.external_account_id is distinct from mailbox
      or previous_row.connection_config->>'mailbox_source_connection_id'
        is distinct from target_mailbox_source_connection_id::text;
  end if;

  if target_mailbox_source_connection_id is not null then
    -- A shared inbox reads the source's credential, so the source must hold
    -- its own mailbox (no chains) and stay inside the same tenant.
    perform 1 from public.connected_accounts source_row
    where source_row.id = target_mailbox_source_connection_id
      and source_row.organization_id = target_organization_id
      and source_row.provider_key in ('justdial', 'carwale', 'cardekho', 'indiamart')
      and source_row.deleted_at is null
      and source_row.connection_config->>'ingest_mode' = 'EMAIL_INBOX'
      and source_row.connection_config->>'mailbox_source_connection_id' is null
      and lower(source_row.external_account_id) = mailbox;
    if not found then
      raise exception using errcode = '22023', message = 'PORTAL_INBOX_SOURCE_INVALID';
    end if;
    if exists (select 1 from public.connected_accounts dependent
      where dependent.organization_id = target_organization_id
        and dependent.deleted_at is null
        and dependent.connection_config->>'mailbox_source_connection_id' = saved_connection_id::text) then
      raise exception using errcode = '22023', message = 'PORTAL_INBOX_SOURCE_IN_USE';
    end if;
  elsif target_encrypted_payload is null then
    -- Leaving the password blank keeps the stored one, which only exists if
    -- this connection already owned a mailbox credential for this address.
    if target_connection_id is null
      or previous_row.connection_config->>'ingest_mode' is distinct from 'EMAIL_INBOX'
      or previous_row.connection_config->>'mailbox_source_connection_id' is not null
      or previous_row.external_account_id is distinct from mailbox
      or not exists (select 1 from public.integration_credentials
        where connected_account_id = saved_connection_id and organization_id = target_organization_id) then
      raise exception using errcode = '22023', message = 'PORTAL_INBOX_PASSWORD_REQUIRED';
    end if;
  end if;

  config := target_connection_config || jsonb_build_object(
    'ingest_mode', 'EMAIL_INBOX',
    'lead_source', case target_provider_key
      when 'justdial' then 'Justdial' when 'carwale' then 'CarWale'
      when 'cardekho' then 'CarDekho' else 'IndiaMART' end,
    'poll_interval_minutes', target_poll_interval_minutes,
    'mailbox_source_connection_id', target_mailbox_source_connection_id
  );

  if target_connection_id is not null then
    update public.connected_accounts set
      display_name = btrim(target_display_name),
      scope_mode = target_scope_mode::public.branch_scope_mode,
      status = 'AUTHORIZING',
      auth_type = 'BASIC_AUTH',
      external_account_id = mailbox,
      connection_config = config,
      default_team_id = target_default_team_id,
      last_error_code = null
    where id = saved_connection_id and organization_id = target_organization_id;
  else
    insert into public.connected_accounts(id, organization_id, provider_key, display_name,
      scope_mode, status, auth_type, external_account_id, connection_config,
      default_team_id, created_by)
    values (saved_connection_id, target_organization_id, target_provider_key, btrim(target_display_name),
      target_scope_mode::public.branch_scope_mode, 'AUTHORIZING', 'BASIC_AUTH', mailbox, config,
      target_default_team_id, target_actor_id);
  end if;

  if target_encrypted_payload is not null then
    insert into public.integration_credentials(organization_id, connected_account_id,
      encrypted_payload, key_version, cipher_version, replaced_by)
    values (target_organization_id, saved_connection_id, target_encrypted_payload, 1,
      'AES-256-GCM-v1', target_actor_id)
    on conflict (connected_account_id) do update set
      encrypted_payload = excluded.encrypted_payload, key_version = excluded.key_version,
      cipher_version = excluded.cipher_version, replaced_by = excluded.replaced_by,
      updated_at = now();
  end if;

  update public.integration_branch_mappings set deleted_at = now()
  where connected_account_id = saved_connection_id and deleted_at is null;
  insert into public.integration_branch_mappings(organization_id, connected_account_id,
    branch_id, external_resource_type, external_resource_id)
  select target_organization_id, saved_connection_id, branch_id, 'CONNECTION_SCOPE', saved_connection_id::text
  from unnest(target_branch_ids) branch_id
  on conflict (connected_account_id, branch_id, external_resource_type, external_resource_id)
  do update set deleted_at = null;

  insert into public.portal_inbox_sync_state(connection_id, organization_id,
    poll_interval_minutes, next_poll_at)
  values (saved_connection_id, target_organization_id, target_poll_interval_minutes, now())
  on conflict (connection_id) do update set
    poll_interval_minutes = excluded.poll_interval_minutes,
    next_poll_at = now(),
    -- A different mailbox has unrelated UIDs; start its cursor afresh.
    uid_validity = case when mailbox_changed then null else public.portal_inbox_sync_state.uid_validity end,
    last_uid = case when mailbox_changed then null else public.portal_inbox_sync_state.last_uid end,
    last_error_code = null,
    consecutive_failures = 0,
    updated_at = now();

  insert into public.audit_logs(organization_id, actor_id, action, resource_type, resource_id,
    request_id, metadata)
  values (target_organization_id, target_actor_id,
    case when target_connection_id is null then 'integration.connected' else 'integration.reconnected' end,
    'connected_account', saved_connection_id::text, target_request_id,
    jsonb_build_object(
      'provider_key', target_provider_key,
      'ingest_mode', 'EMAIL_INBOX',
      'scope_mode', target_scope_mode,
      'poll_interval_minutes', target_poll_interval_minutes,
      'shared_mailbox', target_mailbox_source_connection_id is not null,
      'credential_replaced', target_encrypted_payload is not null,
      'converted_from_webhook', target_connection_id is not null
        and previous_row.connection_config->>'ingest_mode' is distinct from 'EMAIL_INBOX'
    ));

  return jsonb_build_object('connection_id', saved_connection_id, 'provider_key', target_provider_key,
    'status', 'AUTHORIZING');
end;
$function$;
revoke all on function public.save_portal_inbox_connection(uuid,uuid,uuid,text,text,text,uuid[],uuid,text,bytea,uuid,integer,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function public.save_portal_inbox_connection(uuid,uuid,uuid,text,text,text,uuid[],uuid,text,bytea,uuid,integer,jsonb,uuid)
  to service_role;

-- Called once a minute by the Trigger.dev minute-dispatch pass. Claiming moves
-- next_poll_at forward by the connection's own interval, which is what makes
-- the 10 / 20 / 30 minute cadence independent of the one-minute cron.
create or replace function public.claim_due_portal_inboxes(target_limit integer default 20)
returns table (connection_id uuid, organization_id uuid, claimed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return query
  with due as (
    select state.connection_id
    from public.portal_inbox_sync_state state
    join public.connected_accounts connection_row
      on connection_row.id = state.connection_id
      and connection_row.organization_id = state.organization_id
    join public.organizations organization_row on organization_row.id = state.organization_id
    where state.next_poll_at <= now()
      and connection_row.deleted_at is null
      and connection_row.status = 'CONNECTED'
      and connection_row.connection_config->>'ingest_mode' = 'EMAIL_INBOX'
      and organization_row.status in ('ACTIVE', 'SUPPORT_MAINTENANCE')
    order by state.next_poll_at, state.connection_id
    limit least(greatest(coalesce(target_limit, 20), 1), 50)
    for update of state skip locked
  )
  update public.portal_inbox_sync_state state set
    next_poll_at = now() + make_interval(mins => state.poll_interval_minutes),
    last_claimed_at = now(),
    updated_at = now()
  from due
  where state.connection_id = due.connection_id
  returning state.connection_id, state.organization_id, state.last_claimed_at;
end;
$function$;
revoke all on function public.claim_due_portal_inboxes(integer) from public, anon, authenticated;
grant execute on function public.claim_due_portal_inboxes(integer) to service_role;

-- "Sync now": the next minute pass picks the connection up. Throttled to one
-- request per 20 seconds per connection, i.e. the 3-per-minute refresh rule.
create or replace function public.request_portal_inbox_sync(
  target_organization_id uuid,
  target_connection_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  state_row public.portal_inbox_sync_state%rowtype;
begin
  if actor_id is null or not public.authorize_integration_connection_action(
    target_organization_id, target_connection_id, 'integration.manage'
  ) then
    raise exception using errcode = '42501', message = 'PORTAL_INBOX_SYNC_DENIED';
  end if;
  select * into state_row from public.portal_inbox_sync_state
  where connection_id = target_connection_id and organization_id = target_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PORTAL_INBOX_NOT_CONFIGURED';
  end if;
  if state_row.last_manual_request_at > now() - interval '20 seconds' then
    raise exception using errcode = 'P0001', message = 'PORTAL_INBOX_SYNC_RATE_LIMITED';
  end if;
  update public.portal_inbox_sync_state set
    next_poll_at = least(next_poll_at, now()),
    last_manual_request_at = now(),
    updated_at = now()
  where connection_id = target_connection_id;
  insert into public.audit_logs(organization_id, actor_id, action, resource_type, resource_id, metadata)
  values (target_organization_id, actor_id, 'integration.sync_requested', 'connected_account',
    target_connection_id::text, jsonb_build_object('ingest_mode', 'EMAIL_INBOX'));
  return jsonb_build_object('connection_id', target_connection_id, 'requested_at', now());
end;
$function$;
revoke all on function public.request_portal_inbox_sync(uuid, uuid) from public, anon;
grant execute on function public.request_portal_inbox_sync(uuid, uuid) to authenticated;

commit;
