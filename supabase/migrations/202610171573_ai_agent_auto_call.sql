begin;

-- AI agent auto call (product decision 2026-10-17).
--
-- The keypad auto-call (202610141573) gains a second mode. With mode
-- AI_AGENT the dialer still calls a telecaller's uncontacted New leads one at a
-- time, but TeleCMI PIOPIY connects each call to our own voice agent
-- (services/voice-agent, the piopiy-ai orchestrator with Groq, Deepgram and
-- Sarvam) instead of a keypad menu. The agent talks to the customer in the
-- lead's language and posts back an outcome, a summary, the transcript and the
-- answers it heard.
--
-- * Nothing the agent hears edits the lead. Answers become suggestions in
--   auto_ivr_call_results, exactly like key presses, and the telecaller applies
--   them and verifies the call. DO_NOT_CALL only suggests DORMANT (9.7).
-- * A lead moves New -> Contacted only when the agent reports a conversation;
--   voicemail and silence leave it New for a retry.
-- * AI credits are charged per answered conversation, never for a call that
--   was not picked up. A call never reaches the agent without enough balance.
-- * Lead PII never travels through TeleCMI: the call carries only the CRM call
--   id and a random context token. The agent fetches the script and lead
--   context from us with that token, and the token stops working once the call
--   closes.
-- * calls.call_mode AUTO_AI is new. AI_AGENT stays reserved for the retired
--   assignment-escalation feature so the two never mix.

-- -------------------------------------------------------------- guards

do $guard$
begin
  if md5(pg_get_functiondef('public.claim_auto_call_jobs(text,integer)'::regprocedure))
    <> '9548e9ea6f2f9f5a58c154a205a08638' then
    raise exception 'claim_auto_call_jobs changed since this migration was written; re-base it';
  end if;
end;
$guard$;

-- -------------------------------------------------------------- columns

alter table public.auto_call_settings
  add column mode text not null default 'KEYPAD_IVR'
    check (mode in ('KEYPAD_IVR', 'AI_AGENT')),
  add column ai_script jsonb
    check (ai_script is null or (jsonb_typeof(ai_script) = 'object'
      and pg_column_size(ai_script) <= 50000)),
  add column ai_credit_cost smallint not null default 1
    check (ai_credit_cost between 0 and 100);

alter table public.auto_call_jobs
  alter column flow_version_id drop not null,
  add column mode text not null default 'KEYPAD_IVR'
    check (mode in ('KEYPAD_IVR', 'AI_AGENT')),
  add column ai_script jsonb,
  add column language text
    check (language is null or language in ('en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'ml-IN')),
  add column context_token_hash text
    check (context_token_hash is null or context_token_hash ~ '^[a-f0-9]{64}$'),
  add column context_fetched_at timestamptz,
  add constraint auto_call_jobs_mode_payload check (
    (mode = 'KEYPAD_IVR' and flow_version_id is not null and ai_script is null)
    or (mode = 'AI_AGENT' and flow_version_id is null and ai_script is not null
      and language is not null and context_token_hash is not null)
  );

alter table public.auto_ivr_call_results
  alter column flow_version_id drop not null,
  add column mode text not null default 'KEYPAD_IVR'
    check (mode in ('KEYPAD_IVR', 'AI_AGENT')),
  add column ai_outcome text check (ai_outcome is null or ai_outcome in (
    'ANSWERED_QUALIFIED', 'CALLBACK_REQUESTED', 'NOT_INTERESTED', 'DO_NOT_CALL',
    'WRONG_NUMBER', 'NO_RESPONSE', 'VOICEMAIL', 'FAILED')),
  add column summary text check (summary is null or char_length(summary) <= 4000),
  add column language text
    check (language is null or language in ('en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'ml-IN'));

alter table public.calls drop constraint calls_call_mode_check;
alter table public.calls add constraint calls_call_mode_check
  check (call_mode = any (array['HUMAN'::text, 'AI_AGENT'::text, 'AUTO_IVR'::text, 'AUTO_AI'::text]));

-- The language an AI call speaks for this lead; null follows the script default.
alter table public.leads
  add column call_language text
    check (call_language is null or call_language in ('en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'ml-IN'));

-- -------------------------------------------------------------- helpers

-- An agent answer may also carry the variant and an upper budget.
do $patch$
declare
  target regprocedure := 'app_private.auto_ivr_field_value_valid(text,jsonb)'::regprocedure;
  definition text := pg_get_functiondef(target);
  anchor text := E'    when ''callback_requested'' then value = ''true''::jsonb\n';
begin
  if position('''budget_max''' in definition) > 0 then
    raise exception 'auto_ivr_field_value_valid already patched';
  end if;
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'auto_ivr_field_value_valid anchor not found exactly once';
  end if;
  execute replace(definition, anchor,
    E'    when ''variant'' then jsonb_typeof(value) = ''string''\n'
    || E'      and char_length(btrim(value #>> ''{}'')) between 1 and 80\n'
    || E'    when ''budget_max'' then case when jsonb_typeof(value) = ''number''\n'
    || E'      then (value #>> ''{}'')::numeric between 10000 and 1000000000 else false end\n'
    || anchor);
end;
$patch$;

-- Returns why an AI call script is unusable, or null when it is valid.
create function app_private.auto_ai_script_error(script jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  question jsonb;
  question_ids text[] := '{}';
  supported_fields constant text[] := array[
    'temperature', 'purchase_timeline', 'interested_model', 'variant', 'budget_max',
    'finance_required', 'exchange_required', 'test_drive_required', 'callback_requested',
    'not_interested'];
  supported_languages constant text[] := array['en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'ml-IN'];
begin
  if script is null or jsonb_typeof(script) <> 'object' then
    return 'AI_SCRIPT_MISSING';
  end if;
  if char_length(btrim(coalesce(script->>'agent_name', ''))) not between 1 and 40 then
    return 'AI_SCRIPT_AGENT_NAME_INVALID';
  end if;
  if char_length(btrim(coalesce(script->>'goal', ''))) not between 10 and 800 then
    return 'AI_SCRIPT_GOAL_INVALID';
  end if;
  if char_length(coalesce(script->>'intro', '')) > 400
    or char_length(coalesce(script->>'closing', '')) > 400 then
    return 'AI_SCRIPT_TEXT_TOO_LONG';
  end if;
  if jsonb_typeof(script->'languages') is distinct from 'array'
    or jsonb_array_length(script->'languages') not between 1 and 6
    or exists (
      select 1 from jsonb_array_elements(script->'languages') language_item(value)
      where jsonb_typeof(language_item.value) <> 'string'
        or (language_item.value #>> '{}') <> all (supported_languages)
    ) then
    return 'AI_SCRIPT_LANGUAGES_INVALID';
  end if;
  if not ((script->'languages') ? coalesce(script->>'default_language', '')) then
    return 'AI_SCRIPT_DEFAULT_LANGUAGE_INVALID';
  end if;
  if script ? 'voice' and coalesce(script->>'voice', '') !~ '^[a-z_]{2,40}$' then
    return 'AI_SCRIPT_VOICE_INVALID';
  end if;
  if jsonb_typeof(script->'questions') is distinct from 'array'
    or jsonb_array_length(script->'questions') not between 1 and 12 then
    return 'AI_SCRIPT_QUESTIONS_INVALID';
  end if;
  for question in select value from jsonb_array_elements(script->'questions') loop
    if jsonb_typeof(question) <> 'object'
      or coalesce(question->>'id', '') !~ '^[a-z0-9_-]{1,40}$'
      or (question->>'id') = any (question_ids)
      or char_length(btrim(coalesce(question->>'ask', ''))) not between 3 and 300
      or (jsonb_typeof(question->'field') = 'string'
        and (question->>'field') <> all (supported_fields))
      or (question ? 'field' and jsonb_typeof(question->'field') not in ('string', 'null')) then
      return 'AI_SCRIPT_QUESTION_INVALID';
    end if;
    question_ids := question_ids || (question->>'id');
  end loop;
  return null;
end;
$$;

-- -------------------------------------------------------------- claim

create or replace function public.claim_auto_call_jobs(target_worker_id text, target_batch_size integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  dialer_row record;
  lead_row public.leads%rowtype;
  version_row public.auto_ivr_flow_versions%rowtype;
  connection_id uuid;
  call_row public.calls%rowtype;
  job_row public.auto_call_jobs%rowtype;
  attempt integer;
  stale_row record;
  ai_token text;
  ai_language text;
  claimed jsonb := '[]'::jsonb;
  batch integer := least(greatest(coalesce(target_batch_size, 5), 1), 20);
  local_now time := (pg_catalog.timezone('Asia/Kolkata', now()))::time;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(coalesce(target_worker_id, '')) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'AUTO_CALL_WORKER_INVALID';
  end if;

  -- Never accepted by PIOPIY: the worker died between claim and dial.
  for stale_row in
    select job.id, job.call_id from public.auto_call_jobs job
    where job.status = 'DIALING' and job.lease_expires_at < now()
    order by job.updated_at limit 50
    for update skip locked
  loop
    update public.auto_call_jobs set status = 'FAILED', safe_error_code = 'DISPATCH_LEASE_EXPIRED',
      lease_token = null, lease_expires_at = null, finished_at = now(), updated_at = now()
    where id = stale_row.id;
    update public.calls set status = 'FAILED', outcome = 'FAILED', ended_at = now(),
      finalized_at = now(), version = version + 1, updated_at = now()
    where id = stale_row.call_id and finalized_at is null;
  end loop;
  -- Accepted but no end-of-call event: close it from what was captured.
  for stale_row in
    select job.call_id, job.mode from public.auto_call_jobs job
    join public.auto_call_settings settings_row on settings_row.organization_id = job.organization_id
    where job.status = 'IN_CALL'
      and job.dispatched_at < now() - make_interval(
        secs => settings_row.max_duration_sec + settings_row.ring_timeout_sec + 180)
    order by job.dispatched_at limit 50
    for update of job skip locked
  loop
    if stale_row.mode = 'AI_AGENT' then
      perform app_private.finalize_auto_ai_call_internal(
        stale_row.call_id, 'TIMEOUT', null, null, 'NO_END_EVENT', true);
    else
      perform app_private.finalize_auto_ivr_call_internal(
        stale_row.call_id, 'TIMEOUT', null, null, 'NO_END_EVENT');
    end if;
  end loop;

  for dialer_row in
    select dialer.organization_id, dialer.user_id, settings_row.default_flow_id,
      settings_row.mode, settings_row.ai_script, settings_row.ai_credit_cost,
      settings_row.max_attempts_per_lead, settings_row.retry_after_minutes,
      settings_row.ring_timeout_sec, settings_row.max_duration_sec
    from public.auto_call_dialers dialer
    join public.auto_call_settings settings_row
      on settings_row.organization_id = dialer.organization_id and settings_row.enabled
    join public.organizations organization_row
      on organization_row.id = dialer.organization_id
     and organization_row.status = 'ACTIVE' and organization_row.deleted_at is null
    where dialer.enabled and dialer.paused_reason is null
      and local_now >= settings_row.calling_window_start
      and local_now < settings_row.calling_window_end
      and not exists (
        select 1 from public.auto_call_jobs active_job
        where active_job.organization_id = dialer.organization_id
          and active_job.assigned_user_id = dialer.user_id
          and active_job.status in ('DIALING', 'IN_CALL')
      )
    order by dialer.last_dispatch_at nulls first, dialer.user_id
    limit batch
    for update of dialer skip locked
  loop
    update public.auto_call_dialers set last_dispatch_at = now(), updated_at = now()
    where organization_id = dialer_row.organization_id and user_id = dialer_row.user_id;

    if not app_private.is_active_telecaller(dialer_row.organization_id, dialer_row.user_id) then
      update public.auto_call_dialers set enabled = false, paused_reason = 'NOT_A_TELECALLER'
      where organization_id = dialer_row.organization_id and user_id = dialer_row.user_id;
      continue;
    end if;
    if dialer_row.mode = 'AI_AGENT' then
      if app_private.auto_ai_script_error(dialer_row.ai_script) is not null then
        update public.auto_call_dialers set paused_reason = 'AI_SCRIPT_MISSING'
        where organization_id = dialer_row.organization_id and user_id = dialer_row.user_id;
        continue;
      end if;
      -- Credits are charged after an answered call; never start one the
      -- organization cannot pay for.
      if dialer_row.ai_credit_cost > 0 and coalesce((
        select balance_row.balance from public.credit_balances balance_row
        where balance_row.organization_id = dialer_row.organization_id
          and balance_row.ledger_kind = 'AI'
      ), 0) < dialer_row.ai_credit_cost then
        update public.auto_call_dialers set paused_reason = 'AI_CREDITS_EXHAUSTED'
        where organization_id = dialer_row.organization_id and user_id = dialer_row.user_id;
        continue;
      end if;
    else
      select version_row_inner.* into version_row
      from public.auto_ivr_flows flow_row
      join public.auto_ivr_flow_versions version_row_inner
        on version_row_inner.id = flow_row.published_version_id
      where flow_row.id = dialer_row.default_flow_id
        and flow_row.status = 'PUBLISHED' and flow_row.deleted_at is null;
      if version_row.id is null then
        update public.auto_call_dialers set paused_reason = 'AUTO_IVR_FLOW_NOT_PUBLISHED'
        where organization_id = dialer_row.organization_id and user_id = dialer_row.user_id;
        continue;
      end if;
    end if;

    lead_row := null;
    select candidate.* into lead_row
    from public.leads candidate
    join public.branches branch_row
      on branch_row.id = candidate.branch_id
     and branch_row.organization_id = candidate.organization_id
     and branch_row.active and branch_row.deleted_at is null
    where candidate.organization_id = dialer_row.organization_id
      and candidate.assigned_user_id = dialer_row.user_id
      and candidate.lifecycle_status = 'New'
      and candidate.first_contacted_at is null
      and candidate.deleted_at is null
      and candidate.temperature is distinct from 'DORMANT'
      and char_length(regexp_replace(coalesce(candidate.phone, ''), '\D', '', 'g')) between 10 and 15
      and (
        select count(*) from public.auto_call_jobs previous_job
        where previous_job.organization_id = candidate.organization_id
          and previous_job.lead_id = candidate.id
          and previous_job.status <> 'CANCELLED'
      ) < dialer_row.max_attempts_per_lead
      and not exists (
        select 1 from public.auto_call_jobs recent_job
        where recent_job.organization_id = candidate.organization_id
          and recent_job.lead_id = candidate.id
          and recent_job.created_at > now() - make_interval(mins => dialer_row.retry_after_minutes)
      )
      -- The telecaller already tried this lead by hand recently.
      and not exists (
        select 1 from public.calls human_call
        where human_call.organization_id = candidate.organization_id
          and human_call.lead_id = candidate.id
          and human_call.call_mode = 'HUMAN'
          and human_call.started_at > now() - make_interval(mins => dialer_row.retry_after_minutes)
      )
    order by candidate.created_at, candidate.id
    limit 1
    for update of candidate skip locked;
    if lead_row.id is null then continue; end if;

    connection_id := app_private.auto_call_connection_for_branch(
      dialer_row.organization_id, lead_row.branch_id);
    if connection_id is null then
      update public.auto_call_dialers set paused_reason = 'PIOPIY_NOT_CONNECTED'
      where organization_id = dialer_row.organization_id and user_id = dialer_row.user_id;
      continue;
    end if;

    select coalesce(max(previous_job.attempt_no), 0) + 1 into attempt
    from public.auto_call_jobs previous_job
    where previous_job.organization_id = lead_row.organization_id
      and previous_job.lead_id = lead_row.id;
    if attempt > 5 then continue; end if;

    if dialer_row.mode = 'AI_AGENT' then
      ai_language := case
        when lead_row.call_language is not null
          and (dialer_row.ai_script->'languages') ? lead_row.call_language
          then lead_row.call_language
        else dialer_row.ai_script->>'default_language'
      end;
      ai_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    else
      ai_language := null;
      ai_token := null;
    end if;

    insert into public.calls (
      organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
      connection_id, direction, call_source, started_at, status, call_mode,
      auto_ivr_flow_version_id
    ) values (
      lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.id,
      lead_row.customer_id, dialer_row.user_id, connection_id, 'OUTBOUND', 'PROVIDER',
      now(), 'PENDING',
      case when dialer_row.mode = 'AI_AGENT' then 'AUTO_AI' else 'AUTO_IVR' end,
      case when dialer_row.mode = 'AI_AGENT' then null else version_row.id end
    ) returning * into call_row;
    insert into public.auto_call_jobs (
      organization_id, branch_id, team_id, lead_id, assigned_user_id, connection_id,
      flow_version_id, call_id, attempt_no, status, lease_token, lease_expires_at,
      mode, ai_script, language, context_token_hash
    ) values (
      lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.id,
      dialer_row.user_id, connection_id,
      case when dialer_row.mode = 'AI_AGENT' then null else version_row.id end,
      call_row.id, attempt, 'DIALING', gen_random_uuid(), now() + interval '2 minutes',
      dialer_row.mode,
      case when dialer_row.mode = 'AI_AGENT' then dialer_row.ai_script end,
      ai_language,
      case when ai_token is not null
        then encode(sha256(convert_to(ai_token, 'UTF8')), 'hex') end
    ) returning * into job_row;

    claimed := claimed || jsonb_build_array(jsonb_build_object(
      'job_id', job_row.id,
      'lease_token', job_row.lease_token,
      'organization_id', job_row.organization_id,
      'branch_id', job_row.branch_id,
      'call_id', call_row.id,
      'lead_id', lead_row.id,
      'connection_id', connection_id,
      'to_number', regexp_replace(lead_row.phone, '\D', '', 'g'),
      'customer_name', lead_row.customer_name,
      'interested_model', lead_row.interested_model,
      'ring_timeout_sec', dialer_row.ring_timeout_sec,
      'max_duration_sec', dialer_row.max_duration_sec
    ) || case when dialer_row.mode = 'AI_AGENT' then jsonb_build_object(
      'mode', 'AI_AGENT',
      'context_token', ai_token,
      'language', ai_language
    ) else jsonb_build_object(
      'mode', 'KEYPAD_IVR',
      'flow_version_id', version_row.id,
      'start_node_id', version_row.definition->>'start',
      'greeting', version_row.definition->'greeting',
      'start_node', version_row.definition->'nodes'->(version_row.definition->>'start')
    ) end);
  end loop;
  return claimed;
end;
$function$;

-- -------------------------------------------------------------- finalize

-- Closes an AI auto call from whatever arrived: the agent's result, the
-- PIOPIY status event, or the stale sweep. A connected call whose result has
-- not arrived yet stays open (unless forced) so the result can close it.
create function app_private.finalize_auto_ai_call_internal(
  target_call_id uuid,
  target_provider_status text,
  target_duration_seconds integer,
  target_recording_ref text,
  target_reason text,
  target_force boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  job_row public.auto_call_jobs%rowtype;
  result_row public.auto_ivr_call_results%rowtype;
  answered boolean;
  final_outcome text;
  first_finalize boolean;
  recording_id uuid;
  normalized_status text := upper(btrim(coalesce(target_provider_status, '')));
  normalized_recording text := nullif(btrim(coalesce(target_recording_ref, '')), '');
  duration integer := case when target_duration_seconds between 0 and 86400
    then target_duration_seconds end;
begin
  select * into call_row from public.calls
  where id = target_call_id and call_mode = 'AUTO_AI' for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_NOT_FOUND';
  end if;
  select * into job_row from public.auto_call_jobs
  where call_id = call_row.id and organization_id = call_row.organization_id for update;
  select * into result_row from public.auto_ivr_call_results where call_id = call_row.id;
  answered := coalesce(result_row.answered, false);

  if duration is not null and duration > coalesce(call_row.duration_seconds, 0) then
    update public.calls set duration_seconds = duration, version = version + 1, updated_at = now()
    where id = call_row.id
    returning * into call_row;
  end if;

  if normalized_recording is not null and char_length(normalized_recording) <= 255 then
    select id into recording_id from public.call_recordings
    where organization_id = call_row.organization_id and call_id = call_row.id
      and provider_recording_id = normalized_recording;
    if recording_id is null then
      insert into public.call_recordings (
        organization_id, call_id, provider_recording_id, source, status, duration_seconds
      ) values (
        call_row.organization_id, call_row.id, normalized_recording, 'PROVIDER_SYNC', 'PENDING',
        duration
      ) returning id into recording_id;
    end if;
  end if;

  if result_row.call_id is null and not coalesce(target_force, false)
    and call_row.finalized_at is null
    and (coalesce(duration, 0) > 0 or normalized_status in ('ANSWERED', 'CONNECTED', 'IN_PROGRESS')) then
    return jsonb_build_object(
      'call_id', call_row.id,
      'organization_id', call_row.organization_id,
      'branch_id', call_row.branch_id,
      'lead_id', call_row.lead_id,
      'assigned_user_id', call_row.assigned_user_id,
      'answered', false,
      'pending_result', true,
      'recording_id', recording_id
    );
  end if;

  final_outcome := case
    when result_row.call_id is not null then case result_row.ai_outcome
      when 'NO_RESPONSE' then 'NO_INPUT'
      when 'VOICEMAIL' then 'NO_ANSWER'
      when 'FAILED' then 'FAILED'
      else 'ANSWERED' end
    when normalized_status = 'BUSY' then 'BUSY'
    when normalized_status in ('FAILED', 'ERROR') then 'FAILED'
    when coalesce(call_row.duration_seconds, 0) > 0 or call_row.answered_at is not null then 'NO_INPUT'
    else 'NO_ANSWER'
  end;
  first_finalize := call_row.finalized_at is null;
  if first_finalize or (result_row.call_id is not null
    and call_row.outcome is distinct from final_outcome) then
    update public.calls set
      status = case when final_outcome = 'FAILED' then 'FAILED' else 'COMPLETED' end,
      outcome = final_outcome,
      ended_at = coalesce(ended_at, greatest(now(), started_at)),
      finalized_at = coalesce(finalized_at, now()),
      version = version + 1,
      updated_at = now()
    where id = call_row.id
    returning * into call_row;
  end if;

  if job_row.id is not null and (job_row.status in ('DIALING', 'IN_CALL')
    or (answered and job_row.status in ('NO_ANSWER', 'FAILED'))) then
    update public.auto_call_jobs set
      status = case when answered then 'COMPLETED'
        when final_outcome = 'FAILED' then 'FAILED' else 'NO_ANSWER' end,
      safe_error_code = case when answered then null
        when target_reason is not null
        then left(upper(regexp_replace(target_reason, '[^A-Za-z0-9_]', '_', 'g')), 80)
        else safe_error_code end,
      lease_token = null, lease_expires_at = null,
      finished_at = coalesce(finished_at, now()), updated_at = now()
    where id = job_row.id;
  end if;

  if first_finalize then
    update public.auto_call_dialers set
      consecutive_failures = case when final_outcome = 'FAILED' then consecutive_failures + 1 else 0 end,
      paused_reason = case when final_outcome = 'FAILED' and consecutive_failures + 1 >= 3
        then 'PROVIDER_FAILING' else paused_reason end,
      updated_at = now()
    where organization_id = call_row.organization_id and user_id = call_row.assigned_user_id;

    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
    ) values (
      call_row.organization_id, null, 'call.auto_ai_finalized', 'call', call_row.id::text,
      call_row.branch_id,
      jsonb_build_object('lead_id', call_row.lead_id, 'answered', answered,
        'outcome', final_outcome, 'ai_outcome', result_row.ai_outcome, 'reason', target_reason)
    );
  end if;

  return jsonb_build_object(
    'call_id', call_row.id,
    'organization_id', call_row.organization_id,
    'branch_id', call_row.branch_id,
    'lead_id', call_row.lead_id,
    'assigned_user_id', call_row.assigned_user_id,
    'answered', answered,
    'status', call_row.status,
    'outcome', call_row.outcome,
    'pending_result', false,
    'recording_id', recording_id
  );
end;
$$;

-- The PIOPIY status/CDR webhook entry point for AI calls.
create function public.finalize_auto_ai_call(
  target_connection_id uuid,
  target_call_id uuid,
  target_provider_status text,
  target_duration_seconds integer,
  target_recording_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.calls call_row
    where call_row.id = target_call_id and call_row.connection_id = target_connection_id
      and call_row.call_mode = 'AUTO_AI'
  ) then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_NOT_FOUND';
  end if;
  return app_private.finalize_auto_ai_call_internal(
    target_call_id, target_provider_status, target_duration_seconds, target_recording_ref,
    null, false);
end;
$$;

-- -------------------------------------------------------------- agent API

-- What the voice agent needs to run one call. Valid only while the call is open.
create function public.get_auto_ai_call_context(target_call_id uuid, target_context_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  job_row public.auto_call_jobs%rowtype;
  lead_row public.leads%rowtype;
  settings_row public.auto_call_settings%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_call_id is null or coalesce(target_context_token, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'AI_CALL_TOKEN_INVALID';
  end if;
  select * into call_row from public.calls where id = target_call_id and call_mode = 'AUTO_AI';
  if found then
    select * into job_row from public.auto_call_jobs
    where call_id = call_row.id and organization_id = call_row.organization_id for update;
  end if;
  if job_row.id is null
    or job_row.context_token_hash is distinct from
      encode(sha256(convert_to(target_context_token, 'UTF8')), 'hex') then
    raise exception using errcode = '42501', message = 'AI_CALL_TOKEN_INVALID';
  end if;
  if job_row.status not in ('DIALING', 'IN_CALL') then
    raise exception using errcode = 'P0001', message = 'AI_CALL_CLOSED';
  end if;
  update public.auto_call_jobs set context_fetched_at = coalesce(context_fetched_at, now()),
    updated_at = now()
  where id = job_row.id;
  if call_row.answered_at is null then
    update public.calls set answered_at = now(),
      status = case when status in ('PENDING', 'RINGING') then 'IN_PROGRESS' else status end,
      version = version + 1, updated_at = now()
    where id = call_row.id;
  end if;

  select * into lead_row from public.leads
  where id = call_row.lead_id and organization_id = call_row.organization_id;
  select * into settings_row from public.auto_call_settings
  where organization_id = call_row.organization_id;
  return jsonb_build_object(
    'call_id', call_row.id,
    'organization_id', call_row.organization_id,
    'language', job_row.language,
    'max_duration_sec', coalesce(settings_row.max_duration_sec, 300),
    'script', job_row.ai_script,
    'dealership_name', (select organization_row.name from public.organizations organization_row
      where organization_row.id = call_row.organization_id),
    'branch_name', (select branch_row.name from public.branches branch_row
      where branch_row.id = call_row.branch_id),
    'customer_first_name', nullif(split_part(btrim(coalesce(lead_row.customer_name, '')), ' ', 1), ''),
    'interested_model', lead_row.interested_model,
    'source', lead_row.source,
    'executive_first_name', (select nullif(split_part(btrim(profile_row.full_name), ' ', 1), '')
      from public.profiles profile_row where profile_row.id = call_row.assigned_user_id)
  );
end;
$$;

-- The agent's end-of-call report. Idempotent: a repeated post returns replayed.
create function public.record_auto_ai_call_result(
  target_call_id uuid,
  target_context_token text,
  target_outcome text,
  target_language text,
  target_summary text,
  target_answers jsonb,
  target_turns jsonb,
  target_duration_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  job_row public.auto_call_jobs%rowtype;
  existing_row public.auto_ivr_call_results%rowtype;
  credit_cost smallint;
  outcome text := upper(btrim(coalesce(target_outcome, '')));
  summary_text text := nullif(btrim(coalesce(target_summary, '')), '');
  answered boolean;
  suggestion_map jsonb := '{}'::jsonb;
  answer_item record;
  result_language text;
  transcript_saved boolean := false;
  charge_error text;
  finalized jsonb;
  supported_fields constant text[] := array[
    'temperature', 'purchase_timeline', 'interested_model', 'variant', 'budget_max',
    'finance_required', 'exchange_required', 'test_drive_required', 'not_interested'];
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if outcome not in ('ANSWERED_QUALIFIED', 'CALLBACK_REQUESTED', 'NOT_INTERESTED', 'DO_NOT_CALL',
      'WRONG_NUMBER', 'NO_RESPONSE', 'VOICEMAIL', 'FAILED')
    or (target_answers is not null and jsonb_typeof(target_answers) <> 'object')
    or (target_turns is not null and jsonb_typeof(target_turns) <> 'array')
    or char_length(coalesce(summary_text, '')) > 4000 then
    raise exception using errcode = '22023', message = 'AI_CALL_RESULT_INVALID';
  end if;
  if target_call_id is null or coalesce(target_context_token, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'AI_CALL_TOKEN_INVALID';
  end if;
  select * into call_row from public.calls
  where id = target_call_id and call_mode = 'AUTO_AI' for update;
  if found then
    select * into job_row from public.auto_call_jobs
    where call_id = call_row.id and organization_id = call_row.organization_id for update;
  end if;
  if job_row.id is null
    or job_row.context_token_hash is distinct from
      encode(sha256(convert_to(target_context_token, 'UTF8')), 'hex') then
    raise exception using errcode = '42501', message = 'AI_CALL_TOKEN_INVALID';
  end if;

  select * into existing_row from public.auto_ivr_call_results where call_id = call_row.id;
  if existing_row.ai_outcome is not null then
    return jsonb_build_object('call_id', call_row.id, 'organization_id', call_row.organization_id,
      'branch_id', call_row.branch_id, 'answered', existing_row.answered, 'replayed', true);
  end if;

  answered := outcome in ('ANSWERED_QUALIFIED', 'CALLBACK_REQUESTED', 'NOT_INTERESTED',
    'DO_NOT_CALL', 'WRONG_NUMBER');
  result_language := case when target_language in ('en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'ml-IN')
    then target_language else job_row.language end;

  -- Only known fields with valid values become suggestions; anything else
  -- the model reported is dropped.
  if answered then
    for answer_item in select key, value from jsonb_each(coalesce(target_answers, '{}'::jsonb)) loop
      if answer_item.key = any (supported_fields)
        and app_private.auto_ivr_field_value_valid(answer_item.key, answer_item.value) then
        suggestion_map := suggestion_map || jsonb_build_object(answer_item.key, answer_item.value);
      end if;
    end loop;
    case outcome
      when 'DO_NOT_CALL' then
        suggestion_map := jsonb_build_object('temperature', 'DORMANT');
      when 'WRONG_NUMBER' then
        suggestion_map := jsonb_build_object('not_interested', 'Wrong number (AI call)');
      when 'NOT_INTERESTED' then
        if not suggestion_map ? 'not_interested' then
          suggestion_map := suggestion_map || jsonb_build_object('not_interested', 'Not interested (AI call)');
        end if;
      when 'CALLBACK_REQUESTED' then
        suggestion_map := suggestion_map || jsonb_build_object('callback_requested', true);
      else null;
    end case;
  end if;

  insert into public.auto_ivr_call_results (
    call_id, organization_id, lead_id, flow_version_id, mode, answered, suggestions,
    ai_outcome, summary, language
  ) values (
    call_row.id, call_row.organization_id, call_row.lead_id, null, 'AI_AGENT', answered,
    suggestion_map, outcome, summary_text, result_language
  )
  on conflict (call_id) do update set
    answered = excluded.answered,
    suggestions = excluded.suggestions,
    ai_outcome = excluded.ai_outcome,
    summary = excluded.summary,
    language = excluded.language,
    updated_at = now();

  if answered then
    perform app_private.mark_auto_call_contact(call_row.id);
  end if;

  if (jsonb_typeof(target_turns) = 'array' and jsonb_array_length(target_turns) > 0)
    or summary_text is not null then
    -- A malformed transcript must not lose the outcome and the suggestions.
    begin
      perform public.save_provider_call_intelligence(
        call_row.organization_id, call_row.id, 'AI_AGENT', null,
        coalesce(target_turns, '[]'::jsonb), summary_text, result_language,
        call_row.provider_call_id);
      transcript_saved := true;
    exception when sqlstate '22023' then
      transcript_saved := false;
    end;
  end if;

  select settings_row.ai_credit_cost into credit_cost from public.auto_call_settings settings_row
  where settings_row.organization_id = call_row.organization_id;
  if answered and coalesce(credit_cost, 0) > 0 then
    begin
      perform public.commit_ai_credit_reservation(public.reserve_ai_credits(
        call_row.organization_id, credit_cost, 'AI_AUTO_CALL', 'auto_ai_call:' || call_row.id::text));
    exception when sqlstate 'P0001' then
      charge_error := 'AI_CREDITS_EXHAUSTED';
      update public.auto_call_dialers set paused_reason = 'AI_CREDITS_EXHAUSTED', updated_at = now()
      where organization_id = call_row.organization_id and user_id = call_row.assigned_user_id;
    end;
  end if;

  finalized := app_private.finalize_auto_ai_call_internal(
    call_row.id, 'COMPLETED',
    case when target_duration_seconds between 0 and 86400 then target_duration_seconds end,
    null, null, true);

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    call_row.organization_id, null, 'call.auto_ai_result_recorded', 'call', call_row.id::text,
    call_row.branch_id,
    jsonb_build_object('lead_id', call_row.lead_id, 'ai_outcome', outcome,
      'language', result_language, 'transcript_saved', transcript_saved,
      'credit_error', charge_error,
      'suggested_fields', (select coalesce(jsonb_agg(key), '[]'::jsonb)
        from jsonb_object_keys(suggestion_map) key))
  );
  return finalized || jsonb_build_object('replayed', false, 'credit_error', charge_error);
end;
$$;

-- -------------------------------------------------------------- admin and lead

create function public.save_auto_call_ai_settings(
  target_mode text,
  target_ai_script jsonb,
  target_ai_credit_cost integer,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  current_row public.auto_call_settings%rowtype;
  script_error text := app_private.auto_ai_script_error(target_ai_script);
  next_version bigint;
begin
  if not app_private.can_manage_auto_call(current_organization_id) then
    raise exception using errcode = '42501', message = 'AUTO_CALL_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_mode not in ('KEYPAD_IVR', 'AI_AGENT')
    or target_ai_credit_cost is null or target_ai_credit_cost not between 0 and 100 then
    raise exception using errcode = '22023', message = 'AUTO_CALL_SETTINGS_INVALID';
  end if;
  if (target_mode = 'AI_AGENT' or target_ai_script is not null) and script_error is not null then
    raise exception using errcode = '22023', message = script_error;
  end if;

  select * into current_row from public.auto_call_settings
  where organization_id = current_organization_id for update;
  if (found and current_row.version is distinct from expected_version)
    or (not found and expected_version is not null) then
    raise exception using errcode = 'PT409', message = 'AUTO_CALL_SETTINGS_VERSION_CONFLICT';
  end if;
  -- Keypad mode needs a published flow before it can stay switched on.
  if target_mode = 'KEYPAD_IVR' and coalesce(current_row.enabled, false)
    and current_row.default_flow_id is null then
    raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_REQUIRED';
  end if;
  next_version := coalesce(current_row.version, 0) + 1;

  insert into public.auto_call_settings as settings_row (
    organization_id, mode, ai_script, ai_credit_cost, version, updated_by, updated_at
  ) values (
    current_organization_id, target_mode, target_ai_script, target_ai_credit_cost,
    next_version, auth.uid(), now()
  )
  on conflict (organization_id) do update set
    mode = excluded.mode,
    ai_script = excluded.ai_script,
    ai_credit_cost = excluded.ai_credit_cost,
    version = excluded.version,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  update public.auto_call_dialers set paused_reason = null, consecutive_failures = 0, updated_at = now()
  where organization_id = current_organization_id
    and paused_reason in ('AI_SCRIPT_MISSING', 'AI_AGENT_NOT_CONFIGURED', 'AUTO_IVR_FLOW_NOT_PUBLISHED');

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'auto_call.ai_settings_saved', 'organization',
    current_organization_id::text,
    jsonb_build_object('mode', target_mode, 'ai_credit_cost', target_ai_credit_cost,
      'languages', target_ai_script->'languages',
      'question_count', case when jsonb_typeof(target_ai_script->'questions') = 'array'
        then jsonb_array_length(target_ai_script->'questions') end,
      'version', next_version)
  );
  return jsonb_build_object('version', next_version);
end;
$$;

create function public.set_lead_call_language(target_lead_id uuid, target_language text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
  next_language text := nullif(btrim(coalesce(target_language, '')), '');
begin
  if auth.uid() is null or target_lead_id is null
    or (next_language is not null
      and next_language not in ('en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'ml-IN')) then
    raise exception using errcode = '22023', message = 'LEAD_CALL_LANGUAGE_INVALID';
  end if;
  select * into lead_row from public.leads
  where id = target_lead_id and deleted_at is null for update;
  if not found or not app_private.has_permission(lead_row.organization_id, 'lead.update')
    or not app_private.can_access_record(lead_row.organization_id, lead_row.branch_id,
      lead_row.team_id, lead_row.assigned_user_id) then
    raise exception using errcode = '42501', message = 'LEAD_UPDATE_PERMISSION_REQUIRED';
  end if;
  if lead_row.call_language is not distinct from next_language then
    return jsonb_build_object('lead_id', lead_row.id, 'call_language', next_language, 'changed', false);
  end if;
  update public.leads set
    call_language = next_language,
    updated_at = greatest(clock_timestamp(), lead_row.updated_at + interval '1 microsecond')
  where id = lead_row.id and organization_id = lead_row.organization_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    lead_row.organization_id, auth.uid(), 'lead.call_language_changed', 'lead', lead_row.id::text,
    lead_row.branch_id, jsonb_build_object('from', lead_row.call_language, 'to', next_language)
  );
  return jsonb_build_object('lead_id', lead_row.id, 'call_language', next_language, 'changed', true);
end;
$$;

-- -------------------------------------------------------------- patches

create function pg_temp.patch_function(
  target regprocedure,
  marker text,
  anchors text[],
  replacements text[]
)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  i integer;
begin
  if position(marker in definition) > 0 then
    raise exception '% already patched', target;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], ''))) / length(anchors[i]) <> 1 then
      raise exception '% anchor % not found exactly once', target, i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
  if position(marker in pg_get_functiondef(target)) = 0 then
    raise exception '% patch did not land', target;
  end if;
end;
$$;

-- AI calls count as auto calls wherever a contact is marked or reviewed.
select pg_temp.patch_function(
  'app_private.mark_auto_call_contact(uuid)'::regprocedure,
  E'call_mode in (''AUTO_IVR'', ''AUTO_AI'')',
  array[E'  where id = target_call_id and call_mode = ''AUTO_IVR'' for update;'],
  array[E'  where id = target_call_id and call_mode in (''AUTO_IVR'', ''AUTO_AI'') for update;']
);

select pg_temp.patch_function(
  'public.verify_auto_contact(uuid)'::regprocedure,
  E'call_mode in (''AUTO_IVR'', ''AUTO_AI'')',
  array[E'where id = target_call_id and call_mode = ''AUTO_IVR'';'],
  array[E'where id = target_call_id and call_mode in (''AUTO_IVR'', ''AUTO_AI'');']
);

select pg_temp.patch_function(
  'public.apply_auto_call_suggestions(uuid,text[],uuid)'::regprocedure,
  E'call_mode in (''AUTO_IVR'', ''AUTO_AI'')',
  array[
    E'not between 1 and 8 then',
    E'where id = target_call_id and call_mode = ''AUTO_IVR'';'
  ],
  array[
    E'not between 1 and 10 then',
    E'where id = target_call_id and call_mode in (''AUTO_IVR'', ''AUTO_AI'');'
  ]
);

select pg_temp.patch_function(
  'public.get_auto_call_result(uuid)'::regprocedure,
  E'''transcript''',
  array[
    E'  where id = target_call_id and call_mode = ''AUTO_IVR'';',
    E'    ''call'', jsonb_build_object(\n      ''id'', call_row.id,\n',
    E'        ''purchase_timeline'', requirements_row.purchase_timeline,\n',
    E'    ''applied'', coalesce(result_row.applied, ''{}''::jsonb),\n'
  ],
  array[
    E'  where id = target_call_id and call_mode in (''AUTO_IVR'', ''AUTO_AI'');',
    E'    ''call'', jsonb_build_object(\n      ''id'', call_row.id,\n'
      || E'      ''mode'', case when call_row.call_mode = ''AUTO_AI'' then ''AI_AGENT'' else ''KEYPAD_IVR'' end,\n',
    E'        ''purchase_timeline'', requirements_row.purchase_timeline,\n'
      || E'        ''variant'', requirements_row.variant,\n'
      || E'        ''budget_max'', requirements_row.budget_max,\n',
    E'    ''applied'', coalesce(result_row.applied, ''{}''::jsonb),\n'
      || E'    ''ai'', case when call_row.call_mode = ''AUTO_AI'' then jsonb_build_object(\n'
      || E'      ''outcome'', result_row.ai_outcome,\n'
      || E'      ''summary'', result_row.summary,\n'
      || E'      ''language'', result_row.language\n'
      || E'    ) end,\n'
      || E'    ''transcript'', (\n'
      || E'      select transcript_row.speaker_turns from public.call_transcripts transcript_row\n'
      || E'      where transcript_row.organization_id = call_row.organization_id\n'
      || E'        and transcript_row.call_id = call_row.id and transcript_row.source = ''AI_AGENT''\n'
      || E'      limit 1\n'
      || E'    ),\n'
  ]
);

select pg_temp.patch_function(
  'public.get_my_auto_calls(integer,integer)'::regprocedure,
  E'''ai_outcome''',
  array[E'          ''status'', job_row.status,\n'],
  array[E'          ''status'', job_row.status,\n'
    || E'          ''mode'', job_row.mode,\n'
    || E'          ''ai_outcome'', (select result_row.ai_outcome from public.auto_ivr_call_results result_row\n'
    || E'            where result_row.call_id = job_row.call_id),\n']
);

select pg_temp.patch_function(
  'public.get_my_auto_call_status()'::regprocedure,
  E'''AI_SCRIPT_MISSING''',
  array[
    E'    when not exists (\n      select 1 from public.auto_ivr_flows flow_row\n',
    E'    ''available'', true,\n'
  ],
  array[
    E'    when settings_row.mode = ''AI_AGENT''\n'
      || E'      and app_private.auto_ai_script_error(settings_row.ai_script) is not null\n'
      || E'      then ''AI_SCRIPT_MISSING''\n'
      || E'    when coalesce(settings_row.mode, ''KEYPAD_IVR'') = ''KEYPAD_IVR'' and not exists (\n'
      || E'      select 1 from public.auto_ivr_flows flow_row\n',
    E'    ''available'', true,\n'
      || E'    ''mode'', coalesce(settings_row.mode, ''KEYPAD_IVR''),\n'
  ]
);

select pg_temp.patch_function(
  'public.set_my_auto_call(boolean)'::regprocedure,
  E'''AI_SCRIPT_MISSING''',
  array[E'    if not exists (\n      select 1 from public.auto_ivr_flows flow_row\n'],
  array[E'    if settings_row.mode = ''AI_AGENT'' then\n'
    || E'      if app_private.auto_ai_script_error(settings_row.ai_script) is not null then\n'
    || E'        raise exception using errcode = ''22023'', message = ''AI_SCRIPT_MISSING'';\n'
    || E'      end if;\n'
    || E'    elsif not exists (\n      select 1 from public.auto_ivr_flows flow_row\n']
);

select pg_temp.patch_function(
  'public.save_auto_call_settings(boolean,uuid,time,time,integer,integer,integer,integer,bigint)'::regprocedure,
  E'''AI_SCRIPT_MISSING''',
  array[
    E'  if target_enabled and target_default_flow_id is null then\n',
    E'    and paused_reason in (''AUTO_IVR_FLOW_NOT_PUBLISHED'', ''AUTO_CALL_DISABLED'');'
  ],
  array[
    E'  if target_enabled and exists (\n'
      || E'    select 1 from public.auto_call_settings ai_settings\n'
      || E'    where ai_settings.organization_id = current_organization_id\n'
      || E'      and ai_settings.mode = ''AI_AGENT''\n'
      || E'      and app_private.auto_ai_script_error(ai_settings.ai_script) is not null\n'
      || E'  ) then\n'
      || E'    raise exception using errcode = ''22023'', message = ''AI_SCRIPT_MISSING'';\n'
      || E'  end if;\n'
      || E'  if target_enabled and target_default_flow_id is null and coalesce((\n'
      || E'    select ai_settings.mode from public.auto_call_settings ai_settings\n'
      || E'    where ai_settings.organization_id = current_organization_id\n'
      || E'  ), ''KEYPAD_IVR'') = ''KEYPAD_IVR'' then\n',
    E'    and paused_reason in (''AUTO_IVR_FLOW_NOT_PUBLISHED'', ''AUTO_CALL_DISABLED'', ''AI_SCRIPT_MISSING'');'
  ]
);

select pg_temp.patch_function(
  'public.get_auto_call_admin_workspace()'::regprocedure,
  E'''ai_credit_balance''',
  array[
    E'    ''organization_id'', current_organization_id,\n',
    E'      ''enabled'', coalesce(settings_row.enabled, false),\n',
    E'        ''caller_id_label'', connection_row.connection_config->>''caller_id_label'',\n'
  ],
  array[
    E'    ''organization_id'', current_organization_id,\n'
      || E'    ''ai_credit_balance'', coalesce((select balance_row.balance from public.credit_balances balance_row\n'
      || E'      where balance_row.organization_id = current_organization_id\n'
      || E'        and balance_row.ledger_kind = ''AI''), 0),\n',
    E'      ''enabled'', coalesce(settings_row.enabled, false),\n'
      || E'      ''mode'', coalesce(settings_row.mode, ''KEYPAD_IVR''),\n'
      || E'      ''ai_script'', settings_row.ai_script,\n'
      || E'      ''ai_credit_cost'', coalesce(settings_row.ai_credit_cost, 1),\n',
    E'        ''caller_id_label'', connection_row.connection_config->>''caller_id_label'',\n'
      || E'        ''agent_id'', connection_row.connection_config->>''agent_id'',\n'
  ]
);

-- The agent already transcribed and summarised an AI call; Groq would only
-- repeat it and spend credits again.
select pg_temp.patch_function(
  'app_private.enqueue_ai_call_processing()'::regprocedure,
  E'call_mode <> ''AUTO_AI''',
  array[E'    and call_source in (''PROVIDER'', ''PERSONAL_MANUAL'');'],
  array[E'    and call_source in (''PROVIDER'', ''PERSONAL_MANUAL'')\n    and call_mode <> ''AUTO_AI'';']
);

-- -------------------------------------------------------------- grants

revoke all on function app_private.auto_ai_script_error(jsonb) from public, anon, authenticated;
revoke all on function app_private.finalize_auto_ai_call_internal(uuid, text, integer, text, text, boolean) from public, anon, authenticated;

revoke all on function public.finalize_auto_ai_call(uuid, uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.get_auto_ai_call_context(uuid, text) from public, anon, authenticated;
revoke all on function public.record_auto_ai_call_result(uuid, text, text, text, text, jsonb, jsonb, integer) from public, anon, authenticated;
grant execute on function public.finalize_auto_ai_call(uuid, uuid, text, integer, text) to service_role;
grant execute on function public.get_auto_ai_call_context(uuid, text) to service_role;
grant execute on function public.record_auto_ai_call_result(uuid, text, text, text, text, jsonb, jsonb, integer) to service_role;

revoke all on function public.save_auto_call_ai_settings(text, jsonb, integer, bigint) from public, anon;
revoke all on function public.set_lead_call_language(uuid, text) from public, anon;
grant execute on function public.save_auto_call_ai_settings(text, jsonb, integer, bigint) to authenticated;
grant execute on function public.set_lead_call_language(uuid, text) to authenticated;

commit;
