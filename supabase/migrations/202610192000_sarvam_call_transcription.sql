-- Call transcription on the platform's Sarvam + Groq (product decision 2026-10-19).
--
-- Sarvam batch speech-to-text (with speaker separation) replaces Groq Whisper;
-- Groq's LLM translates to English and writes the summary and suggestions.
-- Every tenant uses the platform keys and pays in AI credits: the price is
-- Sarvam's cost plus the platform margin, at the platform's rupee value of a
-- credit, so a call costs what its audio length costs.
--
-- A Sarvam job runs for seconds to minutes, so the worker no longer waits for
-- it: it submits, parks the job in WAITING_PROVIDER and collects the result on
-- a later per-minute pass. A poll does not use up one of the seven attempts.

begin;

-- ---------------------------------------------------------------------------
-- Pricing: one platform row, read only by definer functions.
-- ---------------------------------------------------------------------------

create table if not exists public.platform_ai_call_pricing (
  id boolean primary key default true check (id),
  stt_inr_per_hour numeric(10, 2) not null check (stt_inr_per_hour > 0),
  margin_percent numeric(6, 2) not null check (margin_percent between 0 and 500),
  inr_per_credit numeric(10, 4) not null check (inr_per_credit > 0),
  updated_at timestamptz not null default now()
);
alter table public.platform_ai_call_pricing enable row level security;
revoke all on table public.platform_ai_call_pricing from public, anon, authenticated;

-- Sarvam speech-to-text with diarization: ₹45/hour, billed per second.
-- 30 % margin, 1 credit = ₹1.
insert into public.platform_ai_call_pricing (id, stt_inr_per_hour, margin_percent, inr_per_credit)
values (true, 45, 30, 1)
on conflict (id) do nothing;

create or replace function app_private.ai_call_credit_cost(target_seconds integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(1, ceil(
    least(greatest(coalesce(target_seconds, 0), 1), 86400)::numeric / 3600
      * pricing.stt_inr_per_hour * (1 + pricing.margin_percent / 100)
      / pricing.inr_per_credit
  ))::integer
  from public.platform_ai_call_pricing pricing
  where pricing.id;
$$;
revoke all on function app_private.ai_call_credit_cost(integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Job state for the provider round trip.
-- ---------------------------------------------------------------------------

alter table public.ai_call_processing_jobs
  add column if not exists provider_job_id text,
  add column if not exists provider_submitted_at timestamptz,
  add column if not exists provider_poll_after timestamptz,
  add column if not exists provider_poll_count integer not null default 0,
  add column if not exists audio_duration_seconds integer,
  add column if not exists credits_held integer,
  add column if not exists generation integer not null default 1;

alter table public.ai_call_processing_jobs
  drop constraint if exists ai_call_processing_jobs_status_check;
alter table public.ai_call_processing_jobs
  add constraint ai_call_processing_jobs_status_check
  check (status in ('QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'COMPLETED', 'RETRY', 'FAILED'));
alter table public.ai_call_processing_jobs
  drop constraint if exists ai_call_processing_jobs_provider_poll_count_check;
alter table public.ai_call_processing_jobs
  add constraint ai_call_processing_jobs_provider_poll_count_check
  check (provider_poll_count between 0 and 1000);
alter table public.ai_call_processing_jobs
  drop constraint if exists ai_call_processing_jobs_audio_duration_check;
alter table public.ai_call_processing_jobs
  add constraint ai_call_processing_jobs_audio_duration_check
  check (audio_duration_seconds is null or audio_duration_seconds between 0 and 86400);
alter table public.ai_call_processing_jobs
  drop constraint if exists ai_call_processing_jobs_credits_held_check;
alter table public.ai_call_processing_jobs
  add constraint ai_call_processing_jobs_credits_held_check
  check (credits_held is null or credits_held between 1 and 100000);

create index if not exists ai_call_processing_jobs_provider_poll_idx
  on public.ai_call_processing_jobs (provider_poll_after, id)
  where status = 'WAITING_PROVIDER';

-- Reservations of one job share this prefix (the generation keeps a
-- regenerated run from reusing a committed charge).
create or replace function app_private.ai_call_job_reference_prefix(
  job_row public.ai_call_processing_jobs
)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'ai-call:' || job_row.id::text || ':' || job_row.recording_id::text || ':';
$$;
revoke all on function app_private.ai_call_job_reference_prefix(public.ai_call_processing_jobs)
  from public, anon, authenticated;

create or replace function app_private.reverse_ai_call_job_reservations(
  job_row public.ai_call_processing_jobs,
  target_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation_row record;
  reversed integer := 0;
begin
  for reservation_row in
    select reservation.id
    from public.ai_credit_reservations reservation
    where reservation.organization_id = job_row.organization_id
      and reservation.status = 'RESERVED'
      and left(reservation.reference_id, char_length(
        app_private.ai_call_job_reference_prefix(job_row)
      )) = app_private.ai_call_job_reference_prefix(job_row)
    for update
  loop
    perform app_private.reverse_ai_credit_reservation(reservation_row.id, target_reason);
    reversed := reversed + 1;
  end loop;
  return reversed;
end;
$$;
revoke all on function app_private.reverse_ai_call_job_reservations(
  public.ai_call_processing_jobs, text
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Worker RPCs (service role).
-- ---------------------------------------------------------------------------

drop function if exists public.claim_ai_call_processing_jobs(text, integer);
create function public.claim_ai_call_processing_jobs(
  target_worker_id text,
  target_batch_size integer default 2
)
returns table (
  id uuid, organization_id uuid, branch_id uuid, call_id uuid, lead_id uuid,
  recording_id uuid, lease_token uuid, object_bucket text, object_key text, mime_type text,
  size_bytes bigint, known_duration_seconds integer, provider_job_id text,
  provider_submitted_at timestamptz, provider_poll_count integer, credits_held integer,
  generation integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_worker_id), '') is null
    or target_batch_size not between 1 and 10 then
    raise exception using errcode = '22023', message = 'INVALID_AI_CALL_CLAIM';
  end if;
  return query
  with candidates as (
    select job_row.id
    from public.ai_call_processing_jobs job_row
    where (
      (job_row.status in ('QUEUED', 'RETRY') and job_row.attempt_count < 7)
      or (job_row.status = 'WAITING_PROVIDER' and job_row.provider_poll_after <= now())
      or (
        job_row.status = 'PROCESSING'
        and job_row.lease_expires_at < now()
        and job_row.attempt_count <= 7
      )
    )
    order by job_row.created_at, job_row.id
    limit target_batch_size
    for update skip locked
  ), claimed as (
    update public.ai_call_processing_jobs job_row
    set status = 'PROCESSING',
        -- Collecting a submitted Sarvam job is not a new attempt.
        attempt_count = case when job_row.status = 'WAITING_PROVIDER'
          then job_row.attempt_count else least(7, job_row.attempt_count + 1) end,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + interval '15 minutes',
        safe_error_code = null,
        updated_at = now()
    from candidates
    where job_row.id = candidates.id
    returning job_row.*
  )
  select claimed.id, claimed.organization_id, claimed.branch_id, claimed.call_id,
    call_row.lead_id, claimed.recording_id, claimed.lease_token,
    file_row.bucket, file_row.object_key, file_row.mime_type, file_row.size_bytes,
    coalesce(claimed.audio_duration_seconds, recording_row.duration_seconds, call_row.duration_seconds),
    claimed.provider_job_id, claimed.provider_submitted_at, claimed.provider_poll_count,
    claimed.credits_held, claimed.generation
  from claimed
  join public.calls call_row
    on call_row.id = claimed.call_id
   and call_row.organization_id = claimed.organization_id
  join public.call_recordings recording_row
    on recording_row.id = claimed.recording_id
   and recording_row.organization_id = claimed.organization_id
  join public.object_files file_row
    on file_row.id = recording_row.object_file_id
   and file_row.organization_id = claimed.organization_id
   and file_row.resource_type = 'call'
   and file_row.resource_id = claimed.call_id
   and file_row.deleted_at is null;
end;
$$;
revoke all on function public.claim_ai_call_processing_jobs(text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_call_processing_jobs(text, integer) to service_role;

-- The worker calls this after reserving the hold and starting the Sarvam job.
-- The held amount is kept so the settlement finds the same reservation.
create or replace function public.record_ai_call_provider_submission(
  target_job_id uuid,
  target_lease_token uuid,
  target_provider_job_id text,
  target_credits_held integer
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
  if nullif(btrim(target_provider_job_id), '') is null
    or char_length(target_provider_job_id) > 200
    or target_credits_held is null or target_credits_held not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'INVALID_PROVIDER_JOB_ID';
  end if;
  update public.ai_call_processing_jobs set
    status = 'WAITING_PROVIDER',
    provider_job_id = btrim(target_provider_job_id),
    provider_submitted_at = now(),
    provider_poll_after = now() + interval '30 seconds',
    provider_poll_count = 0,
    credits_held = target_credits_held,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING';
  return found;
end;
$$;
revoke all on function public.record_ai_call_provider_submission(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.record_ai_call_provider_submission(uuid, uuid, text, integer) to service_role;

-- Sarvam is still working: look again later, backing off to two minutes.
create or replace function public.defer_ai_call_provider_poll(
  target_job_id uuid,
  target_lease_token uuid
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
  update public.ai_call_processing_jobs set
    status = 'WAITING_PROVIDER',
    provider_poll_count = least(1000, provider_poll_count + 1),
    provider_poll_after = now() + make_interval(
      secs => least(120, 30 * (1 + least(provider_poll_count, 3)))
    ),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING'
    and provider_job_id is not null;
  return found;
end;
$$;
revoke all on function public.defer_ai_call_provider_poll(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.defer_ai_call_provider_poll(uuid, uuid) to service_role;

-- Ends a job now (not enough credits, the provider rejected the audio, or it
-- never finished) and returns any held credits.
create or replace function public.fail_ai_call_processing_job(
  target_job_id uuid,
  target_lease_token uuid,
  target_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare job_row public.ai_call_processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into job_row from public.ai_call_processing_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING'
  for update;
  if not found then return false; end if;
  update public.ai_call_processing_jobs set
    status = 'FAILED',
    safe_error_code = left(coalesce(nullif(btrim(target_safe_error_code), ''),
      'AI_CALL_PROCESSING_FAILED'), 100),
    lease_token = null, lease_expires_at = null, provider_poll_after = null,
    updated_at = now()
  where id = job_row.id;
  perform app_private.reverse_ai_call_job_reservations(
    job_row, 'AI call processing ended without a result'
  );
  return true;
end;
$$;
revoke all on function public.fail_ai_call_processing_job(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_ai_call_processing_job(uuid, uuid, text) to service_role;

-- Same contract as before; the final attempt now returns every hold of the
-- job, including the Sarvam hold, not only the two original references.
create or replace function public.retry_ai_call_processing_job(
  target_job_id uuid,
  target_lease_token uuid,
  target_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare job_row public.ai_call_processing_jobs%rowtype; final_failure boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into job_row from public.ai_call_processing_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING'
  for update;
  if not found then return false; end if;
  final_failure := job_row.attempt_count >= 7;
  update public.ai_call_processing_jobs set
    status = case when final_failure then 'FAILED' else 'RETRY' end,
    safe_error_code = left(coalesce(nullif(btrim(target_safe_error_code), ''),
      'AI_CALL_PROCESSING_RETRY'), 100),
    lease_token = null, lease_expires_at = null, provider_poll_after = null,
    updated_at = now()
  where id = job_row.id;
  if final_failure then
    perform app_private.reverse_ai_call_job_reservations(
      job_row, 'AI call processing exhausted its bounded retries'
    );
  end if;
  return true;
end;
$$;

-- The Sarvam result: the original-language transcript and its diarized turns
-- (speaker roles not yet known). A regenerated run overwrites the last one.
create or replace function public.save_ai_call_provider_transcript(
  target_job_id uuid,
  target_lease_token uuid,
  target_raw_transcript text,
  target_language text,
  target_speaker_turns jsonb,
  target_audio_duration_seconds integer,
  target_provider_reference text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare job_row public.ai_call_processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_raw_transcript), '') is null
    or char_length(target_raw_transcript) > 1000000
    or char_length(coalesce(target_language, '')) > 20
    or jsonb_typeof(target_speaker_turns) <> 'array'
    or jsonb_array_length(target_speaker_turns) > 10000
    or target_audio_duration_seconds is null
    or target_audio_duration_seconds not between 0 and 86400
    or nullif(btrim(target_provider_reference), '') is null
    or char_length(target_provider_reference) > 200 then
    raise exception using errcode = '22023', message = 'INVALID_AI_TRANSCRIPTION_RESULT';
  end if;
  select * into job_row from public.ai_call_processing_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING'
  for update;
  if not found then return false; end if;
  update public.ai_call_processing_jobs set
    audio_duration_seconds = target_audio_duration_seconds, updated_at = now()
  where id = job_row.id;
  update public.call_recordings set duration_seconds = target_audio_duration_seconds
  where id = job_row.recording_id and organization_id = job_row.organization_id
    and duration_seconds is null;
  insert into public.call_transcripts (
    organization_id, call_id, processing_job_id, raw_transcript_text, transcript_text,
    language, speaker_turns, speaker_separation_method, provider_reference, status, updated_at
  ) values (
    job_row.organization_id, job_row.call_id, job_row.id, btrim(target_raw_transcript),
    btrim(target_raw_transcript), nullif(btrim(target_language), ''), target_speaker_turns,
    'PROVIDER_DIARIZATION', btrim(target_provider_reference), 'TRANSCRIBED', now()
  ) on conflict (organization_id, processing_job_id) do update set
    raw_transcript_text = excluded.raw_transcript_text,
    transcript_text = excluded.transcript_text,
    language = excluded.language,
    speaker_turns = excluded.speaker_turns,
    speaker_separation_method = excluded.speaker_separation_method,
    provider_reference = excluded.provider_reference,
    status = 'TRANSCRIBED',
    updated_at = now();
  return true;
end;
$$;
revoke all on function public.save_ai_call_provider_transcript(
  uuid, uuid, text, text, jsonb, integer, text
) from public, anon, authenticated;
grant execute on function public.save_ai_call_provider_transcript(
  uuid, uuid, text, text, jsonb, integer, text
) to service_role;

-- What the worker reserves for a duration: one price, shared with the UI.
create or replace function public.quote_ai_call_credits(target_seconds integer)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return app_private.ai_call_credit_cost(target_seconds);
end;
$$;
revoke all on function public.quote_ai_call_credits(integer) from public, anon, authenticated;
grant execute on function public.quote_ai_call_credits(integer) to service_role;

-- ---------------------------------------------------------------------------
-- User-facing RPCs.
-- ---------------------------------------------------------------------------

-- A regenerated run starts a new generation, so it is charged again and its
-- Sarvam job is submitted afresh.
create or replace function public.request_call_ai_processing(
  target_call_id uuid,
  target_regenerate boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  recording_row public.call_recordings%rowtype;
  job_row public.ai_call_processing_jobs%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into call_row from public.calls where id = target_call_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
  end if;
  if not app_private.can_update_own_manual_call(call_row.organization_id, call_row.assigned_user_id)
    or not app_private.can_access_call(call_row.organization_id, call_row.id)
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if call_row.call_source not in ('PROVIDER', 'PERSONAL_MANUAL') or call_row.call_mode = 'AUTO_AI' then
    raise exception using errcode = '22023', message = 'CALL_AI_NOT_SUPPORTED';
  end if;

  select * into recording_row
  from public.call_recordings recording
  where recording.organization_id = call_row.organization_id
    and recording.call_id = call_row.id
    and recording.status = 'READY'
    and recording.object_file_id is not null
  order by recording.created_at desc, recording.id desc
  limit 1;
  if not found then
    raise exception using errcode = '22023', message = 'CALL_RECORDING_NOT_READY';
  end if;

  select * into job_row
  from public.ai_call_processing_jobs job
  where job.organization_id = call_row.organization_id
    and job.call_id = call_row.id
    and job.recording_id = recording_row.id
  for update;

  if found and job_row.status in ('QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRY') then
    return jsonb_build_object(
      'job_id', job_row.id,
      'status', case when job_row.status = 'WAITING_PROVIDER' then 'PROCESSING' else job_row.status end,
      'queued', false
    );
  end if;
  if found and job_row.status = 'COMPLETED' and not coalesce(target_regenerate, false) then
    raise exception using errcode = 'PT409', message = 'AI_ALREADY_DONE';
  end if;

  if found then
    update public.ai_call_processing_jobs set
      status = 'QUEUED',
      attempt_count = 0,
      lease_token = null,
      lease_expires_at = null,
      safe_error_code = null,
      completed_at = null,
      provider_job_id = null,
      provider_submitted_at = null,
      provider_poll_after = null,
      provider_poll_count = 0,
      credits_held = null,
      audio_duration_seconds = null,
      generation = job_row.generation + 1,
      updated_at = now()
    where id = job_row.id
    returning * into job_row;
  else
    insert into public.ai_call_processing_jobs (
      organization_id, branch_id, call_id, recording_id, status, updated_at
    ) values (
      call_row.organization_id, call_row.branch_id, call_row.id, recording_row.id, 'QUEUED', now()
    ) returning * into job_row;
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    call_row.organization_id, auth.uid(), 'call.ai_processing_requested', 'call',
    call_row.id::text, call_row.branch_id,
    jsonb_build_object(
      'job_id', job_row.id,
      'recording_id', recording_row.id,
      'regenerate', coalesce(target_regenerate, false),
      'generation', job_row.generation
    )
  );

  return jsonb_build_object('job_id', job_row.id, 'status', job_row.status, 'queued', true);
end;
$$;
revoke all on function public.request_call_ai_processing(uuid, boolean) from public, anon;
grant execute on function public.request_call_ai_processing(uuid, boolean) to authenticated;

-- WAITING_PROVIDER stays internal: clients see PROCESSING. The estimate is the
-- price of the known call length; unknown length shows no number.
create or replace function public.get_call_ai_processing_state(target_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  recording_row public.call_recordings%rowtype;
  job_row public.ai_call_processing_jobs%rowtype;
  transcript_status text;
  has_summary boolean;
  extraction_row public.ai_extraction_runs%rowtype;
  can_update boolean;
  visible_lead_id uuid;
  known_seconds integer;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into call_row from public.calls where id = target_call_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
  end if;
  if not app_private.has_permission(call_row.organization_id, 'call.view')
    or not app_private.can_access_record(
      call_row.organization_id, call_row.branch_id, call_row.team_id, call_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  select * into recording_row
  from public.call_recordings recording
  where recording.organization_id = call_row.organization_id
    and recording.call_id = call_row.id
    and recording.status = 'READY'
    and recording.object_file_id is not null
  order by recording.created_at desc, recording.id desc
  limit 1;

  if recording_row.id is not null then
    select * into job_row
    from public.ai_call_processing_jobs job
    where job.organization_id = call_row.organization_id
      and job.call_id = call_row.id
      and job.recording_id = recording_row.id;
  end if;

  select transcript.status into transcript_status
  from public.call_transcripts transcript
  where transcript.organization_id = call_row.organization_id
    and transcript.call_id = call_row.id
  order by transcript.created_at desc, transcript.id desc
  limit 1;

  has_summary := exists (
    select 1 from public.ai_call_summaries summary
    where summary.organization_id = call_row.organization_id
      and summary.call_id = call_row.id
  );

  select * into extraction_row
  from public.ai_extraction_runs extraction
  where extraction.organization_id = call_row.organization_id
    and extraction.call_id = call_row.id
  order by extraction.created_at desc, extraction.id desc
  limit 1;

  can_update := app_private.can_update_own_manual_call(
    call_row.organization_id, call_row.assigned_user_id
  ) and call_row.call_source in ('PROVIDER', 'PERSONAL_MANUAL')
    and call_row.call_mode <> 'AUTO_AI';

  if call_row.lead_id is not null
    and app_private.has_permission(call_row.organization_id, 'lead.view')
    and app_private.can_access_lead(call_row.lead_id)
  then
    visible_lead_id := call_row.lead_id;
  end if;

  known_seconds := coalesce(
    job_row.audio_duration_seconds, recording_row.duration_seconds, call_row.duration_seconds
  );

  return jsonb_build_object(
    'call_id', call_row.id,
    'lead_id', visible_lead_id,
    'phone', call_row.normalized_caller_phone,
    'call_source', call_row.call_source,
    'recording_ready', recording_row.id is not null,
    'job', case when job_row.id is null then null else jsonb_build_object(
      'id', job_row.id,
      'status', case when job_row.status = 'WAITING_PROVIDER' then 'PROCESSING' else job_row.status end,
      'safe_error_code', job_row.safe_error_code,
      'updated_at', job_row.updated_at,
      'completed_at', job_row.completed_at
    ) end,
    'transcript_status', transcript_status,
    'has_summary', has_summary,
    'extraction_run_id', extraction_row.id,
    'can_request', can_update
      and recording_row.id is not null
      and (job_row.id is null or job_row.status = 'FAILED'),
    'can_regenerate', can_update and coalesce(job_row.status = 'COMPLETED', false),
    'can_create_lead', call_row.lead_id is null
      and call_row.normalized_caller_phone is not null
      and app_private.has_permission(call_row.organization_id, 'lead.create'),
    'auto_process', app_private.call_ai_auto_process_enabled(call_row.organization_id, auth.uid()),
    'estimated_credits', case when known_seconds is null then null
      else app_private.ai_call_credit_cost(known_seconds) end
  );
end;
$$;
revoke all on function public.get_call_ai_processing_state(uuid) from public, anon;
grant execute on function public.get_call_ai_processing_state(uuid) to authenticated;

-- Turns now carry original_text (the spoken language) beside the English
-- text; the transcript's language comes with them.
create or replace function public.get_call_speaker_transcript(target_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare call_record public.calls%rowtype; result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into call_record from public.calls where id = target_call_id;
  if not found then raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND'; end if;
  if not app_private.has_permission(call_record.organization_id, 'call.view')
    or not app_private.can_access_record(
      call_record.organization_id, call_record.branch_id,
      call_record.team_id, call_record.assigned_user_id
    ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select jsonb_build_object(
    'speaker_turns', coalesce((
      select jsonb_agg(turn_row.value order by turn_row.ordinality)
      from jsonb_array_elements(coalesce(transcript_row.speaker_turns, '[]'::jsonb))
        with ordinality as turn_row(value, ordinality)
      where turn_row.ordinality <= 500
    ), '[]'::jsonb),
    'speaker_separation_method', transcript_row.speaker_separation_method,
    'language', transcript_row.language,
    'truncated', jsonb_array_length(coalesce(transcript_row.speaker_turns, '[]'::jsonb)) > 500
  ) into result
  from public.call_transcripts transcript_row
  where transcript_row.organization_id = call_record.organization_id
    and transcript_row.call_id = call_record.id
  order by transcript_row.created_at desc, transcript_row.id desc
  limit 1;
  return coalesce(result, jsonb_build_object(
    'speaker_turns', '[]'::jsonb,
    'speaker_separation_method', null,
    'language', null,
    'truncated', false
  ));
end;
$$;

commit;
