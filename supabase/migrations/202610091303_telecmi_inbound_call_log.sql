begin;

-- Calls to the dealership's TeleCMI IVR number used to leave no trace: the
-- webhook dropped the caller's number and apply_telecmi_call_event only moves
-- calls the CRM itself started. An inbound call is now logged as a calls row
-- so a telecaller sees it in Calls (missed ones under Missed), can call back
-- and create a lead.
--
-- Identity: TeleCMI inbound events carry no call_id. conversation_uuid is
-- shared by both legs, so it is the call's provider_call_id; the existing
-- (organization_id, connection_id, provider_call_id) unique index makes every
-- redelivery land on the same row.
--
-- Owner (calls.assigned_user_id is NOT NULL and decides who sees the call):
--   1. the TeleCMI agent who answered, mapped through parallel_agents phones
--   2. the owner of the caller's latest open lead
--   3. the mapped telecaller with the fewest missed inbound calls in 24 h
-- A lead is linked when the caller's number matches one (latest open lead
-- first); no lead or customer is ever created here.

alter table public.calls
  add column if not exists caller_phone text,
  add column if not exists normalized_caller_phone text;

alter table public.calls drop constraint if exists calls_caller_phone_size;
alter table public.calls
  add constraint calls_caller_phone_size
  check (caller_phone is null or char_length(caller_phone) <= 32);

create index if not exists calls_org_caller_phone_idx
  on public.calls (organization_id, normalized_caller_phone)
  where normalized_caller_phone is not null;

create or replace function public.apply_telecmi_inbound_call_event(
  target_organization_id uuid,
  target_connection_id uuid,
  target_received_at timestamptz,
  target_receipt jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_row public.connected_accounts%rowtype;
  call_row public.calls%rowtype;
  receipt_call_id text := nullif(btrim(target_receipt ->> 'provider_call_id'), '');
  receipt_event_type text := upper(coalesce(nullif(btrim(target_receipt ->> 'event_type'), ''), 'CALL'));
  receipt_status text := upper(coalesce(nullif(btrim(target_receipt ->> 'status'), ''), 'UNKNOWN'));
  receipt_agent text := nullif(btrim(target_receipt ->> 'agent_user_id'), '');
  receipt_duration integer;
  caller_digits text;
  caller_lead_phone text;
  agent_profile_id uuid;
  lead_match public.leads%rowtype;
  owner_id uuid;
  owner_branch_id uuid;
  owner_team_id uuid;
  event_at timestamptz := coalesce(target_received_at, now());
  created boolean := false;
  changed boolean := false;
  terminal boolean;
  next_status text;
  next_outcome text;
  logged_call_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_connection_id is null
    or target_receipt is null or jsonb_typeof(target_receipt) <> 'object'
    or receipt_call_id is null or char_length(receipt_call_id) > 255 then
    raise exception using errcode = '22023', message = 'TELECMI_INBOUND_RECEIPT_INVALID';
  end if;
  if target_receipt ? 'duration_seconds' and jsonb_typeof(target_receipt -> 'duration_seconds') = 'number' then
    receipt_duration := least(greatest((target_receipt ->> 'duration_seconds')::numeric, 0), 86400)::integer;
  end if;

  select * into connection_row from public.connected_accounts
  where id = target_connection_id and organization_id = target_organization_id
    and provider_key = 'telecmi' and deleted_at is null;
  if not found then
    raise exception using errcode = '22023', message = 'TELECMI_CONNECTION_NOT_FOUND';
  end if;

  caller_digits := nullif(app_private.telecmi_mapping_phone(target_receipt ->> 'caller_phone'), '');
  if caller_digits is not null and caller_digits !~ '^[0-9]{6,15}$' then
    caller_digits := null;
  end if;
  caller_lead_phone := case when caller_digits is null then null else '+' || caller_digits end;

  -- The answering agent, when the receipt names one.
  if receipt_agent is not null then
    select profile_row.id into agent_profile_id
    from jsonb_array_elements(case
      when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
        then connection_row.connection_config -> 'parallel_agents' else '[]'::jsonb end) agent
    join public.profiles profile_row
      on profile_row.organization_id = target_organization_id
     and profile_row.active and profile_row.deleted_at is null
     and app_private.telecmi_mapping_phone(profile_row.normalized_phone)
       = app_private.telecmi_mapping_phone(agent ->> 'phone')
    where btrim(agent ->> 'user_id') = receipt_agent
    order by profile_row.created_at, profile_row.id
    limit 1;
  end if;

  select * into call_row from public.calls
  where organization_id = target_organization_id
    and connection_id = target_connection_id
    and provider_call_id = receipt_call_id
  for update;

  if not found then
    if caller_lead_phone is not null then
      select * into lead_match from public.leads
      where organization_id = target_organization_id
        and normalized_phone = caller_lead_phone
        and deleted_at is null
      order by (lifecycle_status::text = 'Lost'), created_at desc, id
      limit 1;
    end if;

    owner_id := agent_profile_id;
    if owner_id is null and lead_match.id is not null and exists (
      select 1 from public.profiles
      where id = lead_match.assigned_user_id and active and deleted_at is null
    ) then
      owner_id := lead_match.assigned_user_id;
    end if;
    if owner_id is null then
      select profile_row.id into owner_id
      from jsonb_array_elements(case
        when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
          then connection_row.connection_config -> 'parallel_agents' else '[]'::jsonb end) agent
      join public.profiles profile_row
        on profile_row.organization_id = target_organization_id
       and profile_row.active and profile_row.deleted_at is null
       and app_private.telecmi_mapping_phone(profile_row.normalized_phone)
         = app_private.telecmi_mapping_phone(agent ->> 'phone')
      where exists (
        select 1 from public.team_members member_row
        where member_row.organization_id = target_organization_id
          and member_row.user_id = profile_row.id
          and member_row.active
          and member_row.member_type::text = 'TELECALLER_BDC'
      )
      order by (
        select count(*) from public.calls missed_row
        where missed_row.organization_id = target_organization_id
          and missed_row.assigned_user_id = profile_row.id
          and missed_row.direction = 'INBOUND'
          and missed_row.outcome = 'NO_ANSWER'
          and missed_row.started_at > now() - interval '24 hours'
      ), profile_row.id
      limit 1;
    end if;
    if owner_id is null then
      raise exception using errcode = '22023', message = 'TELECMI_INBOUND_OWNER_UNAVAILABLE';
    end if;

    if lead_match.id is not null then
      owner_branch_id := lead_match.branch_id;
      owner_team_id := lead_match.team_id;
    end if;
    if owner_branch_id is null then
      select team_row.branch_id, team_row.id into owner_branch_id, owner_team_id
      from public.team_members member_row
      join public.teams team_row
        on team_row.id = member_row.team_id and team_row.organization_id = member_row.organization_id
      where member_row.organization_id = target_organization_id
        and member_row.user_id = owner_id and member_row.active and team_row.active
      order by team_row.created_at, team_row.id
      limit 1;
    end if;
    if owner_branch_id is null then
      select coalesce(assignment_row.scope_branch_id, assignment_row.selected_branch_ids[1])
        into owner_branch_id
      from public.user_role_assignments assignment_row
      where assignment_row.organization_id = target_organization_id
        and assignment_row.user_id = owner_id and assignment_row.active
      order by assignment_row.created_at
      limit 1;
    end if;
    if owner_branch_id is null then
      select id into owner_branch_id from public.branches
      where organization_id = target_organization_id and active and deleted_at is null
      order by created_at, id limit 1;
    end if;
    if owner_branch_id is null then
      raise exception using errcode = '22023', message = 'TELECMI_INBOUND_BRANCH_UNAVAILABLE';
    end if;

    insert into public.calls (
      organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
      connection_id, provider_call_id, direction, call_source, call_mode, status,
      started_at, caller_phone, normalized_caller_phone, updated_at
    ) values (
      target_organization_id, owner_branch_id, owner_team_id, lead_match.id,
      lead_match.customer_id, owner_id, target_connection_id, receipt_call_id, 'INBOUND',
      'PROVIDER', 'HUMAN', 'RINGING', event_at,
      left(target_receipt ->> 'caller_phone', 32), caller_lead_phone, now()
    )
    on conflict (organization_id, connection_id, provider_call_id)
      where connection_id is not null and provider_call_id is not null
    do nothing
    returning * into call_row;

    if call_row.id is null then
      -- A concurrent delivery created it first; continue with that row.
      select * into call_row from public.calls
      where organization_id = target_organization_id
        and connection_id = target_connection_id
        and provider_call_id = receipt_call_id
      for update;
    else
      created := true;
      insert into public.audit_logs (
        organization_id, branch_id, actor_id, action, resource_type, resource_id, metadata
      ) values (
        target_organization_id, owner_branch_id, null, 'call.inbound_logged', 'call', call_row.id,
        jsonb_build_object(
          'connection_id', target_connection_id,
          'lead_linked', lead_match.id is not null,
          'owner_source', case
            when agent_profile_id is not null then 'ANSWERING_AGENT'
            when lead_match.id is not null and owner_id = lead_match.assigned_user_id then 'LEAD_OWNER'
            else 'LEAST_LOADED_TELECALLER' end
        )
      );
    end if;
  end if;

  if call_row.direction <> 'INBOUND' then
    raise exception using errcode = '22023', message = 'TELECMI_INBOUND_IDENTITY_CONFLICT';
  end if;

  logged_call_id := call_row.id;
  terminal := call_row.status in ('COMPLETED', 'FAILED', 'CANCELLED');
  next_status := call_row.status;
  next_outcome := call_row.outcome;

  if receipt_event_type = 'CDR' then
    -- The call-end record is the final word, even over an out-of-order live event.
    if receipt_status = 'ANSWERED' or coalesce(receipt_duration, 0) > 0 then
      next_status := 'COMPLETED';
      next_outcome := 'CONNECTED';
    elsif call_row.status <> 'COMPLETED' then
      next_status := 'FAILED';
      next_outcome := 'NO_ANSWER';
    end if;
  elsif not terminal then
    if receipt_status = 'ANSWERED' and agent_profile_id is not null then
      next_status := 'IN_PROGRESS';
    elsif call_row.status = 'PENDING' then
      next_status := 'RINGING';
    end if;
  end if;

  update public.calls set
    status = next_status,
    outcome = next_outcome,
    -- Whoever actually talked to the caller owns the call from then on.
    assigned_user_id = case
      when agent_profile_id is not null and (receipt_status = 'ANSWERED' or coalesce(receipt_duration, 0) > 0)
        then agent_profile_id else assigned_user_id end,
    answered_at = case
      when next_status in ('IN_PROGRESS', 'COMPLETED') and next_outcome is distinct from 'NO_ANSWER'
        then coalesce(answered_at, event_at) else answered_at end,
    agent_answered_at = case
      when agent_profile_id is not null and receipt_status = 'ANSWERED'
        then coalesce(agent_answered_at, event_at) else agent_answered_at end,
    duration_seconds = case
      when receipt_duration is not null and receipt_duration > coalesce(duration_seconds, -1)
        then receipt_duration else duration_seconds end,
    ended_at = case
      when receipt_event_type = 'CDR' then coalesce(ended_at, greatest(event_at, started_at))
      else ended_at end,
    finalized_at = case
      when receipt_event_type = 'CDR' then coalesce(finalized_at, event_at) else finalized_at end,
    version = version + 1,
    updated_at = now()
  where id = logged_call_id
    and (
      status is distinct from next_status
      or outcome is distinct from next_outcome
      or (receipt_duration is not null and receipt_duration > coalesce(duration_seconds, -1))
      or (receipt_event_type = 'CDR' and finalized_at is null)
      or (agent_profile_id is not null and assigned_user_id is distinct from agent_profile_id
          and (receipt_status = 'ANSWERED' or coalesce(receipt_duration, 0) > 0))
    )
  returning * into call_row;
  changed := found;
  if not changed then
    select * into call_row from public.calls where id = logged_call_id;
  end if;

  return jsonb_build_object(
    'call_id', call_row.id,
    'branch_id', call_row.branch_id,
    'lead_id', call_row.lead_id,
    'status', call_row.status,
    'outcome', call_row.outcome,
    'connected', coalesce(call_row.outcome = 'CONNECTED', false),
    'created', created,
    'changed', changed or created
  );
end;
$$;

revoke all on function public.apply_telecmi_inbound_call_event(uuid, uuid, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_telecmi_inbound_call_event(uuid, uuid, timestamptz, jsonb)
  to service_role;

commit;
