-- Phone call recordings -> CRM (mobile recording sync).
--
-- Telecallers and Sales Consultants call from their own phones, and Android's
-- built-in recorder saves each call as an audio file. The mobile app now syncs
-- that folder: every new file becomes a PERSONAL_MANUAL call on the lead with
-- that phone number, or a call with no lead that the user can turn into a lead
-- pre-filled from the transcript.
--
--   * log_recorded_phone_call: one call per recording file. The file's SHA-256
--     is the idempotency key, so a re-sync returns the existing call. Matching
--     reads only the leads carrying that one phone number (the org/phone index),
--     so its cost scales with the duplicates of one number, not with the
--     tenant's lead count; the caller's record scope is applied to that handful.
--   * AI is on demand by default. A recording attached by its uploader queues
--     transcription + summary only when that user switched on auto_process in
--     user_call_ai_preferences (default off). Otherwise the call shows a
--     "Transcribe & summarise" button: request_call_ai_processing.
--     Provider (IVR) recordings keep queueing automatically, as before.
--   * Suggestions are kept for a call with no lead (save_ai_call_analysis_result
--     no longer drops them), so get_ai_call_field_review can pre-fill the new
--     lead form and create_lead_from_call_review applies what the user confirmed
--     (Suggest -> Review -> Apply; nothing is written without that review).
--   * The owner of a manual call may attach its recording and request AI with
--     call.create: the Telecaller preset has call.create but not call.update, so
--     until now a Telecaller could not attach a recording to their own call.
--
-- Bodies of the replaced functions are the deployed definitions with only the
-- described predicates changed.

begin;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.calls
  add column if not exists recording_sync_key text;

alter table public.calls
  drop constraint if exists calls_recording_sync_key_format;
alter table public.calls
  add constraint calls_recording_sync_key_format
  check (recording_sync_key is null or recording_sync_key ~ '^[0-9a-f]{64}$');

create unique index if not exists calls_recording_sync_key_unique_idx
  on public.calls (organization_id, assigned_user_id, recording_sync_key)
  where recording_sync_key is not null;

create table if not exists public.user_call_ai_preferences (
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references public.profiles(id),
  auto_process boolean not null default false,
  auto_sync boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id) references public.profiles(organization_id, id)
);

alter table public.user_call_ai_preferences enable row level security;
revoke all on table public.user_call_ai_preferences from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- '+91 98765 43210', '09876543210', '919876543210' and '9876543210' all become
-- '+919876543210', the form leads.normalized_phone carries. Other international
-- numbers keep their '+' and digits; anything else is not a phone number.
create or replace function app_private.recorded_call_phone(input_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when digits ~ '^(91|0)?[6-9][0-9]{9}$' then '+91' || right(digits, 10)
    when btrim(coalesce(input_value, '')) ~ '^[+]' and digits ~ '^[1-9][0-9]{7,14}$'
      then '+' || digits
    else null
  end
  from (select regexp_replace(coalesce(input_value, ''), '[^0-9]', '', 'g') as digits) phone_row
$$;

create or replace function app_private.call_ai_auto_process_enabled(
  target_organization_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select preference_row.auto_process
    from public.user_call_ai_preferences preference_row
    where preference_row.organization_id = target_organization_id
      and preference_row.user_id = target_user_id
  ), false)
$$;

-- A manual call may be changed by call.update holders in scope, or by the user
-- who logged it (call.create) -- the Telecaller preset.
create or replace function app_private.can_update_own_manual_call(
  target_organization_id uuid,
  target_assigned_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.has_permission(target_organization_id, 'call.update')
    or (
      target_assigned_user_id = auth.uid()
      and app_private.has_permission(target_organization_id, 'call.create')
    )
$$;

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------

create or replace function public.get_my_call_ai_preferences()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  preference_row public.user_call_ai_preferences%rowtype;
begin
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into preference_row
  from public.user_call_ai_preferences preference
  where preference.organization_id = current_organization_id
    and preference.user_id = auth.uid();
  return jsonb_build_object(
    'auto_process', coalesce(preference_row.auto_process, false),
    'auto_sync', coalesce(preference_row.auto_sync, true),
    'updated_at', preference_row.updated_at
  );
end;
$$;

create or replace function public.set_my_call_ai_preferences(
  target_auto_process boolean default null,
  target_auto_sync boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  previous_row public.user_call_ai_preferences%rowtype;
  saved_row public.user_call_ai_preferences%rowtype;
begin
  if auth.uid() is null or current_organization_id is null
    or not exists (
      select 1 from public.profiles profile_row
      where profile_row.id = auth.uid()
        and profile_row.organization_id = current_organization_id
        and profile_row.active
        and profile_row.deleted_at is null
    )
  then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select * into previous_row
  from public.user_call_ai_preferences preference
  where preference.organization_id = current_organization_id
    and preference.user_id = auth.uid()
  for update;

  insert into public.user_call_ai_preferences as preference (
    organization_id, user_id, auto_process, auto_sync, updated_at
  ) values (
    current_organization_id,
    auth.uid(),
    coalesce(target_auto_process, previous_row.auto_process, false),
    coalesce(target_auto_sync, previous_row.auto_sync, true),
    now()
  )
  on conflict (organization_id, user_id) do update set
    auto_process = excluded.auto_process,
    auto_sync = excluded.auto_sync,
    updated_at = now()
  returning * into saved_row;

  -- Auto-processing spends AI credits, so turning it on or off is audited.
  if saved_row.auto_process is distinct from coalesce(previous_row.auto_process, false) then
    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, metadata
    ) values (
      current_organization_id, auth.uid(), 'call_ai.preferences_updated',
      'profile', auth.uid()::text,
      jsonb_build_object(
        'auto_process', saved_row.auto_process,
        'auto_sync', saved_row.auto_sync
      )
    );
  end if;

  return jsonb_build_object(
    'auto_process', saved_row.auto_process,
    'auto_sync', saved_row.auto_sync,
    'updated_at', saved_row.updated_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording sync
-- ---------------------------------------------------------------------------

create or replace function public.log_recorded_phone_call(
  target_phone text,
  target_direction text,
  target_started_at timestamptz,
  target_duration_seconds integer,
  target_sync_key text,
  target_file_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  call_phone text := app_private.recorded_call_phone(target_phone);
  normalized_direction text := upper(btrim(coalesce(target_direction, '')));
  normalized_key text := lower(btrim(coalesce(target_sync_key, '')));
  normalized_file_name text := left(nullif(btrim(coalesce(target_file_name, '')), ''), 200);
  existing_call public.calls%rowtype;
  lead_record public.leads%rowtype;
  effective_branch_id uuid;
  effective_team_id uuid;
  effective_customer_id uuid;
  created_call public.calls%rowtype;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if normalized_key !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'RECORDED_CALL_SYNC_KEY_INVALID';
  end if;
  if call_phone is null or char_length(call_phone) > 32 then
    raise exception using errcode = '22023', message = 'RECORDED_CALL_PHONE_INVALID';
  end if;
  if normalized_direction not in ('INBOUND', 'OUTBOUND') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_DIRECTION';
  end if;
  if target_started_at is null
    or target_started_at > now() + interval '5 minutes'
    or target_started_at < now() - interval '366 days'
  then
    raise exception using errcode = '22023', message = 'CALL_START_TIME_OUT_OF_RANGE';
  end if;
  if target_duration_seconds is not null
    and (target_duration_seconds < 0 or target_duration_seconds > 86400)
  then
    raise exception using errcode = '22023', message = 'RECORDED_CALL_DURATION_INVALID';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.create')
    or not exists (
      select 1 from public.profiles profile_row
      where profile_row.id = auth.uid()
        and profile_row.organization_id = current_organization_id
        and profile_row.active
        and profile_row.deleted_at is null
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      current_organization_id::text || ':' || auth.uid()::text || ':' || normalized_key, 0
    )
  );

  select * into existing_call
  from public.calls call_row
  where call_row.organization_id = current_organization_id
    and call_row.assigned_user_id = auth.uid()
    and call_row.recording_sync_key = normalized_key;
  if found then
    return jsonb_build_object(
      'call_id', existing_call.id,
      'organization_id', existing_call.organization_id,
      'branch_id', existing_call.branch_id,
      'lead_id', existing_call.lead_id,
      'customer_id', existing_call.customer_id,
      'customer_name', (
        select lead_row.customer_name from public.leads lead_row
        where lead_row.organization_id = existing_call.organization_id
          and lead_row.id = existing_call.lead_id
      ),
      'phone', existing_call.normalized_caller_phone,
      'matched', existing_call.lead_id is not null,
      'duplicate', true,
      'has_recording', exists (
        select 1 from public.call_recordings recording_row
        where recording_row.organization_id = existing_call.organization_id
          and recording_row.call_id = existing_call.id
          and recording_row.status = 'READY'
          and recording_row.object_file_id is not null
      )
    );
  end if;

  -- The leads with this one number, narrowed to the caller's record scope.
  -- Prefer an open lead, then one the caller owns, then the latest activity.
  if app_private.has_permission(current_organization_id, 'lead.view') then
    select lead_row.* into lead_record
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.normalized_phone = call_phone
      and lead_row.deleted_at is null
      and app_private.can_access_record(
        lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
      )
    order by
      (lead_row.lifecycle_status <> 'Lost') desc,
      (lead_row.assigned_user_id is not distinct from auth.uid()) desc,
      lead_row.updated_at desc,
      lead_row.id desc
    limit 1;
  end if;

  if lead_record.id is not null then
    effective_branch_id := lead_record.branch_id;
    effective_team_id := lead_record.team_id;
    if lead_record.customer_id is not null
      and app_private.has_permission(current_organization_id, 'customer.view')
      and app_private.can_access_customer(current_organization_id, lead_record.customer_id)
    then
      effective_customer_id := lead_record.customer_id;
    end if;
  else
    -- No lead: file the call under the caller's own team, else a branch they
    -- are granted, so their manager sees it in the usual place.
    select team_row.branch_id, team_row.id into effective_branch_id, effective_team_id
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
     and team_row.active
    join public.branches branch_row
      on branch_row.id = team_row.branch_id
     and branch_row.organization_id = team_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    where member_row.organization_id = current_organization_id
      and member_row.user_id = auth.uid()
      and member_row.active
    order by member_row.joined_at, team_row.id
    limit 1;

    if effective_branch_id is null then
      select access_row.branch_id into effective_branch_id
      from public.user_branch_access access_row
      join public.branches branch_row
        on branch_row.id = access_row.branch_id
       and branch_row.organization_id = access_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where access_row.organization_id = current_organization_id
        and access_row.user_id = auth.uid()
        and access_row.active
      order by access_row.created_at, access_row.branch_id
      limit 1;
    end if;
    if effective_branch_id is null then
      select assignment_row.scope_branch_id into effective_branch_id
      from public.user_role_assignments assignment_row
      join public.branches branch_row
        on branch_row.id = assignment_row.scope_branch_id
       and branch_row.organization_id = assignment_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where assignment_row.organization_id = current_organization_id
        and assignment_row.user_id = auth.uid()
        and assignment_row.active
      order by assignment_row.created_at
      limit 1;
    end if;
  end if;

  if effective_branch_id is null then
    raise exception using errcode = '22023', message = 'CALL_BRANCH_REQUIRED';
  end if;
  if not app_private.can_access_record(
    current_organization_id, effective_branch_id, effective_team_id, auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'CALL_SCOPE_DENIED';
  end if;

  -- A recorded call connected; its outcome is known, so it is logged complete.
  insert into public.calls (
    organization_id,
    branch_id,
    team_id,
    lead_id,
    customer_id,
    assigned_user_id,
    direction,
    call_source,
    started_at,
    ended_at,
    duration_seconds,
    outcome,
    status,
    notes,
    finalized_at,
    finalized_by,
    caller_phone,
    normalized_caller_phone,
    recording_sync_key
  ) values (
    current_organization_id,
    effective_branch_id,
    effective_team_id,
    lead_record.id,
    effective_customer_id,
    auth.uid(),
    normalized_direction,
    'PERSONAL_MANUAL',
    target_started_at,
    target_started_at + make_interval(secs => coalesce(target_duration_seconds, 0)),
    target_duration_seconds,
    'CONNECTED',
    'COMPLETED',
    case when normalized_file_name is null then 'Phone call recording'
      else left('Phone call recording: ' || normalized_file_name, 4000) end,
    now(),
    auth.uid(),
    call_phone,
    call_phone,
    normalized_key
  ) returning * into created_call;

  result := jsonb_build_object(
    'call_id', created_call.id,
    'organization_id', created_call.organization_id,
    'branch_id', created_call.branch_id,
    'lead_id', created_call.lead_id,
    'customer_id', created_call.customer_id,
    'customer_name', lead_record.customer_name,
    'phone', call_phone,
    'matched', lead_record.id is not null,
    'duplicate', false,
    'has_recording', false
  );

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'call.recording_synced', 'call',
    created_call.id::text, effective_branch_id,
    jsonb_build_object(
      'lead_id', created_call.lead_id,
      'matched', lead_record.id is not null,
      'direction', normalized_direction
    )
  );

  if lead_record.id is not null then
    insert into public.activities (
      organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at
    ) values (
      current_organization_id,
      effective_customer_id,
      lead_record.id,
      'CALL_LOGGED',
      auth.uid(),
      jsonb_build_object(
        'call_id', created_call.id,
        'direction', normalized_direction,
        'call_source', 'PERSONAL_MANUAL',
        'recording_sync', true
      ),
      target_started_at
    );
  end if;

  return result;
end;
$$;

-- Deployed body (202608200006); only the permission check changed: the call's
-- owner may attach with call.create.
create or replace function public.attach_manual_call_recording(
  target_call_id uuid,
  target_object_file_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  object_row public.object_files%rowtype;
  previous_metadata jsonb;
  recording_row public.call_recordings%rowtype;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_call_id is null or target_object_file_id is null or target_request_id is null then
    raise exception using errcode = '22023', message = 'CALL_RECORDING_FIELDS_REQUIRED';
  end if;

  select audit_row.metadata into previous_metadata
  from public.audit_logs audit_row
  where audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'call.manual_recording_attached';
  if found then
    if previous_metadata->>'call_id' is distinct from target_call_id::text
      or previous_metadata->>'object_file_id' is distinct from target_object_file_id::text
    then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata->'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;

  select * into call_row
  from public.calls
  where id = target_call_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
  end if;
  if call_row.call_source <> 'PERSONAL_MANUAL' then
    raise exception using errcode = '42501', message = 'PROVIDER_RECORDING_UPLOAD_DENIED';
  end if;
  if not app_private.can_update_own_manual_call(call_row.organization_id, call_row.assigned_user_id)
    or not app_private.has_permission(call_row.organization_id, 'document.upload')
    or not app_private.can_access_call(call_row.organization_id, call_row.id)
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  select * into object_row
  from public.object_files
  where id = target_object_file_id
    and organization_id = call_row.organization_id
    and resource_type = 'call'
    and resource_id = call_row.id
    and deleted_at is null;
  if not found or lower(object_row.mime_type) not in (
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm'
  ) then
    raise exception using errcode = '23514', message = 'CALL_RECORDING_OBJECT_INVALID';
  end if;
  if object_row.uploaded_by is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'CALL_RECORDING_UPLOADER_MISMATCH';
  end if;

  insert into public.call_recordings (
    organization_id,
    call_id,
    object_file_id,
    source,
    status,
    checksum
  ) values (
    call_row.organization_id,
    call_row.id,
    object_row.id,
    'MANUAL_UPLOAD',
    'READY',
    object_row.checksum
  )
  on conflict (organization_id, object_file_id) where object_file_id is not null
  do update set status = 'READY'
  returning * into recording_row;

  result := jsonb_build_object(
    'recording_id', recording_row.id,
    'call_id', call_row.id,
    'object_file_id', object_row.id,
    'status', recording_row.status,
    'replayed', false
  );

  insert into public.audit_logs (
    organization_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    branch_id,
    request_id,
    metadata
  ) values (
    call_row.organization_id,
    auth.uid(),
    'call.manual_recording_attached',
    'call_recording',
    recording_row.id::text,
    call_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'call_id', call_row.id,
      'object_file_id', object_row.id,
      'result', result
    )
  );

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- AI on demand
-- ---------------------------------------------------------------------------

-- Deployed body (202610171573); a manual upload now queues only when its
-- uploader chose automatic processing.
create or replace function app_private.enqueue_ai_call_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare call_row public.calls%rowtype;
  uploader_id uuid;
begin
  if new.status <> 'READY' or new.object_file_id is null then return new; end if;
  select * into call_row from public.calls
  where id = new.call_id and organization_id = new.organization_id
    and call_source in ('PROVIDER', 'PERSONAL_MANUAL')
    and call_mode <> 'AUTO_AI';
  if not found then return new; end if;
  if call_row.call_source = 'PERSONAL_MANUAL' then
    select file_row.uploaded_by into uploader_id
    from public.object_files file_row
    where file_row.organization_id = new.organization_id
      and file_row.id = new.object_file_id;
    if not app_private.call_ai_auto_process_enabled(
      new.organization_id, coalesce(uploader_id, call_row.assigned_user_id)
    ) then
      return new;
    end if;
  end if;
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

-- The "Transcribe & summarise" button. Queues the call's latest ready
-- recording once; a queued or running job is returned as is. Credits are
-- reserved and committed by the worker, as for automatic jobs.
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

  if found and job_row.status in ('QUEUED', 'PROCESSING', 'RETRY') then
    return jsonb_build_object('job_id', job_row.id, 'status', job_row.status, 'queued', false);
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
      'regenerate', coalesce(target_regenerate, false)
    )
  );

  return jsonb_build_object('job_id', job_row.id, 'status', job_row.status, 'queued', true);
end;
$$;

-- What the call screen needs to show the AI button, its progress and the
-- create-lead / review actions. Polled while a job runs; one call, no lists.
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

  return jsonb_build_object(
    'call_id', call_row.id,
    'lead_id', visible_lead_id,
    'phone', call_row.normalized_caller_phone,
    'call_source', call_row.call_source,
    'recording_ready', recording_row.id is not null,
    'job', case when job_row.id is null then null else jsonb_build_object(
      'id', job_row.id,
      'status', job_row.status,
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
    'auto_process', app_private.call_ai_auto_process_enabled(call_row.organization_id, auth.uid())
  );
end;
$$;

-- Deployed body (202609030001); suggestions are now kept for a call with no
-- lead, so they can pre-fill the new lead form.
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
    on conflict (organization_id, processing_job_id) do update set
      status = 'COMPLETED', suggestions = excluded.suggestions;
  end if;
  return true;
end;
$$;

-- Deployed body (202609040006); reads a call with no lead too, so the new lead
-- form can be pre-filled. The caller's phone stands in for the missing lead.
create or replace function public.get_ai_call_field_review(target_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  call_record public.calls%rowtype;
  extraction_record public.ai_extraction_runs%rowtype;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into call_record from public.calls where id = target_call_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
  end if;
  if not app_private.has_permission(call_record.organization_id, 'call.view')
    or not app_private.can_access_record(
      call_record.organization_id, call_record.branch_id,
      call_record.team_id, call_record.assigned_user_id
    ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select * into extraction_record
  from public.ai_extraction_runs extraction_row
  where extraction_row.organization_id = call_record.organization_id
    and extraction_row.call_id = call_record.id
  order by extraction_row.created_at desc, extraction_row.id desc
  limit 1;

  select jsonb_build_object(
    'call', jsonb_build_object(
      'id', call_record.id,
      'lead_id', call_record.lead_id,
      'customer_name', coalesce(customer_row.full_name, lead_row.customer_name, 'Customer'),
      'phone', coalesce(
        customer_row.primary_phone, lead_row.phone, call_record.normalized_caller_phone, ''
      ),
      'interested_model', lead_row.interested_model,
      'started_at', call_record.started_at,
      'duration_seconds', call_record.duration_seconds
    ),
    'transcript', (
      select jsonb_build_object(
        'text', left(transcript_row.transcript_text, 100000),
        'language', transcript_row.language,
        'speaker_turns', coalesce((
          select jsonb_agg(turn_row.value order by turn_row.ordinality)
          from jsonb_array_elements(coalesce(transcript_row.speaker_turns, '[]'::jsonb))
            with ordinality as turn_row(value, ordinality)
          where turn_row.ordinality <= 500
        ), '[]'::jsonb),
        'speaker_separation_method', transcript_row.speaker_separation_method,
        'truncated', char_length(coalesce(transcript_row.transcript_text, '')) > 100000
          or jsonb_array_length(coalesce(transcript_row.speaker_turns, '[]'::jsonb)) > 500
      )
      from public.call_transcripts transcript_row
      where transcript_row.organization_id = call_record.organization_id
        and transcript_row.call_id = call_record.id
      order by transcript_row.created_at desc, transcript_row.id desc
      limit 1
    ),
    'summary', (
      select left(summary_row.summary, 20000)
      from public.ai_call_summaries summary_row
      where summary_row.organization_id = call_record.organization_id
        and summary_row.call_id = call_record.id
      order by summary_row.created_at desc, summary_row.id desc
      limit 1
    ),
    'extraction', case
      when extraction_record.id is null then null
      else jsonb_build_object(
        'id', extraction_record.id,
        'status', extraction_record.status,
        'created_at', extraction_record.created_at,
        'fields', coalesce((
          select jsonb_agg(jsonb_build_object(
            'field_key', suggested.key,
            'suggested_value', suggested.value,
            'current_value', case suggested.key
              when 'customer_name' then to_jsonb(coalesce(customer_row.full_name, lead_row.customer_name))
              when 'phone' then to_jsonb(coalesce(customer_row.primary_phone, lead_row.phone))
              when 'email' then to_jsonb(coalesce(customer_row.primary_email, lead_row.email))
              else to_jsonb(lead_row) -> suggested.key
            end,
            'decision', coalesce(review_row.decision, 'PENDING'),
            'applied_value', review_row.applied_value
          ) order by suggested.key)
          from jsonb_each(extraction_record.suggestions) suggested
          left join lateral (
            select field_review.decision, field_review.applied_value
            from public.ai_field_reviews field_review
            where field_review.extraction_run_id = extraction_record.id
              and field_review.field_key = suggested.key
            order by field_review.reviewed_at desc nulls last, field_review.id desc
            limit 1
          ) review_row on true
        ), '[]'::jsonb)
      )
    end
  ) into result
  from (select 1) anchor_row
  left join public.leads lead_row
    on lead_row.organization_id = call_record.organization_id
   and lead_row.id = call_record.lead_id
  left join public.customers customer_row
    on customer_row.organization_id = call_record.organization_id
   and customer_row.id = coalesce(call_record.customer_id, lead_row.customer_id)
   and customer_row.deleted_at is null;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- New lead from a call
-- ---------------------------------------------------------------------------

-- Deployed body (202610091401); the source detail now says where the call came
-- from, and the call's AI suggestions follow it onto the new lead.
create or replace function public.create_lead_from_call(
  target_call_id uuid,
  lead_customer_name text,
  lead_interested_model text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  new_lead_id uuid;
  new_customer_id uuid;
begin
  select * into call_row from public.calls where id = target_call_id for update;
  if not found or not app_private.can_access_call(call_row.organization_id, call_row.id) then
    raise exception using errcode = '42501', message = 'CALL_ACCESS_DENIED';
  end if;
  if call_row.lead_id is not null then
    raise exception using errcode = 'PT409', message = 'CALL_ALREADY_HAS_LEAD';
  end if;
  if nullif(btrim(coalesce(call_row.normalized_caller_phone, '')), '') is null then
    raise exception using errcode = '22023', message = 'CALL_HAS_NO_CALLER_PHONE';
  end if;

  new_lead_id := public.create_lead(
    call_row.organization_id,
    call_row.branch_id,
    -- No team: a telecaller (own-records scope) then self-assigns the lead, so
    -- whoever handled the call keeps the customer instead of round-robin
    -- handing it to a colleague; a manager creates into the queue as usual.
    null,
    'Manual',
    lead_customer_name,
    call_row.normalized_caller_phone,
    null,
    case when call_row.call_source = 'PERSONAL_MANUAL'
      then 'Phone call recording' else 'TeleCMI inbound call' end,
    null,
    nullif(btrim(coalesce(lead_interested_model, '')), '')
  );

  select customer_id into new_customer_id from public.leads where id = new_lead_id;

  update public.calls set
    lead_id = new_lead_id,
    customer_id = coalesce(customer_id, new_customer_id),
    version = version + 1,
    updated_at = now()
  where id = call_row.id;

  update public.ai_extraction_runs set lead_id = new_lead_id
  where organization_id = call_row.organization_id
    and call_id = call_row.id
    and lead_id is null;

  insert into public.audit_logs (
    organization_id, branch_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    call_row.organization_id, call_row.branch_id, auth.uid(), 'call.lead_created_from_call',
    'call', call_row.id, jsonb_build_object('lead_id', new_lead_id)
  );

  return jsonb_build_object('call_id', call_row.id, 'lead_id', new_lead_id);
end;
$$;

-- The pre-filled new lead form. The user confirmed name / email / model (each
-- may differ from the suggestion); target_decisions carries their review of
-- the remaining suggestions (temperature, next follow-up, ...) and is applied
-- through review_ai_call_fields once the lead exists, so the same validation,
-- audit and Suggest -> Review -> Apply records are written as for any lead.
create or replace function public.create_lead_from_call_review(
  target_call_id uuid,
  target_customer_name text,
  target_email text,
  target_interested_model text,
  target_decisions jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  extraction_record public.ai_extraction_runs%rowtype;
  previous_metadata jsonb;
  normalized_name text := nullif(btrim(coalesce(target_customer_name, '')), '');
  normalized_email text := lower(nullif(btrim(coalesce(target_email, '')), ''));
  normalized_model text := nullif(btrim(coalesce(target_interested_model, '')), '');
  decisions jsonb := coalesce(target_decisions, '[]'::jsonb);
  lead_decisions jsonb;
  created jsonb;
  new_lead_id uuid;
  new_customer_id uuid;
  review_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_call_id is null or target_request_id is null
    or jsonb_typeof(decisions) <> 'array'
    or jsonb_array_length(decisions) > 8
    or normalized_name is null or char_length(normalized_name) > 200
    or (normalized_email is not null and (
      char_length(normalized_email) > 320 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    ))
    or (normalized_model is not null and char_length(normalized_model) > 200)
  then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_FROM_CALL_REQUEST';
  end if;

  select * into call_row from public.calls where id = target_call_id for update;
  if not found or not app_private.can_access_call(call_row.organization_id, call_row.id) then
    raise exception using errcode = '42501', message = 'CALL_ACCESS_DENIED';
  end if;

  select audit_row.metadata into previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = call_row.organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'call.lead_created_from_review';
  if found then
    if previous_metadata ->> 'call_id' is distinct from call_row.id::text then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata -> 'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;

  if call_row.lead_id is not null then
    raise exception using errcode = 'PT409', message = 'CALL_ALREADY_HAS_LEAD';
  end if;
  if nullif(btrim(coalesce(call_row.normalized_caller_phone, '')), '') is null then
    raise exception using errcode = '22023', message = 'CALL_HAS_NO_CALLER_PHONE';
  end if;

  new_lead_id := public.create_lead(
    call_row.organization_id,
    call_row.branch_id,
    null,
    'Manual',
    normalized_name,
    call_row.normalized_caller_phone,
    normalized_email,
    case when call_row.call_source = 'PERSONAL_MANUAL'
      then 'Phone call recording' else 'TeleCMI inbound call' end,
    null,
    normalized_model
  );
  select customer_id into new_customer_id from public.leads where id = new_lead_id;

  update public.calls set
    lead_id = new_lead_id,
    customer_id = coalesce(customer_id, new_customer_id),
    version = version + 1,
    updated_at = now()
  where id = call_row.id;

  update public.ai_extraction_runs set lead_id = new_lead_id
  where organization_id = call_row.organization_id
    and call_id = call_row.id
    and lead_id is null;

  select * into extraction_record
  from public.ai_extraction_runs extraction_row
  where extraction_row.organization_id = call_row.organization_id
    and extraction_row.call_id = call_row.id
  order by extraction_row.created_at desc, extraction_row.id desc
  limit 1;

  if extraction_record.id is not null then
    -- The identity fields went into the new lead as the user confirmed them;
    -- record that review so the suggestions are not offered again.
    insert into public.ai_field_reviews (
      organization_id, extraction_run_id, field_key, suggested_value,
      applied_value, decision, reviewed_by, reviewed_at
    )
    select
      extraction_record.organization_id,
      extraction_record.id,
      used.field_key,
      extraction_record.suggestions -> used.field_key,
      to_jsonb(used.value_used),
      case
        when used.value_used is null then 'REJECTED'
        when extraction_record.suggestions -> used.field_key = to_jsonb(used.value_used) then 'APPLIED'
        else 'EDITED'
      end,
      auth.uid(),
      now()
    from (values
      ('customer_name', normalized_name),
      ('phone', call_row.normalized_caller_phone),
      ('email', normalized_email),
      ('interested_model', normalized_model)
    ) as used(field_key, value_used)
    where extraction_record.suggestions ? used.field_key;

    select coalesce(jsonb_agg(decision.value), '[]'::jsonb) into lead_decisions
    from jsonb_array_elements(decisions) decision(value)
    where decision.value ->> 'field_key' not in (
      'customer_name', 'phone', 'email', 'interested_model'
    );
    if jsonb_array_length(lead_decisions) > 0 then
      review_result := public.review_ai_call_fields(
        extraction_record.id,
        lead_decisions,
        md5(target_request_id::text || ':review')::uuid
      );
    end if;
  elsif jsonb_array_length(decisions) > 0 then
    raise exception using errcode = 'P0002', message = 'AI_FIELD_REVIEW_NOT_FOUND';
  end if;

  result := jsonb_build_object(
    'call_id', call_row.id,
    'lead_id', new_lead_id,
    'customer_id', new_customer_id,
    'accepted_fields', coalesce(review_result -> 'accepted_fields', '[]'::jsonb),
    'replayed', false
  );

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    call_row.organization_id, auth.uid(), 'call.lead_created_from_review', 'call',
    call_row.id::text, call_row.branch_id, target_request_id,
    jsonb_build_object(
      'call_id', call_row.id,
      'lead_id', new_lead_id,
      'extraction_run_id', extraction_record.id,
      'result', result
    )
  );

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function app_private.recorded_call_phone(text) from public, anon, authenticated;
revoke all on function app_private.call_ai_auto_process_enabled(uuid, uuid)
  from public, anon, authenticated;
revoke all on function app_private.can_update_own_manual_call(uuid, uuid)
  from public, anon, authenticated;

revoke all on function public.get_my_call_ai_preferences() from public, anon;
revoke all on function public.set_my_call_ai_preferences(boolean, boolean) from public, anon;
revoke all on function public.log_recorded_phone_call(text, text, timestamptz, integer, text, text)
  from public, anon;
revoke all on function public.request_call_ai_processing(uuid, boolean) from public, anon;
revoke all on function public.get_call_ai_processing_state(uuid) from public, anon;
revoke all on function public.create_lead_from_call_review(uuid, text, text, text, jsonb, uuid)
  from public, anon;

grant execute on function public.get_my_call_ai_preferences() to authenticated;
grant execute on function public.set_my_call_ai_preferences(boolean, boolean) to authenticated;
grant execute on function public.log_recorded_phone_call(text, text, timestamptz, integer, text, text)
  to authenticated;
grant execute on function public.request_call_ai_processing(uuid, boolean) to authenticated;
grant execute on function public.get_call_ai_processing_state(uuid) to authenticated;
grant execute on function public.create_lead_from_call_review(uuid, text, text, text, jsonb, uuid)
  to authenticated;

commit;
