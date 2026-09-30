begin;

-- When the employee's own leg (TeleCMI leg A) picked up. Click-to-call rings
-- the employee first and only dials the customer once they answer, so the live
-- call bar needs this to tell "ringing you" apart from "you're on the line,
-- calling the customer" -- both are RINGING as far as the customer is concerned.
alter table public.calls add column if not exists agent_answered_at timestamptz;

-- The single place a TeleCMI call event moves a call. The webhook calls it the
-- moment an event arrives, so the live call bar follows the call in real time
-- through the realtime broadcast on public.calls; the provider-event
-- dispatcher replays the same receipt later for recording ingestion. Replays
-- are harmless: every transition is monotonic and every timestamp is
-- first-write-wins, so applying a receipt twice, or out of order, converges.
--
-- Observed TeleCMI click-to-call sequence (leg a = employee, leg b = customer):
--   event:a:STARTED > event:a:ANSWERED > event:b:STARTED > event:b:ANSWERED
--   > event:*:HANGUP > cdr:b:ANSWERED|MISSED > cdr:a:ANSWERED
-- When the employee never answers, TeleCMI never dials the customer and only
-- sends event:a:STARTED > cdr:a:MISSED > event:a:HANGUP.
create or replace function public.apply_telecmi_call_event(
  target_organization_id uuid,
  target_connection_id uuid,
  target_provider_event_id uuid,
  target_received_at timestamptz,
  target_receipt jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_crm_call_text text;
  receipt_crm_call_id uuid;
  receipt_request_id text;
  receipt_provider_call_id text;
  receipt_event_type text;
  receipt_leg text;
  receipt_status text;
  receipt_duration integer;
  customer_leg boolean;
  matched_call_id uuid;
  candidate_call_id uuid;
  call_row public.calls%rowtype;
  current_status text;
  terminal boolean;
  event_at timestamptz;
  next_status text;
  next_outcome text;
  next_answered_at timestamptz;
  next_agent_answered_at timestamptz;
  next_ended_at timestamptz;
  next_finalized_at timestamptz;
  next_duration integer;
  next_request_id text;
  next_provider_call_id text;
  became_connected boolean;
  changed boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_connection_id is null
    or target_provider_event_id is null or target_receipt is null
    or jsonb_typeof(target_receipt) <> 'object' then
    raise exception using errcode = '22023', message = 'TELECMI_RECEIPT_INVALID';
  end if;

  receipt_crm_call_text := nullif(btrim(target_receipt->>'crm_call_id'), '');
  if receipt_crm_call_text is not null then
    if receipt_crm_call_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'TELECMI_CRM_CALL_ID_INVALID';
    end if;
    receipt_crm_call_id := receipt_crm_call_text::uuid;
  end if;
  receipt_request_id := nullif(btrim(target_receipt->>'provider_request_id'), '');
  receipt_provider_call_id := nullif(btrim(target_receipt->>'provider_call_id'), '');
  if receipt_crm_call_id is null and receipt_request_id is null and receipt_provider_call_id is null then
    raise exception using errcode = '22023', message = 'TELECMI_CALL_IDENTITY_MISSING';
  end if;
  receipt_event_type := upper(coalesce(nullif(btrim(target_receipt->>'event_type'), ''), 'CALL'));
  receipt_leg := lower(nullif(btrim(target_receipt->>'leg'), ''));
  receipt_status := upper(coalesce(nullif(btrim(target_receipt->>'status'), ''), 'UNKNOWN'));
  if target_receipt ? 'duration_seconds' and jsonb_typeof(target_receipt->'duration_seconds') <> 'null' then
    if jsonb_typeof(target_receipt->'duration_seconds') <> 'number'
      or (target_receipt->>'duration_seconds')::numeric not between 0 and 86400
      or (target_receipt->>'duration_seconds')::numeric <> trunc((target_receipt->>'duration_seconds')::numeric) then
      raise exception using errcode = '22023', message = 'TELECMI_DURATION_INVALID';
    end if;
    receipt_duration := (target_receipt->>'duration_seconds')::integer;
  end if;
  -- Leg b is the customer. A receipt with no leg predates leg reporting and was
  -- always read as the customer, so it keeps that meaning.
  customer_leg := receipt_leg is distinct from 'a';

  -- Every identity the receipt carries must point at the same call; two
  -- different calls behind one receipt is a mapping fault, never a guess.
  if receipt_crm_call_id is not null then
    select id into matched_call_id
    from public.calls
    where organization_id = target_organization_id
      and connection_id = target_connection_id
      and call_source = 'PROVIDER'
      and id = receipt_crm_call_id;
  end if;
  if receipt_request_id is not null then
    candidate_call_id := null;
    select id into candidate_call_id
    from public.calls
    where organization_id = target_organization_id
      and connection_id = target_connection_id
      and call_source = 'PROVIDER'
      and provider_request_id = receipt_request_id;
    if matched_call_id is not null and candidate_call_id is not null
      and candidate_call_id <> matched_call_id then
      raise exception using errcode = '22023', message = 'TELECMI_CALL_IDENTITY_CONFLICT';
    end if;
    matched_call_id := coalesce(matched_call_id, candidate_call_id);
  end if;
  if receipt_provider_call_id is not null then
    candidate_call_id := null;
    select id into candidate_call_id
    from public.calls
    where organization_id = target_organization_id
      and connection_id = target_connection_id
      and call_source = 'PROVIDER'
      and provider_call_id = receipt_provider_call_id;
    if matched_call_id is not null and candidate_call_id is not null
      and candidate_call_id <> matched_call_id then
      raise exception using errcode = '22023', message = 'TELECMI_CALL_IDENTITY_CONFLICT';
    end if;
    matched_call_id := coalesce(matched_call_id, candidate_call_id);
  end if;
  if matched_call_id is null then
    return null;
  end if;

  select * into call_row
  from public.calls
  where id = matched_call_id and organization_id = target_organization_id
  for update;

  current_status := upper(call_row.status);
  terminal := current_status in ('COMPLETED', 'FAILED', 'CANCELLED');
  -- TeleCMI sends no timestamp of its own, so arrival time is the best clock.
  -- The time_order check requires ended_at >= started_at.
  event_at := greatest(coalesce(target_received_at, clock_timestamp()), call_row.started_at);

  next_status := current_status;
  next_outcome := call_row.outcome;
  next_answered_at := call_row.answered_at;
  next_agent_answered_at := call_row.agent_answered_at;
  next_ended_at := call_row.ended_at;
  next_finalized_at := call_row.finalized_at;
  next_duration := call_row.duration_seconds;
  next_request_id := coalesce(call_row.provider_request_id, receipt_request_id);
  next_provider_call_id := call_row.provider_call_id;
  if next_provider_call_id is null and receipt_provider_call_id is not null
    and not exists (
      select 1 from public.calls
      where organization_id = target_organization_id
        and connection_id = target_connection_id
        and provider_call_id = receipt_provider_call_id
        and id <> call_row.id
    ) then
    next_provider_call_id := receipt_provider_call_id;
  end if;

  if receipt_event_type = 'CDR' then
    if customer_leg then
      -- The customer leg's record is the final word on whether the customer
      -- was reached, and may correct a live status that arrived out of order.
      if receipt_status = 'ANSWERED' or coalesce(receipt_duration, 0) > 0 then
        if current_status <> 'CANCELLED' then
          next_status := 'COMPLETED';
          next_outcome := 'CONNECTED';
        end if;
      elsif current_status not in ('COMPLETED', 'CANCELLED') then
        next_status := 'FAILED';
        if upper(coalesce(call_row.outcome, '')) <> 'CONNECTED' then
          next_outcome := case
            when receipt_status = 'BUSY' then 'BUSY'
            when receipt_status in ('MISSED', 'NO_ANSWER', 'NO-ANSWER', 'UNANSWERED', 'REJECTED')
              then 'NO_ANSWER'
            else coalesce(call_row.outcome, 'OTHER')
          end;
        end if;
      end if;
      -- Billed talk time belongs to the customer leg only; the employee leg
      -- also counts the ringing and the time spent waiting on the customer.
      if receipt_duration is not null and receipt_duration > coalesce(next_duration, -1) then
        next_duration := receipt_duration;
      end if;
      next_ended_at := coalesce(next_ended_at, event_at);
      next_finalized_at := coalesce(next_finalized_at, event_at);
    else
      if receipt_status = 'ANSWERED' or coalesce(receipt_duration, 0) > 0 then
        next_agent_answered_at := coalesce(next_agent_answered_at, event_at);
      elsif not terminal and call_row.answered_at is null then
        -- The employee never picked up, so the customer was never dialled and
        -- no customer-leg record will follow. Without this the call sat at
        -- PENDING forever.
        next_status := 'FAILED';
        next_outcome := coalesce(call_row.outcome, 'OTHER');
        next_ended_at := coalesce(next_ended_at, event_at);
        next_finalized_at := coalesce(next_finalized_at, event_at);
      end if;
    end if;
  elsif not terminal then
    if receipt_status = 'ANSWERED' then
      next_agent_answered_at := coalesce(next_agent_answered_at, event_at);
      if customer_leg then
        -- Only the customer answering is a connected conversation. Leg a
        -- answering used to flip the bar to "Connected" while the customer's
        -- phone had not even started ringing.
        next_status := 'IN_PROGRESS';
        next_answered_at := coalesce(next_answered_at, event_at);
      elsif current_status = 'PENDING' then
        next_status := 'RINGING';
      end if;
    elsif receipt_status in ('STARTED', 'RINGING', 'WAITING', 'BRIDGING') then
      if current_status = 'PENDING' then
        next_status := 'RINGING';
      end if;
    elsif receipt_status = 'HANGUP' then
      -- Either leg hanging up ends the live call. The customer-leg CDR still
      -- follows and settles the final outcome and billed duration.
      if current_status = 'IN_PROGRESS' then
        next_status := 'COMPLETED';
        next_outcome := 'CONNECTED';
      else
        next_status := 'FAILED';
        next_outcome := coalesce(
          call_row.outcome,
          case when customer_leg or next_agent_answered_at is not null then 'NO_ANSWER' else 'OTHER' end
        );
      end if;
      next_ended_at := coalesce(next_ended_at, event_at);
    end if;
  end if;

  became_connected := next_status = 'COMPLETED'
    and next_outcome = 'CONNECTED'
    and upper(coalesce(call_row.outcome, '')) <> 'CONNECTED';
  changed := next_status is distinct from call_row.status
    or next_outcome is distinct from call_row.outcome
    or next_answered_at is distinct from call_row.answered_at
    or next_agent_answered_at is distinct from call_row.agent_answered_at
    or next_ended_at is distinct from call_row.ended_at
    or next_finalized_at is distinct from call_row.finalized_at
    or next_duration is distinct from call_row.duration_seconds
    or next_request_id is distinct from call_row.provider_request_id
    or next_provider_call_id is distinct from call_row.provider_call_id;

  if changed then
    update public.calls set
      status = next_status,
      outcome = next_outcome,
      answered_at = next_answered_at,
      agent_answered_at = next_agent_answered_at,
      ended_at = next_ended_at,
      finalized_at = next_finalized_at,
      duration_seconds = next_duration,
      provider_request_id = next_request_id,
      provider_call_id = next_provider_call_id,
      version = call_row.version + 1,
      updated_at = greatest(clock_timestamp(), call_row.updated_at + interval '1 microsecond')
    where id = call_row.id and organization_id = call_row.organization_id;
  end if;

  -- Marks the lead contacted and writes the audit fact once, the first time
  -- the call is known to have reached the customer.
  if became_connected and call_row.lead_id is not null then
    perform public.record_telecmi_connected_call(
      target_organization_id, target_connection_id, call_row.id, target_provider_event_id
    );
  end if;

  return jsonb_build_object(
    'call_id', call_row.id,
    'branch_id', call_row.branch_id,
    'lead_id', call_row.lead_id,
    'status', next_status,
    'outcome', next_outcome,
    'connected', next_status = 'COMPLETED' and next_outcome = 'CONNECTED',
    'changed', changed
  );
end;
$$;

revoke all on function public.apply_telecmi_call_event(uuid, uuid, uuid, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_telecmi_call_event(uuid, uuid, uuid, timestamptz, jsonb)
  to service_role;

-- Same single-row read behind the live call bar, now also reporting whether
-- the employee has answered their own leg. Ringing is still bounded to five
-- minutes so an abandoned request cannot pin "Starting call" to the screen,
-- but a connected conversation is kept for two hours from the answer: the old
-- five-minute bound on every live status made the bar vanish mid-conversation.
create or replace function public.get_active_call_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'call_id', call_row.id,
    'status', call_row.status,
    'outcome', call_row.outcome,
    'lead_id', call_row.lead_id,
    'customer_id', call_row.customer_id,
    'customer_name', coalesce(customer_row.full_name, lead_row.customer_name, 'Customer'),
    'phone', coalesce(customer_row.primary_phone, lead_row.phone),
    'started_at', call_row.started_at,
    'answered_at', call_row.answered_at,
    'agent_answered_at', call_row.agent_answered_at,
    'ended_at', call_row.ended_at,
    'duration_seconds', call_row.duration_seconds
  )
  from public.calls call_row
  left join public.customers customer_row
    on customer_row.id = call_row.customer_id
   and customer_row.organization_id = call_row.organization_id
  left join public.leads lead_row
    on lead_row.id = call_row.lead_id
   and lead_row.organization_id = call_row.organization_id
  where call_row.assigned_user_id = auth.uid()
    and call_row.call_source = 'PROVIDER'
    and (
      (
        call_row.status in ('PENDING', 'RINGING')
        and call_row.started_at > now() - interval '5 minutes'
      )
      or (
        call_row.status = 'IN_PROGRESS'
        and coalesce(call_row.answered_at, call_row.started_at) > now() - interval '2 hours'
      )
      or (
        call_row.ended_at is not null
        and call_row.ended_at > now() - interval '25 seconds'
      )
    )
  order by call_row.started_at desc
  limit 1;
$$;

revoke all on function public.get_active_call_status() from public, anon;
grant execute on function public.get_active_call_status() to authenticated;

commit;
