begin;

-- Apply one leased AI voice callback as an atomic CRM fact. The Edge ingress
-- validates the signed envelope; this function owns monotonic call state,
-- lead contact history, recording identity and audit attribution together.
create or replace function public.apply_ai_voice_call_event(
  target_event_id uuid,
  target_lease_token uuid,
  target_organization_id uuid,
  target_call_id uuid,
  target_provider_call_id text,
  target_next_status text,
  target_outcome text,
  target_duration_seconds integer,
  target_recording_provider_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_row public.ai_voice_webhook_events%rowtype;
  call_row public.calls%rowtype;
  lead_row public.leads%rowtype;
  recording_row public.call_recordings%rowtype;
  normalized_status text := upper(btrim(coalesce(target_next_status, '')));
  normalized_outcome text := nullif(upper(btrim(coalesce(target_outcome, ''))), '');
  normalized_recording_id text := nullif(btrim(coalesce(target_recording_provider_id, '')), '');
  transition_allowed boolean := false;
  connected_event boolean := false;
  lead_contacted boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_event_id is null or target_lease_token is null
    or target_organization_id is null or target_call_id is null
    or nullif(btrim(coalesce(target_provider_call_id, '')), '') is null
    or char_length(btrim(target_provider_call_id)) > 255
    or normalized_status not in (
      'PENDING', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'
    )
    or char_length(coalesce(normalized_outcome, '')) > 100
    or target_duration_seconds is not null
      and target_duration_seconds not between 0 and 86400
    or char_length(coalesce(normalized_recording_id, '')) > 255
  then
    raise exception using errcode = '22023', message = 'AI_VOICE_CALL_EVENT_INVALID';
  end if;

  select * into event_row
  from public.ai_voice_webhook_events
  where id = target_event_id
    and organization_id = target_organization_id
    and call_id = target_call_id
    and provider_call_id = btrim(target_provider_call_id)
    and status = 'PROCESSING'
    and lease_token = target_lease_token
    and lease_expires_at > now()
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'AI_VOICE_WEBHOOK_LEASE_LOST';
  end if;

  select * into call_row
  from public.calls
  where id = target_call_id
    and organization_id = target_organization_id
    and call_mode = 'AI_AGENT'
    and provider_call_id = btrim(target_provider_call_id)
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'AI_VOICE_CALL_NOT_FOUND';
  end if;

  transition_allowed := case
    when call_row.status = normalized_status then true
    when call_row.status in ('COMPLETED', 'FAILED', 'CANCELLED') then false
    when normalized_status in ('COMPLETED', 'FAILED', 'CANCELLED') then true
    when normalized_status = 'IN_PROGRESS'
      then call_row.status in ('PENDING', 'RINGING', 'IN_PROGRESS')
    when normalized_status = 'RINGING'
      then call_row.status in ('PENDING', 'RINGING')
    when normalized_status = 'PENDING' then call_row.status = 'PENDING'
    else false
  end;

  if transition_allowed then
    update public.calls
    set status = normalized_status,
      outcome = coalesce(normalized_outcome, outcome),
      duration_seconds = case
        when target_duration_seconds is null then duration_seconds
        when duration_seconds is null then target_duration_seconds
        else greatest(duration_seconds, target_duration_seconds)
      end,
      ended_at = case
        when normalized_status in ('COMPLETED', 'FAILED', 'CANCELLED')
          then coalesce(ended_at, now())
        else ended_at
      end,
      finalized_at = case
        when normalized_status in ('COMPLETED', 'FAILED', 'CANCELLED')
          then coalesce(finalized_at, now())
        else finalized_at
      end,
      version = version + 1,
      updated_at = now()
    where id = call_row.id and organization_id = call_row.organization_id
    returning * into call_row;
  end if;

  connected_event := transition_allowed
    and normalized_status in ('IN_PROGRESS', 'COMPLETED')
    and call_row.status in ('IN_PROGRESS', 'COMPLETED');
  if connected_event and call_row.lead_id is not null then
    select * into lead_row
    from public.leads
    where id = call_row.lead_id
      and organization_id = call_row.organization_id
      and deleted_at is null
    for update;
    if found then
      lead_contacted := true;
      if lead_row.lifecycle_status = 'New' then
        insert into public.lead_stage_history (
          organization_id, lead_id, from_status, to_status, changed_by, reason
        ) values (
          lead_row.organization_id, lead_row.id, lead_row.lifecycle_status,
          'Contacted', null, 'Connected AI voice call'
        );
        update public.leads
        set lifecycle_status = 'Contacted',
          first_contacted_at = coalesce(
            first_contacted_at,
            greatest(lead_row.created_at, call_row.started_at)
          ),
          updated_at = greatest(clock_timestamp(), lead_row.updated_at + interval '1 microsecond')
        where id = lead_row.id and organization_id = lead_row.organization_id;
      elsif lead_row.first_contacted_at is null then
        update public.leads
        set first_contacted_at = greatest(lead_row.created_at, call_row.started_at),
          updated_at = greatest(clock_timestamp(), lead_row.updated_at + interval '1 microsecond')
        where id = lead_row.id and organization_id = lead_row.organization_id;
      end if;
    end if;
  end if;

  if transition_allowed and normalized_status = 'COMPLETED'
    and call_row.status = 'COMPLETED' and normalized_recording_id is not null then
    select * into recording_row
    from public.call_recordings
    where organization_id = call_row.organization_id
      and call_id = call_row.id
      and provider_recording_id = normalized_recording_id
    for update;
    if not found then
      insert into public.call_recordings (
        organization_id, call_id, provider_recording_id, source, status,
        duration_seconds
      ) values (
        call_row.organization_id, call_row.id, normalized_recording_id,
        'PROVIDER_SYNC', 'PENDING', target_duration_seconds
      ) returning * into recording_row;
    elsif target_duration_seconds is not null
      and (
        recording_row.duration_seconds is null
        or target_duration_seconds > recording_row.duration_seconds
      ) then
      update public.call_recordings
      set duration_seconds = target_duration_seconds
      where id = recording_row.id and organization_id = recording_row.organization_id
      returning * into recording_row;
    end if;
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    call_row.organization_id, null, 'call.ai_voice_event_applied', 'call',
    call_row.id::text, call_row.branch_id, event_row.id,
    jsonb_build_object(
      'provider_event_id', event_row.provider_event_id,
      'provider_call_id', event_row.provider_call_id,
      'reported_status', normalized_status,
      'effective_status', call_row.status,
      'transition_applied', transition_allowed,
      'lead_contacted', lead_contacted,
      'recording_id', recording_row.id,
      'assigned_user_id', call_row.assigned_user_id
    )
  ) on conflict do nothing;

  return jsonb_build_object(
    'call_id', call_row.id,
    'branch_id', call_row.branch_id,
    'call_status', call_row.status,
    'transition_applied', transition_allowed,
    'lead_contacted', lead_contacted,
    'recording_id', recording_row.id,
    'recording_status', recording_row.status
  );
end;
$$;

create unique index if not exists audit_ai_voice_event_apply_unique_idx
  on public.audit_logs (organization_id, request_id)
  where request_id is not null and action = 'call.ai_voice_event_applied';

revoke all on function public.apply_ai_voice_call_event(
  uuid, uuid, uuid, uuid, text, text, text, integer, text
) from public, anon, authenticated;
grant execute on function public.apply_ai_voice_call_event(
  uuid, uuid, uuid, uuid, text, text, text, integer, text
) to service_role;

commit;
