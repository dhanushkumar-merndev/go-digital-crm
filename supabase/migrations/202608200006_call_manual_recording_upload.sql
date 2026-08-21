begin;

create or replace function public.get_assigned_dealership_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with actor as (
    select profile_row.organization_id
    from public.profiles profile_row
    where profile_row.id = auth.uid()
      and profile_row.active
      and profile_row.deleted_at is null
  ), assigned_branch as (
    select assignment_row.scope_branch_id as branch_id, 1 as priority
    from public.user_role_assignments assignment_row
    join actor on actor.organization_id = assignment_row.organization_id
    where assignment_row.user_id = auth.uid()
      and assignment_row.active
      and assignment_row.scope_branch_id is not null
    union all
    select team_row.branch_id, 2
    from public.team_members member_row
    join public.teams team_row
      on team_row.organization_id = member_row.organization_id
     and team_row.id = member_row.team_id
     and team_row.active
    join actor on actor.organization_id = member_row.organization_id
    where member_row.user_id = auth.uid() and member_row.active
    union all
    select access_row.branch_id, 3
    from public.user_branch_access access_row
    join actor on actor.organization_id = access_row.organization_id
    where access_row.user_id = auth.uid()
  )
  select coalesce(
    (
      select branch_row.name
      from assigned_branch assignment
      join public.branches branch_row on branch_row.id = assignment.branch_id
      join actor on actor.organization_id = branch_row.organization_id
      where branch_row.active and branch_row.deleted_at is null
      order by assignment.priority, branch_row.name, branch_row.id
      limit 1
    ),
    (
      select organization_row.name
      from actor
      join public.organizations organization_row on organization_row.id = actor.organization_id
      where organization_row.deleted_at is null
    )
  );
$$;

revoke all on function public.get_assigned_dealership_name() from public, anon;
grant execute on function public.get_assigned_dealership_name() to authenticated;

alter table public.call_recordings
  add column if not exists provider_recording_id text,
  add column if not exists duration_seconds integer
    check (duration_seconds is null or duration_seconds >= 0);

create unique index if not exists call_recordings_provider_identity_unique_idx
  on public.call_recordings (organization_id, call_id, provider_recording_id)
  where provider_recording_id is not null;

create unique index if not exists call_recordings_object_file_unique_idx
  on public.call_recordings (organization_id, object_file_id)
  where object_file_id is not null;

create unique index if not exists call_manual_recording_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action = 'call.manual_recording_attached';

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
  if not app_private.has_permission(call_row.organization_id, 'call.update')
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

revoke all on function public.attach_manual_call_recording(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.attach_manual_call_recording(uuid, uuid, uuid)
  to authenticated;

create unique index if not exists call_provider_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action = 'call.provider_requested';

create or replace function public.get_call_provider_options(target_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  organization_id uuid;
  result jsonb;
begin
  select profile_row.organization_id into organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if organization_id is null
    or not app_private.has_permission(organization_id, 'call.create')
    or target_branch_id is null
    or not app_private.can_access_branch(organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', connection_row.id,
    'provider_key', connection_row.provider_key,
    'display_name', connection_row.display_name,
    'caller_id_label', nullif(connection_row.connection_config->>'caller_id_label', '')
  ) order by connection_row.display_name, connection_row.id), '[]'::jsonb)
  into result
  from public.connected_accounts connection_row
  where connection_row.organization_id = organization_id
    and connection_row.provider_key = 'twilio_voice'
    and connection_row.status = 'CONNECTED'
    and connection_row.deleted_at is null
    and (
      connection_row.scope_mode = 'ALL_BRANCHES'
      or exists (
        select 1
        from public.integration_branch_mappings mapping_row
        where mapping_row.organization_id = organization_id
          and mapping_row.connected_account_id = connection_row.id
          and mapping_row.branch_id = target_branch_id
          and mapping_row.deleted_at is null
      )
    );
  return result;
end;
$$;

revoke all on function public.get_call_provider_options(uuid) from public, anon;
grant execute on function public.get_call_provider_options(uuid) to authenticated;

create or replace function public.create_provider_call_request(
  target_connection_id uuid,
  target_lead_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_row public.profiles%rowtype;
  lead_row public.leads%rowtype;
  customer_row public.customers%rowtype;
  connection_row public.connected_accounts%rowtype;
  call_row public.calls%rowtype;
  previous_metadata jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_connection_id is null or target_lead_id is null or target_request_id is null then
    raise exception using errcode = '22023', message = 'PROVIDER_CALL_FIELDS_REQUIRED';
  end if;

  select * into actor_row from public.profiles
  where id = auth.uid() and active and deleted_at is null;
  if not found or actor_row.organization_id is null
    or not app_private.has_permission(actor_row.organization_id, 'call.create')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if nullif(btrim(coalesce(actor_row.phone, '')), '') is null then
    raise exception using errcode = '22023', message = 'CALLER_PHONE_REQUIRED';
  end if;

  select * into lead_row from public.leads
  where id = target_lead_id
    and organization_id = actor_row.organization_id
    and deleted_at is null;
  if not found or not app_private.can_access_record(
    lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'CALL_LEAD_NOT_AUTHORIZED';
  end if;
  if lead_row.customer_id is null then
    raise exception using errcode = '22023', message = 'CALL_CUSTOMER_LINK_REQUIRED';
  end if;
  select * into customer_row from public.customers
  where id = lead_row.customer_id
    and organization_id = actor_row.organization_id
    and deleted_at is null;
  if not found or nullif(btrim(coalesce(customer_row.primary_phone, lead_row.phone, '')), '') is null
    or not app_private.can_access_customer(actor_row.organization_id, customer_row.id)
  then
    raise exception using errcode = '42501', message = 'CALL_CUSTOMER_NOT_AUTHORIZED';
  end if;

  select * into connection_row from public.connected_accounts
  where id = target_connection_id
    and organization_id = actor_row.organization_id
    and provider_key = 'twilio_voice'
    and status = 'CONNECTED'
    and deleted_at is null;
  if not found or not (
    connection_row.scope_mode = 'ALL_BRANCHES'
    or exists (
      select 1 from public.integration_branch_mappings mapping_row
      where mapping_row.organization_id = actor_row.organization_id
        and mapping_row.connected_account_id = connection_row.id
        and mapping_row.branch_id = lead_row.branch_id
        and mapping_row.deleted_at is null
    )
  ) then
    raise exception using errcode = '42501', message = 'CALL_PROVIDER_SCOPE_DENIED';
  end if;

  select audit_row.metadata into previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = actor_row.organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'call.provider_requested';
  if found then
    if previous_metadata->>'connection_id' is distinct from target_connection_id::text
      or previous_metadata->>'lead_id' is distinct from target_lead_id::text
    then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata->'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;

  insert into public.calls (
    organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
    connection_id, provider_call_id, direction, call_source, started_at, status
  ) values (
    actor_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.id,
    customer_row.id, auth.uid(), connection_row.id, null, 'OUTBOUND', 'PROVIDER', now(), 'PENDING'
  ) returning * into call_row;

  result := jsonb_build_object(
    'call_id', call_row.id,
    'organization_id', call_row.organization_id,
    'branch_id', call_row.branch_id,
    'connection_id', connection_row.id,
    'provider_key', connection_row.provider_key,
    'caller_phone', actor_row.phone,
    'customer_phone', coalesce(customer_row.primary_phone, lead_row.phone),
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    actor_row.organization_id, auth.uid(), 'call.provider_requested', 'call', call_row.id::text,
    call_row.branch_id, target_request_id,
    jsonb_build_object('connection_id', connection_row.id, 'lead_id', lead_row.id, 'result', result)
  );
  return result;
end;
$$;

revoke all on function public.create_provider_call_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.create_provider_call_request(uuid, uuid, uuid) to authenticated;

commit;
