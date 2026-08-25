begin;

-- Customer 360 edits are intentionally a narrow, auditable RPC. Customer IDs
-- stay immutable and matching identifiers never trigger a silent merge.
insert into public.permissions (permission_key, module, description)
values ('customer.update', 'customers', 'Update an authorized customer profile and identifiers')
on conflict (permission_key) do update
  set module = excluded.module, description = excluded.description;

create or replace function app_private.grant_customer_update_default_permission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  permission_id uuid;
begin
  if new.role_key not in (
    'client_admin', 'system_administrator', 'showroom_manager', 'team_manager',
    'sales_consultant', 'telecaller_bdc'
  ) then
    return new;
  end if;
  select id into permission_id
  from public.permissions
  where permission_key = 'customer.update';
  if permission_id is not null then
    insert into public.role_permissions (role_id, permission_id)
    values (new.id, permission_id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists grant_customer_update_default_permission_after_role_insert on public.roles;
create trigger grant_customer_update_default_permission_after_role_insert
after insert on public.roles
for each row execute function app_private.grant_customer_update_default_permission();

-- enforce_role_permission_write_security gates grants on the acting user's
-- tenant authority, which a migration session (no JWT) cannot have. This
-- backfill is the platform shipping a new default rather than a tenant action,
-- so the guard is lifted for this one statement and restored before commit.
alter table public.role_permissions disable trigger enforce_role_permission_write_security;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
join public.permissions permission_row on permission_row.permission_key = 'customer.update'
where role_row.role_key in (
  'client_admin', 'system_administrator', 'showroom_manager', 'team_manager',
  'sales_consultant', 'telecaller_bdc'
)
on conflict do nothing;

alter table public.role_permissions enable trigger enforce_role_permission_write_security;

create unique index if not exists customer_update_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action = 'customer.updated';

create or replace function public.get_customer_360_edit_data(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  customer_row public.customers%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into customer_row
  from public.customers
  where id = target_customer_id and deleted_at is null;
  if not found
    or not app_private.has_permission(customer_row.organization_id, 'customer.update')
    or not app_private.can_access_customer(customer_row.organization_id, customer_row.id)
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_UPDATE_SCOPE_DENIED';
  end if;

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', customer_row.id,
      'full_name', customer_row.full_name,
      'primary_phone', customer_row.primary_phone,
      'primary_email', customer_row.primary_email,
      'created_at', customer_row.created_at,
      'updated_at', customer_row.updated_at
    ),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', contact_row.id,
        'type', contact_row.type,
        'value', contact_row.value,
        'is_primary', contact_row.is_primary
      ) order by contact_row.is_primary desc, contact_row.created_at, contact_row.id)
      from public.customer_contacts contact_row
      where contact_row.organization_id = customer_row.organization_id
        and contact_row.customer_id = customer_row.id
    ), '[]'::jsonb),
    'addresses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', address_row.id,
        'address_type', address_row.address_type,
        'address', case when jsonb_typeof(address_row.address) = 'object'
          then address_row.address else '{}'::jsonb end
      ) order by address_row.created_at, address_row.id)
      from public.customer_addresses address_row
      where address_row.organization_id = customer_row.organization_id
        and address_row.customer_id = customer_row.id
    ), '[]'::jsonb),
    'vehicles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', vehicle_row.id,
        'registration', vehicle_row.registration,
        'brand', vehicle_row.brand,
        'model', vehicle_row.model,
        'variant', vehicle_row.variant,
        'model_year', vehicle_row.model_year,
        'created_at', vehicle_row.created_at
      ) order by vehicle_row.created_at desc, vehicle_row.id)
      from (
        select *
        from public.customer_vehicles vehicle_source
        where vehicle_source.organization_id = customer_row.organization_id
          and vehicle_source.customer_id = customer_row.id
        order by vehicle_source.created_at desc, vehicle_source.id
        limit 50
      ) vehicle_row
    ), '[]'::jsonb),
    'custom_fields', coalesce((
      select jsonb_agg(jsonb_build_object(
        'definition_id', definition_row.id,
        'field_key', definition_row.field_key,
        'label', definition_row.label,
        'field_type', definition_row.field_type,
        'value', value_row.value
      ) order by definition_row.label, definition_row.id)
      from public.custom_field_definitions definition_row
      left join public.custom_field_values value_row
        on value_row.organization_id = definition_row.organization_id
       and value_row.definition_id = definition_row.id
       and upper(value_row.resource_type) = 'CUSTOMER'
       and value_row.resource_id = customer_row.id
      where definition_row.organization_id = customer_row.organization_id
        and upper(definition_row.module) = 'CUSTOMERS'
        and definition_row.active
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_customer_360_edit_data(uuid) from public, anon;
grant execute on function public.get_customer_360_edit_data(uuid) to authenticated;

create or replace function public.update_customer_360(
  target_customer_id uuid,
  expected_customer_updated_at timestamptz,
  target_payload jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_row public.profiles%rowtype;
  customer_row public.customers%rowtype;
  previous_metadata jsonb;
  contact_input jsonb;
  address_input jsonb;
  vehicle_input jsonb;
  field_input jsonb;
  input_contact_id uuid;
  input_address_id uuid;
  input_vehicle_id uuid;
  input_definition_id uuid;
  input_type text;
  input_value text;
  input_is_primary boolean;
  input_address_type text;
  input_address jsonb;
  input_registration text;
  input_brand text;
  input_model text;
  input_variant text;
  input_model_year integer;
  input_field_value jsonb;
  definition_row public.custom_field_definitions%rowtype;
  normalized_phone text;
  normalized_email text;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_customer_id is null
    or expected_customer_updated_at is null
    or target_request_id is null
    or jsonb_typeof(target_payload) <> 'object'
  then
    raise exception using errcode = '22023', message = 'CUSTOMER_UPDATE_FIELDS_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(target_payload->'contacts', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(target_payload->'addresses', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(target_payload->'vehicles', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(target_payload->'custom_fields', '[]'::jsonb)) <> 'array'
  then
    raise exception using errcode = '22023', message = 'CUSTOMER_UPDATE_COLLECTION_INVALID';
  end if;
  if jsonb_array_length(coalesce(target_payload->'contacts', '[]'::jsonb)) > 25
    or jsonb_array_length(coalesce(target_payload->'addresses', '[]'::jsonb)) > 10
    or jsonb_array_length(coalesce(target_payload->'vehicles', '[]'::jsonb)) > 50
    or jsonb_array_length(coalesce(target_payload->'custom_fields', '[]'::jsonb)) > 50
  then
    raise exception using errcode = '22023', message = 'CUSTOMER_UPDATE_COLLECTION_LIMIT';
  end if;

  select * into actor_row
  from public.profiles
  where id = auth.uid() and active and deleted_at is null;
  if not found or actor_row.organization_id is null
    or not app_private.has_permission(actor_row.organization_id, 'customer.update')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_UPDATE_PERMISSION_REQUIRED';
  end if;

  select metadata into previous_metadata
  from public.audit_logs
  where organization_id = actor_row.organization_id
    and actor_id = auth.uid()
    and request_id = target_request_id
    and action = 'customer.updated';
  if found then
    if previous_metadata->>'customer_id' is distinct from target_customer_id::text then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata->'result', '{}'::jsonb) || jsonb_build_object('replayed', true);
  end if;

  select * into customer_row
  from public.customers
  where id = target_customer_id
    and organization_id = actor_row.organization_id
    and deleted_at is null
  for update;
  if not found or not app_private.can_access_customer(actor_row.organization_id, target_customer_id) then
    raise exception using errcode = '42501', message = 'CUSTOMER_UPDATE_SCOPE_DENIED';
  end if;
  if customer_row.updated_at is distinct from expected_customer_updated_at then
    raise exception using errcode = '40001', message = 'CUSTOMER_VERSION_CONFLICT';
  end if;

  if nullif(btrim(coalesce(target_payload->>'full_name', '')), '') is null
    or char_length(btrim(target_payload->>'full_name')) > 180
  then
    raise exception using errcode = '22023', message = 'CUSTOMER_NAME_INVALID';
  end if;
  normalized_phone := app_private.normalize_phone_digits(coalesce(target_payload->>'primary_phone', ''));
  if normalized_phone <> '' and char_length(normalized_phone) not between 7 and 15 then
    raise exception using errcode = '22023', message = 'CUSTOMER_PHONE_INVALID';
  end if;
  normalized_email := lower(btrim(coalesce(target_payload->>'primary_email', '')));
  if normalized_email <> ''
    and normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then
    raise exception using errcode = '22023', message = 'CUSTOMER_EMAIL_INVALID';
  end if;

  update public.customers
  set full_name = btrim(target_payload->>'full_name'),
      primary_phone = nullif(btrim(coalesce(target_payload->>'primary_phone', '')), ''),
      primary_email = nullif(normalized_email, ''),
      updated_at = now()
  where id = customer_row.id
    and organization_id = customer_row.organization_id
  returning * into customer_row;

  for contact_input in select value from jsonb_array_elements(coalesce(target_payload->'contacts', '[]'::jsonb))
  loop
    if jsonb_typeof(contact_input) <> 'object' then
      raise exception using errcode = '22023', message = 'CUSTOMER_CONTACT_INVALID';
    end if;
    input_contact_id := nullif(contact_input->>'id', '')::uuid;
    input_type := upper(btrim(coalesce(contact_input->>'type', '')));
    input_value := btrim(coalesce(contact_input->>'value', ''));
    input_is_primary := coalesce((contact_input->>'is_primary')::boolean, false);
    if input_type not in ('PHONE', 'EMAIL') or input_value = '' or char_length(input_value) > 254 then
      raise exception using errcode = '22023', message = 'CUSTOMER_CONTACT_INVALID';
    end if;
    if input_type = 'PHONE' then
      normalized_phone := app_private.normalize_phone_digits(input_value);
      if char_length(normalized_phone) not between 7 and 15 then
        raise exception using errcode = '22023', message = 'CUSTOMER_CONTACT_PHONE_INVALID';
      end if;
    else
      normalized_email := lower(input_value);
      if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
        raise exception using errcode = '22023', message = 'CUSTOMER_CONTACT_EMAIL_INVALID';
      end if;
    end if;
    if input_is_primary then
      update public.customer_contacts
      set is_primary = false
      where organization_id = customer_row.organization_id
        and customer_id = customer_row.id
        and type = input_type;
    end if;
    if input_contact_id is null then
      insert into public.customer_contacts (
        organization_id, customer_id, type, value, normalized_value, is_primary
      ) values (
        customer_row.organization_id, customer_row.id, input_type, input_value,
        case when input_type = 'PHONE' then normalized_phone else normalized_email end,
        input_is_primary
      );
    else
      update public.customer_contacts
      set type = input_type,
          value = input_value,
          normalized_value = case when input_type = 'PHONE' then normalized_phone else normalized_email end,
          is_primary = input_is_primary
      where id = input_contact_id
        and organization_id = customer_row.organization_id
        and customer_id = customer_row.id;
      if not found then
        raise exception using errcode = '42501', message = 'CUSTOMER_CONTACT_SCOPE_DENIED';
      end if;
    end if;
  end loop;

  for address_input in select value from jsonb_array_elements(coalesce(target_payload->'addresses', '[]'::jsonb))
  loop
    if jsonb_typeof(address_input) <> 'object'
      or jsonb_typeof(coalesce(address_input->'address', '{}'::jsonb)) <> 'object'
    then
      raise exception using errcode = '22023', message = 'CUSTOMER_ADDRESS_INVALID';
    end if;
    input_address_id := nullif(address_input->>'id', '')::uuid;
    input_address_type := upper(left(btrim(coalesce(address_input->>'address_type', 'HOME')), 64));
    input_address := coalesce(address_input->'address', '{}'::jsonb);
    if input_address_type = '' then
      raise exception using errcode = '22023', message = 'CUSTOMER_ADDRESS_TYPE_INVALID';
    end if;
    if input_address_id is null then
      insert into public.customer_addresses (organization_id, customer_id, address_type, address)
      values (customer_row.organization_id, customer_row.id, input_address_type, input_address);
    else
      update public.customer_addresses
      set address_type = input_address_type, address = input_address
      where id = input_address_id
        and organization_id = customer_row.organization_id
        and customer_id = customer_row.id;
      if not found then
        raise exception using errcode = '42501', message = 'CUSTOMER_ADDRESS_SCOPE_DENIED';
      end if;
    end if;
  end loop;

  for vehicle_input in select value from jsonb_array_elements(coalesce(target_payload->'vehicles', '[]'::jsonb))
  loop
    if jsonb_typeof(vehicle_input) <> 'object' then
      raise exception using errcode = '22023', message = 'CUSTOMER_VEHICLE_INVALID';
    end if;
    input_vehicle_id := nullif(vehicle_input->>'id', '')::uuid;
    input_registration := nullif(left(btrim(coalesce(vehicle_input->>'registration', '')), 80), '');
    input_brand := nullif(left(btrim(coalesce(vehicle_input->>'brand', '')), 120), '');
    input_model := nullif(left(btrim(coalesce(vehicle_input->>'model', '')), 120), '');
    input_variant := nullif(left(btrim(coalesce(vehicle_input->>'variant', '')), 120), '');
    input_model_year := nullif(vehicle_input->>'model_year', '')::integer;
    if input_model_year is not null and input_model_year not between 1900 and 2100 then
      raise exception using errcode = '22023', message = 'CUSTOMER_VEHICLE_YEAR_INVALID';
    end if;
    if input_vehicle_id is null then
      insert into public.customer_vehicles (
        organization_id, customer_id, registration, normalized_registration, brand, model, variant, model_year
      ) values (
        customer_row.organization_id, customer_row.id, input_registration,
        nullif(upper(regexp_replace(coalesce(input_registration, ''), '[^A-Za-z0-9]', '', 'g')), ''),
        input_brand, input_model, input_variant, input_model_year
      );
    else
      update public.customer_vehicles
      set registration = input_registration,
          normalized_registration = nullif(upper(regexp_replace(coalesce(input_registration, ''), '[^A-Za-z0-9]', '', 'g')), ''),
          brand = input_brand,
          model = input_model,
          variant = input_variant,
          model_year = input_model_year
      where id = input_vehicle_id
        and organization_id = customer_row.organization_id
        and customer_id = customer_row.id;
      if not found then
        raise exception using errcode = '42501', message = 'CUSTOMER_VEHICLE_SCOPE_DENIED';
      end if;
    end if;
  end loop;

  for field_input in select value from jsonb_array_elements(coalesce(target_payload->'custom_fields', '[]'::jsonb))
  loop
    if jsonb_typeof(field_input) <> 'object' then
      raise exception using errcode = '22023', message = 'CUSTOMER_CUSTOM_FIELD_INVALID';
    end if;
    input_definition_id := nullif(field_input->>'definition_id', '')::uuid;
    input_field_value := coalesce(field_input->'value', 'null'::jsonb);
    select * into definition_row
    from public.custom_field_definitions
    where id = input_definition_id
      and organization_id = customer_row.organization_id
      and upper(module) = 'CUSTOMERS'
      and active;
    if not found then
      raise exception using errcode = '42501', message = 'CUSTOMER_CUSTOM_FIELD_SCOPE_DENIED';
    end if;
    if (definition_row.required and input_field_value = 'null'::jsonb)
      or (definition_row.field_type = 'NUMBER' and jsonb_typeof(input_field_value) not in ('number', 'null'))
      or (definition_row.field_type = 'BOOLEAN' and jsonb_typeof(input_field_value) not in ('boolean', 'null'))
      or (definition_row.field_type = 'MULTI_SELECT' and jsonb_typeof(input_field_value) not in ('array', 'null'))
      or (definition_row.field_type in ('TEXT', 'DATE', 'SELECT') and jsonb_typeof(input_field_value) not in ('string', 'null'))
    then
      raise exception using errcode = '22023', message = 'CUSTOMER_CUSTOM_FIELD_VALUE_INVALID';
    end if;
    insert into public.custom_field_values (
      organization_id, definition_id, resource_type, resource_id, value
    ) values (
      customer_row.organization_id, definition_row.id, 'CUSTOMER', customer_row.id, input_field_value
    ) on conflict (definition_id, resource_type, resource_id) do update
      set value = excluded.value;
  end loop;

  result := jsonb_build_object(
    'customer_id', customer_row.id,
    'updated_at', customer_row.updated_at,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    customer_row.organization_id, auth.uid(), 'customer.updated', 'customer', customer_row.id::text,
    target_request_id,
    jsonb_build_object(
      'customer_id', customer_row.id,
      'updated_fields', jsonb_build_array('full_name', 'primary_phone', 'primary_email', 'contacts', 'addresses', 'vehicles', 'custom_fields'),
      'contact_count', jsonb_array_length(coalesce(target_payload->'contacts', '[]'::jsonb)),
      'address_count', jsonb_array_length(coalesce(target_payload->'addresses', '[]'::jsonb)),
      'vehicle_count', jsonb_array_length(coalesce(target_payload->'vehicles', '[]'::jsonb)),
      'custom_field_count', jsonb_array_length(coalesce(target_payload->'custom_fields', '[]'::jsonb)),
      'result', result
    )
  );
  return result;
end;
$$;

revoke all on function public.update_customer_360(uuid, timestamptz, jsonb, uuid) from public, anon;
grant execute on function public.update_customer_360(uuid, timestamptz, jsonb, uuid) to authenticated;

-- The Customer 360 action only exposes AI-enabled Twilio connections that are
-- mapped to the branch of a lead the current user can access.
create or replace function public.get_customer_ai_call_options(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  lead_row record;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
    or not app_private.has_permission(current_organization_id, 'call.create')
    or not app_private.can_access_customer(current_organization_id, target_customer_id)
  then
    raise exception using errcode = '42501', message = 'AI_CALL_PERMISSION_REQUIRED';
  end if;

  select lead_source.id, lead_source.branch_id, branch_row.name as branch_name
  into lead_row
  from public.leads lead_source
  join public.branches branch_row
    on branch_row.organization_id = lead_source.organization_id
   and branch_row.id = lead_source.branch_id
  where lead_source.organization_id = current_organization_id
    and lead_source.customer_id = target_customer_id
    and lead_source.deleted_at is null
    and app_private.can_access_record(
      lead_source.organization_id, lead_source.branch_id, lead_source.team_id, lead_source.assigned_user_id
    )
  order by lead_source.updated_at desc, lead_source.id desc
  limit 1;

  if not found then
    return jsonb_build_object('lead_id', null, 'branch_name', null, 'connections', '[]'::jsonb);
  end if;

  select jsonb_build_object(
    'lead_id', lead_row.id,
    'branch_name', lead_row.branch_name,
    'connections', coalesce(jsonb_agg(jsonb_build_object(
      'id', connection_row.id,
      'display_name', connection_row.display_name,
      'caller_id_label', nullif(connection_row.connection_config->>'caller_id_label', ''),
      'scope_mode', connection_row.scope_mode
    ) order by connection_row.display_name, connection_row.id), '[]'::jsonb)
  ) into result
  from public.connected_accounts connection_row
  where connection_row.organization_id = current_organization_id
    and connection_row.provider_key = 'twilio_voice'
    and connection_row.status = 'CONNECTED'
    and connection_row.deleted_at is null
    and connection_row.connection_config @> '{"capabilities":["AI_VOICE_CALLING"]}'::jsonb
    and (
      connection_row.scope_mode = 'ALL_BRANCHES'
      or exists (
        select 1
        from public.integration_branch_mappings mapping_row
        where mapping_row.organization_id = current_organization_id
          and mapping_row.connected_account_id = connection_row.id
          and mapping_row.branch_id = lead_row.branch_id
          and mapping_row.deleted_at is null
      )
    );
  return result;
end;
$$;

revoke all on function public.get_customer_ai_call_options(uuid) from public, anon;
grant execute on function public.get_customer_ai_call_options(uuid) to authenticated;

create or replace function public.create_ai_provider_call_request(
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
  current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.create')
    or not exists (
      select 1
      from public.connected_accounts connection_row
      where connection_row.id = target_connection_id
        and connection_row.organization_id = current_organization_id
        and connection_row.provider_key = 'twilio_voice'
        and connection_row.status = 'CONNECTED'
        and connection_row.deleted_at is null
        and connection_row.connection_config @> '{"capabilities":["AI_VOICE_CALLING"]}'::jsonb
    )
  then
    raise exception using errcode = '42501', message = 'AI_CALL_CONNECTION_NOT_AUTHORIZED';
  end if;
  return public.create_provider_call_request(
    target_connection_id,
    target_lead_id,
    target_request_id
  );
end;
$$;

revoke all on function public.create_ai_provider_call_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.create_ai_provider_call_request(uuid, uuid, uuid) to authenticated;

commit;
