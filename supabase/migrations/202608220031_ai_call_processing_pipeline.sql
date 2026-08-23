-- IVR recordings become eligible for this background workflow only after the
-- private Tigris object has been finalized. The worker owns external calls;
-- the database owns leasing, scope, idempotency, and credit accounting.

alter table public.call_transcripts
  add column if not exists raw_transcript_text text,
  add column if not exists analysis_model_reference text,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.ai_call_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  call_id uuid not null references public.calls(id),
  recording_id uuid not null references public.call_recordings(id),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'PROCESSING', 'COMPLETED', 'RETRY', 'FAILED')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 7),
  lease_token uuid,
  lease_expires_at timestamptz,
  safe_error_code text,
  billing_mode text check (billing_mode in ('PLATFORM_CREDITS', 'TENANT_CONNECTION')),
  credits_consumed integer not null default 0 check (credits_consumed >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, call_id)
);

create index if not exists ai_call_processing_jobs_claim_idx
  on public.ai_call_processing_jobs (status, lease_expires_at, created_at, id);
create index if not exists ai_call_processing_jobs_org_call_idx
  on public.ai_call_processing_jobs (organization_id, call_id);

alter table public.ai_call_processing_jobs enable row level security;
revoke all on public.ai_call_processing_jobs from anon, authenticated;

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
  on conflict (organization_id, call_id) do update
    set recording_id = excluded.recording_id,
        status = case when public.ai_call_processing_jobs.status in ('FAILED', 'RETRY') then 'QUEUED' else public.ai_call_processing_jobs.status end,
        safe_error_code = null,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists queue_ai_call_processing_after_recording_ready on public.call_recordings;
create trigger queue_ai_call_processing_after_recording_ready
after insert or update of status, object_file_id on public.call_recordings
for each row execute function app_private.enqueue_ai_call_processing();

create or replace function public.claim_ai_call_processing_jobs(
  target_worker_id text,
  target_batch_size integer default 2
)
returns table (
  id uuid, organization_id uuid, branch_id uuid, call_id uuid, recording_id uuid,
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
  select claimed.id, claimed.organization_id, claimed.branch_id, claimed.call_id, claimed.recording_id,
    claimed.lease_token, file_row.bucket, file_row.object_key, file_row.mime_type
  from claimed
  join public.call_recordings recording_row
    on recording_row.id = claimed.recording_id and recording_row.organization_id = claimed.organization_id
  join public.object_files file_row
    on file_row.id = recording_row.object_file_id and file_row.organization_id = claimed.organization_id
   and file_row.resource_type = 'call' and file_row.resource_id = claimed.call_id and file_row.deleted_at is null;
end;
$$;

create or replace function public.complete_ai_call_processing_job(
  target_job_id uuid, target_lease_token uuid, target_billing_mode text, target_credits_consumed integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  update public.ai_call_processing_jobs
  set status = 'COMPLETED', billing_mode = target_billing_mode, credits_consumed = target_credits_consumed,
    completed_at = now(), lease_expires_at = null, updated_at = now()
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING';
  return found;
end;
$$;

create or replace function public.retry_ai_call_processing_job(
  target_job_id uuid, target_lease_token uuid, target_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  update public.ai_call_processing_jobs
  set status = case when attempt_count >= 7 then 'FAILED' else 'RETRY' end,
    safe_error_code = left(coalesce(nullif(btrim(target_safe_error_code), ''), 'AI_CALL_PROCESSING_RETRY'), 100),
    lease_expires_at = null, updated_at = now()
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING';
  return found;
end;
$$;

create or replace function public.consume_platform_ai_credits(
  target_organization_id uuid, target_amount integer, target_feature text, target_reference_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare current_balance bigint; ledger_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  if target_amount <= 0 or nullif(btrim(target_feature), '') is null or nullif(btrim(target_reference_id), '') is null then
    raise exception using errcode = '22023', message = 'INVALID_CREDIT_CONSUMPTION';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_organization_id::text || ':AI', 0));
  select id into ledger_id from public.credit_ledger
  where organization_id = target_organization_id and ledger_kind = 'AI' and reference_id = target_reference_id;
  if found then return ledger_id; end if;
  select coalesce(sum(amount), 0) into current_balance from public.credit_ledger
  where organization_id = target_organization_id and ledger_kind = 'AI';
  if current_balance < target_amount then raise exception using errcode = 'P0001', message = 'INSUFFICIENT_CREDITS'; end if;
  insert into public.credit_ledger (
    organization_id, ledger_kind, transaction_type, amount, feature, reference_id, reason
  ) values (
    target_organization_id, 'AI', 'CONSUMPTION', -target_amount, target_feature,
    target_reference_id, 'Platform-managed AI call processing'
  ) returning id into ledger_id;
  return ledger_id;
end;
$$;

revoke all on function public.claim_ai_call_processing_jobs(text, integer) from public, anon, authenticated;
revoke all on function public.complete_ai_call_processing_job(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.retry_ai_call_processing_job(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.consume_platform_ai_credits(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.claim_ai_call_processing_jobs(text, integer) to service_role;
grant execute on function public.complete_ai_call_processing_job(uuid, uuid, text, integer) to service_role;
grant execute on function public.retry_ai_call_processing_job(uuid, uuid, text) to service_role;
grant execute on function public.consume_platform_ai_credits(uuid, integer, text, text) to service_role;
