begin;

alter table public.integration_branch_mappings
  add column external_resource_label text,
  add column mapping_metadata jsonb not null default '{}'::jsonb,
  add constraint integration_mapping_metadata_has_no_secrets check (
    not (mapping_metadata ?| array[
      'access_token', 'refresh_token', 'client_secret', 'app_secret',
      'api_key', 'password', 'webhook_verify_token'
    ])
  );

update public.integration_branch_mappings
set external_resource_type = 'LEGACY'
where external_resource_type is null;
alter table public.integration_branch_mappings
  alter column external_resource_type set not null,
  drop constraint integration_branch_mappings_pkey,
  add constraint integration_branch_mappings_pkey primary key (
    connected_account_id,
    branch_id,
    external_resource_type,
    external_resource_id
  );

create index integration_asset_mapping_lookup_idx
  on public.integration_branch_mappings (
    organization_id,
    connected_account_id,
    external_resource_type,
    external_resource_id
  )
  where deleted_at is null;

create or replace function public.authorize_integration_scope(
  target_organization_id uuid,
  target_permission text,
  target_scope_mode public.branch_scope_mode,
  target_branch_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_permission in ('integration.view', 'integration.manage')
    and app_private.has_permission(target_organization_id, target_permission)
    and case target_scope_mode
      when 'ALL_BRANCHES' then
        coalesce(cardinality(target_branch_ids), 0) = 0
        and app_private.has_organization_wide_scope(target_organization_id)
      when 'ONE_BRANCH' then
        cardinality(target_branch_ids) = 1
        and app_private.can_access_branch(target_organization_id, target_branch_ids[1])
      when 'SELECTED_BRANCHES' then
        cardinality(target_branch_ids) between 1 and 100
        and cardinality(target_branch_ids) = (
          select count(distinct branch_id) from unnest(target_branch_ids) branch_id
        )
        and not exists (
          select 1
          from unnest(target_branch_ids) branch_id
          where not app_private.can_access_branch(target_organization_id, branch_id)
        )
      else false
    end;
$$;

create or replace function public.authorize_integration_connection_action(
  target_organization_id uuid,
  target_connection_id uuid,
  target_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_permission in ('integration.view', 'integration.manage')
    and app_private.has_permission(target_organization_id, target_permission)
    and exists (
      select 1
      from public.connected_accounts connection_row
      where connection_row.id = target_connection_id
        and connection_row.organization_id = target_organization_id
        and connection_row.deleted_at is null
        and case connection_row.scope_mode
          when 'ALL_BRANCHES' then
            app_private.has_organization_wide_scope(target_organization_id)
            and not exists (
              select 1
              from public.integration_branch_mappings unexpected_scope
              where unexpected_scope.organization_id = target_organization_id
                and unexpected_scope.connected_account_id = target_connection_id
                and unexpected_scope.external_resource_type = 'CONNECTION_SCOPE'
                and unexpected_scope.deleted_at is null
            )
          when 'ONE_BRANCH' then
            1 = (
              select count(*)
              from public.integration_branch_mappings scope_mapping
              where scope_mapping.organization_id = target_organization_id
                and scope_mapping.connected_account_id = target_connection_id
                and scope_mapping.external_resource_type = 'CONNECTION_SCOPE'
                and scope_mapping.deleted_at is null
            )
            and not exists (
              select 1
              from public.integration_branch_mappings scope_mapping
              where scope_mapping.organization_id = target_organization_id
                and scope_mapping.connected_account_id = target_connection_id
                and scope_mapping.external_resource_type = 'CONNECTION_SCOPE'
                and scope_mapping.deleted_at is null
                and not app_private.can_access_branch(target_organization_id, scope_mapping.branch_id)
            )
          when 'SELECTED_BRANCHES' then
            (
              select count(*) between 1 and 100
              from public.integration_branch_mappings scope_mapping
              where scope_mapping.organization_id = target_organization_id
                and scope_mapping.connected_account_id = target_connection_id
                and scope_mapping.external_resource_type = 'CONNECTION_SCOPE'
                and scope_mapping.deleted_at is null
            )
            and (
              select count(*) = count(distinct scope_mapping.branch_id)
              from public.integration_branch_mappings scope_mapping
              where scope_mapping.organization_id = target_organization_id
                and scope_mapping.connected_account_id = target_connection_id
                and scope_mapping.external_resource_type = 'CONNECTION_SCOPE'
                and scope_mapping.deleted_at is null
            )
            and not exists (
              select 1
              from public.integration_branch_mappings scope_mapping
              where scope_mapping.organization_id = target_organization_id
                and scope_mapping.connected_account_id = target_connection_id
                and scope_mapping.external_resource_type = 'CONNECTION_SCOPE'
                and scope_mapping.deleted_at is null
                and not app_private.can_access_branch(target_organization_id, scope_mapping.branch_id)
            )
          else false
        end
    );
$$;

create or replace function app_private.can_access_connection(
  target_organization_id uuid,
  target_connection_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.authorize_integration_connection_action(
    target_organization_id,
    target_connection_id,
    'integration.view'
  );
$$;

create or replace function public.replace_integration_asset_mappings(
  target_organization_id uuid,
  target_connection_id uuid,
  target_actor_id uuid,
  target_mappings jsonb,
  target_connection_config jsonb,
  target_request_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare connection_row public.connected_accounts%rowtype;
declare mapping_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not app_private.actor_has_tenant_operation_context(
    target_actor_id,
    target_organization_id,
    'integration.manage'
  ) then
    raise exception using errcode = '42501', message = 'INVALID_INTEGRATION_ACTOR';
  end if;
  if jsonb_typeof(target_mappings) <> 'array'
    or jsonb_array_length(target_mappings) > 200
    or jsonb_typeof(target_connection_config) <> 'object'
  then
    raise exception using errcode = '22023', message = 'INVALID_ASSET_MAPPINGS';
  end if;
  if target_connection_config ?| array[
    'access_token', 'refresh_token', 'client_secret', 'app_secret',
    'api_key', 'password', 'webhook_verify_token'
  ] then
    raise exception using errcode = '22023', message = 'CONNECTION_CONFIG_CONTAINS_SECRET';
  end if;

  select * into connection_row
  from public.connected_accounts
  where id = target_connection_id
    and organization_id = target_organization_id
    and status = 'CONNECTED'
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CONNECTED_ACCOUNT_NOT_FOUND';
  end if;

  with supplied as (
    select *
    from jsonb_to_recordset(target_mappings) as mapping_row(
      branch_id uuid,
      team_id uuid,
      external_resource_type text,
      external_resource_id text,
      external_resource_label text,
      mapping_metadata jsonb
    )
  )
  select count(*) into mapping_count from supplied;
  if exists (
    with supplied as (
      select *
      from jsonb_to_recordset(target_mappings) as mapping_row(
        branch_id uuid,
        team_id uuid,
        external_resource_type text,
        external_resource_id text,
        external_resource_label text,
        mapping_metadata jsonb
      )
    )
    select 1
    from supplied mapping_row
    left join public.branches branch_row
      on branch_row.id = mapping_row.branch_id
     and branch_row.organization_id = target_organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    left join public.teams team_row
      on team_row.id = mapping_row.team_id
     and team_row.organization_id = target_organization_id
     and team_row.branch_id = mapping_row.branch_id
     and team_row.active
    where branch_row.id is null
      or nullif(btrim(mapping_row.external_resource_id), '') is null
      or char_length(mapping_row.external_resource_id) > 255
      or nullif(btrim(mapping_row.external_resource_label), '') is null
      or char_length(mapping_row.external_resource_label) > 255
      or coalesce(jsonb_typeof(mapping_row.mapping_metadata), 'object') <> 'object'
      or mapping_row.mapping_metadata ?| array[
        'access_token', 'refresh_token', 'client_secret', 'app_secret',
        'api_key', 'password', 'webhook_verify_token'
      ]
      or (mapping_row.team_id is not null and team_row.id is null)
      or (
        connection_row.scope_mode <> 'ALL_BRANCHES'
        and not exists (
          select 1
          from public.integration_branch_mappings scope_mapping
          where scope_mapping.organization_id = target_organization_id
            and scope_mapping.connected_account_id = target_connection_id
            and scope_mapping.branch_id = mapping_row.branch_id
            and scope_mapping.external_resource_type = 'CONNECTION_SCOPE'
            and scope_mapping.deleted_at is null
        )
      )
      or not (
        (connection_row.provider_key = 'meta' and mapping_row.external_resource_type in ('META_PAGE', 'INSTAGRAM_ACCOUNT'))
        or (connection_row.provider_key = 'google_ads' and mapping_row.external_resource_type in ('GOOGLE_ADS_CUSTOMER', 'GOOGLE_ADS_CAMPAIGN', 'GOOGLE_ADS_LEAD_FORM'))
        or (connection_row.provider_key = 'google_business_profile' and mapping_row.external_resource_type = 'GBP_LOCATION')
      )
  ) then
    raise exception using errcode = '23514', message = 'INVALID_ASSET_MAPPING_TARGET';
  end if;
  if (
    select count(*)
    from (
      select distinct
        mapping_row.branch_id,
        mapping_row.external_resource_type,
        mapping_row.external_resource_id
      from jsonb_to_recordset(target_mappings) as mapping_row(
        branch_id uuid,
        external_resource_type text,
        external_resource_id text
      )
    ) distinct_mapping
  ) <> mapping_count then
    raise exception using errcode = '23505', message = 'DUPLICATE_ASSET_MAPPING';
  end if;

  update public.integration_branch_mappings
  set deleted_at = now()
  where organization_id = target_organization_id
    and connected_account_id = target_connection_id
    and external_resource_type <> 'CONNECTION_SCOPE'
    and deleted_at is null;

  insert into public.integration_branch_mappings (
    organization_id,
    connected_account_id,
    branch_id,
    team_id,
    external_resource_type,
    external_resource_id,
    external_resource_label,
    mapping_metadata,
    deleted_at
  )
  select
    target_organization_id,
    target_connection_id,
    mapping_row.branch_id,
    mapping_row.team_id,
    mapping_row.external_resource_type,
    btrim(mapping_row.external_resource_id),
    btrim(mapping_row.external_resource_label),
    coalesce(mapping_row.mapping_metadata, '{}'::jsonb),
    null
  from jsonb_to_recordset(target_mappings) as mapping_row(
    branch_id uuid,
    team_id uuid,
    external_resource_type text,
    external_resource_id text,
    external_resource_label text,
    mapping_metadata jsonb
  )
  on conflict (connected_account_id, branch_id, external_resource_type, external_resource_id)
  do update set
    team_id = excluded.team_id,
    external_resource_type = excluded.external_resource_type,
    external_resource_label = excluded.external_resource_label,
    mapping_metadata = excluded.mapping_metadata,
    deleted_at = null;

  update public.connected_accounts
  set connection_config = target_connection_config,
      updated_at = now(),
      last_error_code = null
  where id = target_connection_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id, target_actor_id, 'integration.assets_mapped',
    'connected_account', target_connection_id::text, target_request_id,
    jsonb_build_object('mapping_count', mapping_count, 'provider_key', connection_row.provider_key)
  );
  return mapping_count;
end;
$$;

revoke all on function public.replace_integration_asset_mappings(uuid, uuid, uuid, jsonb, jsonb, uuid)
from public, anon, authenticated;
grant execute on function public.replace_integration_asset_mappings(uuid, uuid, uuid, jsonb, jsonb, uuid)
to service_role;
revoke all on function public.authorize_integration_scope(uuid, text, public.branch_scope_mode, uuid[])
from public, anon;
grant execute on function public.authorize_integration_scope(uuid, text, public.branch_scope_mode, uuid[])
to authenticated;
revoke all on function public.authorize_integration_connection_action(uuid, uuid, text)
from public, anon;
grant execute on function public.authorize_integration_connection_action(uuid, uuid, text)
to authenticated;

commit;
