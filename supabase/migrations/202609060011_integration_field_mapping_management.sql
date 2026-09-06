-- integration_field_mappings has existed since the first business-module
-- migration and has a read policy, but no write path was ever built: direct
-- writes are revoked and no RPC inserted one. So an ads account's own column
-- names could never actually be mapped onto CRM fields by anyone.
--
-- The canonical targets below are exactly the fields CanonicalLeadInput accepts
-- in src/lib/providers/contracts.ts. Constraining to that list here means an
-- unmappable target is refused at save time rather than silently dropping the
-- value during ingestion.
create or replace function app_private.canonical_lead_fields()
returns text[] language sql immutable set search_path = '' as $$
  select array[
    'source', 'customerName', 'phone', 'email', 'location', 'campaign',
    'interestedModel', 'preferredBranchId', 'sourceDetail', 'externalLeadId'
  ]
$$;

create or replace function public.get_integration_field_mappings(target_connection_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  connection_row public.connected_accounts%rowtype;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'INTEGRATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into connection_row from public.connected_accounts
  where id = target_connection_id and organization_id = current_organization_id
    and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'INTEGRATION_CONNECTION_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'connection_id', connection_row.id,
    'provider_key', connection_row.provider_key,
    'canonical_fields', to_jsonb(app_private.canonical_lead_fields()),
    'mappings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mapping_row.id,
        'external_field', mapping_row.external_field,
        'canonical_field', mapping_row.canonical_field,
        'transform_config', mapping_row.transform_config
      ) order by mapping_row.canonical_field, mapping_row.external_field)
      from public.integration_field_mappings mapping_row
      where mapping_row.connected_account_id = connection_row.id
        and mapping_row.organization_id = current_organization_id
    ), '[]'::jsonb)
  );
end;
$$;

-- Saved as a complete set rather than row by row: a half-applied mapping would
-- ingest leads with some columns landing in the wrong CRM field.
create or replace function public.save_integration_field_mappings(
  target_connection_id uuid,
  target_mappings jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  connection_row public.connected_accounts%rowtype;
  normalized jsonb := coalesce(target_mappings, '[]'::jsonb);
  saved integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'INTEGRATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null or jsonb_typeof(normalized) <> 'array'
    or jsonb_array_length(normalized) > 100
  then
    raise exception using errcode = '22023', message = 'INVALID_FIELD_MAPPING_INPUT';
  end if;

  select * into connection_row from public.connected_accounts
  where id = target_connection_id and organization_id = current_organization_id
    and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'INTEGRATION_CONNECTION_NOT_FOUND';
  end if;
  if connection_row.scope_mode <> 'ALL_BRANCHES' and not exists (
    select 1 from public.integration_branch_mappings branch_mapping
    join public.branches branch_row on branch_row.id = branch_mapping.branch_id
    where branch_mapping.connected_account_id = connection_row.id
      and app_private.can_access_branch(current_organization_id, branch_row.id)
  ) then
    raise exception using errcode = '42501', message = 'INTEGRATION_SCOPE_DENIED';
  end if;

  -- Validated before anything is written, so an invalid entry leaves the
  -- existing mapping untouched instead of half-replacing it.
  if exists (
    select 1 from jsonb_array_elements(normalized) as entry
    where jsonb_typeof(entry) <> 'object'
      or char_length(btrim(coalesce(entry ->> 'external_field', ''))) not between 1 and 200
      or not (entry ->> 'canonical_field' = any (app_private.canonical_lead_fields()))
      or jsonb_typeof(coalesce(entry -> 'transform_config', '{}'::jsonb)) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_FIELD_MAPPING_ENTRY';
  end if;
  -- The table is unique on (connected_account_id, external_field); a duplicate
  -- in the payload would otherwise fail mid-write.
  if (
    select count(distinct btrim(entry ->> 'external_field'))
    from jsonb_array_elements(normalized) as entry
  ) <> jsonb_array_length(normalized) then
    raise exception using errcode = '22023', message = 'DUPLICATE_EXTERNAL_FIELD';
  end if;

  delete from public.integration_field_mappings
  where connected_account_id = connection_row.id
    and organization_id = current_organization_id;
  insert into public.integration_field_mappings (
    organization_id, connected_account_id, external_field, canonical_field, transform_config
  )
  select current_organization_id, connection_row.id,
    btrim(entry ->> 'external_field'), entry ->> 'canonical_field',
    coalesce(entry -> 'transform_config', '{}'::jsonb)
  from jsonb_array_elements(normalized) as entry;
  get diagnostics saved = row_count;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'integration_field_mappings.saved',
    'connected_account', connection_row.id::text, target_request_id,
    jsonb_build_object('mapping_count', saved, 'provider_key', connection_row.provider_key)
  );
  return jsonb_build_object('connection_id', connection_row.id, 'mapping_count', saved);
end;
$$;

revoke all on function public.get_integration_field_mappings(uuid) from public, anon;
grant execute on function public.get_integration_field_mappings(uuid) to authenticated;
revoke all on function public.save_integration_field_mappings(uuid, jsonb, uuid) from public, anon;
grant execute on function public.save_integration_field_mappings(uuid, jsonb, uuid) to authenticated;
