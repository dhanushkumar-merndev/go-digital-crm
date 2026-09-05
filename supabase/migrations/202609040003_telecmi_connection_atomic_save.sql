begin;

-- The provider has already been verified by the TeleCMI Edge adapter when this
-- RPC runs. Keep the CRM-side connection, encrypted credential, exact branch
-- scope, credential version and audit record in one database transaction.
create or replace function public.save_telecmi_connection(
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
set search_path = ''
as $$
declare
  connection_row public.connected_accounts%rowtype;
  credential_row public.integration_credentials%rowtype;
  normalized_branch_ids uuid[] := coalesce(target_branch_ids, '{}'::uuid[]);
  next_credential_version integer;
  request_fingerprint jsonb;
  previous_metadata jsonb;
  result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_actor_id is null or target_request_id is null
    or char_length(btrim(coalesce(target_display_name, ''))) not between 2 and 120
    or char_length(btrim(coalesce(target_external_account_id, ''))) not between 1 and 80
    or target_connection_config is null
    or jsonb_typeof(target_connection_config) <> 'object'
    or target_connection_config ->> 'connection_type' <> 'IVR_PROVIDER'
    or target_encrypted_payload is null
    or target_cipher_version <> 'AES-256-GCM-v1'
  then
    raise exception using errcode = '22023', message = 'INVALID_TELECMI_CONNECTION';
  end if;

  -- Service-role writes still carry and re-check the original authenticated
  -- actor. TeleCMI is dealership business configuration, so System Admin and
  -- support sessions cannot substitute for an active Client Admin.
  if not app_private.actor_has_tenant_operation_context(
    target_actor_id, target_organization_id, 'integration.manage'
  ) or not exists (
    select 1
    from public.profiles actor_profile
    join public.user_role_assignments actor_assignment
      on actor_assignment.user_id = actor_profile.id
     and actor_assignment.organization_id = actor_profile.organization_id
     and actor_assignment.active
    join public.roles actor_role
      on actor_role.id = actor_assignment.role_id
     and actor_role.organization_id = actor_assignment.organization_id
     and actor_role.role_key = 'client_admin'
    where actor_profile.id = target_actor_id
      and actor_profile.organization_id = target_organization_id
      and actor_profile.active
      and actor_profile.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'CLIENT_ADMIN_REQUIRED';
  end if;

  if (target_scope_mode = 'ALL_BRANCHES' and cardinality(normalized_branch_ids) <> 0)
    or (target_scope_mode = 'ONE_BRANCH' and cardinality(normalized_branch_ids) <> 1)
    or (target_scope_mode = 'SELECTED_BRANCHES'
      and cardinality(normalized_branch_ids) not between 1 and 100)
    or cardinality(normalized_branch_ids) <> (
      select count(distinct branch_id) from unnest(normalized_branch_ids) branch_id
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_TELECMI_BRANCH_SCOPE';
  end if;

  if target_scope_mode = 'ALL_BRANCHES' then
    if not exists (
      select 1
      from public.user_role_assignments actor_assignment
      join public.roles actor_role
        on actor_role.id = actor_assignment.role_id
       and actor_role.organization_id = actor_assignment.organization_id
       and actor_role.role_key = 'client_admin'
      where actor_assignment.organization_id = target_organization_id
        and actor_assignment.user_id = target_actor_id
        and actor_assignment.active
        and actor_assignment.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
    ) then
      raise exception using errcode = '42501', message = 'ALL_BRANCHES_SCOPE_DENIED';
    end if;
  elsif exists (
    select 1
    from unnest(normalized_branch_ids) requested_branch(branch_id)
    where not exists (
      select 1
      from public.branches branch_row
      where branch_row.id = requested_branch.branch_id
        and branch_row.organization_id = target_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
    ) or not exists (
      select 1
      from public.user_role_assignments actor_assignment
      join public.roles actor_role
        on actor_role.id = actor_assignment.role_id
       and actor_role.organization_id = actor_assignment.organization_id
       and actor_role.role_key = 'client_admin'
      where actor_assignment.organization_id = target_organization_id
        and actor_assignment.user_id = target_actor_id
        and actor_assignment.active
        and (
          actor_assignment.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
          or (
            actor_assignment.data_scope = 'ONE_BRANCH'
            and actor_assignment.scope_branch_id = requested_branch.branch_id
          )
          or (
            actor_assignment.data_scope = 'SELECTED_BRANCHES'
            and requested_branch.branch_id = any(actor_assignment.selected_branch_ids)
          )
        )
    )
  ) then
    raise exception using errcode = '42501', message = 'BRANCH_SCOPE_DENIED';
  end if;

  request_fingerprint := jsonb_build_object(
    'connection_id', target_connection_id,
    'display_name', btrim(target_display_name),
    'scope_mode', target_scope_mode,
    'branch_ids', to_jsonb(normalized_branch_ids),
    'external_account_id', btrim(target_external_account_id),
    'connection_config', target_connection_config
  );
  perform pg_advisory_xact_lock(hashtextextended(
    target_organization_id::text || ':' || target_actor_id::text || ':' || target_request_id::text,
    0
  ));
  select audit_row.metadata into previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = target_actor_id
    and audit_row.request_id = target_request_id
    and audit_row.action = 'integration.telecmi_saved';
  if found then
    if previous_metadata -> 'fingerprint' is distinct from request_fingerprint then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata -> 'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;

  if target_connection_id is not null then
    select * into connection_row
    from public.connected_accounts
    where id = target_connection_id
      and organization_id = target_organization_id
      and provider_key = 'telecmi'
      and deleted_at is null
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'TELECMI_CONNECTION_NOT_FOUND';
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
      last_tested_at = now(),
      last_error_code = null,
      updated_at = now()
    where id = connection_row.id
      and organization_id = connection_row.organization_id;
  else
    next_credential_version := 1;
    insert into public.connected_accounts (
      organization_id, provider_key, display_name, scope_mode, status, auth_type,
      external_account_id, credential_version, connection_config, connected_at,
      last_tested_at, created_by
    ) values (
      target_organization_id, 'telecmi', btrim(target_display_name), target_scope_mode,
      'CONNECTED', 'API_KEY', btrim(target_external_account_id), next_credential_version,
      target_connection_config, now(), now(), target_actor_id
    ) returning * into connection_row;
  end if;

  select * into credential_row
  from public.integration_credentials
  where organization_id = target_organization_id
    and connected_account_id = connection_row.id
  for update;
  if found then
    update public.integration_credentials set
      encrypted_payload = target_encrypted_payload,
      key_version = next_credential_version,
      cipher_version = target_cipher_version,
      replaced_by = target_actor_id,
      updated_at = now()
    where id = credential_row.id;
  else
    insert into public.integration_credentials (
      organization_id, connected_account_id, encrypted_payload, key_version,
      cipher_version, replaced_by, updated_at
    ) values (
      target_organization_id, connection_row.id, target_encrypted_payload,
      next_credential_version, target_cipher_version, target_actor_id, now()
    );
  end if;

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

  result := jsonb_build_object(
    'connection_id', connection_row.id,
    'credential_version', next_credential_version,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id, target_actor_id, 'integration.telecmi_saved',
    'connected_account', connection_row.id::text, target_request_id,
    jsonb_build_object(
      'fingerprint', request_fingerprint,
      'result', result,
      'provider_key', 'telecmi',
      'scope_mode', target_scope_mode,
      'inbound_route', target_connection_config ->> 'inbound_route'
    )
  );
  return result;
end;
$$;

create unique index if not exists audit_telecmi_save_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action = 'integration.telecmi_saved';

revoke all on function public.save_telecmi_connection(
  uuid, uuid, text, public.branch_scope_mode, uuid[], text, jsonb,
  bytea, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.save_telecmi_connection(
  uuid, uuid, text, public.branch_scope_mode, uuid[], text, jsonb,
  bytea, text, uuid, uuid
) to service_role;

commit;
