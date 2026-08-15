begin;

-- Provider webhooks durably store a sanitized receipt before any external fetch or
-- CRM mutation. Trigger.dev workers claim these receipts with a lease so provider
-- redelivery is not required for retry and a crashed worker can be recovered.
alter table public.provider_events
  add column processing_worker_id text;

alter table public.provider_events
  add constraint provider_events_status_check
  check (status in (
    'RECEIVED', 'PROCESSING', 'RETRY', 'PROCESSED', 'UNMAPPED', 'FAILED',
    'TEST_VALIDATED', 'PENDING_RECONCILIATION'
  )) not valid;

-- Delivery callbacks can arrive out of order. Keep the provider timestamp so a
-- delayed SENT callback cannot regress a message that is already DELIVERED/READ.
alter table public.conversation_messages
  add column provider_status_at timestamptz;

-- Meta and WhatsApp deliver to one application-level callback. Their globally
-- unique Page/phone identifiers therefore need one unambiguous active tenant
-- route; the callback must never trust a tenant ID supplied in its URL.
create unique index integration_provider_asset_route_unique_idx
  on public.integration_branch_mappings (
    external_resource_type,
    external_resource_id
  )
  where deleted_at is null
    and external_resource_type in ('META_PAGE', 'WHATSAPP_PHONE_NUMBER');

drop index if exists public.provider_events_retry_idx;
create index provider_events_dispatch_idx
  on public.provider_events (
    coalesce(next_attempt_at, processed_at, received_at),
    received_at,
    id
  )
  where status in ('RECEIVED', 'RETRY', 'PROCESSING', 'PENDING_RECONCILIATION');

create or replace function public.claim_provider_events(
  target_worker_id text,
  target_batch_size integer default 50
)
returns setof public.provider_events
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_worker_id), '') is null
    or char_length(target_worker_id) > 200
    or target_batch_size is null
    or target_batch_size not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'INVALID_PROVIDER_EVENT_CLAIM';
  end if;

  -- A final-attempt crash must not leave a PROCESSING row leased forever.
  update public.provider_events event_row
  set status = 'FAILED',
      safe_error_code = 'PROVIDER_EVENT_RETRY_EXHAUSTED',
      processed_at = now(),
      processing_started_at = null,
      processing_worker_id = null,
      next_attempt_at = null
  where event_row.attempt_count >= 8
    and (
      (
        event_row.status in ('RECEIVED', 'RETRY', 'PENDING_RECONCILIATION')
        and coalesce(event_row.next_attempt_at, event_row.received_at) <= now()
      )
      or (
        event_row.status = 'PROCESSING'
        and (
          event_row.processing_started_at is null
          or event_row.processing_started_at < now() - interval '5 minutes'
        )
      )
    );

  return query
  with candidates as (
    select event_row.id
    from public.provider_events event_row
    where event_row.attempt_count < 8
      and (
        (
          event_row.status in ('RECEIVED', 'RETRY')
          and coalesce(event_row.next_attempt_at, event_row.received_at) <= now()
        )
        or (
          event_row.status = 'PENDING_RECONCILIATION'
          and coalesce(event_row.next_attempt_at, event_row.processed_at, event_row.received_at)
            <= now() - interval '2 minutes'
        )
        or (
          event_row.status = 'PROCESSING'
          and (
            event_row.processing_started_at is null
            or event_row.processing_started_at < now() - interval '5 minutes'
          )
        )
      )
    order by coalesce(
      event_row.next_attempt_at,
      event_row.processed_at,
      event_row.received_at
    ), event_row.id
    for update skip locked
    limit target_batch_size
  )
  update public.provider_events event_row
  set status = 'PROCESSING',
      attempt_count = event_row.attempt_count + 1,
      processing_started_at = now(),
      processing_worker_id = target_worker_id,
      next_attempt_at = null,
      safe_error_code = null,
      processed_at = null
  from candidates
  where event_row.id = candidates.id
  returning event_row.*;
end;
$$;

create or replace function public.complete_provider_event(
  target_event_id uuid,
  target_worker_id text,
  target_status text,
  target_safe_error_code text default null,
  target_payload_patch jsonb default '{}'::jsonb
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
  if target_status is null
    or target_status not in (
    'PROCESSED', 'UNMAPPED', 'FAILED', 'TEST_VALIDATED', 'PENDING_RECONCILIATION'
  )
    or target_payload_patch is null
    or jsonb_typeof(target_payload_patch) <> 'object'
    or char_length(coalesce(target_safe_error_code, '')) > 120
  then
    raise exception using errcode = '22023', message = 'INVALID_PROVIDER_EVENT_COMPLETION';
  end if;

  update public.provider_events event_row
  set status = target_status,
      safe_error_code = nullif(btrim(target_safe_error_code), ''),
      payload = coalesce(event_row.payload, '{}'::jsonb) || target_payload_patch,
      processed_at = now(),
      processing_started_at = null,
      processing_worker_id = null,
      next_attempt_at = null
  where event_row.id = target_event_id
    and event_row.status = 'PROCESSING'
    and event_row.processing_worker_id = target_worker_id;
  return found;
end;
$$;

create or replace function public.retry_provider_event(
  target_event_id uuid,
  target_worker_id text,
  target_safe_error_code text,
  target_delay_seconds integer default 60,
  target_permanent boolean default false
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
  if nullif(btrim(target_safe_error_code), '') is null
    or char_length(target_safe_error_code) > 120
    or target_delay_seconds is null
    or target_delay_seconds not between 5 and 86400
    or target_permanent is null
  then
    raise exception using errcode = '22023', message = 'INVALID_PROVIDER_EVENT_RETRY';
  end if;

  select event_row.attempt_count into current_attempts
  from public.provider_events event_row
  where event_row.id = target_event_id
    and event_row.status = 'PROCESSING'
    and event_row.processing_worker_id = target_worker_id
  for update;
  if not found then return false; end if;

  update public.provider_events event_row
  set status = case when target_permanent or current_attempts >= 8 then 'FAILED' else 'RETRY' end,
      safe_error_code = left(target_safe_error_code, 120),
      processed_at = case when target_permanent or current_attempts >= 8 then now() else null end,
      processing_started_at = null,
      processing_worker_id = null,
      next_attempt_at = case
        when target_permanent or current_attempts >= 8 then null
        else now() + make_interval(secs => target_delay_seconds)
      end
  where event_row.id = target_event_id;
  return true;
end;
$$;

-- Persisting an inbound WhatsApp message is one idempotent database operation.
-- The RPC also rechecks the connection/asset mapping so a remap or disconnect
-- between claim and dispatch cannot write into an unauthorized branch.
create or replace function public.ingest_whatsapp_inbound_message(
  target_organization_id uuid,
  target_connection_id uuid,
  target_branch_id uuid,
  target_phone_number_id text,
  target_provider_message_id text,
  target_sender text,
  target_sender_name text,
  target_sent_at timestamptz,
  target_message_type text,
  target_body text,
  target_provider_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_conversation_id uuid;
  target_message_id uuid;
  inserted_message boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null
    or target_connection_id is null
    or target_branch_id is null
    or nullif(btrim(target_phone_number_id), '') is null
    or char_length(target_phone_number_id) > 255
    or target_phone_number_id !~ '^[A-Za-z0-9._:-]+$'
    or nullif(btrim(target_provider_message_id), '') is null
    or char_length(target_provider_message_id) > 512
    or target_sender is null
    or target_sender !~ '^[0-9]{7,20}$'
    or nullif(btrim(target_message_type), '') is null
    or char_length(target_message_type) > 64
    or char_length(coalesce(target_sender_name, '')) > 200
    or char_length(coalesce(target_body, '')) > 65535
    or target_sent_at is null
    or target_sent_at < timestamptz '2000-01-01 00:00:00+00'
    or target_sent_at > now() + interval '10 minutes'
    or target_provider_payload is null
    or jsonb_typeof(target_provider_payload) <> 'object'
    or pg_column_size(target_provider_payload) > 262144
  then
    raise exception using errcode = '22023', message = 'INVALID_WHATSAPP_INBOUND_MESSAGE';
  end if;
  if not exists (
    select 1
    from public.connected_accounts connection_row
    where connection_row.id = target_connection_id
      and connection_row.organization_id = target_organization_id
      and connection_row.provider_key = 'whatsapp_cloud'
      and connection_row.status = 'CONNECTED'
      and connection_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'ACTIVE_WHATSAPP_CONNECTION_NOT_FOUND';
  end if;
  if not exists (
    select 1
    from public.integration_branch_mappings mapping_row
    join public.branches branch_row
      on branch_row.organization_id = mapping_row.organization_id
     and branch_row.id = mapping_row.branch_id
    where mapping_row.organization_id = target_organization_id
      and mapping_row.connected_account_id = target_connection_id
      and mapping_row.branch_id = target_branch_id
      and mapping_row.external_resource_type = 'WHATSAPP_PHONE_NUMBER'
      and mapping_row.external_resource_id = target_phone_number_id
      and mapping_row.deleted_at is null
      and branch_row.active
      and branch_row.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'WHATSAPP_NUMBER_NOT_MAPPED';
  end if;

  insert into public.conversations as existing_conversation (
    organization_id, branch_id, channel, connection_id, external_thread_id,
    external_contact, normalized_contact, last_message_at,
    service_window_expires_at, status
  ) values (
    target_organization_id, target_branch_id, 'WHATSAPP_BUSINESS',
    target_connection_id, target_sender, target_sender, target_sender,
    target_sent_at, target_sent_at + interval '24 hours', 'OPEN'
  )
  on conflict (organization_id, connection_id, external_thread_id)
  do update set
    branch_id = excluded.branch_id,
    external_contact = excluded.external_contact,
    normalized_contact = excluded.normalized_contact,
    last_message_at = greatest(
      coalesce(existing_conversation.last_message_at, excluded.last_message_at),
      excluded.last_message_at
    ),
    service_window_expires_at = greatest(
      coalesce(
        existing_conversation.service_window_expires_at,
        excluded.service_window_expires_at
      ),
      excluded.service_window_expires_at
    ),
    status = case
      when excluded.last_message_at >= coalesce(
        existing_conversation.last_message_at,
        timestamptz '-infinity'
      ) then 'OPEN'
      else existing_conversation.status
    end
  returning id into target_conversation_id;

  insert into public.conversation_messages (
    organization_id, conversation_id, provider_message_id, direction, body,
    delivery_status, sent_at, metadata
  ) values (
    target_organization_id, target_conversation_id,
    btrim(target_provider_message_id), 'INBOUND', target_body, 'RECEIVED',
    target_sent_at,
    jsonb_strip_nulls(jsonb_build_object(
      'message_type', btrim(target_message_type),
      'sender_name', nullif(btrim(coalesce(target_sender_name, '')), ''),
      'provider_payload', target_provider_payload
    ))
  )
  on conflict (organization_id, conversation_id, provider_message_id)
    where provider_message_id is not null
  do nothing
  returning id into target_message_id;

  if target_message_id is not null then
    inserted_message := true;
  else
    select message_row.id into target_message_id
    from public.conversation_messages message_row
    where message_row.organization_id = target_organization_id
      and message_row.conversation_id = target_conversation_id
      and message_row.provider_message_id = btrim(target_provider_message_id)
      and message_row.direction = 'INBOUND';
  end if;

  return jsonb_build_object(
    'conversation_id', target_conversation_id,
    'message_id', target_message_id,
    'duplicate', not inserted_message
  );
end;
$$;

-- Apply only monotonic WhatsApp delivery states and scope the provider message
-- lookup through its connection. This makes redelivery and out-of-order status
-- callbacks safe.
create or replace function public.apply_whatsapp_message_status(
  target_organization_id uuid,
  target_connection_id uuid,
  target_provider_message_id text,
  target_application_message_id uuid,
  target_delivery_status text,
  target_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  matching_message_ids uuid[];
  target_message_id uuid;
  current_provider_message_id text;
  current_delivery_status text;
  current_status_at timestamptz;
  current_rank integer;
  target_rank integer;
  status_updated boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null
    or target_connection_id is null
    or nullif(btrim(target_provider_message_id), '') is null
    or char_length(target_provider_message_id) > 512
    or target_delivery_status is null
    or target_delivery_status not in ('SENT', 'DELIVERED', 'READ', 'FAILED')
    or target_occurred_at is null
    or target_occurred_at < timestamptz '2000-01-01 00:00:00+00'
    or target_occurred_at > now() + interval '10 minutes'
  then
    raise exception using errcode = '22023', message = 'INVALID_WHATSAPP_MESSAGE_STATUS';
  end if;
  if not exists (
    select 1
    from public.connected_accounts connection_row
    where connection_row.id = target_connection_id
      and connection_row.organization_id = target_organization_id
      and connection_row.provider_key = 'whatsapp_cloud'
      and connection_row.status = 'CONNECTED'
      and connection_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'ACTIVE_WHATSAPP_CONNECTION_NOT_FOUND';
  end if;

  select array_agg(message_row.id order by message_row.id)
  into matching_message_ids
  from public.conversation_messages message_row
  join public.conversations conversation_row
    on conversation_row.organization_id = message_row.organization_id
   and conversation_row.id = message_row.conversation_id
  where message_row.organization_id = target_organization_id
    and conversation_row.connection_id = target_connection_id
    and message_row.provider_message_id = btrim(target_provider_message_id)
    and message_row.direction = 'OUTBOUND';
  if coalesce(cardinality(matching_message_ids), 0) > 1 then
    raise exception using errcode = '23514', message = 'WHATSAPP_PROVIDER_MESSAGE_AMBIGUOUS';
  end if;
  target_message_id := matching_message_ids[1];

  if target_message_id is null and target_application_message_id is not null then
    select message_row.id into target_message_id
    from public.conversation_messages message_row
    join public.conversations conversation_row
      on conversation_row.organization_id = message_row.organization_id
     and conversation_row.id = message_row.conversation_id
    where message_row.organization_id = target_organization_id
      and conversation_row.connection_id = target_connection_id
      and message_row.application_message_id = target_application_message_id
      and message_row.direction = 'OUTBOUND';
  end if;
  if target_message_id is null then
    return jsonb_build_object('matched', false, 'updated', false);
  end if;

  select message_row.provider_message_id, message_row.delivery_status,
    message_row.provider_status_at
  into current_provider_message_id, current_delivery_status, current_status_at
  from public.conversation_messages message_row
  where message_row.id = target_message_id
    and message_row.organization_id = target_organization_id
  for update;
  if current_provider_message_id is not null
    and current_provider_message_id <> btrim(target_provider_message_id)
  then
    raise exception using errcode = '23514', message = 'WHATSAPP_PROVIDER_MESSAGE_CONFLICT';
  end if;

  current_rank := case upper(coalesce(current_delivery_status, ''))
    when 'READ' then 4
    when 'DELIVERED' then 3
    when 'SENT' then 2
    when 'FAILED' then 2
    else 1
  end;
  target_rank := case target_delivery_status
    when 'READ' then 4
    when 'DELIVERED' then 3
    else 2
  end;
  if target_rank >= current_rank
    and (current_status_at is null or target_occurred_at >= current_status_at)
  then
    update public.conversation_messages message_row
    set provider_message_id = coalesce(
          message_row.provider_message_id,
          btrim(target_provider_message_id)
        ),
        delivery_status = target_delivery_status,
        provider_status_at = target_occurred_at,
        safe_error_code = null
    where message_row.id = target_message_id;
    status_updated := true;
  end if;

  return jsonb_build_object(
    'matched', true,
    'updated', status_updated,
    'message_id', target_message_id
  );
end;
$$;

revoke all on function public.claim_provider_events(text, integer)
from public, anon, authenticated;
revoke all on function public.complete_provider_event(uuid, text, text, text, jsonb)
from public, anon, authenticated;
revoke all on function public.retry_provider_event(uuid, text, text, integer, boolean)
from public, anon, authenticated;
revoke all on function public.ingest_whatsapp_inbound_message(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, jsonb)
from public, anon, authenticated;
revoke all on function public.apply_whatsapp_message_status(uuid, uuid, text, uuid, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.claim_provider_events(text, integer) to service_role;
grant execute on function public.complete_provider_event(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.retry_provider_event(uuid, text, text, integer, boolean) to service_role;
grant execute on function public.ingest_whatsapp_inbound_message(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, jsonb) to service_role;
grant execute on function public.apply_whatsapp_message_status(uuid, uuid, text, uuid, text, timestamptz) to service_role;

commit;
