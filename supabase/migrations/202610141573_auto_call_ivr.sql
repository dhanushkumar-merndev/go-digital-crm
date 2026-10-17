begin;

-- Auto-call IVR (product decision 2026-10-14).
--
-- A telecaller switches Auto call on. TeleCMI PIOPIY then calls the
-- telecaller's own uncontacted New leads one at a time and plays the
-- dealership's questions; the customer answers on the keypad. Nobody listens
-- live and no LLM is involved: TeleCMI supplies the call, `say` text-to-speech
-- and key capture (PCMO `play_get_input`), the CRM supplies the questions.
--
-- * Questions are a Client Admin flow (auto_ivr_flows). Publishing freezes a
--   version; a call always runs the version it started with.
-- * An answer never edits the lead. It becomes a suggestion that the
--   telecaller applies, and the telecaller verifies the call.
-- * A lead moves New -> Contacted only once a key is pressed: that proves a
--   person answered, not voicemail. No answer leaves it New for a retry.
-- * DORMANT leads are never dialled (AGENTS.md 9.7). No credits are charged.
--
-- The assignment-based "AI voice after 5 minutes" trigger is retired; its
-- gateway never existed and nothing should dial a lead behind the telecaller.

drop trigger if exists enqueue_ai_voice_after_round_robin_assignment on public.lead_assignments;

-- ---------------------------------------------------------------- tables

create table public.auto_ivr_flows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  draft_definition jsonb not null,
  published_version_id uuid,
  version bigint not null default 1 check (version > 0),
  created_by uuid not null references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  constraint auto_ivr_flows_definition_size check (pg_column_size(draft_definition) <= 200000)
);

create table public.auto_ivr_flow_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  flow_id uuid not null,
  version_no integer not null check (version_no > 0),
  definition jsonb not null,
  published_by uuid not null references public.profiles (id),
  published_at timestamptz not null default now(),
  unique (flow_id, version_no),
  unique (organization_id, id),
  foreign key (organization_id, flow_id) references public.auto_ivr_flows (organization_id, id)
);

alter table public.auto_ivr_flows
  add constraint auto_ivr_flows_published_version_fk
  foreign key (organization_id, published_version_id)
  references public.auto_ivr_flow_versions (organization_id, id);

create index auto_ivr_flows_org_idx
  on public.auto_ivr_flows (organization_id, updated_at desc, id) where deleted_at is null;

create table public.auto_call_settings (
  organization_id uuid primary key references public.organizations (id),
  enabled boolean not null default false,
  default_flow_id uuid,
  calling_window_start time not null default '10:00',
  calling_window_end time not null default '19:00',
  max_attempts_per_lead smallint not null default 2 check (max_attempts_per_lead between 1 and 5),
  retry_after_minutes integer not null default 120 check (retry_after_minutes between 15 and 2880),
  ring_timeout_sec smallint not null default 30 check (ring_timeout_sec between 10 and 60),
  max_duration_sec smallint not null default 300 check (max_duration_sec between 60 and 900),
  version bigint not null default 1 check (version > 0),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auto_call_settings_window check (calling_window_start < calling_window_end),
  foreign key (organization_id, default_flow_id) references public.auto_ivr_flows (organization_id, id)
);

create table public.auto_call_dialers (
  organization_id uuid not null references public.organizations (id),
  user_id uuid not null references public.profiles (id),
  enabled boolean not null default false,
  paused_reason text check (paused_reason is null or paused_reason ~ '^[A-Z0-9_]{3,60}$'),
  consecutive_failures smallint not null default 0 check (consecutive_failures between 0 and 100),
  last_dispatch_at timestamptz,
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id) references public.profiles (organization_id, id)
);

create index auto_call_dialers_active_idx
  on public.auto_call_dialers (last_dispatch_at nulls first)
  where enabled and paused_reason is null;

create table public.auto_call_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  branch_id uuid not null references public.branches (id),
  team_id uuid references public.teams (id),
  lead_id uuid not null references public.leads (id),
  assigned_user_id uuid not null references public.profiles (id),
  connection_id uuid not null references public.connected_accounts (id),
  flow_version_id uuid not null references public.auto_ivr_flow_versions (id),
  call_id uuid not null references public.calls (id),
  attempt_no smallint not null check (attempt_no between 1 and 5),
  status text not null check (
    status in ('DIALING', 'IN_CALL', 'COMPLETED', 'NO_ANSWER', 'FAILED', 'CANCELLED')
  ),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_call_id text check (provider_call_id is null or char_length(provider_call_id) <= 255),
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{3,80}$'),
  dispatched_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, lead_id, attempt_no),
  unique (call_id)
);

create unique index auto_call_jobs_one_active_per_user
  on public.auto_call_jobs (organization_id, assigned_user_id)
  where status in ('DIALING', 'IN_CALL');
create index auto_call_jobs_lead_idx
  on public.auto_call_jobs (organization_id, lead_id, created_at desc);
create index auto_call_jobs_open_idx
  on public.auto_call_jobs (status, updated_at) where status in ('DIALING', 'IN_CALL');
create index auto_call_jobs_user_day_idx
  on public.auto_call_jobs (organization_id, assigned_user_id, created_at desc);

create table public.auto_ivr_call_answers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  call_id uuid not null references public.calls (id),
  node_id text not null check (node_id ~ '^[a-z0-9_-]{1,40}$'),
  attempt_no smallint not null default 1 check (attempt_no between 1 and 5),
  question_text text not null check (char_length(question_text) <= 500),
  key_pressed text check (key_pressed is null or key_pressed ~ '^[0-9*#]$'),
  option_label text check (option_label is null or char_length(option_label) <= 80),
  answered_at timestamptz not null default clock_timestamp(),
  unique (call_id, node_id, attempt_no)
);

create index auto_ivr_call_answers_call_idx
  on public.auto_ivr_call_answers (organization_id, call_id, answered_at);

create table public.auto_ivr_call_results (
  call_id uuid primary key references public.calls (id),
  organization_id uuid not null references public.organizations (id),
  lead_id uuid not null references public.leads (id),
  flow_version_id uuid not null references public.auto_ivr_flow_versions (id),
  answered boolean not null,
  suggestions jsonb not null default '{}'::jsonb check (jsonb_typeof(suggestions) = 'object'),
  applied jsonb not null default '{}'::jsonb check (jsonb_typeof(applied) = 'object'),
  finalized_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calls drop constraint calls_call_mode_check;
alter table public.calls add constraint calls_call_mode_check
  check (call_mode = any (array['HUMAN'::text, 'AI_AGENT'::text, 'AUTO_IVR'::text]));
alter table public.calls
  add column auto_ivr_flow_version_id uuid references public.auto_ivr_flow_versions (id);

alter table public.leads
  add column auto_contact_call_id uuid references public.calls (id),
  add column auto_contact_verified_at timestamptz,
  add column auto_contact_verified_by uuid references public.profiles (id);

-- Every table above is reached only through the RPCs below.
alter table public.auto_ivr_flows enable row level security;
alter table public.auto_ivr_flow_versions enable row level security;
alter table public.auto_call_settings enable row level security;
alter table public.auto_call_dialers enable row level security;
alter table public.auto_call_jobs enable row level security;
alter table public.auto_ivr_call_answers enable row level security;
alter table public.auto_ivr_call_results enable row level security;
revoke all on table public.auto_ivr_flows, public.auto_ivr_flow_versions,
  public.auto_call_settings, public.auto_call_dialers, public.auto_call_jobs,
  public.auto_ivr_call_answers, public.auto_ivr_call_results
  from anon, authenticated;

-- ---------------------------------------------------------------- helpers

-- What an answer may suggest. DORMANT is a deliberate human choice and is
-- never suggested by a keypress (AGENTS.md 9.7).
create function app_private.auto_ivr_field_value_valid(field text, value jsonb)
returns boolean
language sql
immutable
set search_path to ''
as $$
  select case field
    when 'temperature' then jsonb_typeof(value) = 'string' and value #>> '{}' in ('HOT', 'WARM', 'COLD')
    when 'purchase_timeline' then jsonb_typeof(value) = 'string'
      and char_length(btrim(value #>> '{}')) between 1 and 60
    when 'interested_model' then jsonb_typeof(value) = 'string'
      and char_length(btrim(value #>> '{}')) between 1 and 120
    when 'not_interested' then jsonb_typeof(value) = 'string'
      and char_length(btrim(value #>> '{}')) between 1 and 120
    when 'finance_required' then jsonb_typeof(value) = 'boolean'
    when 'exchange_required' then jsonb_typeof(value) = 'boolean'
    when 'test_drive_required' then jsonb_typeof(value) = 'boolean'
    when 'callback_requested' then value = 'true'::jsonb
    else false
  end;
$$;

create function app_private.auto_ivr_prompt_error(
  target_organization_id uuid,
  prompt jsonb,
  label text
)
returns text
language plpgsql
stable
security definer
set search_path to ''
as $$
declare audio_id uuid;
begin
  if jsonb_typeof(prompt) is distinct from 'object' then
    return label || ': the prompt is missing.';
  end if;
  if prompt ? 'audio_file_id' and prompt->>'audio_file_id' is not null then
    if prompt->>'audio_file_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return label || ': the recording reference is invalid.';
    end if;
    audio_id := (prompt->>'audio_file_id')::uuid;
    if not exists (
      select 1 from public.object_files file_row
      where file_row.id = audio_id
        and file_row.organization_id = target_organization_id
        and file_row.resource_type = 'auto_ivr_flow'
        and file_row.deleted_at is null
        and file_row.mime_type in ('audio/mpeg', 'audio/wav', 'audio/x-wav')
    ) then
      return label || ': the uploaded recording no longer exists.';
    end if;
  elsif char_length(btrim(coalesce(prompt->>'text', ''))) not between 1 and 500 then
    return label || ': enter the words to speak (up to 500 characters) or upload a recording.';
  end if;
  if char_length(coalesce(prompt->>'text', '')) > 500
    or char_length(coalesce(prompt->>'language', '')) > 12
    or char_length(coalesce(prompt->>'voice_id', '')) > 40 then
    return label || ': the prompt settings are too long.';
  end if;
  return null;
end;
$$;

-- Returns the first problem in a flow definition, or null when it can be
-- published. The definition is a DAG of questions; every path must end.
create function app_private.auto_ivr_definition_error(
  target_organization_id uuid,
  definition jsonb
)
returns text
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  nodes jsonb;
  node_key text;
  node_value jsonb;
  option_value jsonb;
  set_value jsonb;
  start_node text;
  next_node text;
  problem text;
  node_count integer;
  keys_seen text[];
  cycle_found boolean;
  reachable_count integer;
begin
  if jsonb_typeof(definition) is distinct from 'object' then
    return 'The flow is empty.';
  end if;
  nodes := definition->'nodes';
  start_node := definition->>'start';
  if jsonb_typeof(nodes) is distinct from 'object' then
    return 'Add at least one question.';
  end if;
  select count(*) into node_count from jsonb_object_keys(nodes);
  if node_count not between 1 and 20 then
    return 'A flow needs between 1 and 20 questions.';
  end if;
  if start_node is null or not nodes ? start_node then
    return 'Choose the first question.';
  end if;
  if definition ? 'greeting' and jsonb_typeof(definition->'greeting') = 'object' then
    problem := app_private.auto_ivr_prompt_error(
      target_organization_id, definition->'greeting', 'Greeting');
    if problem is not null then return problem; end if;
  end if;
  problem := app_private.auto_ivr_prompt_error(
    target_organization_id, definition->'goodbye', 'Goodbye message');
  if problem is not null then return problem; end if;

  for node_key, node_value in select key, value from jsonb_each(nodes) loop
    if node_key !~ '^[a-z0-9_-]{1,40}$' or jsonb_typeof(node_value) <> 'object' then
      return 'A question has an invalid id.';
    end if;
    if char_length(btrim(coalesce(node_value->>'title', ''))) not between 1 and 120 then
      return 'Every question needs a short title.';
    end if;
    problem := app_private.auto_ivr_prompt_error(
      target_organization_id, node_value->'prompt', 'Question "' || (node_value->>'title') || '"');
    if problem is not null then return problem; end if;
    if jsonb_typeof(node_value->'timeout_sec') <> 'number'
      or (node_value->>'timeout_sec')::numeric not between 3 and 15
      or jsonb_typeof(node_value->'retries') <> 'number'
      or (node_value->>'retries')::numeric not between 0 and 2 then
      return 'Question "' || (node_value->>'title') || '": wait time must be 3-15 s and repeats 0-2.';
    end if;
    next_node := node_value->>'on_no_input';
    if next_node is null or (next_node <> 'END' and not nodes ? next_node) then
      return 'Question "' || (node_value->>'title') || '": choose what happens when nothing is pressed.';
    end if;
    if jsonb_typeof(node_value->'options') <> 'array'
      or jsonb_array_length(node_value->'options') not between 1 and 10 then
      return 'Question "' || (node_value->>'title') || '" needs 1 to 10 key options.';
    end if;
    keys_seen := array[]::text[];
    for option_value in select value from jsonb_array_elements(node_value->'options') loop
      if jsonb_typeof(option_value) <> 'object'
        or coalesce(option_value->>'key', '') !~ '^[0-9*#]$' then
        return 'Question "' || (node_value->>'title') || '": each option needs a key 0-9, * or #.';
      end if;
      if option_value->>'key' = any(keys_seen) then
        return 'Question "' || (node_value->>'title') || '": key ' || (option_value->>'key') || ' is used twice.';
      end if;
      keys_seen := keys_seen || (option_value->>'key');
      if char_length(btrim(coalesce(option_value->>'label', ''))) not between 1 and 80 then
        return 'Question "' || (node_value->>'title') || '": every key needs a meaning (up to 80 characters).';
      end if;
      next_node := option_value->>'next';
      if next_node is null or (next_node <> 'END' and not nodes ? next_node) then
        return 'Question "' || (node_value->>'title') || '", key ' || (option_value->>'key') || ': choose the next step.';
      end if;
      if option_value ? 'sets' and jsonb_typeof(option_value->'sets') <> 'array' then
        return 'Question "' || (node_value->>'title') || '": invalid field mapping.';
      end if;
      if jsonb_array_length(coalesce(option_value->'sets', '[]'::jsonb)) > 5 then
        return 'Question "' || (node_value->>'title') || '": a key can fill at most 5 fields.';
      end if;
      for set_value in select value from jsonb_array_elements(coalesce(option_value->'sets', '[]'::jsonb)) loop
        if jsonb_typeof(set_value) <> 'object'
          or not app_private.auto_ivr_field_value_valid(set_value->>'field', set_value->'value') then
          return 'Question "' || (node_value->>'title') || '", key ' || (option_value->>'key')
            || ': a CRM field mapping is not allowed.';
        end if;
      end loop;
    end loop;
  end loop;

  -- Every question must be reachable from the first one, and no path may loop.
  with recursive edges as (
    select node.key as source, option_row.value->>'next' as target
    from jsonb_each(nodes) node
    cross join lateral jsonb_array_elements(node.value->'options') option_row(value)
    union
    select node.key, node.value->>'on_no_input'
    from jsonb_each(nodes) node
  ), walk (node_id, path, looped) as (
    select start_node, array[start_node], false
    union all
    select edge_row.target, walk.path || edge_row.target, edge_row.target = any(walk.path)
    from walk
    join edges edge_row on edge_row.source = walk.node_id
    where edge_row.target <> 'END' and not walk.looped
  )
  select bool_or(looped), count(distinct node_id) filter (where not looped)
  into cycle_found, reachable_count
  from walk;
  if cycle_found then
    return 'The questions loop back on themselves. Every path must end.';
  end if;
  if reachable_count <> node_count then
    return 'Some questions can never be reached from the first question.';
  end if;
  return null;
end;
$$;

create function app_private.can_manage_auto_call(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select auth.uid() is not null
    and target_organization_id is not null
    and app_private.has_permission(target_organization_id, 'integration.manage')
    and app_private.has_organization_wide_scope(target_organization_id);
$$;

create function app_private.is_active_telecaller(target_organization_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_organization_id
      and member_row.user_id = target_user_id
      and member_row.active
      and member_row.member_type = 'TELECALLER_BDC'
      and profile_row.active
      and profile_row.deleted_at is null
  );
$$;

-- The PIOPIY connection that may dial a lead in this branch.
create function app_private.auto_call_connection_for_branch(
  target_organization_id uuid,
  target_branch_id uuid
)
returns uuid
language sql
stable
security definer
set search_path to ''
as $$
  select connection_row.id
  from public.connected_accounts connection_row
  where connection_row.organization_id = target_organization_id
    and connection_row.provider_key = 'telecmi_piopiy'
    and connection_row.status = 'CONNECTED'
    and connection_row.deleted_at is null
    and (
      connection_row.scope_mode = 'ALL_BRANCHES'
      or exists (
        select 1 from public.integration_branch_mappings mapping_row
        where mapping_row.organization_id = connection_row.organization_id
          and mapping_row.connected_account_id = connection_row.id
          and mapping_row.branch_id = target_branch_id
          and mapping_row.external_resource_type = 'CONNECTION_SCOPE'
          and mapping_row.deleted_at is null
      )
    )
  order by connection_row.created_at, connection_row.id
  limit 1;
$$;

-- Marks the lead contacted the first time a key is pressed on an auto call.
create function app_private.mark_auto_call_contact(target_call_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  call_row public.calls%rowtype;
  lead_row public.leads%rowtype;
begin
  select * into call_row from public.calls
  where id = target_call_id and call_mode = 'AUTO_IVR' for update;
  if not found or call_row.lead_id is null then return false; end if;
  if call_row.answered_at is null or call_row.status in ('PENDING', 'RINGING') then
    update public.calls set
      status = case when status in ('PENDING', 'RINGING') then 'IN_PROGRESS' else status end,
      answered_at = coalesce(answered_at, now()),
      version = version + 1,
      updated_at = now()
    where id = call_row.id;
  end if;
  select * into lead_row from public.leads
  where id = call_row.lead_id and organization_id = call_row.organization_id and deleted_at is null
  for update;
  if not found then return false; end if;
  if lead_row.first_contacted_at is not null and lead_row.auto_contact_call_id is not null then
    return false;
  end if;
  if lead_row.lifecycle_status = 'New' then
    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      lead_row.organization_id, lead_row.id, lead_row.lifecycle_status,
      'Contacted', null, 'Answered an auto call'
    );
  end if;
  update public.leads set
    lifecycle_status = case when lifecycle_status = 'New' then 'Contacted'::public.lead_lifecycle
      else lifecycle_status end,
    first_contacted_at = coalesce(first_contacted_at, greatest(created_at, call_row.started_at)),
    auto_contact_call_id = case when first_contacted_at is null then call_row.id
      else auto_contact_call_id end,
    updated_at = greatest(clock_timestamp(), lead_row.updated_at + interval '1 microsecond')
  where id = lead_row.id and organization_id = lead_row.organization_id;
  return true;
end;
$$;

-- Closes an auto call once: call status, job status, suggestions, recording.
create function app_private.finalize_auto_ivr_call_internal(
  target_call_id uuid,
  target_provider_status text,
  target_duration_seconds integer,
  target_recording_ref text,
  target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  call_row public.calls%rowtype;
  job_row public.auto_call_jobs%rowtype;
  answered boolean;
  suggestion_map jsonb := '{}'::jsonb;
  answer_row record;
  set_value jsonb;
  final_status text;
  final_outcome text;
  recording_id uuid;
  normalized_status text := upper(btrim(coalesce(target_provider_status, '')));
  normalized_recording text := nullif(btrim(coalesce(target_recording_ref, '')), '');
begin
  select * into call_row from public.calls
  where id = target_call_id and call_mode = 'AUTO_IVR' for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_NOT_FOUND';
  end if;
  select * into job_row from public.auto_call_jobs
  where call_id = call_row.id and organization_id = call_row.organization_id for update;

  select exists (
    select 1 from public.auto_ivr_call_answers answer
    where answer.call_id = call_row.id and answer.key_pressed is not null
  ) into answered;

  if call_row.finalized_at is null then
    final_status := case
      when answered or call_row.answered_at is not null then 'COMPLETED'
      when normalized_status in ('FAILED', 'ERROR') then 'FAILED'
      else 'COMPLETED'
    end;
    final_outcome := case
      when answered then 'ANSWERED'
      when call_row.answered_at is not null then 'NO_INPUT'
      when normalized_status in ('BUSY') then 'BUSY'
      when normalized_status in ('FAILED', 'ERROR') then 'FAILED'
      else 'NO_ANSWER'
    end;
    update public.calls set
      status = final_status,
      outcome = final_outcome,
      ended_at = coalesce(ended_at, greatest(now(), started_at)),
      finalized_at = now(),
      duration_seconds = case
        when target_duration_seconds is null then duration_seconds
        else greatest(coalesce(duration_seconds, 0), least(target_duration_seconds, 86400))
      end,
      version = version + 1,
      updated_at = now()
    where id = call_row.id
    returning * into call_row;
  end if;

  if job_row.id is not null and job_row.status in ('DIALING', 'IN_CALL') then
    update public.auto_call_jobs set
      status = case when answered then 'COMPLETED'
        when call_row.outcome = 'FAILED' then 'FAILED' else 'NO_ANSWER' end,
      safe_error_code = case when target_reason is not null
        then left(upper(regexp_replace(target_reason, '[^A-Za-z0-9_]', '_', 'g')), 80) end,
      lease_token = null, lease_expires_at = null,
      finished_at = now(), updated_at = now()
    where id = job_row.id;
  end if;

  -- The last answer that set a field wins.
  for answer_row in
    select answer.node_id, answer.key_pressed
    from public.auto_ivr_call_answers answer
    where answer.call_id = call_row.id and answer.key_pressed is not null
    order by answer.answered_at, answer.id
  loop
    for set_value in
      select set_item.value
      from public.auto_ivr_flow_versions version_row
      cross join lateral jsonb_array_elements(
        version_row.definition->'nodes'->answer_row.node_id->'options') option_item(value)
      cross join lateral jsonb_array_elements(coalesce(option_item.value->'sets', '[]'::jsonb)) set_item(value)
      where version_row.id = call_row.auto_ivr_flow_version_id
        and option_item.value->>'key' = answer_row.key_pressed
    loop
      suggestion_map := suggestion_map || jsonb_build_object(set_value->>'field', set_value->'value');
    end loop;
  end loop;

  if call_row.lead_id is not null and call_row.auto_ivr_flow_version_id is not null then
    insert into public.auto_ivr_call_results (
      call_id, organization_id, lead_id, flow_version_id, answered, suggestions
    ) values (
      call_row.id, call_row.organization_id, call_row.lead_id,
      call_row.auto_ivr_flow_version_id, answered, suggestion_map
    )
    on conflict (call_id) do update set
      answered = excluded.answered,
      suggestions = excluded.suggestions,
      updated_at = now();
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
        target_duration_seconds
      ) returning id into recording_id;
    end if;
  end if;

  update public.auto_call_dialers set
    consecutive_failures = case when call_row.outcome = 'FAILED' then consecutive_failures + 1 else 0 end,
    paused_reason = case when call_row.outcome = 'FAILED' and consecutive_failures + 1 >= 3
      then 'PROVIDER_FAILING' else paused_reason end,
    updated_at = now()
  where organization_id = call_row.organization_id and user_id = call_row.assigned_user_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    call_row.organization_id, null, 'call.auto_ivr_finalized', 'call', call_row.id::text,
    call_row.branch_id,
    jsonb_build_object('lead_id', call_row.lead_id, 'answered', answered,
      'outcome', call_row.outcome, 'reason', target_reason,
      'suggested_fields', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_object_keys(suggestion_map) key))
  );

  return jsonb_build_object(
    'call_id', call_row.id,
    'organization_id', call_row.organization_id,
    'branch_id', call_row.branch_id,
    'lead_id', call_row.lead_id,
    'assigned_user_id', call_row.assigned_user_id,
    'answered', answered,
    'status', call_row.status,
    'outcome', call_row.outcome,
    'recording_id', recording_id
  );
end;
$$;

-- ---------------------------------------------------------------- admin RPCs

create function public.get_auto_call_admin_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  settings_row public.auto_call_settings%rowtype;
begin
  if not app_private.can_manage_auto_call(current_organization_id) then
    raise exception using errcode = '42501', message = 'AUTO_CALL_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into settings_row from public.auto_call_settings
  where organization_id = current_organization_id;
  return jsonb_build_object(
    'organization_id', current_organization_id,
    'settings', jsonb_build_object(
      'enabled', coalesce(settings_row.enabled, false),
      'default_flow_id', settings_row.default_flow_id,
      'calling_window_start', to_char(coalesce(settings_row.calling_window_start, '10:00'::time), 'HH24:MI'),
      'calling_window_end', to_char(coalesce(settings_row.calling_window_end, '19:00'::time), 'HH24:MI'),
      'max_attempts_per_lead', coalesce(settings_row.max_attempts_per_lead, 2),
      'retry_after_minutes', coalesce(settings_row.retry_after_minutes, 120),
      'ring_timeout_sec', coalesce(settings_row.ring_timeout_sec, 30),
      'max_duration_sec', coalesce(settings_row.max_duration_sec, 300),
      'version', settings_row.version
    ),
    'flows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', flow_row.id,
        'name', flow_row.name,
        'status', flow_row.status,
        'version', flow_row.version,
        'published_version_no', version_row.version_no,
        'published_at', version_row.published_at,
        'question_count', (select count(*) from jsonb_object_keys(
          case when jsonb_typeof(flow_row.draft_definition->'nodes') = 'object'
            then flow_row.draft_definition->'nodes' else '{}'::jsonb end)),
        'updated_at', flow_row.updated_at
      ) order by flow_row.updated_at desc, flow_row.id)
      from public.auto_ivr_flows flow_row
      left join public.auto_ivr_flow_versions version_row
        on version_row.id = flow_row.published_version_id
      where flow_row.organization_id = current_organization_id
        and flow_row.deleted_at is null
        and flow_row.status <> 'ARCHIVED'
    ), '[]'::jsonb),
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', connection_row.id,
        'display_name', connection_row.display_name,
        'status', connection_row.status,
        'scope_mode', connection_row.scope_mode,
        'caller_id_label', connection_row.connection_config->>'caller_id_label',
        'last_error_code', connection_row.last_error_code,
        'updated_at', connection_row.updated_at
      ) order by connection_row.created_at)
      from public.connected_accounts connection_row
      where connection_row.organization_id = current_organization_id
        and connection_row.provider_key = 'telecmi_piopiy'
        and connection_row.deleted_at is null
    ), '[]'::jsonb),
    'telecallers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', telecaller.user_id,
        'full_name', telecaller.full_name,
        'enabled', coalesce(dialer_row.enabled, false),
        'paused_reason', dialer_row.paused_reason,
        'calls_today', (
          select count(*) from public.auto_call_jobs job_row
          where job_row.organization_id = current_organization_id
            and job_row.assigned_user_id = telecaller.user_id
            and job_row.created_at >= pg_catalog.timezone('Asia/Kolkata',
              date_trunc('day', pg_catalog.timezone('Asia/Kolkata', now())))
        )
      ) order by telecaller.full_name, telecaller.user_id)
      from (
        select distinct profile_row.id as user_id, profile_row.full_name
        from public.team_members member_row
        join public.profiles profile_row
          on profile_row.id = member_row.user_id
         and profile_row.organization_id = member_row.organization_id
        where member_row.organization_id = current_organization_id
          and member_row.active
          and member_row.member_type = 'TELECALLER_BDC'
          and profile_row.active and profile_row.deleted_at is null
      ) telecaller
      left join public.auto_call_dialers dialer_row
        on dialer_row.organization_id = current_organization_id
       and dialer_row.user_id = telecaller.user_id
    ), '[]'::jsonb)
  );
end;
$$;

create function public.save_auto_call_settings(
  target_enabled boolean,
  target_default_flow_id uuid,
  target_calling_window_start time,
  target_calling_window_end time,
  target_max_attempts_per_lead integer,
  target_retry_after_minutes integer,
  target_ring_timeout_sec integer,
  target_max_duration_sec integer,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  current_row public.auto_call_settings%rowtype;
  next_version bigint;
begin
  if not app_private.can_manage_auto_call(current_organization_id) then
    raise exception using errcode = '42501', message = 'AUTO_CALL_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_enabled is null or target_calling_window_start is null
    or target_calling_window_end is null
    or target_calling_window_start >= target_calling_window_end
    or target_max_attempts_per_lead not between 1 and 5
    or target_retry_after_minutes not between 15 and 2880
    or target_ring_timeout_sec not between 10 and 60
    or target_max_duration_sec not between 60 and 900 then
    raise exception using errcode = '22023', message = 'AUTO_CALL_SETTINGS_INVALID';
  end if;
  if target_default_flow_id is not null and not exists (
    select 1 from public.auto_ivr_flows flow_row
    where flow_row.id = target_default_flow_id
      and flow_row.organization_id = current_organization_id
      and flow_row.deleted_at is null
      and flow_row.status = 'PUBLISHED'
      and flow_row.published_version_id is not null
  ) then
    raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_NOT_PUBLISHED';
  end if;
  if target_enabled and target_default_flow_id is null then
    raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_REQUIRED';
  end if;

  select * into current_row from public.auto_call_settings
  where organization_id = current_organization_id for update;
  if found and current_row.version is distinct from expected_version then
    raise exception using errcode = 'PT409', message = 'AUTO_CALL_SETTINGS_VERSION_CONFLICT';
  end if;
  if not found and expected_version is not null then
    raise exception using errcode = 'PT409', message = 'AUTO_CALL_SETTINGS_VERSION_CONFLICT';
  end if;
  next_version := coalesce(current_row.version, 0) + 1;

  insert into public.auto_call_settings as settings_row (
    organization_id, enabled, default_flow_id, calling_window_start, calling_window_end,
    max_attempts_per_lead, retry_after_minutes, ring_timeout_sec, max_duration_sec,
    version, updated_by, updated_at
  ) values (
    current_organization_id, target_enabled, target_default_flow_id,
    target_calling_window_start, target_calling_window_end, target_max_attempts_per_lead,
    target_retry_after_minutes, target_ring_timeout_sec, target_max_duration_sec,
    next_version, auth.uid(), now()
  )
  on conflict (organization_id) do update set
    enabled = excluded.enabled,
    default_flow_id = excluded.default_flow_id,
    calling_window_start = excluded.calling_window_start,
    calling_window_end = excluded.calling_window_end,
    max_attempts_per_lead = excluded.max_attempts_per_lead,
    retry_after_minutes = excluded.retry_after_minutes,
    ring_timeout_sec = excluded.ring_timeout_sec,
    max_duration_sec = excluded.max_duration_sec,
    version = excluded.version,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  -- A flow or provider problem that paused dialers is fixed by this save.
  update public.auto_call_dialers set paused_reason = null, consecutive_failures = 0, updated_at = now()
  where organization_id = current_organization_id
    and paused_reason in ('AUTO_IVR_FLOW_NOT_PUBLISHED', 'AUTO_CALL_DISABLED');

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'auto_call.settings_saved', 'organization',
    current_organization_id::text,
    jsonb_build_object('enabled', target_enabled, 'default_flow_id', target_default_flow_id,
      'window', jsonb_build_array(target_calling_window_start, target_calling_window_end),
      'max_attempts_per_lead', target_max_attempts_per_lead,
      'retry_after_minutes', target_retry_after_minutes, 'version', next_version)
  );
  return jsonb_build_object('version', next_version);
end;
$$;

create function public.get_auto_ivr_flow(target_flow_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  flow_row public.auto_ivr_flows%rowtype;
  version_row public.auto_ivr_flow_versions%rowtype;
begin
  if not app_private.can_manage_auto_call(current_organization_id) then
    raise exception using errcode = '42501', message = 'AUTO_CALL_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into flow_row from public.auto_ivr_flows
  where id = target_flow_id and organization_id = current_organization_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'AUTO_IVR_FLOW_NOT_FOUND';
  end if;
  select * into version_row from public.auto_ivr_flow_versions where id = flow_row.published_version_id;
  return jsonb_build_object(
    'id', flow_row.id,
    'organization_id', flow_row.organization_id,
    'name', flow_row.name,
    'status', flow_row.status,
    'version', flow_row.version,
    'draft_definition', flow_row.draft_definition,
    'published_version_no', version_row.version_no,
    'published_at', version_row.published_at,
    'has_unpublished_changes', version_row.id is null
      or version_row.definition is distinct from flow_row.draft_definition,
    'validation_error', app_private.auto_ivr_definition_error(current_organization_id, flow_row.draft_definition),
    'updated_at', flow_row.updated_at
  );
end;
$$;

create function public.save_auto_ivr_flow_draft(
  target_flow_id uuid,
  target_name text,
  target_definition jsonb,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  flow_row public.auto_ivr_flows%rowtype;
begin
  if not app_private.can_manage_auto_call(current_organization_id) then
    raise exception using errcode = '42501', message = 'AUTO_CALL_MANAGE_PERMISSION_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_name, ''))) not between 2 and 120
    or jsonb_typeof(target_definition) is distinct from 'object'
    or pg_column_size(target_definition) > 200000 then
    raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_INVALID';
  end if;
  if target_flow_id is null then
    insert into public.auto_ivr_flows (
      organization_id, name, draft_definition, created_by, updated_by
    ) values (
      current_organization_id, btrim(target_name), target_definition, auth.uid(), auth.uid()
    ) returning * into flow_row;
  else
    select * into flow_row from public.auto_ivr_flows
    where id = target_flow_id and organization_id = current_organization_id and deleted_at is null
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'AUTO_IVR_FLOW_NOT_FOUND';
    end if;
    if flow_row.status = 'ARCHIVED' then
      raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_ARCHIVED';
    end if;
    if flow_row.version is distinct from expected_version then
      raise exception using errcode = 'PT409', message = 'AUTO_IVR_FLOW_VERSION_CONFLICT';
    end if;
    update public.auto_ivr_flows set
      name = btrim(target_name),
      draft_definition = target_definition,
      version = version + 1,
      updated_by = auth.uid(),
      updated_at = now()
    where id = flow_row.id
    returning * into flow_row;
  end if;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'auto_ivr.flow_draft_saved', 'auto_ivr_flow',
    flow_row.id::text, jsonb_build_object('version', flow_row.version, 'name', flow_row.name)
  );
  return jsonb_build_object(
    'id', flow_row.id,
    'version', flow_row.version,
    'validation_error', app_private.auto_ivr_definition_error(current_organization_id, flow_row.draft_definition)
  );
end;
$$;

create function public.publish_auto_ivr_flow(target_flow_id uuid, expected_version bigint)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  flow_row public.auto_ivr_flows%rowtype;
  version_row public.auto_ivr_flow_versions%rowtype;
  problem text;
begin
  if not app_private.can_manage_auto_call(current_organization_id) then
    raise exception using errcode = '42501', message = 'AUTO_CALL_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into flow_row from public.auto_ivr_flows
  where id = target_flow_id and organization_id = current_organization_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'AUTO_IVR_FLOW_NOT_FOUND';
  end if;
  if flow_row.version is distinct from expected_version then
    raise exception using errcode = 'PT409', message = 'AUTO_IVR_FLOW_VERSION_CONFLICT';
  end if;
  if flow_row.status = 'ARCHIVED' then
    raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_ARCHIVED';
  end if;
  problem := app_private.auto_ivr_definition_error(current_organization_id, flow_row.draft_definition);
  if problem is not null then
    raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_INVALID', detail = problem;
  end if;
  insert into public.auto_ivr_flow_versions (
    organization_id, flow_id, version_no, definition, published_by
  ) values (
    current_organization_id, flow_row.id,
    coalesce((select max(existing.version_no) from public.auto_ivr_flow_versions existing
      where existing.flow_id = flow_row.id), 0) + 1,
    flow_row.draft_definition, auth.uid()
  ) returning * into version_row;
  update public.auto_ivr_flows set
    status = 'PUBLISHED',
    published_version_id = version_row.id,
    version = version + 1,
    updated_by = auth.uid(),
    updated_at = now()
  where id = flow_row.id
  returning * into flow_row;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'auto_ivr.flow_published', 'auto_ivr_flow',
    flow_row.id::text, jsonb_build_object('version_no', version_row.version_no)
  );
  return jsonb_build_object('id', flow_row.id, 'version', flow_row.version,
    'published_version_no', version_row.version_no);
end;
$$;

create function public.archive_auto_ivr_flow(target_flow_id uuid, expected_version bigint)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  flow_row public.auto_ivr_flows%rowtype;
begin
  if not app_private.can_manage_auto_call(current_organization_id) then
    raise exception using errcode = '42501', message = 'AUTO_CALL_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into flow_row from public.auto_ivr_flows
  where id = target_flow_id and organization_id = current_organization_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'AUTO_IVR_FLOW_NOT_FOUND';
  end if;
  if flow_row.version is distinct from expected_version then
    raise exception using errcode = 'PT409', message = 'AUTO_IVR_FLOW_VERSION_CONFLICT';
  end if;
  if exists (
    select 1 from public.auto_call_settings settings_row
    where settings_row.organization_id = current_organization_id
      and settings_row.default_flow_id = flow_row.id
  ) then
    raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_IN_USE';
  end if;
  update public.auto_ivr_flows set status = 'ARCHIVED', version = version + 1,
    updated_by = auth.uid(), updated_at = now()
  where id = flow_row.id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'auto_ivr.flow_archived', 'auto_ivr_flow',
    flow_row.id::text, '{}'::jsonb
  );
  return jsonb_build_object('id', flow_row.id);
end;
$$;

-- ---------------------------------------------------------------- telecaller RPCs

create function public.get_my_auto_call_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  settings_row public.auto_call_settings%rowtype;
  dialer_row public.auto_call_dialers%rowtype;
  local_now time := (pg_catalog.timezone('Asia/Kolkata', now()))::time;
  day_start timestamptz := pg_catalog.timezone('Asia/Kolkata',
    date_trunc('day', pg_catalog.timezone('Asia/Kolkata', now())));
  blocked_reason text;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.is_active_telecaller(current_organization_id, auth.uid()) then
    return jsonb_build_object('available', false);
  end if;
  select * into settings_row from public.auto_call_settings
  where organization_id = current_organization_id;
  select * into dialer_row from public.auto_call_dialers
  where organization_id = current_organization_id and user_id = auth.uid();
  blocked_reason := case
    when not coalesce(settings_row.enabled, false) then 'AUTO_CALL_DISABLED'
    when not exists (
      select 1 from public.auto_ivr_flows flow_row
      where flow_row.id = settings_row.default_flow_id and flow_row.status = 'PUBLISHED'
        and flow_row.deleted_at is null
    ) then 'AUTO_IVR_FLOW_NOT_PUBLISHED'
    when not exists (
      select 1 from public.connected_accounts connection_row
      where connection_row.organization_id = current_organization_id
        and connection_row.provider_key = 'telecmi_piopiy'
        and connection_row.status = 'CONNECTED' and connection_row.deleted_at is null
    ) then 'PIOPIY_NOT_CONNECTED'
  end;
  return jsonb_build_object(
    'available', true,
    'blocked_reason', blocked_reason,
    'enabled', coalesce(dialer_row.enabled, false),
    'paused_reason', dialer_row.paused_reason,
    'in_window', settings_row.organization_id is not null
      and local_now >= settings_row.calling_window_start
      and local_now < settings_row.calling_window_end,
    'calling_window_start', to_char(coalesce(settings_row.calling_window_start, '10:00'::time), 'HH24:MI'),
    'calling_window_end', to_char(coalesce(settings_row.calling_window_end, '19:00'::time), 'HH24:MI'),
    'current_call', (
      select jsonb_build_object(
        'call_id', job_row.call_id,
        'lead_id', job_row.lead_id,
        'customer_name', lead_row.customer_name,
        'status', job_row.status,
        'started_at', job_row.created_at
      )
      from public.auto_call_jobs job_row
      join public.leads lead_row on lead_row.id = job_row.lead_id
      where job_row.organization_id = current_organization_id
        and job_row.assigned_user_id = auth.uid()
        and job_row.status in ('DIALING', 'IN_CALL')
      limit 1
    ),
    'waiting_count', (
      select count(*) from (
        select 1 from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.assigned_user_id = auth.uid()
          and lead_row.lifecycle_status = 'New'
          and lead_row.first_contacted_at is null
          and lead_row.deleted_at is null
          and lead_row.temperature is distinct from 'DORMANT'
          and (
            select count(*) from public.auto_call_jobs job_row
            where job_row.organization_id = lead_row.organization_id
              and job_row.lead_id = lead_row.id and job_row.status <> 'CANCELLED'
          ) < coalesce(settings_row.max_attempts_per_lead, 2)
        limit 1000
      ) waiting
    ),
    'today', (
      select jsonb_build_object(
        'calls', count(*),
        'answered', count(*) filter (where job_row.status = 'COMPLETED'),
        'no_answer', count(*) filter (where job_row.status = 'NO_ANSWER'),
        'failed', count(*) filter (where job_row.status = 'FAILED')
      )
      from public.auto_call_jobs job_row
      where job_row.organization_id = current_organization_id
        and job_row.assigned_user_id = auth.uid()
        and job_row.created_at >= day_start
    )
  );
end;
$$;

create function public.set_my_auto_call(target_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  settings_row public.auto_call_settings%rowtype;
  cancelled integer := 0;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.is_active_telecaller(current_organization_id, auth.uid())
    or not app_private.has_permission(current_organization_id, 'lead.view') then
    raise exception using errcode = '42501', message = 'AUTO_CALL_TELECALLER_REQUIRED';
  end if;
  if target_enabled is null then
    raise exception using errcode = '22023', message = 'AUTO_CALL_TOGGLE_INVALID';
  end if;
  if target_enabled then
    select * into settings_row from public.auto_call_settings
    where organization_id = current_organization_id;
    if not coalesce(settings_row.enabled, false) then
      raise exception using errcode = '22023', message = 'AUTO_CALL_NOT_CONFIGURED';
    end if;
    if not exists (
      select 1 from public.auto_ivr_flows flow_row
      where flow_row.id = settings_row.default_flow_id and flow_row.status = 'PUBLISHED'
        and flow_row.deleted_at is null
    ) then
      raise exception using errcode = '22023', message = 'AUTO_IVR_FLOW_NOT_PUBLISHED';
    end if;
    if not exists (
      select 1 from public.connected_accounts connection_row
      where connection_row.organization_id = current_organization_id
        and connection_row.provider_key = 'telecmi_piopiy'
        and connection_row.status = 'CONNECTED' and connection_row.deleted_at is null
    ) then
      raise exception using errcode = '22023', message = 'PIOPIY_NOT_CONNECTED';
    end if;
  end if;
  insert into public.auto_call_dialers as dialer_row (
    organization_id, user_id, enabled, paused_reason, consecutive_failures, enabled_at, updated_at
  ) values (
    current_organization_id, auth.uid(), target_enabled, null, 0,
    case when target_enabled then now() end, now()
  )
  on conflict (organization_id, user_id) do update set
    enabled = excluded.enabled,
    paused_reason = null,
    consecutive_failures = 0,
    enabled_at = case when excluded.enabled then now() else dialer_row.enabled_at end,
    updated_at = now();
  if not target_enabled then
    -- A call already ringing finishes; nothing new is dialled.
    with cancelled_rows as (
      update public.auto_call_jobs set status = 'CANCELLED', safe_error_code = 'SWITCHED_OFF',
        lease_token = null, lease_expires_at = null, finished_at = now(), updated_at = now()
      where organization_id = current_organization_id and assigned_user_id = auth.uid()
        and status = 'DIALING' and provider_call_id is null
      returning call_id
    ), cancelled_calls as (
      update public.calls set status = 'CANCELLED', ended_at = now(), finalized_at = now(),
        version = version + 1, updated_at = now()
      where id in (select call_id from cancelled_rows)
      returning id
    )
    select count(*) into cancelled from cancelled_calls;
  end if;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(),
    case when target_enabled then 'auto_call.switched_on' else 'auto_call.switched_off' end,
    'profile', auth.uid()::text, jsonb_build_object('cancelled_jobs', cancelled)
  );
  return jsonb_build_object('enabled', target_enabled);
end;
$$;

create function public.get_my_auto_calls(
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  page_size integer := case when target_page_size in (25, 50, 100) then target_page_size else 25 end;
  page_number integer := greatest(coalesce(target_page, 1), 1);
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.view') then
    raise exception using errcode = '42501', message = 'CALL_VIEW_PERMISSION_REQUIRED';
  end if;
  return jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(row_data order by (row_data->>'created_at') desc, row_data->>'call_id' desc)
      from (
        select jsonb_build_object(
          'call_id', job_row.call_id,
          'lead_id', job_row.lead_id,
          'customer_name', lead_row.customer_name,
          'interested_model', lead_row.interested_model,
          'attempt_no', job_row.attempt_no,
          'status', job_row.status,
          'outcome', call_row.outcome,
          'answers', (select count(*) from public.auto_ivr_call_answers answer
            where answer.call_id = job_row.call_id and answer.key_pressed is not null),
          'verified', lead_row.auto_contact_call_id = job_row.call_id
            and lead_row.auto_contact_verified_at is not null,
          'created_at', job_row.created_at
        ) as row_data
        from public.auto_call_jobs job_row
        join public.calls call_row on call_row.id = job_row.call_id
        join public.leads lead_row on lead_row.id = job_row.lead_id
        where job_row.organization_id = current_organization_id
          and job_row.assigned_user_id = auth.uid()
        order by job_row.created_at desc, job_row.id desc
        limit page_size offset (page_number - 1) * page_size
      ) page_rows
    ), '[]'::jsonb),
    'total', (select count(*) from public.auto_call_jobs job_row
      where job_row.organization_id = current_organization_id
        and job_row.assigned_user_id = auth.uid()),
    'page', page_number,
    'page_size', page_size
  );
end;
$$;

-- The call page for one auto call: answers, suggestions next to the lead's
-- current values, recording and verification.
create function public.get_auto_call_result(target_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  call_row public.calls%rowtype;
  lead_row public.leads%rowtype;
  requirements_row public.lead_requirements%rowtype;
  result_row public.auto_ivr_call_results%rowtype;
begin
  select * into call_row from public.calls
  where id = target_call_id and call_mode = 'AUTO_IVR';
  if not found or auth.uid() is null
    or not app_private.has_permission(call_row.organization_id, 'call.view')
    or not app_private.can_access_record(call_row.organization_id, call_row.branch_id,
      call_row.team_id, call_row.assigned_user_id) then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_NOT_FOUND';
  end if;
  select * into lead_row from public.leads
  where id = call_row.lead_id and organization_id = call_row.organization_id;
  select * into requirements_row from public.lead_requirements where lead_id = lead_row.id;
  select * into result_row from public.auto_ivr_call_results where call_id = call_row.id;
  return jsonb_build_object(
    'call', jsonb_build_object(
      'id', call_row.id,
      'status', call_row.status,
      'outcome', call_row.outcome,
      'started_at', call_row.started_at,
      'answered_at', call_row.answered_at,
      'ended_at', call_row.ended_at,
      'duration_seconds', call_row.duration_seconds,
      'finalized', call_row.finalized_at is not null
    ),
    'lead', case when lead_row.id is null then null else jsonb_build_object(
      'id', lead_row.id,
      'customer_name', lead_row.customer_name,
      'phone', lead_row.phone,
      'interested_model', lead_row.interested_model,
      'lifecycle_status', lead_row.lifecycle_status,
      'temperature', lead_row.temperature,
      'next_followup_at', lead_row.next_followup_at,
      'auto_contact_call_id', lead_row.auto_contact_call_id,
      'verified_at', case when lead_row.auto_contact_call_id = call_row.id
        then lead_row.auto_contact_verified_at end,
      'verified_by_name', (select profile_row.full_name from public.profiles profile_row
        where profile_row.id = lead_row.auto_contact_verified_by
          and lead_row.auto_contact_call_id = call_row.id),
      'can_update', app_private.has_permission(lead_row.organization_id, 'lead.update')
        and app_private.can_access_record(lead_row.organization_id, lead_row.branch_id,
          lead_row.team_id, lead_row.assigned_user_id),
      'current', jsonb_build_object(
        'temperature', lead_row.temperature,
        'interested_model', lead_row.interested_model,
        'purchase_timeline', requirements_row.purchase_timeline,
        'finance_required', requirements_row.finance_required,
        'exchange_required', requirements_row.exchange_required,
        'test_drive_required', requirements_row.test_drive_required,
        'not_interested', case when lead_row.lifecycle_status = 'Lost' then lead_row.lost_reason end,
        'callback_requested', lead_row.next_followup_at is not null
      )
    ) end,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'node_id', answer.node_id,
        'attempt_no', answer.attempt_no,
        'question', answer.question_text,
        'key_pressed', answer.key_pressed,
        'meaning', answer.option_label,
        'answered_at', answer.answered_at
      ) order by answer.answered_at, answer.id)
      from public.auto_ivr_call_answers answer
      where answer.call_id = call_row.id
    ), '[]'::jsonb),
    'suggestions', coalesce(result_row.suggestions, '{}'::jsonb),
    'applied', coalesce(result_row.applied, '{}'::jsonb),
    'recordings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recording.id,
        'status', recording.status,
        'object_file_id', recording.object_file_id,
        'duration_seconds', recording.duration_seconds
      ) order by recording.created_at)
      from public.call_recordings recording
      where recording.organization_id = call_row.organization_id
        and recording.call_id = call_row.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Applies chosen suggestions through the normal lead and requirements RPCs,
-- so their permission checks, history and audit all still run.
create function public.apply_auto_call_suggestions(
  target_call_id uuid,
  target_fields text[],
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  call_row public.calls%rowtype;
  lead_row public.leads%rowtype;
  result_row public.auto_ivr_call_results%rowtype;
  requirements_row public.lead_requirements%rowtype;
  field_name text;
  lead_patch jsonb := '{}'::jsonb;
  requirements_patch jsonb := '{}'::jsonb;
  requirements_payload jsonb;
  applied_now jsonb := '{}'::jsonb;
begin
  if auth.uid() is null or target_request_id is null
    or coalesce(cardinality(target_fields), 0) not between 1 and 8 then
    raise exception using errcode = '22023', message = 'AUTO_CALL_APPLY_INVALID';
  end if;
  select * into call_row from public.calls where id = target_call_id and call_mode = 'AUTO_IVR';
  if not found then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_NOT_FOUND';
  end if;
  select * into lead_row from public.leads
  where id = call_row.lead_id and organization_id = call_row.organization_id and deleted_at is null
  for update;
  if not found or not app_private.has_permission(lead_row.organization_id, 'lead.update')
    or not app_private.can_access_record(lead_row.organization_id, lead_row.branch_id,
      lead_row.team_id, lead_row.assigned_user_id) then
    raise exception using errcode = '42501', message = 'LEAD_UPDATE_PERMISSION_REQUIRED';
  end if;
  select * into result_row from public.auto_ivr_call_results where call_id = call_row.id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_RESULT_NOT_READY';
  end if;
  if result_row.applied ? ('request:' || target_request_id::text) then
    return jsonb_build_object('lead_id', lead_row.id, 'replayed', true);
  end if;

  foreach field_name in array target_fields loop
    if not result_row.suggestions ? field_name or field_name = 'callback_requested' then
      raise exception using errcode = '22023', message = 'AUTO_CALL_FIELD_NOT_SUGGESTED';
    end if;
    case field_name
      when 'temperature' then lead_patch := lead_patch || jsonb_build_object('temperature', result_row.suggestions->'temperature');
      when 'interested_model' then lead_patch := lead_patch || jsonb_build_object('interested_model', result_row.suggestions->'interested_model');
      when 'not_interested' then lead_patch := lead_patch || jsonb_build_object(
        'lifecycle_status', 'Lost', 'lost_reason', result_row.suggestions->'not_interested');
      else requirements_patch := requirements_patch || jsonb_build_object(field_name, result_row.suggestions->field_name);
    end case;
    applied_now := applied_now || jsonb_build_object(field_name, now());
  end loop;

  if lead_patch <> '{}'::jsonb then
    perform public.update_lead(lead_row.id, lead_row.updated_at, lead_patch, 'Applied auto-call answers');
  end if;
  if requirements_patch <> '{}'::jsonb then
    select * into requirements_row from public.lead_requirements where lead_id = lead_row.id;
    requirements_payload := case when requirements_row.lead_id is null then '{}'::jsonb
      else to_jsonb(requirements_row) - array['lead_id', 'organization_id', 'version', 'updated_by',
        'created_at', 'updated_at'] end;
    perform public.update_lead_requirements(
      lead_row.id,
      requirements_row.version,
      coalesce(requirements_payload, '{}'::jsonb) || requirements_patch,
      target_request_id
    );
  end if;

  update public.auto_ivr_call_results set
    applied = applied || applied_now || jsonb_build_object('request:' || target_request_id::text, now()),
    updated_at = now()
  where call_id = call_row.id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    lead_row.organization_id, auth.uid(), 'auto_call.suggestions_applied', 'lead', lead_row.id::text,
    lead_row.branch_id, target_request_id,
    jsonb_build_object('call_id', call_row.id, 'fields', to_jsonb(target_fields))
  );
  return jsonb_build_object('lead_id', lead_row.id, 'applied', to_jsonb(target_fields), 'replayed', false);
end;
$$;

create function public.verify_auto_contact(target_call_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  call_row public.calls%rowtype;
  lead_row public.leads%rowtype;
begin
  select * into call_row from public.calls where id = target_call_id and call_mode = 'AUTO_IVR';
  if not found or auth.uid() is null then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_NOT_FOUND';
  end if;
  select * into lead_row from public.leads
  where id = call_row.lead_id and organization_id = call_row.organization_id and deleted_at is null
  for update;
  if not found or not app_private.has_permission(lead_row.organization_id, 'lead.update')
    or not app_private.can_access_record(lead_row.organization_id, lead_row.branch_id,
      lead_row.team_id, lead_row.assigned_user_id) then
    raise exception using errcode = '42501', message = 'LEAD_UPDATE_PERMISSION_REQUIRED';
  end if;
  if lead_row.auto_contact_call_id is distinct from call_row.id then
    raise exception using errcode = '22023', message = 'AUTO_CONTACT_NOT_FROM_THIS_CALL';
  end if;
  if lead_row.auto_contact_verified_at is not null then
    return jsonb_build_object('lead_id', lead_row.id, 'verified_at', lead_row.auto_contact_verified_at,
      'replayed', true);
  end if;
  update public.leads set
    auto_contact_verified_at = now(),
    auto_contact_verified_by = auth.uid(),
    updated_at = greatest(clock_timestamp(), lead_row.updated_at + interval '1 microsecond')
  where id = lead_row.id and organization_id = lead_row.organization_id
  returning * into lead_row;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    lead_row.organization_id, auth.uid(), 'auto_call.contact_verified', 'lead', lead_row.id::text,
    lead_row.branch_id, jsonb_build_object('call_id', call_row.id)
  );
  return jsonb_build_object('lead_id', lead_row.id, 'verified_at', lead_row.auto_contact_verified_at,
    'replayed', false);
end;
$$;

-- ---------------------------------------------------------------- service RPCs

-- One job per enabled, in-window, idle telecaller. Also closes jobs whose
-- dispatch lease expired and calls PIOPIY never reported back on.
create function public.claim_auto_call_jobs(target_worker_id text, target_batch_size integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  dialer_row record;
  lead_row public.leads%rowtype;
  version_row public.auto_ivr_flow_versions%rowtype;
  connection_id uuid;
  call_row public.calls%rowtype;
  job_row public.auto_call_jobs%rowtype;
  attempt integer;
  stale_row record;
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
    select job.call_id from public.auto_call_jobs job
    join public.auto_call_settings settings_row on settings_row.organization_id = job.organization_id
    where job.status = 'IN_CALL'
      and job.dispatched_at < now() - make_interval(
        secs => settings_row.max_duration_sec + settings_row.ring_timeout_sec + 180)
    order by job.dispatched_at limit 50
    for update of job skip locked
  loop
    perform app_private.finalize_auto_ivr_call_internal(
      stale_row.call_id, 'TIMEOUT', null, null, 'NO_END_EVENT');
  end loop;

  for dialer_row in
    select dialer.organization_id, dialer.user_id, settings_row.default_flow_id,
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

    insert into public.calls (
      organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
      connection_id, direction, call_source, started_at, status, call_mode,
      auto_ivr_flow_version_id
    ) values (
      lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.id,
      lead_row.customer_id, dialer_row.user_id, connection_id, 'OUTBOUND', 'PROVIDER',
      now(), 'PENDING', 'AUTO_IVR', version_row.id
    ) returning * into call_row;
    insert into public.auto_call_jobs (
      organization_id, branch_id, team_id, lead_id, assigned_user_id, connection_id,
      flow_version_id, call_id, attempt_no, status, lease_token, lease_expires_at
    ) values (
      lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.id,
      dialer_row.user_id, connection_id, version_row.id, call_row.id, attempt,
      'DIALING', gen_random_uuid(), now() + interval '2 minutes'
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
      'max_duration_sec', dialer_row.max_duration_sec,
      'flow_version_id', version_row.id,
      'start_node_id', version_row.definition->>'start',
      'greeting', version_row.definition->'greeting',
      'start_node', version_row.definition->'nodes'->(version_row.definition->>'start')
    ));
  end loop;
  return claimed;
end;
$$;

create function public.mark_auto_call_dispatched(
  target_job_id uuid,
  target_lease_token uuid,
  target_provider_call_id text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare job_row public.auto_call_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_provider_call_id, ''))) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'AUTO_CALL_PROVIDER_ID_INVALID';
  end if;
  select * into job_row from public.auto_call_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'DIALING'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'AUTO_CALL_LEASE_LOST';
  end if;
  update public.auto_call_jobs set status = 'IN_CALL', provider_call_id = btrim(target_provider_call_id),
    lease_token = null, lease_expires_at = null, dispatched_at = now(), updated_at = now()
  where id = job_row.id;
  update public.calls set provider_call_id = btrim(target_provider_call_id),
    status = case when status = 'PENDING' then 'RINGING' else status end,
    version = version + 1, updated_at = now()
  where id = job_row.call_id and organization_id = job_row.organization_id;
  update public.auto_call_dialers set consecutive_failures = 0, updated_at = now()
  where organization_id = job_row.organization_id and user_id = job_row.assigned_user_id;
  return jsonb_build_object('job_id', job_row.id, 'call_id', job_row.call_id);
end;
$$;

create function public.fail_auto_call_dispatch(
  target_job_id uuid,
  target_lease_token uuid,
  target_error_code text,
  target_pause_dialer boolean
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  job_row public.auto_call_jobs%rowtype;
  safe_code text := left(upper(regexp_replace(coalesce(target_error_code, 'PROVIDER_ERROR'),
    '[^A-Za-z0-9_]', '_', 'g')), 60);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(safe_code) < 3 then safe_code := 'PROVIDER_ERROR'; end if;
  select * into job_row from public.auto_call_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'DIALING'
  for update;
  if not found then
    return jsonb_build_object('job_id', target_job_id, 'applied', false);
  end if;
  update public.auto_call_jobs set status = 'FAILED', safe_error_code = safe_code,
    lease_token = null, lease_expires_at = null, finished_at = now(), updated_at = now()
  where id = job_row.id;
  update public.calls set status = 'FAILED', outcome = 'FAILED', ended_at = now(),
    finalized_at = now(), version = version + 1, updated_at = now()
  where id = job_row.call_id and finalized_at is null;
  update public.auto_call_dialers set
    consecutive_failures = consecutive_failures + 1,
    paused_reason = case
      when coalesce(target_pause_dialer, false) then safe_code
      when consecutive_failures + 1 >= 3 then 'PROVIDER_FAILING'
      else paused_reason end,
    updated_at = now()
  where organization_id = job_row.organization_id and user_id = job_row.assigned_user_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    job_row.organization_id, null, 'call.auto_ivr_dispatch_failed', 'call', job_row.call_id::text,
    job_row.branch_id, jsonb_build_object('error_code', safe_code, 'lead_id', job_row.lead_id)
  );
  return jsonb_build_object('job_id', job_row.id, 'applied', true);
end;
$$;

-- One keypress (or silence) from PIOPIY. Validates against the call's own
-- flow snapshot and returns what to play next.
create function public.record_auto_ivr_answer(
  target_connection_id uuid,
  target_call_id uuid,
  target_node_id text,
  target_key text,
  target_attempt integer
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  call_row public.calls%rowtype;
  definition jsonb;
  node jsonb;
  option_value jsonb;
  next_node_id text;
  normalized_key text := nullif(btrim(coalesce(target_key, '')), '');
  attempt integer := least(greatest(coalesce(target_attempt, 1), 1), 5);
  repeat_question boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if coalesce(target_node_id, '') !~ '^[a-z0-9_-]{1,40}$' then
    raise exception using errcode = '22023', message = 'AUTO_IVR_NODE_INVALID';
  end if;
  -- Only the first digit counts; the questions take a single key.
  if normalized_key is not null then
    normalized_key := left(regexp_replace(normalized_key, '[^0-9*#]', '', 'g'), 1);
    if normalized_key = '' then normalized_key := null; end if;
  end if;
  select * into call_row from public.calls
  where id = target_call_id and connection_id = target_connection_id and call_mode = 'AUTO_IVR'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_NOT_FOUND';
  end if;
  select version_row.definition into definition
  from public.auto_ivr_flow_versions version_row
  where version_row.id = call_row.auto_ivr_flow_version_id;
  node := definition->'nodes'->target_node_id;
  if node is null then
    raise exception using errcode = '22023', message = 'AUTO_IVR_NODE_INVALID';
  end if;
  if call_row.finalized_at is not null then
    return jsonb_build_object('end', true, 'goodbye', definition->'goodbye');
  end if;

  if normalized_key is not null then
    select value into option_value from jsonb_array_elements(node->'options')
    where value->>'key' = normalized_key limit 1;
  end if;

  insert into public.auto_ivr_call_answers (
    organization_id, call_id, node_id, attempt_no, question_text, key_pressed, option_label
  ) values (
    call_row.organization_id, call_row.id, target_node_id, attempt,
    left(coalesce(node->>'title', '') || coalesce(': ' || (node->'prompt'->>'text'), ''), 500),
    case when option_value is not null then normalized_key end,
    case when option_value is not null then option_value->>'label'
      when normalized_key is not null then 'Invalid key ' || normalized_key end
  ) on conflict (call_id, node_id, attempt_no) do nothing;

  if option_value is not null then
    perform app_private.mark_auto_call_contact(call_row.id);
    next_node_id := option_value->>'next';
  elsif attempt <= coalesce((node->>'retries')::integer, 0) then
    repeat_question := true;
    next_node_id := target_node_id;
  else
    next_node_id := node->>'on_no_input';
  end if;

  if next_node_id is null or next_node_id = 'END' then
    return jsonb_build_object('end', true, 'goodbye', definition->'goodbye');
  end if;
  return jsonb_build_object(
    'end', false,
    'node_id', next_node_id,
    'attempt', case when repeat_question then attempt + 1 else 1 end,
    'node', definition->'nodes'->next_node_id
  );
end;
$$;

create function public.finalize_auto_ivr_call(
  target_connection_id uuid,
  target_call_id uuid,
  target_provider_status text,
  target_duration_seconds integer,
  target_recording_ref text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.calls call_row
    where call_row.id = target_call_id and call_row.connection_id = target_connection_id
      and call_row.call_mode = 'AUTO_IVR'
  ) then
    raise exception using errcode = 'P0002', message = 'AUTO_CALL_NOT_FOUND';
  end if;
  return app_private.finalize_auto_ivr_call_internal(
    target_call_id, target_provider_status,
    case when target_duration_seconds between 0 and 86400 then target_duration_seconds end,
    target_recording_ref, null);
end;
$$;

-- Resolves an uploaded prompt recording for the PIOPIY handler to presign.
create function public.get_auto_ivr_prompt_object(target_organization_id uuid, target_object_file_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select case when auth.role() <> 'service_role' then null else (
    select jsonb_build_object('bucket', file_row.bucket, 'object_key', file_row.object_key,
      'mime_type', file_row.mime_type)
    from public.object_files file_row
    where file_row.id = target_object_file_id
      and file_row.organization_id = target_organization_id
      and file_row.resource_type = 'auto_ivr_flow'
      and file_row.deleted_at is null
  ) end;
$$;

-- PIOPIY connection save, mirroring save_telecmi_connection.
create function public.save_piopiy_connection(
  target_organization_id uuid,
  target_connection_id uuid,
  target_display_name text,
  target_scope_mode public.branch_scope_mode,
  target_branch_ids uuid[],
  target_external_account_id text,
  target_connection_config jsonb,
  target_encrypted_payload bytea,
  target_cipher_version text,
  target_actor_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  connection_row public.connected_accounts%rowtype;
  normalized_branch_ids uuid[] := coalesce(target_branch_ids, '{}'::uuid[]);
  next_credential_version integer;
  result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_actor_id is null or target_request_id is null
    or char_length(btrim(coalesce(target_display_name, ''))) not between 2 and 120
    or char_length(btrim(coalesce(target_external_account_id, ''))) not between 1 and 80
    or jsonb_typeof(target_connection_config) is distinct from 'object'
    or target_connection_config ->> 'connection_type' <> 'AUTO_CALL_PROVIDER'
    or target_encrypted_payload is null
    or target_cipher_version <> 'AES-256-GCM-v1' then
    raise exception using errcode = '22023', message = 'INVALID_PIOPIY_CONNECTION';
  end if;
  if not app_private.actor_has_tenant_operation_context(
    target_actor_id, target_organization_id, 'integration.manage'
  ) or not exists (
    select 1
    from public.profiles actor_profile
    join public.user_role_assignments actor_assignment
      on actor_assignment.user_id = actor_profile.id
     and actor_assignment.organization_id = actor_profile.organization_id
     and actor_assignment.active
     and actor_assignment.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
    join public.roles actor_role
      on actor_role.id = actor_assignment.role_id
     and actor_role.organization_id = actor_assignment.organization_id
     and actor_role.role_key = 'client_admin'
    where actor_profile.id = target_actor_id
      and actor_profile.organization_id = target_organization_id
      and actor_profile.active and actor_profile.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'CLIENT_ADMIN_REQUIRED';
  end if;
  if (target_scope_mode = 'ALL_BRANCHES' and cardinality(normalized_branch_ids) <> 0)
    or (target_scope_mode = 'ONE_BRANCH' and cardinality(normalized_branch_ids) <> 1)
    or (target_scope_mode = 'SELECTED_BRANCHES'
      and cardinality(normalized_branch_ids) not between 1 and 100)
    or exists (
      select 1 from unnest(normalized_branch_ids) requested(branch_id)
      where not exists (
        select 1 from public.branches branch_row
        where branch_row.id = requested.branch_id
          and branch_row.organization_id = target_organization_id
          and branch_row.active and branch_row.deleted_at is null
      )
    ) then
    raise exception using errcode = '22023', message = 'INVALID_PIOPIY_BRANCH_SCOPE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    target_organization_id::text || ':piopiy:' || target_request_id::text, 0));
  if exists (
    select 1 from public.audit_logs audit_row
    where audit_row.organization_id = target_organization_id
      and audit_row.actor_id = target_actor_id
      and audit_row.request_id = target_request_id
      and audit_row.action = 'integration.piopiy_saved'
  ) then
    return (select audit_row.metadata->'result' from public.audit_logs audit_row
      where audit_row.organization_id = target_organization_id
        and audit_row.actor_id = target_actor_id
        and audit_row.request_id = target_request_id
        and audit_row.action = 'integration.piopiy_saved'
      limit 1) || jsonb_build_object('replayed', true);
  end if;

  if target_connection_id is not null then
    select * into connection_row from public.connected_accounts
    where id = target_connection_id and organization_id = target_organization_id
      and provider_key = 'telecmi_piopiy' and deleted_at is null
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'PIOPIY_CONNECTION_NOT_FOUND';
    end if;
    next_credential_version := connection_row.credential_version + 1;
    update public.connected_accounts set
      display_name = btrim(target_display_name),
      scope_mode = target_scope_mode,
      status = 'CONNECTED',
      auth_type = 'API_KEY',
      external_account_id = btrim(target_external_account_id),
      credential_version = next_credential_version,
      connection_config = target_connection_config,
      connected_at = now(),
      last_error_code = null,
      updated_at = now()
    where id = connection_row.id;
  else
    next_credential_version := 1;
    insert into public.connected_accounts (
      organization_id, provider_key, display_name, scope_mode, status, auth_type,
      external_account_id, credential_version, connection_config, connected_at, created_by
    ) values (
      target_organization_id, 'telecmi_piopiy', btrim(target_display_name), target_scope_mode,
      'CONNECTED', 'API_KEY', btrim(target_external_account_id), next_credential_version,
      target_connection_config, now(), target_actor_id
    ) returning * into connection_row;
  end if;

  insert into public.integration_credentials (
    organization_id, connected_account_id, encrypted_payload, key_version,
    cipher_version, replaced_by, updated_at
  ) values (
    target_organization_id, connection_row.id, target_encrypted_payload,
    next_credential_version, target_cipher_version, target_actor_id, now()
  )
  on conflict (connected_account_id) do update set
    encrypted_payload = excluded.encrypted_payload,
    key_version = excluded.key_version,
    cipher_version = excluded.cipher_version,
    replaced_by = excluded.replaced_by,
    updated_at = now();

  update public.integration_branch_mappings set deleted_at = now()
  where organization_id = target_organization_id
    and connected_account_id = connection_row.id
    and external_resource_type = 'CONNECTION_SCOPE'
    and deleted_at is null;
  if target_scope_mode <> 'ALL_BRANCHES' then
    insert into public.integration_branch_mappings (
      organization_id, connected_account_id, branch_id,
      external_resource_type, external_resource_id, deleted_at
    )
    select target_organization_id, connection_row.id, branch_id,
      'CONNECTION_SCOPE', branch_id::text, null
    from unnest(normalized_branch_ids) branch_id
    on conflict (connected_account_id, branch_id, external_resource_type, external_resource_id)
    do update set organization_id = excluded.organization_id, deleted_at = null;
  end if;

  update public.auto_call_dialers set paused_reason = null, consecutive_failures = 0, updated_at = now()
  where organization_id = target_organization_id
    and paused_reason in ('PIOPIY_NOT_CONNECTED', 'PROVIDER_FAILING', 'PIOPIY_AUTH_FAILED');

  result := jsonb_build_object('connection_id', connection_row.id,
    'credential_version', next_credential_version, 'replayed', false);
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id, target_actor_id, 'integration.piopiy_saved',
    'connected_account', connection_row.id::text, target_request_id,
    jsonb_build_object('result', result, 'provider_key', 'telecmi_piopiy',
      'scope_mode', target_scope_mode)
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------- patches

-- Prompt recordings upload against the flow, only for whoever may edit flows.
do $patch$
declare
  definition text := pg_get_functiondef('public.authorize_object_action(uuid,uuid,text,uuid,text)'::regprocedure);
  anchor text := E'    when ''customer'' then exists (\n';
  addition text := E'    when ''auto_ivr_flow'' then target_branch_id is null\n'
    || E'      and app_private.has_permission(target_organization_id, ''integration.manage'')\n'
    || E'      and exists (\n'
    || E'        select 1 from public.auto_ivr_flows resource_row\n'
    || E'        where resource_row.id = target_resource_id\n'
    || E'          and resource_row.organization_id = target_organization_id\n'
    || E'          and resource_row.deleted_at is null\n'
    || E'      )\n';
begin
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'authorize_object_action anchor not found exactly once';
  end if;
  if position('''auto_ivr_flow''' in definition) > 0 then
    raise exception 'authorize_object_action already patched';
  end if;
  execute replace(definition, anchor, addition || anchor);
end;
$patch$;

-- My Leads rows carry the auto-contact call so the list can badge it.
do $patch$
declare
  target regprocedure := 'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean,text,date,date)'::regprocedure;
  definition text := pg_get_functiondef(target);
  anchors text[] := array[
    E'        stage_row.lead_stage,\n        lead_row.first_contacted_at,\n',
    E'          ''first_contacted_at'', first_contacted_at,\n'
  ];
  replacements text[] := array[
    E'        stage_row.lead_stage,\n        lead_row.first_contacted_at,\n'
      || E'        lead_row.auto_contact_call_id,\n        lead_row.auto_contact_verified_at,\n',
    E'          ''first_contacted_at'', first_contacted_at,\n'
      || E'          ''auto_contact_call_id'', auto_contact_call_id,\n'
      || E'          ''auto_contact_verified_at'', auto_contact_verified_at,\n'
  ];
  i integer;
begin
  if position('auto_contact_call_id' in definition) > 0 then
    raise exception 'lead workspace page already patched';
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], ''))) / length(anchors[i]) <> 1 then
      raise exception 'lead workspace anchor % not found exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
  if position('''auto_contact_call_id''' in pg_get_functiondef(target)) = 0 then
    raise exception 'lead workspace patch did not land';
  end if;
end;
$patch$;

-- ---------------------------------------------------------------- grants

revoke all on function app_private.auto_ivr_field_value_valid(text, jsonb) from public, anon, authenticated;
revoke all on function app_private.auto_ivr_prompt_error(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function app_private.auto_ivr_definition_error(uuid, jsonb) from public, anon, authenticated;
revoke all on function app_private.can_manage_auto_call(uuid) from public, anon, authenticated;
revoke all on function app_private.is_active_telecaller(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.auto_call_connection_for_branch(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.mark_auto_call_contact(uuid) from public, anon, authenticated;
revoke all on function app_private.finalize_auto_ivr_call_internal(uuid, text, integer, text, text) from public, anon, authenticated;

revoke all on function public.get_auto_call_admin_workspace() from public, anon;
revoke all on function public.save_auto_call_settings(boolean, uuid, time, time, integer, integer, integer, integer, bigint) from public, anon;
revoke all on function public.get_auto_ivr_flow(uuid) from public, anon;
revoke all on function public.save_auto_ivr_flow_draft(uuid, text, jsonb, bigint) from public, anon;
revoke all on function public.publish_auto_ivr_flow(uuid, bigint) from public, anon;
revoke all on function public.archive_auto_ivr_flow(uuid, bigint) from public, anon;
revoke all on function public.get_my_auto_call_status() from public, anon;
revoke all on function public.set_my_auto_call(boolean) from public, anon;
revoke all on function public.get_my_auto_calls(integer, integer) from public, anon;
revoke all on function public.get_auto_call_result(uuid) from public, anon;
revoke all on function public.apply_auto_call_suggestions(uuid, text[], uuid) from public, anon;
revoke all on function public.verify_auto_contact(uuid) from public, anon;
grant execute on function public.get_auto_call_admin_workspace() to authenticated;
grant execute on function public.save_auto_call_settings(boolean, uuid, time, time, integer, integer, integer, integer, bigint) to authenticated;
grant execute on function public.get_auto_ivr_flow(uuid) to authenticated;
grant execute on function public.save_auto_ivr_flow_draft(uuid, text, jsonb, bigint) to authenticated;
grant execute on function public.publish_auto_ivr_flow(uuid, bigint) to authenticated;
grant execute on function public.archive_auto_ivr_flow(uuid, bigint) to authenticated;
grant execute on function public.get_my_auto_call_status() to authenticated;
grant execute on function public.set_my_auto_call(boolean) to authenticated;
grant execute on function public.get_my_auto_calls(integer, integer) to authenticated;
grant execute on function public.get_auto_call_result(uuid) to authenticated;
grant execute on function public.apply_auto_call_suggestions(uuid, text[], uuid) to authenticated;
grant execute on function public.verify_auto_contact(uuid) to authenticated;

revoke all on function public.claim_auto_call_jobs(text, integer) from public, anon, authenticated;
revoke all on function public.mark_auto_call_dispatched(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_auto_call_dispatch(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.record_auto_ivr_answer(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.finalize_auto_ivr_call(uuid, uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.get_auto_ivr_prompt_object(uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_piopiy_connection(uuid, uuid, text, public.branch_scope_mode, uuid[], text, jsonb, bytea, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_auto_call_jobs(text, integer) to service_role;
grant execute on function public.mark_auto_call_dispatched(uuid, uuid, text) to service_role;
grant execute on function public.fail_auto_call_dispatch(uuid, uuid, text, boolean) to service_role;
grant execute on function public.record_auto_ivr_answer(uuid, uuid, text, text, integer) to service_role;
grant execute on function public.finalize_auto_ivr_call(uuid, uuid, text, integer, text) to service_role;
grant execute on function public.get_auto_ivr_prompt_object(uuid, uuid) to service_role;
grant execute on function public.save_piopiy_connection(uuid, uuid, text, public.branch_scope_mode, uuid[], text, jsonb, bytea, text, uuid, uuid) to service_role;

commit;
