begin;

create or replace function public.complete_integration_oauth_connection(
  target_organization_id uuid,
  target_connection_id uuid,
  target_encrypted_payload bytea,
  target_cipher_version text,
  target_expires_at timestamptz,
  target_replaced_by uuid,
  target_external_account_id text,
  target_connection_config jsonb,
  target_token_expires_at timestamptz,
  target_connected_at timestamptz,
  target_last_tested_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_row public.connected_accounts%rowtype;
  credential_row public.integration_credentials%rowtype;
  next_credential_version integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_encrypted_payload is null
    or target_cipher_version <> 'AES-256-GCM-v1'
    or char_length(btrim(coalesce(target_external_account_id, ''))) < 1
    or target_connection_config is null
    or jsonb_typeof(target_connection_config) <> 'object'
    or not app_private.actor_has_tenant_operation_context(
      target_replaced_by, target_organization_id, 'integration.manage'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_OAUTH_CONNECTION_COMPLETION';
  end if;

  select * into connection_row
  from public.connected_accounts
  where id = target_connection_id
    and organization_id = target_organization_id
    and deleted_at is null
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'OAUTH_CONNECTION_NOT_FOUND';
  end if;

  select * into credential_row
  from public.integration_credentials
  where organization_id = target_organization_id
    and connected_account_id = target_connection_id
  for update;

  next_credential_version := case
    when found then connection_row.credential_version + 1
    else connection_row.credential_version
  end;

  update public.connected_accounts
  set status = 'CONNECTED',
      auth_type = 'OAUTH2',
      external_account_id = btrim(target_external_account_id),
      connection_config = target_connection_config,
      token_expires_at = target_token_expires_at,
      connected_at = target_connected_at,
      last_tested_at = target_last_tested_at,
      last_error_code = null,
      credential_version = next_credential_version,
      updated_at = now()
  where id = target_connection_id
    and organization_id = target_organization_id;

  if credential_row.id is not null then
    update public.integration_credentials
    set encrypted_payload = target_encrypted_payload,
        key_version = next_credential_version,
        cipher_version = target_cipher_version,
        expires_at = target_expires_at,
        replaced_by = target_replaced_by,
        updated_at = now()
    where id = credential_row.id;
  else
    insert into public.integration_credentials (
      organization_id,
      connected_account_id,
      encrypted_payload,
      key_version,
      cipher_version,
      expires_at,
      replaced_by,
      updated_at
    ) values (
      target_organization_id,
      target_connection_id,
      target_encrypted_payload,
      next_credential_version,
      target_cipher_version,
      target_expires_at,
      target_replaced_by,
      now()
    );
  end if;
end;
$$;

revoke all on function public.complete_integration_oauth_connection(
  uuid, uuid, bytea, text, timestamptz, uuid, text, jsonb,
  timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_integration_oauth_connection(
  uuid, uuid, bytea, text, timestamptz, uuid, text, jsonb,
  timestamptz, timestamptz, timestamptz
) to service_role;

commit;
