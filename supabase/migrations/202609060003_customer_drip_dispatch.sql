-- Drip queued messages and never sent them: `customer_drip_messages_due_idx` was
-- created for "the dispatcher's only query" but no dispatcher was ever written.
-- Queueing more of them was the only thing the feature actually did.
--
-- Delivery also could not have worked in the shape the rows were stored. A drip
-- step runs hours to a year after enrollment, which is outside WhatsApp's 24h
-- service window, where Meta accepts only a pre-approved template; and
-- `email_messages` has no body column at all, only a Brevo template id and its
-- variables. So a step now carries the template it will be sent as, and
-- `message_body` keeps the rendered copy the enroller reviewed.

alter table public.marketing_drip_steps
  add column if not exists template_id uuid references public.templates(id),
  add column if not exists template_variables jsonb not null default '{}'::jsonb;
alter table public.marketing_drip_steps
  drop constraint if exists marketing_drip_steps_template_variables_object,
  add constraint marketing_drip_steps_template_variables_object
    check (jsonb_typeof(template_variables) = 'object');

alter table public.customer_drip_messages
  add column if not exists template_id uuid references public.templates(id),
  add column if not exists template_variables jsonb not null default '{}'::jsonb,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_token text,
  add column if not exists safe_error_code text;
alter table public.customer_drip_messages
  drop constraint if exists customer_drip_messages_template_variables_object,
  add constraint customer_drip_messages_template_variables_object
    check (jsonb_typeof(template_variables) = 'object');

-- Retry backoff needs its own clock: rescheduling `scheduled_for` would rewrite
-- the time the enroller was shown and reviewed.
update public.customer_drip_messages
  set next_attempt_at = scheduled_for where next_attempt_at is null;
alter table public.customer_drip_messages alter column next_attempt_at set not null;
alter table public.customer_drip_messages alter column next_attempt_at set default now();

-- A claimed message is neither queued nor finished, and without that state a
-- second dispatcher pass would send it again.
do $$
declare constraint_name text;
begin
  select conname into constraint_name from pg_constraint
  where conrelid = 'public.customer_drip_messages'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%QUEUED%';
  if constraint_name is not null then
    execute format('alter table public.customer_drip_messages drop constraint %I', constraint_name);
  end if;
end;
$$;
alter table public.customer_drip_messages
  add constraint customer_drip_messages_status_check
    check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'));

drop index if exists public.customer_drip_messages_due_idx;
create index customer_drip_messages_due_idx
  on public.customer_drip_messages (next_attempt_at, id)
  where status = 'QUEUED';
-- Lets a stalled claim be reclaimed without scanning finished rows.
create index customer_drip_messages_leased_idx
  on public.customer_drip_messages (updated_at)
  where status = 'SENDING';

-- The dispatcher claims a bounded batch and resolves everything it needs in the
-- same statement. Cost tracks the batch size, never the size of the queue.
create or replace function public.claim_due_drip_messages(
  target_worker_id text,
  target_batch_size integer default 20
)
returns table (
  id uuid, organization_id uuid, channel text, message_body text,
  template_provider_id text, template_variables jsonb, recipient text,
  connected_account_id uuid, application_message_id uuid, lease_token text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160
    or target_batch_size not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_WORKER_CLAIM';
  end if;

  return query
  with candidates as (
    select message_row.id
    from public.customer_drip_messages message_row
    where message_row.status = 'QUEUED' and message_row.next_attempt_at <= now()
    order by message_row.next_attempt_at, message_row.id
    for update skip locked
    limit target_batch_size
  ), claimed as (
    update public.customer_drip_messages message_row
    set status = 'SENDING',
      attempts = message_row.attempts + 1,
      lease_token = target_worker_id || ':' || gen_random_uuid()::text,
      updated_at = now()
    from candidates
    where message_row.id = candidates.id
    returning message_row.*
  )
  select
    claimed.id,
    claimed.organization_id,
    claimed.channel,
    claimed.message_body,
    template_row.provider_template_id,
    claimed.template_variables,
    case
      when claimed.channel = 'EMAIL' then customer_row.primary_email
      else customer_row.primary_phone
    end,
    connection_row.id,
    -- Deterministic per message, so a retry after an unknown outcome reuses the
    -- provider's own idempotency key rather than sending a second copy.
    claimed.id,
    claimed.lease_token
  from claimed
  join public.customer_drip_enrollments enrollment_row
    on enrollment_row.id = claimed.enrollment_id
   and enrollment_row.organization_id = claimed.organization_id
  join public.customers customer_row
    on customer_row.id = enrollment_row.customer_id
   and customer_row.organization_id = claimed.organization_id
   and customer_row.deleted_at is null
  left join public.templates template_row
    on template_row.id = claimed.template_id
   and template_row.organization_id = claimed.organization_id
   and template_row.deleted_at is null
   and upper(template_row.status) = 'APPROVED'
  -- Only WhatsApp resolves a tenant connection. Brevo is a platform-level key in
  -- send-email and provider-outbox, not a per-tenant connected account, so
  -- looking one up for EMAIL would always miss and read as a misconfiguration.
  left join lateral (
    select account_row.id
    from public.connected_accounts account_row
    where claimed.channel = 'WHATSAPP'
      and account_row.organization_id = claimed.organization_id
      and account_row.provider_key = 'whatsapp_cloud'
      and account_row.status = 'CONNECTED'
      and account_row.deleted_at is null
      and (
        account_row.scope_mode = 'ALL_BRANCHES'
        or exists (
          select 1 from public.integration_branch_mappings mapping_row
          where mapping_row.connected_account_id = account_row.id
            and mapping_row.branch_id = enrollment_row.branch_id
        )
      )
    order by account_row.created_at
    limit 1
  ) connection_row on true
  where enrollment_row.status = 'ACTIVE';
end;
$$;

create or replace function public.complete_drip_message(
  target_message_id uuid,
  target_lease_token text,
  target_provider_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare updated_rows integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.customer_drip_messages
  set status = 'SENT', sent_at = now(), updated_at = now(),
    provider_message_id = left(btrim(coalesce(target_provider_message_id, '')), 200),
    safe_error_code = null, failure_reason = null
  where id = target_message_id
    and lease_token = target_lease_token
    and status = 'SENDING';
  get diagnostics updated_rows = row_count;
  if updated_rows = 0 then return false; end if;

  -- An enrollment with nothing left to send is finished; leaving it ACTIVE would
  -- keep it in the consultant's live list forever.
  update public.customer_drip_enrollments enrollment_row
  set status = 'COMPLETED', completed_at = now(), updated_at = now()
  where enrollment_row.id = (
      select message_row.enrollment_id from public.customer_drip_messages message_row
      where message_row.id = target_message_id
    )
    and enrollment_row.status = 'ACTIVE'
    and not exists (
      select 1 from public.customer_drip_messages pending_row
      where pending_row.enrollment_id = enrollment_row.id
        and pending_row.status in ('QUEUED', 'SENDING')
    );
  return true;
end;
$$;

-- `attempts` is capped at 10 by the table's own check, so the terminal decision
-- is made here rather than letting the increment raise.
create or replace function public.retry_drip_message(
  target_message_id uuid,
  target_lease_token text,
  target_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  message_row public.customer_drip_messages%rowtype;
  normalized_code text := left(btrim(coalesce(target_safe_error_code, '')), 100);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if normalized_code !~ '^[A-Z0-9_]{3,100}$' then
    normalized_code := 'DRIP_SEND_RETRY';
  end if;
  select * into message_row from public.customer_drip_messages
  where id = target_message_id and lease_token = target_lease_token and status = 'SENDING'
  for update;
  if not found then return false; end if;

  if message_row.attempts >= 10 then
    update public.customer_drip_messages
    set status = 'FAILED', failure_reason = normalized_code, safe_error_code = normalized_code,
      updated_at = now()
    where id = message_row.id;
  else
    update public.customer_drip_messages
    set status = 'QUEUED', safe_error_code = normalized_code, updated_at = now(),
      -- Exponential backoff capped so a provider outage cannot push a message
      -- beyond the window where it still makes sense to the customer.
      next_attempt_at = now() + least(interval '6 hours',
        interval '2 minutes' * power(2, least(message_row.attempts, 6)))
    where id = message_row.id;
  end if;
  return true;
end;
$$;

-- A worker that dies mid-send leaves a row SENDING forever. Returning it to the
-- queue is safe because the provider is called with the message's own id as its
-- idempotency key.
create or replace function public.release_stalled_drip_messages(
  target_stale_minutes integer default 15
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare released integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_stale_minutes not between 5 and 240 then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_STALE_WINDOW';
  end if;
  update public.customer_drip_messages
  set status = 'QUEUED', lease_token = null, next_attempt_at = now(),
    safe_error_code = 'DRIP_LEASE_EXPIRED', updated_at = now()
  where status = 'SENDING'
    and updated_at < now() - make_interval(mins => target_stale_minutes);
  get diagnostics released = row_count;
  return released;
end;
$$;

revoke all on function public.claim_due_drip_messages(text, integer) from public, anon, authenticated;
grant execute on function public.claim_due_drip_messages(text, integer) to service_role;
revoke all on function public.complete_drip_message(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_drip_message(uuid, text, text) to service_role;
revoke all on function public.retry_drip_message(uuid, text, text) from public, anon, authenticated;
grant execute on function public.retry_drip_message(uuid, text, text) to service_role;
revoke all on function public.release_stalled_drip_messages(integer) from public, anon, authenticated;
grant execute on function public.release_stalled_drip_messages(integer) to service_role;
