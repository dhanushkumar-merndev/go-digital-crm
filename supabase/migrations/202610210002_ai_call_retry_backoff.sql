-- A failed AI call job waits before its next attempt (found in the 2026-10-21
-- end-to-end run: a missing provider key spent all seven attempts in about a
-- minute, because the per-minute claim picked a RETRY job up again at once).
--
-- retry_ai_call_processing_job now sets retry_after with exponential backoff
-- (1, 2, 4, 8, 16, 32 minutes), and the claim skips a RETRY job until then. A
-- person pressing Try again re-queues the job as QUEUED, which is not delayed.
--
-- A call filed from a phone recording has no duration (the file name carries
-- none), so the call screen read "Duration unavailable". The transcription
-- already learns the real audio length; it now fills calls.duration_seconds
-- too when the call has none, the same way it fills call_recordings.
-- Patched onto the live definitions (see 202610192000), never re-emitted.

begin;

alter table public.ai_call_processing_jobs
  add column if not exists retry_after timestamptz;

create function pg_temp.patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  occurrences integer := (char_length(definition) - char_length(replace(definition, old_text, ''))) / char_length(old_text);
begin
  if occurrences <> 1 then
    raise exception 'PATCH_ANCHOR_% for %: expected 1 occurrence, found %',
      md5(old_text), target, occurrences;
  end if;
  execute replace(definition, old_text, new_text);
  if position(new_text in pg_get_functiondef(target)) = 0 then
    raise exception 'PATCH_NOT_APPLIED for %', target;
  end if;
end;
$$;

select pg_temp.patch_function(
  'public.retry_ai_call_processing_job(uuid,uuid,text)',
  $old$    lease_token = null, lease_expires_at = null, provider_poll_after = null,
$old$,
  $new$    lease_token = null, lease_expires_at = null, provider_poll_after = null,
    retry_after = case when final_failure then null
      else now() + make_interval(mins => power(2, greatest(job_row.attempt_count, 1) - 1)::integer) end,
$new$
);

select pg_temp.patch_function(
  'public.claim_ai_call_processing_jobs(text,integer)',
  $old$      (job_row.status in ('QUEUED', 'RETRY') and job_row.attempt_count < 7)
$old$,
  $new$      (
        job_row.attempt_count < 7
        and (
          job_row.status = 'QUEUED'
          or (job_row.status = 'RETRY' and coalesce(job_row.retry_after, now()) <= now())
        )
      )
$new$
);

select pg_temp.patch_function(
  'public.save_ai_call_provider_transcript(uuid,uuid,text,text,jsonb,integer,text)',
  $old$  update public.call_recordings set duration_seconds = target_audio_duration_seconds
  where id = job_row.recording_id and organization_id = job_row.organization_id
    and duration_seconds is null;
$old$,
  $new$  update public.call_recordings set duration_seconds = target_audio_duration_seconds
  where id = job_row.recording_id and organization_id = job_row.organization_id
    and duration_seconds is null;
  update public.calls set duration_seconds = target_audio_duration_seconds,
    version = version + 1, updated_at = now()
  where id = job_row.call_id and organization_id = job_row.organization_id
    and duration_seconds is null;
$new$
);

commit;
