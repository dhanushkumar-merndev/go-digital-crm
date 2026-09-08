begin;
-- Customer-specific key/value information; shared field definitions stay admin-managed.
create or replace function app_private.valid_customer_additional_fields(fields jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare item jsonb; labels text[] := '{}'; label text;
begin
  if fields is null or jsonb_typeof(fields) <> 'array' then return false; end if;
  if jsonb_array_length(fields) > 25 then return false; end if;
  for item in select value from jsonb_array_elements(fields) loop
    if jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item->'label') is distinct from 'string'
      or jsonb_typeof(item->'value') is distinct from 'string'
      or length(btrim(item->>'label')) not between 1 and 80
      or length(btrim(item->>'value')) not between 1 and 2000 then return false; end if;
    label := lower(btrim(item->>'label'));
    if label = any(labels) then return false; end if;
    labels := array_append(labels,label);
  end loop;
  return true;
end;
$$;
alter table public.customers add column additional_fields jsonb not null default '[]'::jsonb
  check (app_private.valid_customer_additional_fields(additional_fields));
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
    'additional_fields', customer_row.additional_fields,
    'custom_fields', coalesce((
      select jsonb_agg(jsonb_build_object(
        'definition_id', definition_row.id,
        'field_key', definition_row.field_key,
        'label', definition_row.label,
        'field_type', definition_row.field_type,
        'options', definition_row.options,
        'required', definition_row.required,
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
  normalized_phone_value text;
  normalized_email_value text;
  result jsonb;
  previous_additional_fields jsonb;
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
  normalized_phone_value := app_private.normalize_phone_digits(coalesce(target_payload->>'primary_phone', ''));
  if normalized_phone_value <> '' and char_length(normalized_phone_value) not between 7 and 15 then
    raise exception using errcode = '22023', message = 'CUSTOMER_PHONE_INVALID';
  end if;
  normalized_email_value := lower(btrim(coalesce(target_payload->>'primary_email', '')));
  if normalized_email_value <> ''
    and normalized_email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then
    raise exception using errcode = '22023', message = 'CUSTOMER_EMAIL_INVALID';
  end if;

  previous_additional_fields := customer_row.additional_fields;
  if target_payload ? 'additional_fields' and not app_private.valid_customer_additional_fields(target_payload->'additional_fields') then
    raise exception using errcode = '22023', message = 'CUSTOMER_ADDITIONAL_FIELDS_INVALID';
  end if;

  update public.customers
  set full_name = btrim(target_payload->>'full_name'),
      primary_phone = nullif(btrim(coalesce(target_payload->>'primary_phone', '')), ''),
      primary_email = nullif(normalized_email_value, ''),
      additional_fields = coalesce(target_payload->'additional_fields', customer_row.additional_fields),
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
      normalized_phone_value := app_private.normalize_phone_digits(input_value);
      if char_length(normalized_phone_value) not between 7 and 15 then
        raise exception using errcode = '22023', message = 'CUSTOMER_CONTACT_PHONE_INVALID';
      end if;
    else
      normalized_email_value := lower(input_value);
      if normalized_email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
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
        case when input_type = 'PHONE' then normalized_phone_value else normalized_email_value end,
        input_is_primary
      );
    else
      update public.customer_contacts
      set type = input_type,
          value = input_value,
          normalized_value = case when input_type = 'PHONE' then normalized_phone_value else normalized_email_value end,
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
      'additional_fields_before', previous_additional_fields,
      'additional_fields_after', customer_row.additional_fields,
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
create function public.get_customer_additional_fields(target_customer_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare customer_row public.customers;
begin
  select * into customer_row from public.customers where id=target_customer_id and deleted_at is null;
  if auth.uid() is null or not found
    or not app_private.has_permission(customer_row.organization_id,'customer.view')
    or not app_private.can_access_customer(customer_row.organization_id,target_customer_id) then
    raise exception using errcode='42501',message='CUSTOMER_ACCESS_DENIED';
  end if;
  return customer_row.additional_fields;
end $$;
revoke all on function public.get_customer_additional_fields(uuid) from public,anon;
grant execute on function public.get_customer_additional_fields(uuid) to authenticated;
commit;
