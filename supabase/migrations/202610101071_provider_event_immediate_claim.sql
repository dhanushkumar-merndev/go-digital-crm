begin;

-- A verified webhook wakes a worker for its newly persisted receipts. Claim
-- only those IDs so an unrelated provider's backlog cannot delay live chat.
-- The scheduled claim remains responsible for retries and expired leases.
create or replace function public.claim_provider_event_receipts(
  target_worker_id text,
  target_event_ids uuid[]
)
returns setof public.provider_events
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_worker_id), '') is null
    or char_length(target_worker_id) > 200
    or target_event_ids is null
    or cardinality(target_event_ids) not between 1 and 100
    or array_position(target_event_ids, null) is not null
  then
    raise exception using errcode = '22023', message = 'INVALID_PROVIDER_EVENT_CLAIM';
  end if;

  return query
  with candidates as (
    select event_row.id
    from public.provider_events event_row
    where event_row.id = any(target_event_ids)
      and event_row.status = 'RECEIVED'
      and event_row.attempt_count < 8
      and coalesce(event_row.next_attempt_at, event_row.received_at) <= now()
    order by event_row.received_at, event_row.id
    for update skip locked
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

revoke all on function public.claim_provider_event_receipts(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.claim_provider_event_receipts(text, uuid[]) to service_role;

commit;
