-- Organization-wide custom-field definitions are configuration, so only
-- organization-scoped administrators may manage them.

alter table public.custom_field_definitions
  add column if not exists version bigint not null default 1,
  add constraint custom_field_definitions_version_positive check (version > 0);
create index if not exists custom_field_definitions_admin_idx
  on public.custom_field_definitions (organization_id, active, module, label, id);

-- Custom field definitions are organization configuration. Reuse the existing
-- audited role-management permission instead of seeding tenant role grants from
-- a database migration, which would bypass the delegated-authority ceiling.

create or replace function public.get_custom_field_administration_page(
  target_search text default '',
  target_status text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
begin
  if char_length(normalized_search) > 100
    or normalized_status not in ('ALL', 'ACTIVE', 'INACTIVE')
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
  then raise exception using errcode = '22023', message = 'INVALID_CUSTOM_FIELD_QUERY'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'role.manage')
  then raise exception using errcode = '42501', message = 'CUSTOM_FIELD_MANAGE_PERMISSION_REQUIRED'; end if;
  return (
    with authorized as materialized (
      select definition_row.*
      from public.custom_field_definitions definition_row
      where definition_row.organization_id = current_organization_id
        and (normalized_status = 'ALL'
          or (normalized_status = 'ACTIVE' and definition_row.active)
          or (normalized_status = 'INACTIVE' and not definition_row.active))
        and (normalized_search = ''
          or position(normalized_search in lower(definition_row.label)) > 0
          or position(normalized_search in lower(definition_row.field_key)) > 0
          or position(normalized_search in lower(definition_row.module)) > 0)
    ), page_rows as (
      select * from authorized
      order by module, label, id
      limit target_page_size offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'records', coalesce((select jsonb_agg(jsonb_build_object(
        'id', row.id, 'module', row.module, 'field_key', row.field_key,
        'label', row.label, 'field_type', row.field_type, 'options', row.options,
        'required', row.required, 'active', row.active, 'version', row.version
      ) order by row.module, row.label, row.id) from page_rows row), '[]'::jsonb),
      'total', (select count(*) from authorized),
      'active_count', (select count(*) from public.custom_field_definitions where organization_id = current_organization_id and active),
      'inactive_count', (select count(*) from public.custom_field_definitions where organization_id = current_organization_id and not active)
    )
  );
end;
$$;

create or replace function public.create_custom_field_definition(
  target_module text,
  target_field_key text,
  target_label text,
  target_field_type text,
  target_options jsonb,
  target_required boolean,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_module text := upper(btrim(coalesce(target_module, '')));
  normalized_key text := lower(btrim(coalesce(target_field_key, '')));
  normalized_label text := btrim(coalesce(target_label, ''));
  normalized_type text := upper(btrim(coalesce(target_field_type, '')));
  normalized_options jsonb := coalesce(target_options, '[]'::jsonb);
  fingerprint jsonb;
  replay_fingerprint jsonb;
  replay_result jsonb;
  definition_id uuid := gen_random_uuid();
  result jsonb;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if target_request_id is null
    or normalized_module not in ('CUSTOMERS', 'LEADS', 'BOOKINGS', 'FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY')
    or normalized_key !~ '^[a-z][a-z0-9_]{1,62}$'
    or char_length(normalized_label) not between 2 and 120
    or normalized_type not in ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT')
    or jsonb_typeof(normalized_options) <> 'array'
    or jsonb_array_length(normalized_options) > 100
    or (normalized_type in ('SELECT', 'MULTI_SELECT') and jsonb_array_length(normalized_options) = 0)
    or (normalized_type not in ('SELECT', 'MULTI_SELECT') and jsonb_array_length(normalized_options) <> 0)
  then raise exception using errcode = '22023', message = 'INVALID_CUSTOM_FIELD_INPUT'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'role.manage')
  then raise exception using errcode = '42501', message = 'CUSTOM_FIELD_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := jsonb_build_object(
    'module', normalized_module, 'field_key', normalized_key, 'label', normalized_label,
    'field_type', normalized_type, 'options', normalized_options, 'required', coalesce(target_required, false)
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  select audit_row.metadata -> 'fingerprint', audit_row.metadata -> 'result'
    into replay_fingerprint, replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'custom_field.created'
    and audit_row.request_id = target_request_id
  order by audit_row.id desc limit 1;
  if replay_result is not null then
    if replay_fingerprint is distinct from fingerprint then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
    end if;
    return replay_result || jsonb_build_object('replayed', true);
  end if;
  insert into public.custom_field_definitions (
    id, organization_id, module, field_key, label, field_type, options, required, active, version
  ) values (
    definition_id, current_organization_id, normalized_module, normalized_key, normalized_label,
    normalized_type, normalized_options, coalesce(target_required, false), true, 1
  );
  result := jsonb_build_object('id', definition_id, 'version', 1, 'active', true, 'replayed', false);
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'custom_field.created', 'custom_field_definition',
    definition_id::text, target_request_id, jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.set_custom_field_active(
  target_definition_id uuid,
  target_active boolean,
  expected_version bigint,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  definition_row public.custom_field_definitions%rowtype;
  fingerprint jsonb;
  replay_fingerprint jsonb;
  replay_result jsonb;
  result jsonb;
begin
  if target_definition_id is null or target_active is null or expected_version is null or expected_version < 1 or target_request_id is null
  then raise exception using errcode = '22023', message = 'INVALID_CUSTOM_FIELD_STATUS_INPUT'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'role.manage')
  then raise exception using errcode = '42501', message = 'CUSTOM_FIELD_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := jsonb_build_object('definition_id', target_definition_id, 'active', target_active, 'expected_version', expected_version);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  select audit_row.metadata -> 'fingerprint', audit_row.metadata -> 'result'
    into replay_fingerprint, replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id and audit_row.actor_id = auth.uid()
    and audit_row.action = 'custom_field.status_changed' and audit_row.request_id = target_request_id
  order by audit_row.id desc limit 1;
  if replay_result is not null then
    if replay_fingerprint is distinct from fingerprint then raise exception using errcode = '22023', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT'; end if;
    return replay_result || jsonb_build_object('replayed', true);
  end if;
  select * into definition_row from public.custom_field_definitions
  where id = target_definition_id and organization_id = current_organization_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'CUSTOM_FIELD_NOT_FOUND'; end if;
  if definition_row.version <> expected_version then raise exception using errcode = '40001', message = 'CUSTOM_FIELD_VERSION_CONFLICT'; end if;
  update public.custom_field_definitions set active = target_active, version = version + 1
  where id = definition_row.id
  returning * into definition_row;
  result := jsonb_build_object('id', definition_row.id, 'version', definition_row.version, 'active', definition_row.active, 'replayed', false);
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, request_id, metadata)
  values (current_organization_id, auth.uid(), 'custom_field.status_changed', 'custom_field_definition', definition_row.id::text, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result));
  return result;
end;
$$;

revoke all on function public.get_custom_field_administration_page(text, text, integer, integer) from public, anon;
grant execute on function public.get_custom_field_administration_page(text, text, integer, integer) to authenticated;
revoke all on function public.create_custom_field_definition(text, text, text, text, jsonb, boolean, uuid) from public, anon;
grant execute on function public.create_custom_field_definition(text, text, text, text, jsonb, boolean, uuid) to authenticated;
revoke all on function public.set_custom_field_active(uuid, boolean, bigint, uuid) from public, anon;
grant execute on function public.set_custom_field_active(uuid, boolean, bigint, uuid) to authenticated;
