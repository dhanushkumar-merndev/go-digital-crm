begin;

-- Drip dispatch reliability.
--
-- Four ways the queue could stop or mislead, all found by reading the deployed
-- bodies against live rows:
--
--  1. customer_drip_messages.attempts is capped at 10 by a check, and the claim
--     increments it unguarded. A message that reached 10 through expired leases
--     (never through retry_drip_message, which is the only place that fails it)
--     made the next claim raise, and the claim is one statement for every tenant:
--     one such row stopped all drip sending until someone deleted it.
--  2. A message could be QUEUED on an enrollment that is no longer ACTIVE (cancel
--     only closes QUEUED rows, so one that was SENDING and then failed was
--     re-queued). The claim marked it SENDING and then dropped it from its result,
--     so it sat for the lease window, was released, and was claimed again -- each
--     round adding an attempt until it became case 1.
--  3. An enrollment whose last message FAILED stayed ACTIVE forever, because only
--     a successful send or a skip closed it.
--  4. The hourly audience match had no DORMANT filter. The per-row
--     reject_dormant_drip_enrollment trigger then raised for the first dormant
--     lead in the audience and failed the whole campaign's pass, every hour.
--
-- The audience filter validator also accepted unknown keys. An unknown key is
-- ignored by the matcher, which reads as "no filter": the whole customer base.
--
-- Existing bodies are text-patched from the deployed pg_get_functiondef.

alter table public.customer_drip_messages
  drop constraint customer_drip_messages_skip_reason_check,
  add constraint customer_drip_messages_skip_reason_check check (
    skip_reason is null or skip_reason in (
      'CAMPAIGN_PAUSED', 'DORMANT', 'OPTED_OUT', 'NO_RECIPIENT', 'EMAIL_CONDITION_CHANGED',
      'ENROLLMENT_CLOSED'
    )
  );

do $patch$
declare
  body text;
  anchor text;
begin
  body := pg_get_functiondef('public.claim_due_drip_messages(text,integer)'::regprocedure);

  -- Close what is queued on a cancelled or completed enrollment instead of
  -- claiming it.
  anchor := 'when enrollment_row.source_campaign_id is not null';
  if position(anchor in body) = 0 then raise exception 'DRIP_CLAIM_CLOSED_ANCHOR_MISSING'; end if;
  body := replace(body, anchor,
    'when enrollment_row.status <> ''ACTIVE'' then ''ENROLLMENT_CLOSED''
        ' || anchor);

  -- The cancellation pass is bounded, so the claim itself must not pick one up.
  anchor := '-- AGENTS.md 9.7: HOT first, then WARM, then COLD, then by due time.';
  if position(anchor in body) = 0 then raise exception 'DRIP_CLAIM_CANDIDATE_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, 'and priority_enrollment.status = ''ACTIVE''
    ' || anchor);

  -- Never let the increment break the table's own cap.
  anchor := 'attempts = message_row.attempts + 1,';
  if position(anchor in body) = 0 then raise exception 'DRIP_CLAIM_ATTEMPTS_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, 'attempts = least(message_row.attempts + 1, 10),');
  execute body;

  body := pg_get_functiondef('public.run_drip_auto_match(uuid,integer)'::regprocedure);
  anchor := '-- Never enrol the same customer in the same campaign twice.';
  if position(anchor in body) = 0 then raise exception 'DRIP_AUTO_MATCH_DORMANT_ANCHOR_MISSING'; end if;
  body := replace(body, anchor,
    '-- Do not disturb (AGENTS.md 9.7): any DORMANT lead keeps its customer out.
      and not exists (
        select 1 from public.leads dormant_row
        where dormant_row.organization_id = customer_row.organization_id
          and dormant_row.customer_id = customer_row.id
          and dormant_row.deleted_at is null
          and dormant_row.temperature = ''DORMANT''
      )
      ' || anchor);
  execute body;

  body := pg_get_functiondef('app_private.validate_drip_audience_filter(jsonb)'::regprocedure);
  anchor := 'if jsonb_typeof(target_filter) is distinct from ''object'' then return false; end if;';
  if position(anchor in body) = 0 then raise exception 'DRIP_AUDIENCE_KEYS_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || '
  if exists (
    select 1 from jsonb_object_keys(target_filter) filter_name
    where filter_name not in (''lifecycle_status'', ''temperature'', ''source'', ''created_within_days'')
  ) then return false; end if;');
  execute body;
end;
$patch$;

create or replace function public.retry_drip_message(
  target_message_id uuid,
  target_lease_token text,
  target_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
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
  elsif not exists (
    select 1 from public.customer_drip_enrollments enrollment_row
    where enrollment_row.id = message_row.enrollment_id and enrollment_row.status = 'ACTIVE'
  ) then
    -- The enrollment was cancelled while this send was in flight; a retry would
    -- deliver a sequence the user already stopped.
    update public.customer_drip_messages
    set status = 'CANCELLED', skip_reason = 'ENROLLMENT_CLOSED',
      failure_reason = 'Skipped: enrollment closed', safe_error_code = normalized_code,
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

  -- A failed last message finishes the enrollment as a sent one does.
  update public.customer_drip_enrollments enrollment_row
  set status = 'COMPLETED', completed_at = now(), updated_at = now()
  where enrollment_row.id = message_row.enrollment_id
    and enrollment_row.status = 'ACTIVE'
    and not exists (
      select 1 from public.customer_drip_messages pending_row
      where pending_row.enrollment_id = enrollment_row.id
        and pending_row.status in ('QUEUED', 'SENDING')
    );
  return true;
end;
$function$;

create or replace function public.release_stalled_drip_messages(
  target_stale_minutes integer default 15
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  released integer;
  failed_enrollment_ids uuid[];
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_stale_minutes not between 5 and 240 then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_STALE_WINDOW';
  end if;
  -- A lease that expires on the last allowed attempt is a failure, not another
  -- turn in the queue: re-queuing it is what let attempts pass the table's cap.
  with stalled as (
    update public.customer_drip_messages
    set status = case when attempts >= 10 then 'FAILED' else 'QUEUED' end,
      failure_reason = case when attempts >= 10 then 'DRIP_LEASE_EXPIRED' else failure_reason end,
      lease_token = null, next_attempt_at = now(),
      safe_error_code = 'DRIP_LEASE_EXPIRED', updated_at = now()
    where status = 'SENDING'
      and updated_at < now() - make_interval(mins => target_stale_minutes)
    returning enrollment_id, status
  )
  select count(*)::integer,
    coalesce(array_agg(distinct stalled.enrollment_id) filter (where stalled.status = 'FAILED'), '{}'::uuid[])
  into released, failed_enrollment_ids
  from stalled;

  if cardinality(failed_enrollment_ids) > 0 then
    update public.customer_drip_enrollments enrollment_row
    set status = 'COMPLETED', completed_at = now(), updated_at = now()
    where enrollment_row.id = any(failed_enrollment_ids)
      and enrollment_row.status = 'ACTIVE'
      and not exists (
        select 1 from public.customer_drip_messages pending_row
        where pending_row.enrollment_id = enrollment_row.id
          and pending_row.status in ('QUEUED', 'SENDING')
      );
  end if;
  return released;
end;
$function$;

-- Enrollments already stranded by case 3.
update public.customer_drip_enrollments enrollment_row
set status = 'COMPLETED', completed_at = now(), updated_at = now()
where enrollment_row.status = 'ACTIVE'
  and exists (
    select 1 from public.customer_drip_messages message_row
    where message_row.enrollment_id = enrollment_row.id
  )
  and not exists (
    select 1 from public.customer_drip_messages pending_row
    where pending_row.enrollment_id = enrollment_row.id
      and pending_row.status in ('QUEUED', 'SENDING')
  );

commit;
