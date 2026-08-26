begin;

-- `update_customer_360` declared a local called `normalized_email`, which is
-- also a column on `public.customers`. In the UPDATE below, PostgreSQL cannot
-- tell which one `nullif(normalized_email, '')` means and raises
-- "column reference "normalized_email" is ambiguous" at runtime — so saving
-- Edit customer failed outright, and no amount of reading the statement makes
-- the cause visible from the client, which only sees a generic failure.
--
-- Found by `supabase db lint --linked`, which type-checks plpgsql bodies that
-- are only parsed when the function actually runs.
--
-- Both locals that shadow a column are renamed, not just the one that happened
-- to be ambiguous today: `normalized_phone` is equally a customers column and
-- would raise the same error the moment it is used on the right-hand side of
-- that UPDATE.

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

  update public.customers
  set full_name = btrim(target_payload->>'full_name'),
      primary_phone = nullif(btrim(coalesce(target_payload->>'primary_phone', '')), ''),
      primary_email = nullif(normalized_email_value, ''),
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

-- The enrolment RPC bound a whole customer row only to prove the customer
-- exists, which `db lint` reports as a never-read variable. An existence check
-- says the same thing without loading the row.
create or replace function public.create_customer_drip_enrollment(
  target_customer_id uuid,
  target_lead_id uuid,
  target_source_campaign_id uuid,
  target_source_name text,
  target_steps jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  resolved_branch_id uuid;
  resolved_lead_id uuid;
  normalized_name text := btrim(coalesce(target_source_name, ''));
  normalized_steps jsonb := coalesce(target_steps, '[]'::jsonb);
  step_element jsonb;
  step_index integer := 0;
  running_offset_hours integer := 0;
  enrollment_id uuid := gen_random_uuid();
  enrolled_at timestamptz := now();
  fingerprint jsonb;
  replay_fingerprint jsonb;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_customer_id is null
    or target_request_id is null
    or char_length(normalized_name) not between 2 and 180
    or jsonb_typeof(normalized_steps) <> 'array'
    or jsonb_array_length(normalized_steps) not between 1 and 12
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_DRIP_INPUT';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.drip.manage')
    or not app_private.can_access_customer(current_organization_id, target_customer_id)
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_DRIP_MANAGE_PERMISSION_REQUIRED';
  end if;

  -- Existence only; nothing on the row is needed afterwards, so no local is
  -- bound to it.
  if not exists (
    select 1
    from public.customers customer_source
    where customer_source.id = target_customer_id
      and customer_source.organization_id = current_organization_id
      and customer_source.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'CUSTOMER_NOT_FOUND';
  end if;

  -- The branch decides who may later read the sequence, so it is taken from a
  -- lead the actor can actually reach rather than from the request body.
  select lead_row.id, lead_row.branch_id
  into resolved_lead_id, resolved_branch_id
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.customer_id = target_customer_id
    and lead_row.deleted_at is null
    and (target_lead_id is null or lead_row.id = target_lead_id)
    and app_private.can_access_record(
      lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
    )
  order by lead_row.updated_at desc, lead_row.id desc
  limit 1;
  if resolved_branch_id is null then
    raise exception using errcode = '42501', message = 'CUSTOMER_DRIP_SCOPE_DENIED';
  end if;

  if target_source_campaign_id is not null and not exists (
    select 1
    from public.marketing_drip_campaigns campaign_row
    where campaign_row.id = target_source_campaign_id
      and campaign_row.organization_id = current_organization_id
      and campaign_row.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'CUSTOMER_DRIP_TEMPLATE_NOT_FOUND';
  end if;

  fingerprint := jsonb_build_object(
    'customer_id', target_customer_id,
    'source_campaign_id', target_source_campaign_id,
    'source_name', normalized_name,
    'steps', normalized_steps
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  select audit_row.metadata -> 'fingerprint', audit_row.metadata -> 'result'
    into replay_fingerprint, replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'customer_drip.enrolled'
    and audit_row.request_id = target_request_id
  order by audit_row.id desc
  limit 1;
  if replay_result is not null then
    if replay_fingerprint is distinct from fingerprint then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
    end if;
    return replay_result || jsonb_build_object('replayed', true);
  end if;

  insert into public.customer_drip_enrollments (
    id, organization_id, branch_id, customer_id, lead_id,
    source_campaign_id, source_name, status, enrolled_by
  ) values (
    enrollment_id, current_organization_id, resolved_branch_id, target_customer_id,
    resolved_lead_id, target_source_campaign_id, normalized_name, 'ACTIVE', auth.uid()
  );

  for step_element in select * from jsonb_array_elements(normalized_steps) loop
    step_index := step_index + 1;
    if jsonb_typeof(step_element) <> 'object'
      or coalesce(step_element ->> 'channel', '') not in ('WHATSAPP', 'SMS', 'EMAIL')
      or char_length(btrim(coalesce(step_element ->> 'message_body', ''))) not between 1 and 4000
    then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_DRIP_STEP';
    end if;

    begin
      -- Delays are relative to the previous step, which is how a consultant
      -- reads a sequence; the stored schedule is absolute so a later edit to
      -- one step cannot silently move every step after it.
      running_offset_hours := running_offset_hours
        + greatest(0, least(8760, coalesce((step_element ->> 'delay_hours')::integer, 0)));
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_DRIP_STEP';
    end;

    insert into public.customer_drip_messages (
      organization_id, enrollment_id, step_order, channel, message_body, scheduled_for, status
    ) values (
      current_organization_id, enrollment_id, step_index,
      step_element ->> 'channel',
      btrim(step_element ->> 'message_body'),
      enrolled_at + make_interval(hours => running_offset_hours),
      'QUEUED'
    );
  end loop;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, target_customer_id, resolved_lead_id,
    'DRIP_ENROLLED', auth.uid(),
    jsonb_build_object(
      'enrollment_id', enrollment_id, 'source_name', normalized_name, 'steps', step_index
    )
  );

  result := jsonb_build_object(
    'id', enrollment_id, 'status', 'ACTIVE', 'version', 1, 'steps', step_index, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'customer_drip.enrolled', 'customer_drip_enrollment',
    enrollment_id::text, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

commit;
