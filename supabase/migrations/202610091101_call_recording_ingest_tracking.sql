begin;

-- A provider recording whose ingest run failed used to stay PENDING forever
-- with no reason anywhere in the database: the only record of the failure was
-- the Trigger.dev run. The ingest task now writes its safe failure code and
-- attempt count here, and a recording whose run gave up becomes FAILED.
--
-- claim_stuck_call_recordings feeds a sweep in the per-minute dispatch: a
-- TeleCMI recording still PENDING ten minutes after its last attempt is
-- triggered again, at most three times, so a fixed configuration (an env var
-- added on Trigger.dev, a credential replaced) recovers recordings already
-- received instead of losing them.

alter table public.call_recordings
  add column if not exists failure_code text,
  add column if not exists ingest_attempts integer not null default 0,
  add column if not exists last_ingest_attempt_at timestamptz,
  add column if not exists sweep_count integer not null default 0;

alter table public.call_recordings
  drop constraint if exists call_recordings_failure_code_check;
alter table public.call_recordings
  add constraint call_recordings_failure_code_check
  check (failure_code is null or failure_code ~ '^[A-Z0-9_]{3,100}$');

alter table public.call_recordings
  drop constraint if exists call_recordings_sweep_count_check;
alter table public.call_recordings
  add constraint call_recordings_sweep_count_check check (sweep_count between 0 and 3);

create index if not exists call_recordings_stuck_sweep_idx
  on public.call_recordings (created_at, id)
  where status = 'PENDING' and source = 'PROVIDER_SYNC';

create or replace function public.claim_stuck_call_recordings(target_limit integer default 10)
returns table (
  recording_id uuid,
  organization_id uuid,
  branch_id uuid,
  call_id uuid,
  connection_id uuid,
  provider_recording_id text,
  sweep_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return query
  with candidate as (
    select recording_row.id
    from public.call_recordings recording_row
    join public.calls call_row
      on call_row.id = recording_row.call_id
     and call_row.organization_id = recording_row.organization_id
    join public.connected_accounts connection_row
      on connection_row.id = call_row.connection_id
     and connection_row.organization_id = call_row.organization_id
    where recording_row.status = 'PENDING'
      and recording_row.source = 'PROVIDER_SYNC'
      and recording_row.object_file_id is null
      and recording_row.provider_recording_id is not null
      and recording_row.sweep_count < 3
      and recording_row.created_at < now() - interval '10 minutes'
      and coalesce(recording_row.last_ingest_attempt_at, recording_row.created_at)
        < now() - interval '10 minutes'
      and connection_row.provider_key = 'telecmi'
      and connection_row.status = 'CONNECTED'
      and connection_row.deleted_at is null
    order by recording_row.created_at, recording_row.id
    limit greatest(1, least(coalesce(target_limit, 10), 50))
    for update of recording_row skip locked
  )
  update public.call_recordings recording_row
  set sweep_count = recording_row.sweep_count + 1,
      last_ingest_attempt_at = now()
  from candidate, public.calls call_row
  where recording_row.id = candidate.id
    and call_row.id = recording_row.call_id
    and call_row.organization_id = recording_row.organization_id
  returning recording_row.id, recording_row.organization_id, call_row.branch_id,
    recording_row.call_id, call_row.connection_id, recording_row.provider_recording_id,
    recording_row.sweep_count;
end;
$$;

revoke all on function public.claim_stuck_call_recordings(integer) from public, anon, authenticated;
grant execute on function public.claim_stuck_call_recordings(integer) to service_role;

commit;
