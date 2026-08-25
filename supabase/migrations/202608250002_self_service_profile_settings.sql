begin;

-- A profile photo is always a private object-file reference. Signed URLs are
-- generated only at read time and are never persisted on the profile.
alter table public.profiles
  add column if not exists avatar_object_file_id uuid;

alter table public.profiles
  add constraint profiles_avatar_object_file_org_fk
  foreign key (organization_id, avatar_object_file_id)
  references public.object_files (organization_id, id)
  not valid;

create index if not exists profiles_avatar_object_file_idx
  on public.profiles (organization_id, avatar_object_file_id)
  where avatar_object_file_id is not null;

-- Direct profile updates previously allowed a signed-in user to modify more
-- than this feature needs. Identity/security fields and self-service profile
-- settings now have separate, narrow mutation boundaries.
drop policy if exists profiles_update on public.profiles;
revoke update on public.profiles from anon, authenticated;

create unique index if not exists profile_self_update_request_unique_idx
  on public.audit_logs (actor_id, request_id)
  where request_id is not null
    and action = 'profile.self_updated';

-- Profile avatar storage deliberately bypasses generic document permissions:
-- every active CRM user can manage only their own image, never another user's
-- file. Keeping this as a dedicated helper prevents broad document grants.
create or replace function public.authorize_profile_avatar_action(
  target_organization_id uuid,
  target_profile_id uuid,
  target_action text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
begin
  if auth.uid() is null
    or target_organization_id is null
    or target_profile_id is null
    or target_profile_id <> auth.uid()
    or target_action is null
    or target_action not in ('UPLOAD', 'DOWNLOAD')
  then
    return false;
  end if;

  access_context := public.get_access_context();
  if access_context ->> 'destination' <> 'CRM'
    or access_context ->> 'organization_id' is distinct from target_organization_id::text
  then
    return false;
  end if;

  return exists (
    select 1
    from public.profiles profile_row
    where profile_row.id = auth.uid()
      and profile_row.organization_id = target_organization_id
      and profile_row.active
      and profile_row.deleted_at is null
      and app_private.mfa_policy_satisfied(target_organization_id)
  );
end;
$$;

create or replace function public.update_my_profile(
  target_full_name text,
  expected_version bigint,
  target_request_id uuid,
  target_avatar_action text default 'KEEP',
  target_avatar_object_file_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_profile public.profiles%rowtype;
  normalized_full_name text;
  normalized_avatar_action text;
  next_avatar_object_file_id uuid;
  next_version bigint;
  existing_result jsonb;
  audit_result jsonb;
  name_changed boolean;
  avatar_changed boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if expected_version is null or expected_version < 1 or target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PROFILE_UPDATE';
  end if;

  normalized_full_name := regexp_replace(btrim(coalesce(target_full_name, '')), '\s+', ' ', 'g');
  if char_length(normalized_full_name) not between 2 and 160
    or normalized_full_name ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_PROFILE_NAME';
  end if;

  normalized_avatar_action := upper(btrim(coalesce(target_avatar_action, 'KEEP')));
  if normalized_avatar_action not in ('KEEP', 'REPLACE', 'REMOVE')
    or (normalized_avatar_action = 'KEEP' and target_avatar_object_file_id is not null)
    or (normalized_avatar_action = 'REMOVE' and target_avatar_object_file_id is not null)
    or (normalized_avatar_action = 'REPLACE' and target_avatar_object_file_id is null)
  then
    raise exception using errcode = '22023', message = 'INVALID_PROFILE_AVATAR_ACTION';
  end if;

  access_context := public.get_access_context();
  if access_context ->> 'destination' <> 'CRM' then
    raise exception using errcode = '42501', message = 'CRM_ACCESS_REQUIRED';
  end if;

  select profile_row.*
  into current_profile
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'PROFILE_ACCESS_REQUIRED';
  end if;
  if not app_private.mfa_policy_satisfied(current_profile.organization_id) then
    raise exception using errcode = '42501', message = 'MFA_REQUIRED';
  end if;

  -- The profile-row lock makes retrying the same request ID deterministic.
  select audit_row.metadata -> 'result'
  into existing_result
  from public.audit_logs audit_row
  where audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'profile.self_updated'
  order by audit_row.id desc
  limit 1;
  if existing_result is not null then
    return existing_result || jsonb_build_object('full_name', current_profile.full_name);
  end if;

  if current_profile.version <> expected_version then
    raise exception using errcode = '40001', message = 'STALE_PROFILE_VERSION';
  end if;

  next_avatar_object_file_id := case normalized_avatar_action
    when 'KEEP' then current_profile.avatar_object_file_id
    when 'REMOVE' then null
    else target_avatar_object_file_id
  end;

  if normalized_avatar_action = 'REPLACE' then
    if current_profile.organization_id is null then
      raise exception using errcode = '23514', message = 'PROFILE_AVATAR_ORGANIZATION_REQUIRED';
    end if;
    if not exists (
      select 1
      from public.object_files object_file_row
      where object_file_row.id = target_avatar_object_file_id
        and object_file_row.organization_id = current_profile.organization_id
        and object_file_row.branch_id is null
        and object_file_row.resource_type = 'profile'
        and object_file_row.resource_id = auth.uid()
        and object_file_row.uploaded_by = auth.uid()
        and object_file_row.deleted_at is null
        and object_file_row.mime_type in ('image/jpeg', 'image/png', 'image/webp')
        and object_file_row.size_bytes between 1 and 5242880
    ) then
      raise exception using errcode = '42501', message = 'PROFILE_AVATAR_NOT_OWNED';
    end if;
  end if;

  name_changed := normalized_full_name is distinct from current_profile.full_name;
  avatar_changed := next_avatar_object_file_id is distinct from current_profile.avatar_object_file_id;
  if name_changed or avatar_changed then
    update public.profiles profile_row
    set full_name = normalized_full_name,
        avatar_object_file_id = next_avatar_object_file_id,
        updated_at = now()
    where profile_row.id = current_profile.id
    returning profile_row.version into next_version;

    -- Replacement/removal only unlinks the old private object. It remains a
    -- soft-deleted record for controlled retention and is never hard-deleted.
    if avatar_changed and current_profile.avatar_object_file_id is not null then
      update public.object_files object_file_row
      set deleted_at = coalesce(object_file_row.deleted_at, now())
      where object_file_row.id = current_profile.avatar_object_file_id
        and object_file_row.organization_id is not distinct from current_profile.organization_id
        and object_file_row.resource_type = 'profile'
        and object_file_row.resource_id = auth.uid()
        and object_file_row.uploaded_by = auth.uid();
    end if;
  else
    next_version := current_profile.version;
  end if;

  audit_result := jsonb_build_object(
    'avatar_object_file_id', next_avatar_object_file_id,
    'version', next_version
  );
  insert into public.audit_logs (
    organization_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    request_id,
    metadata
  ) values (
    current_profile.organization_id,
    auth.uid(),
    'profile.self_updated',
    'profile',
    auth.uid()::text,
    target_request_id,
    jsonb_build_object(
      'self_update', true,
      'full_name_changed', name_changed,
      'avatar_changed', avatar_changed,
      'avatar_action', normalized_avatar_action,
      'result', audit_result
    )
  );

  return audit_result || jsonb_build_object('full_name', normalized_full_name);
end;
$$;

-- The bootstrap payload contains only an opaque object-file ID. It never
-- carries a Tigris key, bucket, signed URL, or any credential.
create or replace function public.get_workspace_bootstrap()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  profile_row public.profiles%rowtype;
  organization_name_value text;
  permission_keys text[] := array[]::text[];
  allowed_branch_ids uuid[] := array[]::uuid[];
  active_team_ids uuid[] := array[]::uuid[];
  assignment_fingerprint text := '';
  scope_key_value text;
begin
  access_context := public.get_access_context();

  if auth.uid() is null or access_context->>'destination' <> 'CRM' then
    return access_context || jsonb_build_object('permissions', '[]'::jsonb);
  end if;

  select profile_source.*
  into profile_row
  from public.profiles profile_source
  where profile_source.id = auth.uid();

  select coalesce(array_agg(permission_source.permission_key order by permission_source.permission_key), array[]::text[])
  into permission_keys
  from (
    select distinct permission_row.permission_key
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id is not distinct from assignment_row.organization_id
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = role_row.id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
    where assignment_row.user_id = auth.uid()
      and assignment_row.active
      and assignment_row.organization_id is not distinct from profile_row.organization_id
  ) permission_source;

  select coalesce(string_agg(
    concat_ws(
      ':',
      assignment_row.id::text,
      assignment_row.data_scope::text,
      coalesce(assignment_row.scope_branch_id::text, ''),
      assignment_row.selected_branch_ids::text,
      assignment_row.active::text
    ),
    ';' order by assignment_row.id
  ), '')
  into assignment_fingerprint
  from public.user_role_assignments assignment_row
  where assignment_row.user_id = auth.uid()
    and assignment_row.active
    and assignment_row.organization_id is not distinct from profile_row.organization_id;

  if profile_row.organization_id is not null then
    select organization_row.name
    into organization_name_value
    from public.organizations organization_row
    where organization_row.id = profile_row.organization_id;

    select coalesce(array_agg(branch_row.id order by branch_row.id), array[]::uuid[])
    into allowed_branch_ids
    from public.branches branch_row
    where branch_row.organization_id = profile_row.organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and app_private.can_access_branch(profile_row.organization_id, branch_row.id);

    select coalesce(array_agg(member_row.team_id order by member_row.team_id), array[]::uuid[])
    into active_team_ids
    from public.team_members member_row
    join public.teams team_row
      on team_row.organization_id = member_row.organization_id
     and team_row.id = member_row.team_id
     and team_row.active
    where member_row.organization_id = profile_row.organization_id
      and member_row.user_id = auth.uid()
      and member_row.active;
  end if;

  scope_key_value := concat_ws(
    ':',
    coalesce(profile_row.organization_id::text, 'platform'),
    auth.uid()::text,
    coalesce(access_context->>'role_key', 'unknown'),
    coalesce(access_context->>'data_scope', 'none'),
    pg_catalog.md5(concat_ws(
      '|',
      assignment_fingerprint,
      permission_keys::text,
      allowed_branch_ids::text,
      active_team_ids::text
    ))
  );

  return access_context || jsonb_build_object(
    'scope_key', scope_key_value,
    'permissions', to_jsonb(permission_keys),
    'display_name', profile_row.full_name,
    'email', profile_row.email,
    'avatar_object_file_id', profile_row.avatar_object_file_id,
    'profile_version', profile_row.version,
    'organization_name', organization_name_value,
    'workspace_name', coalesce(organization_name_value, 'Go Digital Marketing CRM')
  );
end;
$$;

revoke all on function public.authorize_profile_avatar_action(uuid, uuid, text)
from public, anon;
grant execute on function public.authorize_profile_avatar_action(uuid, uuid, text)
to authenticated;

revoke all on function public.update_my_profile(text, bigint, uuid, text, uuid)
from public, anon;
grant execute on function public.update_my_profile(text, bigint, uuid, text, uuid)
to authenticated;

revoke all on function public.get_workspace_bootstrap() from public, anon;
grant execute on function public.get_workspace_bootstrap() to authenticated;

commit;
