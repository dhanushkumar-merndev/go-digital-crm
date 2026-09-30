begin;

-- TeleCMI agents created from the CRM. The CRM already maps a caller to a
-- TeleCMI agent by mobile number through connection_config.parallel_agents;
-- these functions let the backend create and link that agent itself -- when a
-- Client Admin creates a telecaller or sales consultant, or from the plan card
-- -- instead of the admin copying agent IDs out of the TeleCMI dashboard.
--
-- TeleCMI's API cannot report a plan's seat count, so the Client Admin records
-- it on the connection (connection_config.seat_limit) and the CRM refuses to
-- create an agent it knows has no seat.

-- Same actor rule as save_telecmi_connection: TeleCMI is dealership business
-- configuration, so only an active Client Admin may change it.
create or replace function app_private.telecmi_actor_is_client_admin(
  target_actor_id uuid,
  target_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.actor_has_tenant_operation_context(
      target_actor_id, target_organization_id, 'integration.manage'
    )
    and exists (
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
    );
$$;

revoke all on function app_private.telecmi_actor_is_client_admin(uuid, uuid)
  from public, anon, authenticated;

-- Every branch a user can work in, from any of the three places scope lives.
create or replace function app_private.user_working_branch_ids(
  target_organization_id uuid,
  target_user_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct branch_id) filter (where branch_id is not null), '{}'::uuid[])
  from (
    select access_row.branch_id
    from public.user_branch_access access_row
    where access_row.organization_id = target_organization_id
      and access_row.user_id = target_user_id
      and access_row.active
    union all
    select assignment_row.scope_branch_id
    from public.user_role_assignments assignment_row
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = target_user_id
      and assignment_row.active
    union all
    select unnest(assignment_row.selected_branch_ids)
    from public.user_role_assignments assignment_row
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = target_user_id
      and assignment_row.active
  ) branch_rows;
$$;

revoke all on function app_private.user_working_branch_ids(uuid, uuid)
  from public, anon, authenticated;

create or replace function app_private.telecmi_connection_covers_branches(
  target_organization_id uuid,
  target_connection_id uuid,
  target_branch_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.connected_accounts connection_row
    where connection_row.id = target_connection_id
      and connection_row.organization_id = target_organization_id
      and connection_row.provider_key = 'telecmi'
      and connection_row.deleted_at is null
      and (
        connection_row.scope_mode = 'ALL_BRANCHES'
        or exists (
          select 1
          from public.integration_branch_mappings mapping_row
          where mapping_row.organization_id = target_organization_id
            and mapping_row.connected_account_id = target_connection_id
            and mapping_row.external_resource_type = 'CONNECTION_SCOPE'
            and mapping_row.deleted_at is null
            and mapping_row.branch_id = any(coalesce(target_branch_ids, '{}'::uuid[]))
        )
      )
  );
$$;

revoke all on function app_private.telecmi_connection_covers_branches(uuid, uuid, uuid[])
  from public, anon, authenticated;

-- What an agent is created for: an active telecaller or sales consultant with a
-- mobile, and the TeleCMI line that covers one of their branches.
create or replace function public.get_telecmi_agent_target(
  target_organization_id uuid,
  target_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  role_keys text[];
  branch_ids uuid[];
  connection_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into profile_row
  from public.profiles
  where id = target_user_id and organization_id = target_organization_id and deleted_at is null;
  if not found then
    return null;
  end if;
  select coalesce(array_agg(distinct role_row.role_key), '{}'::text[]) into role_keys
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  where assignment_row.organization_id = target_organization_id
    and assignment_row.user_id = target_user_id
    and assignment_row.active;
  branch_ids := app_private.user_working_branch_ids(target_organization_id, target_user_id);
  select connection_row.id into connection_id
  from public.connected_accounts connection_row
  where connection_row.organization_id = target_organization_id
    and connection_row.provider_key = 'telecmi'
    and connection_row.status = 'CONNECTED'
    and connection_row.deleted_at is null
    and app_private.telecmi_connection_covers_branches(
      target_organization_id, connection_row.id, branch_ids
    )
  order by connection_row.created_at, connection_row.id
  limit 1;

  return jsonb_build_object(
    'user_id', profile_row.id,
    'full_name', profile_row.full_name,
    'phone', coalesce(nullif(btrim(profile_row.normalized_phone), ''), nullif(btrim(profile_row.phone), '')),
    'active', profile_row.active,
    'eligible', profile_row.active and role_keys && array['telecaller_bdc', 'sales_consultant'],
    'role_keys', to_jsonb(role_keys),
    'connection_id', connection_id
  );
end;
$$;

revoke all on function public.get_telecmi_agent_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_telecmi_agent_target(uuid, uuid) to service_role;

-- The CRM side of the plan card: the seat count the admin recorded, the agents
-- mapped on the line, and every telecaller or sales consultant the line covers.
create or replace function public.get_telecmi_agent_directory(
  target_organization_id uuid,
  target_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  connection_row public.connected_accounts%rowtype;
  candidates jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into connection_row
  from public.connected_accounts
  where id = target_connection_id
    and organization_id = target_organization_id
    and provider_key = 'telecmi'
    and deleted_at is null;
  if not found then
    raise exception using errcode = '22023', message = 'TELECMI_CONNECTION_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', profile_row.id,
      'full_name', profile_row.full_name,
      'phone', coalesce(nullif(btrim(profile_row.normalized_phone), ''), nullif(btrim(profile_row.phone), '')),
      'role_key', eligible_roles.role_key
    ) order by profile_row.full_name, profile_row.id), '[]'::jsonb)
  into candidates
  from public.profiles profile_row
  join lateral (
    select min(role_row.role_key) as role_key
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = profile_row.id
      and assignment_row.active
      and role_row.role_key in ('telecaller_bdc', 'sales_consultant')
  ) eligible_roles on eligible_roles.role_key is not null
  where profile_row.organization_id = target_organization_id
    and profile_row.active
    and profile_row.deleted_at is null
    and app_private.telecmi_connection_covers_branches(
      target_organization_id,
      target_connection_id,
      app_private.user_working_branch_ids(target_organization_id, profile_row.id)
    );

  return jsonb_build_object(
    'seat_limit', case
      when jsonb_typeof(connection_row.connection_config -> 'seat_limit') = 'number'
        then (connection_row.connection_config ->> 'seat_limit')::integer
      else null
    end,
    'mapped_agents', case
      when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
        then connection_row.connection_config -> 'parallel_agents'
      else '[]'::jsonb
    end,
    'candidates', candidates
  );
end;
$$;

revoke all on function public.get_telecmi_agent_directory(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_telecmi_agent_directory(uuid, uuid) to service_role;

-- Adds one agent to the line's caller mapping. Row-locked so two agents created
-- at once cannot overwrite each other's append, and conflict-checked so one
-- mobile can never resolve to two agents.
create or replace function public.link_telecmi_agent(
  target_organization_id uuid,
  target_connection_id uuid,
  target_agent_user_id text,
  target_agent_phone text,
  target_crm_user_id uuid,
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
  agents jsonb;
  agent_user_id text := btrim(coalesce(target_agent_user_id, ''));
  agent_phone text := regexp_replace(coalesce(target_agent_phone, ''), '\D', '', 'g');
  existing jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_connection_id is null or target_actor_id is null
    or target_request_id is null
    or agent_user_id !~ '^\d{1,12}_\d{1,12}$'
    or agent_phone !~ '^[1-9]\d{7,14}$' then
    raise exception using errcode = '22023', message = 'INVALID_TELECMI_AGENT_LINK';
  end if;
  if not app_private.telecmi_actor_is_client_admin(target_actor_id, target_organization_id) then
    raise exception using errcode = '42501', message = 'CLIENT_ADMIN_REQUIRED';
  end if;

  select * into connection_row
  from public.connected_accounts
  where id = target_connection_id
    and organization_id = target_organization_id
    and provider_key = 'telecmi'
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'TELECMI_CONNECTION_NOT_FOUND';
  end if;
  agents := case
    when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
      then connection_row.connection_config -> 'parallel_agents'
    else '[]'::jsonb
  end;

  select agent into existing
  from jsonb_array_elements(agents) agent
  where agent ->> 'user_id' = agent_user_id
     or regexp_replace(coalesce(agent ->> 'phone', ''), '\D', '', 'g') = agent_phone
  limit 1;
  if existing is not null then
    if existing ->> 'user_id' = agent_user_id
      and regexp_replace(coalesce(existing ->> 'phone', ''), '\D', '', 'g') = agent_phone then
      return jsonb_build_object('linked', true, 'already_linked', true, 'agent_user_id', agent_user_id);
    end if;
    raise exception using errcode = '22023', message = 'TELECMI_AGENT_MAPPING_CONFLICT';
  end if;

  update public.connected_accounts set
    connection_config = jsonb_set(
      connection_row.connection_config,
      '{parallel_agents}',
      agents || jsonb_build_array(jsonb_build_object(
        'user_id', agent_user_id,
        'phone', agent_phone,
        'crm_user_id', target_crm_user_id
      ))
    ),
    updated_at = greatest(clock_timestamp(), connection_row.updated_at + interval '1 microsecond')
  where id = connection_row.id and organization_id = connection_row.organization_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id, target_actor_id, 'integration.telecmi_agent_linked',
    'connected_account', target_connection_id::text, target_request_id,
    jsonb_build_object('agent_user_id', agent_user_id, 'crm_user_id', target_crm_user_id)
  ) on conflict do nothing;

  return jsonb_build_object('linked', true, 'already_linked', false, 'agent_user_id', agent_user_id);
end;
$$;

revoke all on function public.link_telecmi_agent(uuid, uuid, text, text, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.link_telecmi_agent(uuid, uuid, text, text, uuid, uuid, uuid)
  to service_role;

-- Records how many agent seats the dealership's TeleCMI plan includes. Null
-- clears it, which turns the seat guard off.
create or replace function public.set_telecmi_seat_limit(
  target_organization_id uuid,
  target_connection_id uuid,
  target_seat_limit integer,
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
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_connection_id is null or target_actor_id is null
    or target_request_id is null
    or (target_seat_limit is not null and target_seat_limit not between 1 and 1000) then
    raise exception using errcode = '22023', message = 'INVALID_TELECMI_SEAT_LIMIT';
  end if;
  if not app_private.telecmi_actor_is_client_admin(target_actor_id, target_organization_id) then
    raise exception using errcode = '42501', message = 'CLIENT_ADMIN_REQUIRED';
  end if;
  select * into connection_row
  from public.connected_accounts
  where id = target_connection_id
    and organization_id = target_organization_id
    and provider_key = 'telecmi'
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'TELECMI_CONNECTION_NOT_FOUND';
  end if;

  update public.connected_accounts set
    connection_config = case
      when target_seat_limit is null then connection_row.connection_config - 'seat_limit'
      else jsonb_set(connection_row.connection_config, '{seat_limit}', to_jsonb(target_seat_limit))
    end,
    updated_at = greatest(clock_timestamp(), connection_row.updated_at + interval '1 microsecond')
  where id = connection_row.id and organization_id = connection_row.organization_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id, target_actor_id, 'integration.telecmi_seat_limit_changed',
    'connected_account', target_connection_id::text, target_request_id,
    jsonb_build_object(
      'previous', connection_row.connection_config -> 'seat_limit',
      'seat_limit', target_seat_limit
    )
  ) on conflict do nothing;

  return jsonb_build_object('seat_limit', target_seat_limit);
end;
$$;

revoke all on function public.set_telecmi_seat_limit(uuid, uuid, integer, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.set_telecmi_seat_limit(uuid, uuid, integer, uuid, uuid)
  to service_role;

commit;
