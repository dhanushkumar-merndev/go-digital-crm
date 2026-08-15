begin;

-- OAuth state is a short-lived, one-time server-side record. It must never be
-- readable through the browser because it contains the encrypted PKCE verifier.
create table public.integration_oauth_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connected_account_id uuid not null references public.connected_accounts(id),
  requested_by uuid not null references public.profiles(id),
  provider_key text not null,
  state_hash text not null unique,
  code_verifier_encrypted bytea,
  redirect_path text not null default '/client-admin/settings/integrations'
    check (redirect_path ~ '^/[a-zA-Z0-9/_-]*$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint integration_oauth_state_expiry check (expires_at <= created_at + interval '15 minutes')
);

alter table public.integration_oauth_states enable row level security;
alter table public.integration_oauth_states force row level security;
revoke all on public.integration_oauth_states from public, anon, authenticated;

alter table public.integration_oauth_states
  add constraint integration_oauth_states_account_org_fk
  foreign key (organization_id, connected_account_id)
  references public.connected_accounts (organization_id, id) not valid;

create or replace function app_private.validate_integration_oauth_state_actor()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.connected_account_id is distinct from old.connected_account_id
    or new.requested_by is distinct from old.requested_by
    or new.provider_key is distinct from old.provider_key
    or new.state_hash is distinct from old.state_hash
    or new.code_verifier_encrypted is distinct from old.code_verifier_encrypted
    or new.redirect_path is distinct from old.redirect_path
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at
  ) then
    raise exception using errcode = '42501', message = 'OAUTH_STATE_IDENTITY_IMMUTABLE';
  end if;
  if tg_op = 'INSERT' and not app_private.actor_has_tenant_operation_context(
    new.requested_by,
    new.organization_id,
    'integration.manage'
  ) then
    raise exception using errcode = '42501', message = 'INVALID_OAUTH_REQUEST_ACTOR';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_integration_oauth_state_actor on public.integration_oauth_states;
create trigger enforce_integration_oauth_state_actor
before insert or update on public.integration_oauth_states
for each row execute function app_private.validate_integration_oauth_state_actor();

alter table public.connected_accounts
  add column auth_type text not null default 'OAUTH2'
    check (auth_type in ('OAUTH2', 'API_KEY', 'WEBHOOK_SECRET', 'BASIC_AUTH')),
  add column connection_config jsonb not null default '{}'::jsonb,
  add column connected_at timestamptz,
  add column token_expires_at timestamptz,
  add column last_error_code text,
  add column default_team_id uuid references public.teams(id),
  add column lead_sla_minutes integer not null default 1440
    check (lead_sla_minutes between 5 and 43200),
  add constraint connected_accounts_config_has_no_secrets check (
    not (connection_config ?| array[
      'access_token', 'refresh_token', 'client_secret', 'app_secret',
      'api_key', 'password', 'webhook_verify_token'
    ])
  );

alter table public.integration_credentials
  add column cipher_version text not null default 'AES-256-GCM-v1',
  add column expires_at timestamptz,
  add column updated_at timestamptz not null default now();

alter table public.provider_events
  add column payload jsonb,
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column processing_started_at timestamptz,
  add column safe_error_code text,
  add column next_attempt_at timestamptz;

alter table public.integration_branch_mappings
  add column team_id uuid references public.teams(id),
  add column deleted_at timestamptz;

alter table public.connected_accounts
  add constraint connected_accounts_default_team_org_fk
  foreign key (organization_id, default_team_id)
  references public.teams (organization_id, id) not valid;
alter table public.integration_branch_mappings
  add constraint integration_branch_mappings_team_org_fk
  foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;

alter table public.team_members
  add column last_fresh_assigned_at timestamptz,
  add column last_qualified_assigned_at timestamptz;

-- An inbound business message can arrive before an authorized user has made the
-- customer link/create decision, so the conversation temporarily carries the
-- provider contact while customer_id remains nullable.
alter table public.conversations
  alter column customer_id drop not null,
  add column external_contact text,
  add column normalized_contact text,
  add column last_message_at timestamptz,
  add column service_window_expires_at timestamptz;

alter table public.conversation_messages
  add column application_message_id uuid,
  add column safe_error_code text,
  add column request_hash text,
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column last_attempt_at timestamptz;

alter table public.email_messages
  add column request_hash text,
  add column template_variables jsonb not null default '{}'::jsonb,
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column last_attempt_at timestamptz;

alter table public.domain_outbox
  add column locked_at timestamptz,
  add column locked_by text,
  add column next_attempt_at timestamptz not null default now(),
  add column last_error_code text,
  add column dead_lettered_at timestamptz;

-- Recreate the connection read predicate now that soft-deleted branch mappings
-- exist. A stale mapping must not preserve access after a connection is remapped.
create or replace function app_private.can_access_connection(
  target_organization_id uuid,
  target_connection_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.connected_accounts connection_row
    where connection_row.id = target_connection_id
      and connection_row.organization_id = target_organization_id
      and connection_row.deleted_at is null
      and app_private.has_permission(target_organization_id, 'integration.view')
      and (
        app_private.has_organization_wide_scope(target_organization_id)
        or exists (
          select 1
          from public.integration_branch_mappings mapping_row
          where mapping_row.organization_id = target_organization_id
            and mapping_row.connected_account_id = connection_row.id
            and mapping_row.deleted_at is null
            and app_private.can_access_branch(target_organization_id, mapping_row.branch_id)
        )
        or (
          connection_row.scope_mode = 'ALL_BRANCHES'
          and exists (
            select 1
            from public.branches branch_row
            where branch_row.organization_id = target_organization_id
              and branch_row.active
              and branch_row.deleted_at is null
              and app_private.can_access_branch(target_organization_id, branch_row.id)
          )
        )
      )
  );
$$;

alter table public.conversations
  add constraint conversations_external_thread_unique
  unique (organization_id, connection_id, external_thread_id);
create unique index conversation_messages_application_id_idx
  on public.conversation_messages (organization_id, application_message_id)
  where application_message_id is not null;
create index conversations_recent_idx
  on public.conversations (organization_id, branch_id, last_message_at desc, id);
create index domain_outbox_ready_idx
  on public.domain_outbox (next_attempt_at, created_at, id)
  where published_at is null and dead_lettered_at is null;

create unique index connected_accounts_external_identity_idx
  on public.connected_accounts (organization_id, provider_key, external_account_id)
  where external_account_id is not null and deleted_at is null;
create index integration_oauth_states_expiry_idx
  on public.integration_oauth_states (expires_at)
  where used_at is null;
create index provider_events_retry_idx
  on public.provider_events (next_attempt_at, received_at, id)
  where status in ('RECEIVED', 'RETRY');

-- Provider payloads are deliberately read-only to ordinary authenticated
-- clients. Ingestion and processing use the service role inside Edge/worker
-- boundaries; UI visibility still requires the integration read permission.
drop policy if exists tenant_record_scope on public.provider_events;
create policy provider_events_read on public.provider_events
  for select to authenticated
  using (
    app_private.can_access_connection(organization_id, connected_account_id)
  );
revoke insert, update, delete, truncate on public.provider_events from authenticated;

drop policy if exists tenant_record_scope on public.integration_branch_mappings;
create policy integration_branch_mappings_read on public.integration_branch_mappings
  for select to authenticated
  using (
    deleted_at is null
    and app_private.can_access_connection(organization_id, connected_account_id)
  );

-- Provider ingestion is one atomic database operation: connection/tenant scope,
-- branch/team consistency, idempotency, round-robin selection, assignment
-- history and audit are committed together. Manual-assignment teams intentionally
-- leave the lead unassigned in the fresh queue.
create or replace function public.ingest_provider_lead(
  target_organization_id uuid,
  target_connection_id uuid,
  target_branch_id uuid,
  target_team_id uuid,
  target_external_lead_id text,
  target_source text,
  target_source_detail text,
  target_campaign text,
  target_customer_name text,
  target_phone text,
  target_normalized_phone text,
  target_email text,
  target_interested_model text,
  target_raw_payload jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_row public.connected_accounts%rowtype;
  team_row public.teams%rowtype;
  resolved_team_id uuid;
  selected_user_id uuid;
  existing_lead_id uuid;
  existing_assigned_user_id uuid;
  created_lead_id uuid;
  normalized_customer_name text;
  normalized_external_lead_id text;
  normalized_phone_value text;
  normalized_email_value text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  normalized_external_lead_id := btrim(coalesce(target_external_lead_id, ''));
  if normalized_external_lead_id = '' then
    raise exception using errcode = '23514', message = 'EXTERNAL_LEAD_ID_REQUIRED';
  end if;
  if char_length(normalized_external_lead_id) > 255 then
    raise exception using errcode = '23514', message = 'EXTERNAL_LEAD_ID_TOO_LONG';
  end if;
  if target_source not in ('Facebook','Instagram','Google Ads','Website','WhatsApp Business','CarWale','CarDekho','Justdial','IndiaMART','Other') then
    raise exception using errcode = '23514', message = 'INVALID_PROVIDER_SOURCE';
  end if;

  select * into connection_row
  from public.connected_accounts
  where id = target_connection_id
    and organization_id = target_organization_id
    and deleted_at is null
    and status = 'CONNECTED';
  if not found then
    raise exception using errcode = '23503', message = 'ACTIVE_CONNECTION_NOT_FOUND';
  end if;
  if connection_row.scope_mode <> 'ALL_BRANCHES'
    and not exists (
      select 1
      from public.integration_branch_mappings scope_mapping
      where scope_mapping.organization_id = target_organization_id
        and scope_mapping.connected_account_id = target_connection_id
        and scope_mapping.branch_id = target_branch_id
        and scope_mapping.external_resource_type = 'CONNECTION_SCOPE'
        and scope_mapping.deleted_at is null
    )
  then
    raise exception using errcode = '42501', message = 'CONNECTION_BRANCH_NOT_MAPPED';
  end if;
  if not exists (
    select 1 from public.branches
    where id = target_branch_id and organization_id = target_organization_id and active
  ) then
    raise exception using errcode = '23503', message = 'ACTIVE_BRANCH_NOT_FOUND';
  end if;

  normalized_customer_name := btrim(coalesce(target_customer_name, ''));
  normalized_phone_value := regexp_replace(coalesce(target_phone, ''), '[^0-9]', '', 'g');
  normalized_email_value := nullif(lower(btrim(coalesce(target_email, ''))), '');
  if char_length(normalized_customer_name) not between 2 and 200
    or char_length(normalized_phone_value) not between 7 and 15
    or char_length(coalesce(target_phone, '')) > 30
    or coalesce(target_phone, '') !~ '^[0-9+()., -]+$'
    or char_length(coalesce(target_source_detail, '')) > 255
    or char_length(coalesce(target_campaign, '')) > 255
    or char_length(coalesce(target_interested_model, '')) > 255
    or (
      normalized_email_value is not null
      and (
        char_length(normalized_email_value) > 254
        or normalized_email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    )
  then
    raise exception using errcode = '23514', message = 'INVALID_PROVIDER_LEAD_IDENTITY';
  end if;

  select id, assigned_user_id into existing_lead_id, existing_assigned_user_id
  from public.leads
  where organization_id = target_organization_id
    and connection_id = target_connection_id
    and external_lead_id = normalized_external_lead_id
  limit 1;
  if existing_lead_id is not null then
    return jsonb_build_object(
      'lead_id', existing_lead_id,
      'duplicate', true,
      'assigned_user_id', existing_assigned_user_id
    );
  end if;

  resolved_team_id := coalesce(target_team_id, connection_row.default_team_id);
  if resolved_team_id is not null then
    select * into team_row
    from public.teams
    where id = resolved_team_id
      and organization_id = target_organization_id
      and branch_id = target_branch_id
      and active
    for update;
    if not found then
      raise exception using errcode = '23503', message = 'ACTIVE_TEAM_NOT_FOUND';
    end if;

    if team_row.fresh_assignment_mode = 'ROUND_ROBIN' then
      select tm.user_id into selected_user_id
      from public.team_members tm
      join public.profiles p on p.id = tm.user_id
      where tm.organization_id = target_organization_id
        and tm.team_id = resolved_team_id
        and tm.active
        and tm.eligible_for_fresh_leads
        and p.active
        and p.deleted_at is null
      order by tm.last_fresh_assigned_at asc nulls first, tm.joined_at asc, tm.user_id
      for update of tm
      limit 1;
    end if;
  end if;

  begin
    insert into public.leads (
      organization_id, branch_id, team_id, source, source_detail, campaign,
      connection_id, external_lead_id, raw_payload, customer_name, phone,
      normalized_phone, email, interested_model, assigned_user_id, sla_due_at
    ) values (
      target_organization_id, target_branch_id, resolved_team_id, target_source,
      target_source_detail, target_campaign, target_connection_id,
      normalized_external_lead_id, target_raw_payload, normalized_customer_name,
      target_phone, normalized_phone_value, normalized_email_value,
      nullif(trim(target_interested_model), ''), selected_user_id,
      now() + make_interval(mins => connection_row.lead_sla_minutes)
    ) returning id into created_lead_id;
  exception when unique_violation then
    select id, assigned_user_id into existing_lead_id, existing_assigned_user_id
    from public.leads
    where organization_id = target_organization_id
      and connection_id = target_connection_id
      and external_lead_id = normalized_external_lead_id;
    return jsonb_build_object(
      'lead_id', existing_lead_id,
      'duplicate', true,
      'assigned_user_id', existing_assigned_user_id
    );
  end;

  if selected_user_id is not null then
    update public.team_members
    set last_fresh_assigned_at = now()
    where team_id = resolved_team_id and user_id = selected_user_id;
    insert into public.lead_assignments (
      organization_id, lead_id, branch_id, team_id, assigned_user_id,
      assignment_type, method, reason
    ) values (
      target_organization_id, created_lead_id, target_branch_id, resolved_team_id,
      selected_user_id, 'FRESH', 'ROUND_ROBIN', 'Provider lead ingestion'
    );
    insert into public.lead_assignment_history (
      organization_id, lead_id, branch_id, team_id, previous_owner_id,
      new_owner_id, method, reason
    ) values (
      target_organization_id, created_lead_id, target_branch_id, resolved_team_id,
      null, selected_user_id, 'ROUND_ROBIN', 'Provider lead ingestion'
    );
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id,
    request_id, metadata
  ) values (
    target_organization_id, null, 'lead.provider_ingested', 'lead',
    created_lead_id::text, target_branch_id, target_request_id,
    jsonb_build_object(
      'connection_id', target_connection_id,
      'external_lead_id', normalized_external_lead_id,
      'assignment_mode', case when selected_user_id is null then 'MANUAL_QUEUE' else 'ROUND_ROBIN' end
    )
  );

  return jsonb_build_object(
    'lead_id', created_lead_id,
    'duplicate', false,
    'assigned_user_id', selected_user_id
  );
end;
$$;
revoke all on function public.ingest_provider_lead(uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.ingest_provider_lead(uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, jsonb, uuid) to service_role;

create or replace function public.claim_domain_outbox(
  target_worker_id text,
  target_batch_size integer default 50
)
returns setof public.domain_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(trim(target_worker_id), '') is null or target_batch_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_CLAIM';
  end if;
  return query
  with candidates as (
    select outbox_row.id
    from public.domain_outbox outbox_row
    where outbox_row.published_at is null
      and outbox_row.dead_lettered_at is null
      and outbox_row.next_attempt_at <= now()
      and (
        outbox_row.locked_at is null
        or outbox_row.locked_at < now() - interval '5 minutes'
      )
    order by outbox_row.created_at, outbox_row.id
    for update skip locked
    limit target_batch_size
  )
  update public.domain_outbox outbox_row
  set locked_at = now(),
      locked_by = target_worker_id,
      attempts = outbox_row.attempts + 1
  from candidates
  where outbox_row.id = candidates.id
  returning outbox_row.*;
end;
$$;

create or replace function public.complete_domain_outbox(
  target_event_id uuid,
  target_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.domain_outbox
  set published_at = now(), locked_at = null, locked_by = null, last_error_code = null
  where id = target_event_id and locked_by = target_worker_id and published_at is null;
  return found;
end;
$$;

create or replace function public.retry_domain_outbox(
  target_event_id uuid,
  target_worker_id text,
  target_safe_error_code text,
  target_delay_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare current_attempts integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_delay_seconds not between 5 and 86400 then
    raise exception using errcode = '22023', message = 'INVALID_RETRY_DELAY';
  end if;
  select attempts into current_attempts
  from public.domain_outbox
  where id = target_event_id and locked_by = target_worker_id and published_at is null
  for update;
  if not found then return false; end if;
  update public.domain_outbox
  set locked_at = null,
      locked_by = null,
      last_error_code = left(coalesce(target_safe_error_code, 'OUTBOX_RETRY'), 120),
      next_attempt_at = now() + make_interval(secs => target_delay_seconds),
      dead_lettered_at = case when current_attempts >= 8 then now() else null end
  where id = target_event_id;
  return true;
end;
$$;

revoke all on function public.claim_domain_outbox(text, integer) from public, anon, authenticated;
revoke all on function public.complete_domain_outbox(uuid, text) from public, anon, authenticated;
revoke all on function public.retry_domain_outbox(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_domain_outbox(text, integer) to service_role;
grant execute on function public.complete_domain_outbox(uuid, text) to service_role;
grant execute on function public.retry_domain_outbox(uuid, text, text, integer) to service_role;

revoke all on function app_private.validate_integration_oauth_state_actor()
from public, anon, authenticated;

commit;
