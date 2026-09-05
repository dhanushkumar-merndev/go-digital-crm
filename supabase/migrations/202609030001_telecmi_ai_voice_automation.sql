begin;

-- TeleCMI is the only human telephony provider. Applied Twilio migrations remain
-- immutable history, but their live connections are retired and no runtime code
-- resolves them after this migration.
update public.connected_accounts
set status = 'DISCONNECTED',
    last_error_code = 'PROVIDER_RETIRED',
    updated_at = now()
where provider_key = 'twilio_voice'
  and deleted_at is null;

create or replace function app_private.is_client_admin(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    join public.profiles profile_row
      on profile_row.id = assignment_row.user_id
     and profile_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'client_admin'
      and profile_row.active
      and profile_row.deleted_at is null
  );
$$;

create or replace function public.authorize_telecmi_management_scope(
  target_organization_id uuid,
  target_scope_mode public.branch_scope_mode,
  target_branch_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_client_admin(target_organization_id)
    and app_private.mfa_policy_satisfied(target_organization_id)
    and public.authorize_integration_scope(
      target_organization_id,
      'integration.manage',
      target_scope_mode,
      target_branch_ids
    );
$$;

create table public.ai_voice_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  team_id uuid not null references public.teams(id),
  assigned_user_id uuid not null references public.profiles(id),
  name text not null,
  external_agent_id text not null,
  language text not null default 'en-IN',
  prompt_instructions text not null default '',
  auto_call_enabled boolean not null default true,
  delay_seconds integer not null default 300 check (delay_seconds between 300 and 3600),
  credit_cost integer not null default 1 check (credit_cost between 1 and 10000),
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, branch_id, team_id, assigned_user_id)
);

alter table public.calls
  add column if not exists provider_request_id text,
  add column if not exists call_mode text not null default 'HUMAN'
    check (call_mode in ('HUMAN', 'AI_AGENT')),
  add column if not exists ai_voice_agent_id uuid references public.ai_voice_agents(id);

create unique index if not exists calls_org_connection_provider_request_unique_idx
  on public.calls (organization_id, connection_id, provider_request_id)
  where connection_id is not null and provider_request_id is not null;
create index if not exists calls_lead_actor_started_idx
  on public.calls (organization_id, lead_id, assigned_user_id, started_at desc);

create table public.ai_credit_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  feature text not null,
  reference_id text not null,
  amount integer not null check (amount > 0),
  status text not null default 'RESERVED' check (status in ('RESERVED', 'COMMITTED', 'REVERSED')),
  ledger_id uuid not null references public.credit_ledger(id),
  reversal_ledger_id uuid references public.credit_ledger(id),
  committed_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, reference_id)
);

create table public.ai_voice_escalation_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  team_id uuid not null references public.teams(id),
  lead_id uuid not null references public.leads(id),
  assignment_id uuid not null unique references public.lead_assignments(id),
  assigned_user_id uuid not null references public.profiles(id),
  eligible_at timestamptz not null,
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'PROCESSING', 'DISPATCHING', 'DISPATCHED', 'SKIPPED', 'RETRY', 'FAILED')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 7),
  lease_token uuid,
  lease_expires_at timestamptz,
  call_id uuid references public.calls(id),
  ai_voice_agent_id uuid references public.ai_voice_agents(id),
  credit_reservation_id uuid references public.ai_credit_reservations(id),
  safe_error_code text,
  dispatch_authorized_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_voice_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  call_id uuid not null references public.calls(id),
  provider_event_id text not null,
  provider_call_id text not null,
  payload_hash text not null,
  status text not null default 'RECEIVED'
    check (status in ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')),
  lease_token uuid,
  lease_expires_at timestamptz,
  safe_error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, provider_event_id)
);

create index ai_voice_jobs_claim_idx
  on public.ai_voice_escalation_jobs (status, eligible_at, lease_expires_at, id);
create index ai_voice_agents_lookup_idx
  on public.ai_voice_agents (organization_id, branch_id, team_id, assigned_user_id)
  where active and auto_call_enabled and deleted_at is null;

alter table public.ai_voice_agents enable row level security;
alter table public.ai_credit_reservations enable row level security;
alter table public.ai_voice_escalation_jobs enable row level security;
alter table public.ai_voice_webhook_events enable row level security;

create policy ai_voice_agents_read_scope on public.ai_voice_agents for select to authenticated
using (
  app_private.has_permission(organization_id, 'integration.view')
  and app_private.can_access_branch(organization_id, branch_id)
);
create policy ai_voice_jobs_read_scope on public.ai_voice_escalation_jobs for select to authenticated
using (
  app_private.has_permission(organization_id, 'call.view')
  and app_private.can_access_record(organization_id, branch_id, team_id, assigned_user_id)
);
create policy ai_credit_reservations_read_scope on public.ai_credit_reservations for select to authenticated
using (
  app_private.has_permission(organization_id, 'credit.view')
  or app_private.has_permission(organization_id, 'credit.allocate')
);

revoke all on public.ai_voice_agents, public.ai_credit_reservations,
  public.ai_voice_escalation_jobs, public.ai_voice_webhook_events from anon;
revoke insert, update, delete on public.ai_voice_agents, public.ai_credit_reservations,
  public.ai_voice_escalation_jobs from authenticated;
revoke all on public.ai_voice_webhook_events from authenticated;

create or replace function public.upsert_ai_voice_agent(
  target_id uuid,
  target_branch_id uuid,
  target_team_id uuid,
  target_assigned_user_id uuid,
  target_name text,
  target_external_agent_id text,
  target_language text,
  target_prompt_instructions text,
  target_auto_call_enabled boolean,
  target_credit_cost integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare current_organization_id uuid; result_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.is_client_admin(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'integration.manage')
    or not app_private.can_access_branch(current_organization_id, target_branch_id) then
    raise exception using errcode = '42501', message = 'AI_VOICE_AGENT_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_id is not null and not exists (
    select 1 from public.ai_voice_agents existing_agent
    where existing_agent.id = target_id
      and existing_agent.organization_id = current_organization_id
      and existing_agent.branch_id = target_branch_id
      and existing_agent.team_id = target_team_id
      and existing_agent.assigned_user_id = target_assigned_user_id
  ) then
    raise exception using errcode = '22023', message = 'AI_VOICE_AGENT_TARGET_MISMATCH';
  end if;
  if nullif(btrim(target_name), '') is null
    or nullif(btrim(target_external_agent_id), '') is null
    or char_length(btrim(target_name)) > 120
    or char_length(btrim(target_external_agent_id)) > 255
    or char_length(coalesce(target_language, '')) > 35
    or char_length(coalesce(target_prompt_instructions, '')) > 12000
    or target_credit_cost not between 1 and 10000
    or not exists (
      select 1 from public.teams team_row
      where team_row.id = target_team_id and team_row.organization_id = current_organization_id
        and team_row.branch_id = target_branch_id and team_row.active
    )
    or not exists (
      select 1 from public.team_members member_row
      where member_row.organization_id = current_organization_id
        and member_row.team_id = target_team_id
        and member_row.user_id = target_assigned_user_id
        and member_row.member_type = 'TELECALLER_BDC' and member_row.active
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AI_VOICE_AGENT_CONFIG';
  end if;
  insert into public.ai_voice_agents (
    id, organization_id, branch_id, team_id, assigned_user_id, name,
    external_agent_id, language, prompt_instructions, auto_call_enabled,
    credit_cost, active, created_by, updated_at
  ) values (
    coalesce(target_id, gen_random_uuid()), current_organization_id, target_branch_id,
    target_team_id, target_assigned_user_id, btrim(target_name),
    btrim(target_external_agent_id), coalesce(nullif(btrim(target_language), ''), 'en-IN'),
    btrim(coalesce(target_prompt_instructions, '')), target_auto_call_enabled,
    target_credit_cost, true, auth.uid(), now()
  )
  on conflict (organization_id, branch_id, team_id, assigned_user_id) do update set
    name = excluded.name, external_agent_id = excluded.external_agent_id,
    language = excluded.language, prompt_instructions = excluded.prompt_instructions,
    auto_call_enabled = excluded.auto_call_enabled, credit_cost = excluded.credit_cost,
    active = true, deleted_at = null, updated_at = now()
  returning id into result_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'ai_voice_agent.configured', 'ai_voice_agent',
    result_id::text, target_branch_id,
    jsonb_build_object('team_id', target_team_id, 'assigned_user_id', target_assigned_user_id,
      'auto_call_enabled', target_auto_call_enabled, 'delay_seconds', 300,
      'credit_cost', target_credit_cost)
  );
  return result_id;
end;
$$;

create or replace function public.get_ai_voice_agent_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.is_client_admin(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'integration.manage') then
    raise exception using errcode = '42501', message = 'AI_VOICE_AGENT_MANAGE_PERMISSION_REQUIRED';
  end if;
  return jsonb_build_object(
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', branch_row.id, 'name', branch_row.name)
        order by branch_row.name, branch_row.id)
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.active and branch_row.deleted_at is null
        and app_private.can_access_branch(current_organization_id, branch_row.id)
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object('id', team_row.id, 'branch_id', team_row.branch_id,
        'name', team_row.name) order by team_row.name, team_row.id)
      from public.teams team_row
      where team_row.organization_id = current_organization_id and team_row.active
        and app_private.can_access_branch(current_organization_id, team_row.branch_id)
    ), '[]'::jsonb),
    'telecallers', coalesce((
      select jsonb_agg(jsonb_build_object('id', profile_row.id, 'team_id', member_row.team_id,
        'full_name', profile_row.full_name)
        order by profile_row.full_name, profile_row.id)
      from public.team_members member_row
      join public.teams team_row on team_row.id = member_row.team_id
        and team_row.organization_id = member_row.organization_id and team_row.active
      join public.profiles profile_row on profile_row.id = member_row.user_id
        and profile_row.organization_id = member_row.organization_id
        and profile_row.active and profile_row.deleted_at is null
      where member_row.organization_id = current_organization_id
        and member_row.member_type = 'TELECALLER_BDC' and member_row.active
        and app_private.can_access_branch(current_organization_id, team_row.branch_id)
    ), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', agent_row.id, 'branch_id', agent_row.branch_id, 'team_id', agent_row.team_id,
        'assigned_user_id', agent_row.assigned_user_id, 'name', agent_row.name,
        'external_agent_id', agent_row.external_agent_id, 'language', agent_row.language,
        'prompt_instructions', agent_row.prompt_instructions,
        'auto_call_enabled', agent_row.auto_call_enabled,
        'delay_seconds', agent_row.delay_seconds, 'credit_cost', agent_row.credit_cost,
        'active', agent_row.active
      ) order by agent_row.name, agent_row.id)
      from public.ai_voice_agents agent_row
      where agent_row.organization_id = current_organization_id
        and agent_row.deleted_at is null
        and app_private.can_access_branch(current_organization_id, agent_row.branch_id)
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function app_private.reverse_ai_credit_reservation(
  target_reservation_id uuid,
  target_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare reservation_row public.ai_credit_reservations%rowtype; reversal_id uuid;
begin
  select * into reservation_row from public.ai_credit_reservations
  where id = target_reservation_id for update;
  if not found then return false; end if;
  if reservation_row.status = 'REVERSED' then return true; end if;
  if reservation_row.status <> 'RESERVED' then return false; end if;
  insert into public.credit_ledger (
    organization_id, ledger_kind, transaction_type, amount, feature, source,
    reference_id, reason
  ) values (
    reservation_row.organization_id, 'AI', 'REVERSAL', reservation_row.amount,
    reservation_row.feature, 'AI_CREDIT_RESERVATION',
    'reverse:' || reservation_row.reference_id,
    left(coalesce(nullif(btrim(target_reason), ''), 'External AI work was not accepted'), 500)
  ) on conflict (organization_id, ledger_kind, reference_id) do update
    set reference_id = excluded.reference_id
  returning id into reversal_id;
  update public.ai_credit_reservations set status = 'REVERSED', reversed_at = now(),
    reversal_ledger_id = reversal_id
  where id = target_reservation_id;
  return true;
end;
$$;

create or replace function public.reserve_ai_credits(
  target_organization_id uuid,
  target_amount integer,
  target_feature text,
  target_reference_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare current_balance bigint; ledger_id uuid;
  reservation_row public.ai_credit_reservations%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_amount <= 0 or nullif(btrim(target_feature), '') is null
    or nullif(btrim(target_reference_id), '') is null then
    raise exception using errcode = '22023', message = 'INVALID_AI_CREDIT_RESERVATION';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_organization_id::text || ':AI', 0));
  select * into reservation_row
  from public.ai_credit_reservations existing_reservation
  where existing_reservation.organization_id = target_organization_id
    and existing_reservation.reference_id = target_reference_id
  for update;
  if found then
    if reservation_row.amount <> target_amount or reservation_row.feature <> btrim(target_feature) then
      raise exception using errcode = '22023', message = 'AI_CREDIT_IDEMPOTENCY_MISMATCH';
    end if;
    if reservation_row.status = 'REVERSED' then
      raise exception using errcode = 'P0001', message = 'AI_CREDIT_REFERENCE_REVERSED';
    end if;
    return reservation_row.id;
  end if;
  select coalesce(sum(ledger_row.amount), 0) into current_balance
  from public.credit_ledger ledger_row
  where ledger_row.organization_id = target_organization_id and ledger_row.ledger_kind = 'AI';
  if current_balance < target_amount then
    raise exception using errcode = 'P0001', message = 'INSUFFICIENT_CREDITS';
  end if;
  insert into public.credit_ledger (
    organization_id, ledger_kind, transaction_type, amount, feature, source,
    reference_id, reason
  ) values (
    target_organization_id, 'AI', 'CONSUMPTION', -target_amount, btrim(target_feature),
    'AI_CREDIT_RESERVATION', 'reserve:' || target_reference_id,
    'Reserved before external AI work'
  ) returning id into ledger_id;
  insert into public.ai_credit_reservations (
    organization_id, feature, reference_id, amount, ledger_id
  ) values (
    target_organization_id, btrim(target_feature), target_reference_id, target_amount, ledger_id
  ) returning * into reservation_row;
  return reservation_row.id;
end;
$$;

create or replace function public.commit_ai_credit_reservation(target_reservation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare reservation_status text;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  select status into reservation_status from public.ai_credit_reservations
  where id = target_reservation_id for update;
  if not found or reservation_status = 'REVERSED' then return false; end if;
  if reservation_status = 'COMMITTED' then return true; end if;
  update public.ai_credit_reservations set status = 'COMMITTED', committed_at = now()
  where id = target_reservation_id;
  return true;
end;
$$;

create or replace function public.reverse_ai_credit_reservation(target_reservation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare reservation_row public.ai_credit_reservations%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  return app_private.reverse_ai_credit_reservation(
    target_reservation_id, 'External AI work was not accepted'
  );
end;
$$;

create or replace function app_private.enqueue_ai_voice_after_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.active and new.method = 'ROUND_ROBIN' and new.assignment_type = 'FRESH'
    and new.team_id is not null then
    insert into public.ai_voice_escalation_jobs (
      organization_id, branch_id, team_id, lead_id, assignment_id,
      assigned_user_id, eligible_at
    ) values (
      new.organization_id, new.branch_id, new.team_id, new.lead_id, new.id,
      new.assigned_user_id, new.created_at + interval '5 minutes'
    ) on conflict (assignment_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_ai_voice_after_round_robin_assignment on public.lead_assignments;
create trigger enqueue_ai_voice_after_round_robin_assignment
after insert on public.lead_assignments
for each row execute function app_private.enqueue_ai_voice_after_assignment();

create or replace function app_private.cancel_ai_voice_when_human_call_starts()
returns trigger language plpgsql security definer set search_path = '' as $$
declare job_row record;
begin
  if new.call_mode <> 'HUMAN' or new.lead_id is null then return new; end if;
  for job_row in
    select escalation.id, escalation.credit_reservation_id
    from public.ai_voice_escalation_jobs escalation
    where escalation.organization_id = new.organization_id
      and escalation.lead_id = new.lead_id
      and escalation.assigned_user_id = new.assigned_user_id
      and escalation.status in ('QUEUED', 'RETRY', 'PROCESSING')
    for update
  loop
    if job_row.credit_reservation_id is not null then
      perform app_private.reverse_ai_credit_reservation(
        job_row.credit_reservation_id, 'Human call started before AI voice dispatch'
      );
    end if;
    update public.ai_voice_escalation_jobs set status = 'SKIPPED',
      safe_error_code = 'HUMAN_CALL_STARTED', lease_token = null,
      lease_expires_at = null, updated_at = now()
    where id = job_row.id;
  end loop;
  return new;
end;
$$;

drop trigger if exists cancel_ai_voice_after_human_call on public.calls;
create trigger cancel_ai_voice_after_human_call
after insert on public.calls
for each row execute function app_private.cancel_ai_voice_when_human_call_starts();

create or replace function public.claim_ai_voice_escalations(
  target_worker_id text,
  target_batch_size integer default 5
)
returns table (id uuid, lease_token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  if nullif(btrim(target_worker_id), '') is null or target_batch_size not between 1 and 20 then
    raise exception using errcode = '22023', message = 'INVALID_AI_VOICE_CLAIM';
  end if;
  return query
  with candidates as (
    select job_row.id from public.ai_voice_escalation_jobs job_row
    where job_row.eligible_at <= now()
      and (
        (job_row.status in ('QUEUED', 'RETRY') and job_row.attempt_count < 7)
        or (
          job_row.status in ('PROCESSING', 'DISPATCHING')
          and job_row.lease_expires_at < now()
          and job_row.attempt_count <= 7
        )
      )
    order by job_row.eligible_at, job_row.id
    limit target_batch_size for update skip locked
  ), claimed as (
    update public.ai_voice_escalation_jobs job_row
    set status = 'PROCESSING', attempt_count = least(7, attempt_count + 1),
      lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes',
      safe_error_code = null, updated_at = now()
    from candidates where job_row.id = candidates.id
    returning job_row.id, job_row.lease_token
  ) select claimed.id, claimed.lease_token from claimed;
end;
$$;

create or replace function public.prepare_ai_voice_escalation(
  target_job_id uuid,
  target_lease_token uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job_row public.ai_voice_escalation_jobs%rowtype;
  assignment_row public.lead_assignments%rowtype;
  lead_row public.leads%rowtype;
  customer_row public.customers%rowtype;
  agent_row public.ai_voice_agents%rowtype;
  branch_row public.branches%rowtype;
  call_row public.calls%rowtype;
  inventory_context jsonb;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  select * into job_row from public.ai_voice_escalation_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING' for update;
  if not found then raise exception using errcode = 'P0001', message = 'AI_VOICE_LEASE_LOST'; end if;
  select * into assignment_row from public.lead_assignments
  where id = job_row.assignment_id
    and organization_id = job_row.organization_id
    and lead_id = job_row.lead_id
    and assigned_user_id = job_row.assigned_user_id
    and active and method = 'ROUND_ROBIN' and assignment_type = 'FRESH'
  for update;
  select * into lead_row from public.leads
  where id = job_row.lead_id and organization_id = job_row.organization_id and deleted_at is null
  for update;
  select * into agent_row from public.ai_voice_agents
  where organization_id = job_row.organization_id and branch_id = job_row.branch_id
    and team_id = job_row.team_id and assigned_user_id = job_row.assigned_user_id
    and active and auto_call_enabled and deleted_at is null;
  if assignment_row.id is null or lead_row.id is null or agent_row.id is null
    or job_row.eligible_at > now()
    or lead_row.assigned_user_id is distinct from job_row.assigned_user_id
    or lead_row.first_contacted_at is not null or lead_row.temperature = 'DORMANT'
    or not exists (
      select 1 from public.organizations organization_row
      where organization_row.id = job_row.organization_id
        and organization_row.status = 'ACTIVE'
        and organization_row.deleted_at is null
    )
    or not exists (
      select 1 from public.branches active_branch
      where active_branch.id = job_row.branch_id
        and active_branch.organization_id = job_row.organization_id
        and active_branch.active and active_branch.deleted_at is null
    )
    or not exists (
      select 1 from public.teams active_team
      where active_team.id = job_row.team_id
        and active_team.organization_id = job_row.organization_id
        and active_team.branch_id = job_row.branch_id and active_team.active
    )
    or not exists (
      select 1 from public.profiles active_telecaller
      join public.team_members active_membership
        on active_membership.organization_id = active_telecaller.organization_id
       and active_membership.user_id = active_telecaller.id
       and active_membership.team_id = job_row.team_id
      where active_telecaller.id = job_row.assigned_user_id
        and active_telecaller.organization_id = job_row.organization_id
        and active_telecaller.active and active_telecaller.deleted_at is null
        and active_membership.active
        and active_membership.member_type = 'TELECALLER_BDC'
    )
    or exists (
      select 1 from public.calls call_check
      where call_check.organization_id = job_row.organization_id
        and call_check.lead_id = job_row.lead_id
        and call_check.assigned_user_id = job_row.assigned_user_id
        and call_check.started_at >= assignment_row.created_at
        and call_check.call_mode = 'HUMAN'
  ) then
    if job_row.credit_reservation_id is not null then
      perform app_private.reverse_ai_credit_reservation(
        job_row.credit_reservation_id, 'AI voice lead was no longer eligible before dispatch'
      );
    end if;
    update public.ai_voice_escalation_jobs set status = 'SKIPPED', lease_expires_at = null,
      lease_token = null, safe_error_code = 'NO_LONGER_ELIGIBLE', updated_at = now()
    where id = job_row.id;
    return jsonb_build_object('eligible', false, 'reason', 'NO_LONGER_ELIGIBLE');
  end if;
  select * into customer_row from public.customers
  where id = lead_row.customer_id and organization_id = lead_row.organization_id and deleted_at is null;
  select * into branch_row from public.branches
  where id = job_row.branch_id and organization_id = job_row.organization_id;
  select coalesce(jsonb_agg(model_data order by model_data->>'brand', model_data->>'model'), '[]'::jsonb)
  into inventory_context from (
    select jsonb_build_object('brand', brand_row.name, 'model', model_row.name,
      'variant', variant_row.name, 'available_units', count(stock_row.id),
      'colours', jsonb_agg(distinct stock_row.color) filter (where stock_row.color is not null)) model_data
    from public.stock_units stock_row
    join public.vehicle_variants variant_row on variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row on model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row on brand_row.id = model_row.brand_id
    where stock_row.organization_id = job_row.organization_id
      and stock_row.branch_id = job_row.branch_id and stock_row.status = 'AVAILABLE'
      and stock_row.deleted_at is null
    group by brand_row.name, model_row.name, variant_row.name
    limit 100
  ) inventory_rows;
  if job_row.call_id is null then
    insert into public.calls (
      organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
      connection_id, provider_call_id, direction, call_source, started_at, status,
      call_mode, ai_voice_agent_id
    ) values (
      job_row.organization_id, job_row.branch_id, job_row.team_id, job_row.lead_id,
      lead_row.customer_id, job_row.assigned_user_id, null, null, 'OUTBOUND', 'PROVIDER',
      now(), 'PENDING', 'AI_AGENT', agent_row.id
    ) returning * into call_row;
    update public.ai_voice_escalation_jobs set call_id = call_row.id,
      ai_voice_agent_id = agent_row.id, updated_at = now() where id = job_row.id;
  else
    update public.calls set status = 'PENDING', ended_at = null, finalized_at = null
    where id = job_row.call_id and organization_id = job_row.organization_id
      and provider_call_id is null and status = 'FAILED';
    select * into call_row from public.calls
    where id = job_row.call_id and organization_id = job_row.organization_id;
  end if;
  return jsonb_build_object(
    'eligible', true, 'job_id', job_row.id, 'organization_id', job_row.organization_id,
    'call_id', call_row.id, 'lead_id', lead_row.id, 'agent_id', agent_row.id,
    'external_agent_id', agent_row.external_agent_id, 'language', agent_row.language,
    'credit_cost', agent_row.credit_cost,
    'customer_phone', coalesce(customer_row.primary_phone, lead_row.phone),
    'idempotency_key', 'ai-voice:' || job_row.id::text,
    'context', jsonb_build_object(
      'customer', jsonb_build_object('name', coalesce(customer_row.full_name, lead_row.customer_name),
        'interested_model', lead_row.interested_model, 'lead_source', lead_row.source),
      'branch', jsonb_build_object('name', branch_row.name, 'address', branch_row.address),
      'inventory', inventory_context,
      'test_drive', jsonb_build_object('can_schedule', true,
        'instruction', 'Offer a test drive only when the customer shows interest.'),
      'agent_instructions', agent_row.prompt_instructions,
      'safety', 'Do not promise unavailable stock or pricing. Mark extracted facts as suggestions for human approval.'
    )
  );
end;
$$;

create or replace function public.authorize_ai_voice_escalation(
  target_job_id uuid,
  target_lease_token uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job_row public.ai_voice_escalation_jobs%rowtype;
  assignment_row public.lead_assignments%rowtype;
  lead_row public.leads%rowtype;
  agent_row public.ai_voice_agents%rowtype;
  reservation_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into job_row from public.ai_voice_escalation_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING'
  for update;
  if not found then
    return jsonb_build_object('authorized', false, 'reason', 'AI_VOICE_LEASE_LOST');
  end if;
  select * into assignment_row from public.lead_assignments
  where id = job_row.assignment_id
    and organization_id = job_row.organization_id
    and lead_id = job_row.lead_id
    and assigned_user_id = job_row.assigned_user_id
    and active and method = 'ROUND_ROBIN' and assignment_type = 'FRESH'
  for update;
  select * into lead_row from public.leads
  where id = job_row.lead_id and organization_id = job_row.organization_id
    and deleted_at is null
  for update;
  select * into agent_row from public.ai_voice_agents
  where id = job_row.ai_voice_agent_id and organization_id = job_row.organization_id
    and branch_id = job_row.branch_id and team_id = job_row.team_id
    and assigned_user_id = job_row.assigned_user_id
    and active and auto_call_enabled and deleted_at is null;
  if assignment_row.id is null or lead_row.id is null or agent_row.id is null
    or job_row.eligible_at > now()
    or lead_row.assigned_user_id is distinct from job_row.assigned_user_id
    or lead_row.first_contacted_at is not null or lead_row.temperature = 'DORMANT'
    or not exists (
      select 1 from public.organizations organization_row
      where organization_row.id = job_row.organization_id
        and organization_row.status = 'ACTIVE'
        and organization_row.deleted_at is null
    )
    or not exists (
      select 1 from public.branches active_branch
      where active_branch.id = job_row.branch_id
        and active_branch.organization_id = job_row.organization_id
        and active_branch.active and active_branch.deleted_at is null
    )
    or not exists (
      select 1 from public.teams active_team
      where active_team.id = job_row.team_id
        and active_team.organization_id = job_row.organization_id
        and active_team.branch_id = job_row.branch_id and active_team.active
    )
    or not exists (
      select 1 from public.profiles active_telecaller
      join public.team_members active_membership
        on active_membership.organization_id = active_telecaller.organization_id
       and active_membership.user_id = active_telecaller.id
       and active_membership.team_id = job_row.team_id
      where active_telecaller.id = job_row.assigned_user_id
        and active_telecaller.organization_id = job_row.organization_id
        and active_telecaller.active and active_telecaller.deleted_at is null
        and active_membership.active
        and active_membership.member_type = 'TELECALLER_BDC'
    )
    or exists (
      select 1 from public.calls human_call
      where human_call.organization_id = job_row.organization_id
        and human_call.lead_id = job_row.lead_id
        and human_call.assigned_user_id = job_row.assigned_user_id
        and human_call.started_at >= assignment_row.created_at
        and human_call.call_mode = 'HUMAN'
    ) then
    if job_row.credit_reservation_id is not null then
      perform app_private.reverse_ai_credit_reservation(
        job_row.credit_reservation_id, 'AI voice lead was no longer eligible at dispatch authorization'
      );
    end if;
    update public.ai_voice_escalation_jobs set status = 'SKIPPED',
      safe_error_code = 'NO_LONGER_ELIGIBLE', lease_token = null,
      lease_expires_at = null, updated_at = now()
    where id = job_row.id;
    update public.calls set status = 'CANCELLED', ended_at = now(), finalized_at = now()
    where id = job_row.call_id and organization_id = job_row.organization_id
      and provider_call_id is null;
    return jsonb_build_object('authorized', false, 'reason', 'NO_LONGER_ELIGIBLE');
  end if;
  reservation_id := public.reserve_ai_credits(
    job_row.organization_id, agent_row.credit_cost, 'ai_voice_call',
    'ai-voice:' || job_row.id::text
  );
  update public.ai_voice_escalation_jobs set status = 'DISPATCHING',
    credit_reservation_id = reservation_id, dispatch_authorized_at = now(),
    lease_expires_at = now() + interval '5 minutes', updated_at = now()
  where id = job_row.id;
  return jsonb_build_object('authorized', true, 'reservation_id', reservation_id);
end;
$$;

create or replace function public.complete_ai_voice_escalation(
  target_job_id uuid, target_lease_token uuid, target_provider_call_id text,
  target_credit_reservation_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job_row public.ai_voice_escalation_jobs%rowtype;
  reservation_row public.ai_credit_reservations%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  if nullif(btrim(target_provider_call_id), '') is null
    or char_length(btrim(target_provider_call_id)) > 255 then return false; end if;
  select * into job_row from public.ai_voice_escalation_jobs
  where id = target_job_id and lease_token = target_lease_token
    and status = 'DISPATCHING' and credit_reservation_id = target_credit_reservation_id
  for update;
  if not found then return false; end if;
  select * into reservation_row from public.ai_credit_reservations
  where id = target_credit_reservation_id
    and organization_id = job_row.organization_id
    and reference_id = 'ai-voice:' || job_row.id::text
    and status in ('RESERVED', 'COMMITTED')
  for update;
  if not found then return false; end if;
  update public.calls set provider_call_id = target_provider_call_id
  where id = job_row.call_id and organization_id = job_row.organization_id
    and (provider_call_id is null or provider_call_id = btrim(target_provider_call_id));
  if not found then return false; end if;
  update public.ai_credit_reservations set status = 'COMMITTED',
    committed_at = coalesce(committed_at, now())
  where id = reservation_row.id and status = 'RESERVED';
  update public.ai_voice_escalation_jobs set status = 'DISPATCHED',
    dispatched_at = now(), lease_token = null, lease_expires_at = null, updated_at = now()
  where id = job_row.id;
  return true;
end;
$$;

create or replace function public.recover_ai_voice_gateway_acceptance(
  target_job_id uuid,
  target_provider_call_id text,
  target_credit_reservation_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job_row public.ai_voice_escalation_jobs%rowtype;
  reservation_row public.ai_credit_reservations%rowtype;
  call_provider_id text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_provider_call_id), '') is null
    or char_length(btrim(target_provider_call_id)) > 255 then return false; end if;
  select * into job_row from public.ai_voice_escalation_jobs
  where id = target_job_id for update;
  if not found or job_row.credit_reservation_id is distinct from target_credit_reservation_id
    or job_row.status not in ('PROCESSING', 'DISPATCHING', 'RETRY', 'DISPATCHED') then
    return false;
  end if;
  select * into reservation_row from public.ai_credit_reservations
  where id = target_credit_reservation_id
    and organization_id = job_row.organization_id
    and reference_id = 'ai-voice:' || job_row.id::text
    and status in ('RESERVED', 'COMMITTED')
  for update;
  if not found then return false; end if;
  select provider_call_id into call_provider_id from public.calls
  where id = job_row.call_id and organization_id = job_row.organization_id
    and call_mode = 'AI_AGENT'
  for update;
  if not found or (call_provider_id is not null
    and call_provider_id <> btrim(target_provider_call_id)) then return false; end if;
  update public.calls set provider_call_id = btrim(target_provider_call_id),
    status = case when status = 'FAILED' then 'PENDING' else status end,
    ended_at = case when status = 'FAILED' then null else ended_at end,
    finalized_at = case when status = 'FAILED' then null else finalized_at end
  where id = job_row.call_id and organization_id = job_row.organization_id;
  update public.ai_credit_reservations set status = 'COMMITTED',
    committed_at = coalesce(committed_at, now())
  where id = reservation_row.id and status = 'RESERVED';
  update public.ai_voice_escalation_jobs set status = 'DISPATCHED',
    dispatched_at = coalesce(dispatched_at, now()), lease_token = null,
    lease_expires_at = null, safe_error_code = null, updated_at = now()
  where id = job_row.id;
  return true;
end;
$$;

create or replace function public.retry_ai_voice_escalation(
  target_job_id uuid, target_lease_token uuid, target_safe_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job_row public.ai_voice_escalation_jobs%rowtype; final_failure boolean;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  select * into job_row from public.ai_voice_escalation_jobs
  where id = target_job_id and lease_token = target_lease_token
    and status in ('PROCESSING', 'DISPATCHING') for update;
  if not found then return false; end if;
  final_failure := job_row.attempt_count >= 7;
  update public.ai_voice_escalation_jobs set
    status = case when final_failure then 'FAILED' else 'RETRY' end,
    eligible_at = now() + make_interval(secs => least(900, 30 * power(2, job_row.attempt_count)::integer)),
    safe_error_code = left(coalesce(nullif(btrim(target_safe_error_code), ''), 'AI_VOICE_RETRY'), 100),
    lease_token = null, lease_expires_at = null, updated_at = now()
  where id = job_row.id;
  if final_failure and job_row.credit_reservation_id is not null then
    perform app_private.reverse_ai_credit_reservation(
      job_row.credit_reservation_id, 'AI voice gateway did not accept the call after bounded retries'
    );
  end if;
  if job_row.call_id is not null then
    update public.calls set status = 'FAILED', ended_at = now(), finalized_at = now()
    where id = job_row.call_id and organization_id = job_row.organization_id
      and provider_call_id is null;
  end if;
  return true;
end;
$$;

create or replace function public.claim_ai_voice_webhook_event(
  target_organization_id uuid,
  target_call_id uuid,
  target_provider_event_id text,
  target_provider_call_id text,
  target_payload_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare event_row public.ai_voice_webhook_events%rowtype; next_lease_token uuid;
  call_row public.calls%rowtype;
  escalation_row public.ai_voice_escalation_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_call_id is null
    or nullif(btrim(target_provider_event_id), '') is null
    or char_length(target_provider_event_id) > 255
    or nullif(btrim(target_provider_call_id), '') is null
    or char_length(target_provider_call_id) > 255
    or target_payload_hash !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = '22023', message = 'AI_VOICE_WEBHOOK_IDENTITY_INVALID';
  end if;
  select * into call_row from public.calls
  where id = target_call_id
    and organization_id = target_organization_id
    and call_mode = 'AI_AGENT'
    and (provider_call_id is null or provider_call_id = btrim(target_provider_call_id))
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'AI_VOICE_WEBHOOK_IDENTITY_INVALID';
  end if;
  if call_row.provider_call_id is null then
    select * into escalation_row from public.ai_voice_escalation_jobs
    where call_id = call_row.id
      and organization_id = call_row.organization_id
      and credit_reservation_id is not null
      and status in ('PROCESSING', 'DISPATCHING', 'RETRY', 'DISPATCHED')
    order by created_at desc, id desc
    limit 1
    for update;
    if not found or not public.recover_ai_voice_gateway_acceptance(
      escalation_row.id,
      btrim(target_provider_call_id),
      escalation_row.credit_reservation_id
    ) then
      raise exception using errcode = 'P0001', message = 'AI_VOICE_ACCEPTANCE_NOT_RECORDED';
    end if;
  end if;
  insert into public.ai_voice_webhook_events (
    organization_id, call_id, provider_event_id, provider_call_id, payload_hash
  ) values (
    target_organization_id, target_call_id, btrim(target_provider_event_id),
    btrim(target_provider_call_id), target_payload_hash
  ) on conflict (organization_id, provider_event_id) do nothing;
  select * into event_row from public.ai_voice_webhook_events
  where organization_id = target_organization_id
    and provider_event_id = btrim(target_provider_event_id)
  for update;
  if event_row.call_id <> target_call_id
    or event_row.provider_call_id <> btrim(target_provider_call_id)
    or event_row.payload_hash <> target_payload_hash then
    raise exception using errcode = '22023', message = 'AI_VOICE_WEBHOOK_EVENT_ID_REUSED';
  end if;
  if event_row.status = 'PROCESSED' then
    return jsonb_build_object('claimed', false, 'replayed', true);
  end if;
  if event_row.status = 'PROCESSING' and event_row.lease_expires_at > now() then
    return jsonb_build_object('claimed', false, 'replayed', true);
  end if;
  next_lease_token := gen_random_uuid();
  update public.ai_voice_webhook_events set status = 'PROCESSING',
    lease_token = next_lease_token, lease_expires_at = now() + interval '2 minutes',
    safe_error_code = null, updated_at = now()
  where id = event_row.id;
  return jsonb_build_object('claimed', true, 'replayed', false,
    'event_id', event_row.id, 'lease_token', next_lease_token);
end;
$$;

create or replace function public.complete_ai_voice_webhook_event(
  target_event_id uuid,
  target_lease_token uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.ai_voice_webhook_events set status = 'PROCESSED', processed_at = now(),
    lease_token = null, lease_expires_at = null, updated_at = now()
  where id = target_event_id and lease_token = target_lease_token and status = 'PROCESSING';
  return found;
end;
$$;

create or replace function public.fail_ai_voice_webhook_event(
  target_event_id uuid,
  target_lease_token uuid,
  target_safe_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.ai_voice_webhook_events set status = 'FAILED',
    safe_error_code = left(coalesce(nullif(btrim(target_safe_error_code), ''),
      'AI_VOICE_WEBHOOK_FAILED'), 100),
    lease_token = null, lease_expires_at = null, updated_at = now()
  where id = target_event_id and lease_token = target_lease_token and status = 'PROCESSING';
  return found;
end;
$$;

-- Human website calls resolve only TeleCMI connections and the configured
-- TeleCMI user mapped to the current CRM user when present.
create or replace function public.get_call_provider_options(target_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid; result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.create')
    or not app_private.can_access_branch(current_organization_id, target_branch_id) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', connection_row.id,
    'provider_key', 'telecmi', 'display_name', connection_row.display_name,
    'caller_id_label', nullif(connection_row.connection_config->>'caller_id_label', ''))
    order by connection_row.display_name), '[]'::jsonb) into result
  from public.connected_accounts connection_row
  where connection_row.organization_id = current_organization_id
    and connection_row.provider_key = 'telecmi' and connection_row.status = 'CONNECTED'
    and connection_row.deleted_at is null and (
      connection_row.scope_mode = 'ALL_BRANCHES' or exists (
        select 1 from public.integration_branch_mappings mapping_row
        where mapping_row.organization_id = current_organization_id
          and mapping_row.connected_account_id = connection_row.id
          and mapping_row.external_resource_type = 'CONNECTION_SCOPE'
          and mapping_row.branch_id = target_branch_id and mapping_row.deleted_at is null
      )
    )
    and exists (
      select 1
      from public.profiles actor_profile,
        jsonb_array_elements(
          case when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
            then connection_row.connection_config -> 'parallel_agents' else '[]'::jsonb end
        ) agent_data
      where actor_profile.id = auth.uid()
        and actor_profile.organization_id = current_organization_id
        and actor_profile.active
        and actor_profile.deleted_at is null
        and actor_profile.normalized_phone is not null
        and app_private.normalize_phone_digits(agent_data ->> 'phone')
          = app_private.normalize_phone_digits(actor_profile.normalized_phone)
        and nullif(btrim(agent_data ->> 'user_id'), '') is not null
    );
  return result;
end;
$$;

create or replace function public.create_provider_call_request(
  target_connection_id uuid, target_lead_id uuid, target_request_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor_row public.profiles%rowtype; lead_row public.leads%rowtype;
  customer_row public.customers%rowtype; connection_row public.connected_accounts%rowtype;
  call_row public.calls%rowtype; previous_metadata jsonb; result jsonb;
  provider_user_id text;
begin
  select * into actor_row from public.profiles where id = auth.uid() and active and deleted_at is null;
  if target_request_id is null or actor_row.id is null
    or not app_private.has_permission(actor_row.organization_id, 'call.create') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select * into lead_row from public.leads where id = target_lead_id
    and organization_id = actor_row.organization_id and deleted_at is null;
  if lead_row.id is null or lead_row.customer_id is null
    or not app_private.can_access_record(lead_row.organization_id, lead_row.branch_id,
      lead_row.team_id, lead_row.assigned_user_id) then
    raise exception using errcode = '42501', message = 'CALL_LEAD_NOT_AUTHORIZED';
  end if;
  select * into customer_row from public.customers where id = lead_row.customer_id
    and organization_id = actor_row.organization_id and deleted_at is null;
  select * into connection_row from public.connected_accounts where id = target_connection_id
    and organization_id = actor_row.organization_id and provider_key = 'telecmi'
    and status = 'CONNECTED' and deleted_at is null;
  if connection_row.id is null or customer_row.id is null or not (
    connection_row.scope_mode = 'ALL_BRANCHES' or exists (
      select 1 from public.integration_branch_mappings mapping_row
      where mapping_row.connected_account_id = connection_row.id
        and mapping_row.organization_id = actor_row.organization_id
        and mapping_row.external_resource_type = 'CONNECTION_SCOPE'
        and mapping_row.branch_id = lead_row.branch_id and mapping_row.deleted_at is null
    )
  ) then raise exception using errcode = '42501', message = 'CALL_PROVIDER_SCOPE_DENIED'; end if;
  select nullif(btrim(agent_data ->> 'user_id'), '') into provider_user_id
  from jsonb_array_elements(
    case when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
      then connection_row.connection_config -> 'parallel_agents' else '[]'::jsonb end
  ) agent_data
  where actor_row.normalized_phone is not null
    and app_private.normalize_phone_digits(agent_data ->> 'phone')
      = app_private.normalize_phone_digits(actor_row.normalized_phone)
  order by agent_data ->> 'user_id'
  limit 1;
  if provider_user_id is null then
    raise exception using errcode = '22023', message = 'TELECMI_CALLER_MAPPING_NOT_CONFIGURED';
  end if;
  select metadata into previous_metadata from public.audit_logs
  where organization_id = actor_row.organization_id and actor_id = auth.uid()
    and request_id = target_request_id and action = 'call.provider_requested';
  if found then return coalesce(previous_metadata->'result', '{}'::jsonb) || jsonb_build_object('replayed', true); end if;
  insert into public.calls (organization_id, branch_id, team_id, lead_id, customer_id,
    assigned_user_id, connection_id, direction, call_source, started_at, status, call_mode)
  values (actor_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.id,
    customer_row.id, auth.uid(), connection_row.id, 'OUTBOUND', 'PROVIDER', now(), 'PENDING', 'HUMAN')
  returning * into call_row;
  result := jsonb_build_object('call_id', call_row.id, 'organization_id', call_row.organization_id,
    'branch_id', call_row.branch_id, 'connection_id', connection_row.id,
    'provider_key', 'telecmi',
    'provider_user_id', provider_user_id,
    'customer_phone', coalesce(customer_row.primary_phone, lead_row.phone), 'replayed', false);
  insert into public.audit_logs (organization_id, actor_id, action, resource_type,
    resource_id, branch_id, request_id, metadata)
  values (actor_row.organization_id, auth.uid(), 'call.provider_requested', 'call',
    call_row.id::text, call_row.branch_id, target_request_id,
    jsonb_build_object('connection_id', connection_row.id, 'lead_id', lead_row.id, 'result', result));
  return result;
end;
$$;

alter table public.call_transcripts
  add column if not exists speaker_turns jsonb not null default '[]'::jsonb,
  add column if not exists speaker_separation_method text;

-- A finalized manual Android upload is just as eligible for the AI pipeline as
-- a provider-synced recording. The object itself remains private in Tigris.
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
  where id = new.call_id and organization_id = new.organization_id
    and call_source in ('PROVIDER', 'PERSONAL_MANUAL');
  if not found then return new; end if;
  insert into public.ai_call_processing_jobs (
    organization_id, branch_id, call_id, recording_id, status, updated_at
  ) values (
    call_row.organization_id, call_row.branch_id, call_row.id, new.id, 'QUEUED', now()
  ) on conflict (organization_id, call_id, recording_id) do update
    set status = case when public.ai_call_processing_jobs.status in ('FAILED', 'RETRY')
      then 'QUEUED' else public.ai_call_processing_jobs.status end,
      safe_error_code = null, updated_at = now();
  return new;
end;
$$;

create or replace function public.save_ai_call_transcription(
  target_job_id uuid,
  target_lease_token uuid,
  target_raw_transcript text,
  target_provider_reference text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job_row public.ai_call_processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_raw_transcript), '') is null
    or char_length(target_raw_transcript) > 1000000
    or nullif(btrim(target_provider_reference), '') is null then
    raise exception using errcode = '22023', message = 'INVALID_AI_TRANSCRIPTION_RESULT';
  end if;
  select * into job_row from public.ai_call_processing_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING'
  for update;
  if not found then return false; end if;
  insert into public.call_transcripts (
    organization_id, call_id, processing_job_id, raw_transcript_text,
    transcript_text, speaker_turns, provider_reference, status, updated_at
  ) values (
    job_row.organization_id, job_row.call_id, job_row.id, btrim(target_raw_transcript),
    btrim(target_raw_transcript), '[]'::jsonb, btrim(target_provider_reference),
    'TRANSCRIBED', now()
  ) on conflict (organization_id, processing_job_id) do update set
    raw_transcript_text = excluded.raw_transcript_text,
    transcript_text = case when public.call_transcripts.status = 'COMPLETED'
      then public.call_transcripts.transcript_text else excluded.transcript_text end,
    provider_reference = excluded.provider_reference,
    status = case when public.call_transcripts.status = 'COMPLETED'
      then 'COMPLETED' else 'TRANSCRIBED' end,
    updated_at = now();
  return true;
end;
$$;

create or replace function public.save_ai_call_analysis_result(
  target_job_id uuid,
  target_lease_token uuid,
  target_normalized_transcript text,
  target_speaker_turns jsonb,
  target_separation_method text,
  target_summary text,
  target_suggestions jsonb,
  target_analysis_model_reference text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job_row public.ai_call_processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_normalized_transcript), '') is null
    or char_length(target_normalized_transcript) > 1000000
    or jsonb_typeof(target_speaker_turns) <> 'array'
    or jsonb_array_length(target_speaker_turns) > 10000
    or jsonb_typeof(target_suggestions) <> 'object'
    or exists (
      select 1 from jsonb_array_elements(target_speaker_turns) turn
      where jsonb_typeof(turn) <> 'object'
        or coalesce(turn ->> 'speaker', '') not in ('AGENT', 'CUSTOMER', 'UNKNOWN')
        or nullif(btrim(turn ->> 'text'), '') is null
        or char_length(turn ->> 'text') > 12000
    )
    or exists (
      select 1 from jsonb_object_keys(target_suggestions) suggestion_key
      where suggestion_key not in (
        'customer_name', 'phone', 'email', 'interested_model', 'lifecycle_status',
        'temperature', 'next_followup_at', 'lost_reason'
      )
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AI_ANALYSIS_RESULT';
  end if;
  select * into job_row from public.ai_call_processing_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING'
  for update;
  if not found then return false; end if;
  update public.call_transcripts set
    transcript_text = btrim(target_normalized_transcript),
    speaker_turns = target_speaker_turns,
    speaker_separation_method = nullif(btrim(target_separation_method), ''),
    analysis_model_reference = nullif(btrim(target_analysis_model_reference), ''),
    status = 'COMPLETED', updated_at = now()
  where organization_id = job_row.organization_id and processing_job_id = job_row.id;
  if not found then
    raise exception using errcode = 'P0001', message = 'AI_TRANSCRIPTION_NOT_SAVED';
  end if;
  if nullif(btrim(target_summary), '') is not null then
    insert into public.ai_call_summaries (
      organization_id, call_id, processing_job_id, summary, model_reference
    ) values (
      job_row.organization_id, job_row.call_id, job_row.id,
      left(btrim(target_summary), 12000), nullif(btrim(target_analysis_model_reference), '')
    ) on conflict (organization_id, processing_job_id) do update set
      summary = excluded.summary, model_reference = excluded.model_reference;
  end if;
  if target_suggestions <> '{}'::jsonb then
    insert into public.ai_extraction_runs (
      organization_id, call_id, lead_id, processing_job_id, status, suggestions
    ) select job_row.organization_id, job_row.call_id, call_row.lead_id,
      job_row.id, 'COMPLETED', target_suggestions
    from public.calls call_row
    where call_row.id = job_row.call_id
      and call_row.organization_id = job_row.organization_id
      and call_row.lead_id is not null
    on conflict (organization_id, processing_job_id) do update set
      status = 'COMPLETED', suggestions = excluded.suggestions;
  end if;
  return true;
end;
$$;

create or replace function public.retry_ai_call_processing_job(
  target_job_id uuid, target_lease_token uuid, target_safe_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job_row public.ai_call_processing_jobs%rowtype; final_failure boolean;
  reservation_row record;
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
    lease_token = null, lease_expires_at = null, updated_at = now()
  where id = job_row.id;
  if final_failure then
    for reservation_row in
      select reservation.id from public.ai_credit_reservations reservation
      where reservation.organization_id = job_row.organization_id
        and reservation.status = 'RESERVED'
        and reservation.reference_id in (
          'ai-call:' || job_row.id::text || ':' || job_row.recording_id::text || ':transcription',
          'ai-call:' || job_row.id::text || ':' || job_row.recording_id::text || ':analysis'
        )
      for update
    loop
      perform app_private.reverse_ai_credit_reservation(
        reservation_row.id, 'AI call processing exhausted its bounded retries'
      );
    end loop;
  end if;
  return true;
end;
$$;

drop function if exists public.create_ai_provider_call_request(uuid, uuid, uuid);

revoke all on function public.authorize_telecmi_management_scope(
  uuid, public.branch_scope_mode, uuid[]
) from public, anon;
grant execute on function public.authorize_telecmi_management_scope(
  uuid, public.branch_scope_mode, uuid[]
) to authenticated;
revoke all on function public.get_ai_voice_agent_settings() from public, anon;
grant execute on function public.get_ai_voice_agent_settings() to authenticated;
revoke all on function public.upsert_ai_voice_agent(uuid, uuid, uuid, uuid, text, text, text, text, boolean, integer) from public, anon;
grant execute on function public.upsert_ai_voice_agent(uuid, uuid, uuid, uuid, text, text, text, text, boolean, integer) to authenticated;
revoke all on function public.reserve_ai_credits(uuid, integer, text, text),
  public.commit_ai_credit_reservation(uuid), public.reverse_ai_credit_reservation(uuid),
  public.claim_ai_voice_escalations(text, integer),
  public.prepare_ai_voice_escalation(uuid, uuid),
  public.authorize_ai_voice_escalation(uuid, uuid),
  public.complete_ai_voice_escalation(uuid, uuid, text, uuid),
  public.recover_ai_voice_gateway_acceptance(uuid, text, uuid),
  public.retry_ai_voice_escalation(uuid, uuid, text),
  public.claim_ai_voice_webhook_event(uuid, uuid, text, text, text),
  public.complete_ai_voice_webhook_event(uuid, uuid),
  public.fail_ai_voice_webhook_event(uuid, uuid, text),
  public.save_ai_call_transcription(uuid, uuid, text, text),
  public.save_ai_call_analysis_result(uuid, uuid, text, jsonb, text, text, jsonb, text),
  public.retry_ai_call_processing_job(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reserve_ai_credits(uuid, integer, text, text),
  public.commit_ai_credit_reservation(uuid), public.reverse_ai_credit_reservation(uuid),
  public.claim_ai_voice_escalations(text, integer),
  public.prepare_ai_voice_escalation(uuid, uuid),
  public.authorize_ai_voice_escalation(uuid, uuid),
  public.complete_ai_voice_escalation(uuid, uuid, text, uuid),
  public.recover_ai_voice_gateway_acceptance(uuid, text, uuid),
  public.retry_ai_voice_escalation(uuid, uuid, text),
  public.claim_ai_voice_webhook_event(uuid, uuid, text, text, text),
  public.complete_ai_voice_webhook_event(uuid, uuid),
  public.fail_ai_voice_webhook_event(uuid, uuid, text),
  public.save_ai_call_transcription(uuid, uuid, text, text),
  public.save_ai_call_analysis_result(uuid, uuid, text, jsonb, text, text, jsonb, text),
  public.retry_ai_call_processing_job(uuid, uuid, text)
  to service_role;
revoke all on function public.get_call_provider_options(uuid),
  public.create_provider_call_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.get_call_provider_options(uuid),
  public.create_provider_call_request(uuid, uuid, uuid) to authenticated;

commit;
