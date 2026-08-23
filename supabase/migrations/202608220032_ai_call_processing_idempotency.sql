-- A call can receive more than one finalized recording. Keep each recording
-- independently idempotent so retries never overwrite a different recording's
-- transcript, review suggestions, or credit reference.

alter table public.ai_call_processing_jobs
  drop constraint if exists ai_call_processing_jobs_organization_id_call_id_key;

create unique index if not exists ai_call_processing_jobs_org_call_recording_unique_idx
  on public.ai_call_processing_jobs (organization_id, call_id, recording_id);

alter table public.call_transcripts
  add column if not exists processing_job_id uuid references public.ai_call_processing_jobs(id);
alter table public.ai_call_summaries
  add column if not exists processing_job_id uuid references public.ai_call_processing_jobs(id);
alter table public.ai_extraction_runs
  add column if not exists processing_job_id uuid references public.ai_call_processing_jobs(id);

create unique index if not exists call_transcripts_processing_job_unique_idx
  on public.call_transcripts (organization_id, processing_job_id);
create unique index if not exists ai_call_summaries_processing_job_unique_idx
  on public.ai_call_summaries (organization_id, processing_job_id);
create unique index if not exists ai_extraction_runs_processing_job_unique_idx
  on public.ai_extraction_runs (organization_id, processing_job_id);

create or replace function app_private.enqueue_ai_call_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare call_row public.calls%rowtype;
begin
  if new.status <> 'READY' or new.object_file_id is null then return new; end if;
  select * into call_row from public.calls
  where id = new.call_id and organization_id = new.organization_id and call_source = 'PROVIDER';
  if not found then return new; end if;
  insert into public.ai_call_processing_jobs (
    organization_id, branch_id, call_id, recording_id, status, updated_at
  ) values (call_row.organization_id, call_row.branch_id, call_row.id, new.id, 'QUEUED', now())
  on conflict (organization_id, call_id, recording_id) do update
    set status = case when public.ai_call_processing_jobs.status in ('FAILED', 'RETRY')
                  then 'QUEUED' else public.ai_call_processing_jobs.status end,
        safe_error_code = null,
        updated_at = now();
  return new;
end;
$$;

drop function if exists public.claim_ai_call_processing_jobs(text, integer);
create or replace function public.claim_ai_call_processing_jobs(
  target_worker_id text,
  target_batch_size integer default 2
)
returns table (
  id uuid, organization_id uuid, branch_id uuid, call_id uuid, lead_id uuid, recording_id uuid,
  lease_token uuid, object_bucket text, object_key text, mime_type text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_worker_id), '') is null or target_batch_size not between 1 and 10 then
    raise exception using errcode = '22023', message = 'INVALID_AI_CALL_CLAIM';
  end if;
  return query
  with candidates as (
    select job_row.id
    from public.ai_call_processing_jobs job_row
    where (job_row.status in ('QUEUED', 'RETRY') or (job_row.status = 'PROCESSING' and job_row.lease_expires_at < now()))
      and job_row.attempt_count < 7
    order by job_row.created_at, job_row.id
    limit target_batch_size
    for update skip locked
  ), claimed as (
    update public.ai_call_processing_jobs job_row
    set status = 'PROCESSING', attempt_count = job_row.attempt_count + 1,
      lease_token = gen_random_uuid(), lease_expires_at = now() + interval '15 minutes',
      safe_error_code = null, updated_at = now()
    from candidates
    where job_row.id = candidates.id
    returning job_row.*
  )
  select claimed.id, claimed.organization_id, claimed.branch_id, claimed.call_id, call_row.lead_id,
    claimed.recording_id, claimed.lease_token, file_row.bucket, file_row.object_key, file_row.mime_type
  from claimed
  join public.calls call_row
    on call_row.id = claimed.call_id and call_row.organization_id = claimed.organization_id
  join public.call_recordings recording_row
    on recording_row.id = claimed.recording_id and recording_row.organization_id = claimed.organization_id
  join public.object_files file_row
    on file_row.id = recording_row.object_file_id and file_row.organization_id = claimed.organization_id
   and file_row.resource_type = 'call' and file_row.resource_id = claimed.call_id and file_row.deleted_at is null;
end;
$$;

revoke all on function public.claim_ai_call_processing_jobs(text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_call_processing_jobs(text, integer) to service_role;
