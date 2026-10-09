begin;
-- Customer 360 profile completion (plan phase 1).
--
-- 1. A customer may chat on WhatsApp from a number other than their mobile.
--    `whatsapp_phone` null means "same as the primary phone".
-- 2. Owned vehicles carry the details an exchange conversation needs.
-- 3. Vehicle requirement / budget / exchange preferences are per enquiry, so
--    they live on the lead -- in a 1:1 side table, keeping the hot `leads`
--    table and its list RPCs untouched.
--
-- The large read/write functions are text-patched from their live definitions
-- (never re-emitted from an old migration body); every patch asserts its
-- anchor exists exactly once and that the new text landed.

-- --- 1. WhatsApp number -------------------------------------------------------
alter table public.customers
  add column whatsapp_phone text,
  add column normalized_whatsapp_phone text,
  add constraint customers_whatsapp_phone_check check (
    (whatsapp_phone is null and normalized_whatsapp_phone is null)
    or (
      char_length(btrim(whatsapp_phone)) between 7 and 32
      and normalized_whatsapp_phone ~ '^[0-9]{7,15}$'
    )
  );
create index customers_org_whatsapp_phone_idx
  on public.customers (organization_id, normalized_whatsapp_phone)
  where normalized_whatsapp_phone is not null and deleted_at is null;

-- --- 2. Owned-vehicle details -------------------------------------------------
alter table public.customer_vehicles
  add column fuel_type text,
  add column transmission text,
  add column odometer_km integer,
  add column ownership text,
  add column purchase_year integer,
  add constraint customer_vehicles_details_check check (
    (fuel_type is null or char_length(btrim(fuel_type)) between 2 and 40)
    and (transmission is null or char_length(btrim(transmission)) between 2 and 40)
    and (odometer_km is null or odometer_km between 0 and 5000000)
    and (ownership is null or char_length(btrim(ownership)) between 2 and 40)
    and (purchase_year is null or purchase_year between 1900 and 2100)
  );

-- --- 3. Lead requirements -----------------------------------------------------
create table public.lead_requirements (
  lead_id uuid primary key references public.leads (id),
  organization_id uuid not null references public.organizations (id),
  variant text,
  fuel_type text,
  transmission text,
  colour_preference text,
  usage text,
  delivery_timeline text,
  purchase_timeline text,
  budget_min numeric(14, 2),
  budget_max numeric(14, 2),
  preferred_brand text,
  purchase_type text,
  finance_required boolean,
  finance_note text,
  exchange_required boolean,
  exchange_vehicle_id uuid references public.customer_vehicles (id),
  expected_exchange_value numeric(14, 2),
  insurance_preference text,
  rto_preference text,
  preferred_services text[] not null default '{}',
  test_drive_required boolean,
  competitors text[] not null default '{}',
  version bigint not null default 1 check (version > 0),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_requirements_text_check check (
    coalesce(char_length(variant), 0) <= 120
    and coalesce(char_length(fuel_type), 0) <= 40
    and coalesce(char_length(transmission), 0) <= 40
    and coalesce(char_length(colour_preference), 0) <= 120
    and coalesce(char_length(usage), 0) <= 120
    and coalesce(char_length(delivery_timeline), 0) <= 60
    and coalesce(char_length(purchase_timeline), 0) <= 60
    and coalesce(char_length(preferred_brand), 0) <= 80
    and coalesce(char_length(purchase_type), 0) <= 40
    and coalesce(char_length(finance_note), 0) <= 240
    and coalesce(char_length(insurance_preference), 0) <= 120
    and coalesce(char_length(rto_preference), 0) <= 120
    and cardinality(preferred_services) <= 12
    and cardinality(competitors) <= 12
  ),
  constraint lead_requirements_money_check check (
    (budget_min is null or budget_min between 0 and 1000000000)
    and (budget_max is null or budget_max between 0 and 1000000000)
    and (budget_min is null or budget_max is null or budget_max >= budget_min)
    and (expected_exchange_value is null or expected_exchange_value between 0 and 1000000000)
  )
);
create index lead_requirements_org_idx on public.lead_requirements (organization_id);
create index lead_requirements_exchange_vehicle_idx
  on public.lead_requirements (exchange_vehicle_id)
  where exchange_vehicle_id is not null;

alter table public.lead_requirements enable row level security;
create policy lead_requirements_select on public.lead_requirements
  for select to authenticated
  using (
    app_private.has_permission(organization_id, 'lead.view')
    and app_private.can_access_lead(lead_id)
  );
revoke all on public.lead_requirements from anon, authenticated;
grant select on public.lead_requirements to authenticated;

create or replace function app_private.lead_requirements_json(target_lead_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'variant', r.variant,
    'fuel_type', r.fuel_type,
    'transmission', r.transmission,
    'colour_preference', r.colour_preference,
    'usage', r.usage,
    'delivery_timeline', r.delivery_timeline,
    'purchase_timeline', r.purchase_timeline,
    'budget_min', r.budget_min,
    'budget_max', r.budget_max,
    'preferred_brand', r.preferred_brand,
    'purchase_type', r.purchase_type,
    'finance_required', r.finance_required,
    'finance_note', r.finance_note,
    'exchange_required', r.exchange_required,
    'exchange_vehicle_id', r.exchange_vehicle_id,
    'expected_exchange_value', r.expected_exchange_value,
    'insurance_preference', r.insurance_preference,
    'rto_preference', r.rto_preference,
    'preferred_services', to_jsonb(r.preferred_services),
    'test_drive_required', r.test_drive_required,
    'competitors', to_jsonb(r.competitors),
    'version', r.version,
    'updated_at', r.updated_at
  )
  from public.lead_requirements r
  where r.lead_id = target_lead_id;
$$;
revoke all on function app_private.lead_requirements_json(uuid) from public, anon, authenticated;

create or replace function public.update_lead_requirements(
  target_lead_id uuid,
  expected_version bigint,
  target_payload jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
  current_row public.lead_requirements%rowtype;
  previous_metadata jsonb;
  vehicle_id uuid;
  services text[];
  rivals text[];
  next_version bigint;
  before_json jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_lead_id is null or target_request_id is null
    or jsonb_typeof(target_payload) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'LEAD_REQUIREMENTS_INVALID';
  end if;

  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(lead_row.organization_id, 'lead.update')
    or not app_private.can_access_record(
      lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  select metadata into previous_metadata
  from public.audit_logs
  where organization_id = lead_row.organization_id
    and actor_id = auth.uid()
    and request_id = target_request_id
    and action = 'lead.requirements_updated';
  if found then
    if previous_metadata->>'lead_id' is distinct from target_lead_id::text then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata->'result', '{}'::jsonb) || jsonb_build_object('replayed', true);
  end if;

  select * into current_row from public.lead_requirements where lead_id = target_lead_id for update;
  if found and current_row.version is distinct from expected_version then
    raise exception using errcode = 'PT409', message = 'LEAD_REQUIREMENTS_VERSION_CONFLICT';
  end if;
  if not found and expected_version is not null then
    raise exception using errcode = 'PT409', message = 'LEAD_REQUIREMENTS_VERSION_CONFLICT';
  end if;

  vehicle_id := nullif(target_payload->>'exchange_vehicle_id', '')::uuid;
  if vehicle_id is not null and not exists (
    select 1 from public.customer_vehicles v
    where v.id = vehicle_id
      and v.organization_id = lead_row.organization_id
      and v.customer_id = lead_row.customer_id
  ) then
    raise exception using errcode = '42501', message = 'EXCHANGE_VEHICLE_SCOPE_DENIED';
  end if;
  if jsonb_typeof(coalesce(target_payload->'preferred_services', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(target_payload->'competitors', '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'LEAD_REQUIREMENTS_INVALID';
  end if;
  select coalesce(array_agg(distinct left(btrim(value), 80)) filter (where btrim(value) <> ''), '{}')
    into services
  from jsonb_array_elements_text(coalesce(target_payload->'preferred_services', '[]'::jsonb));
  select coalesce(array_agg(distinct left(btrim(value), 80)) filter (where btrim(value) <> ''), '{}')
    into rivals
  from jsonb_array_elements_text(coalesce(target_payload->'competitors', '[]'::jsonb));

  next_version := coalesce(current_row.version, 0) + 1;
  before_json := app_private.lead_requirements_json(lead_row.id);
  insert into public.lead_requirements as r (
    lead_id, organization_id, variant, fuel_type, transmission, colour_preference, usage,
    delivery_timeline, purchase_timeline, budget_min, budget_max, preferred_brand, purchase_type,
    finance_required, finance_note, exchange_required, exchange_vehicle_id, expected_exchange_value,
    insurance_preference, rto_preference, preferred_services, test_drive_required, competitors,
    version, updated_by, updated_at
  ) values (
    lead_row.id, lead_row.organization_id,
    nullif(btrim(target_payload->>'variant'), ''),
    nullif(btrim(target_payload->>'fuel_type'), ''),
    nullif(btrim(target_payload->>'transmission'), ''),
    nullif(btrim(target_payload->>'colour_preference'), ''),
    nullif(btrim(target_payload->>'usage'), ''),
    nullif(btrim(target_payload->>'delivery_timeline'), ''),
    nullif(btrim(target_payload->>'purchase_timeline'), ''),
    nullif(target_payload->>'budget_min', '')::numeric,
    nullif(target_payload->>'budget_max', '')::numeric,
    nullif(btrim(target_payload->>'preferred_brand'), ''),
    nullif(btrim(target_payload->>'purchase_type'), ''),
    (target_payload->>'finance_required')::boolean,
    nullif(btrim(target_payload->>'finance_note'), ''),
    (target_payload->>'exchange_required')::boolean,
    vehicle_id,
    nullif(target_payload->>'expected_exchange_value', '')::numeric,
    nullif(btrim(target_payload->>'insurance_preference'), ''),
    nullif(btrim(target_payload->>'rto_preference'), ''),
    services,
    (target_payload->>'test_drive_required')::boolean,
    rivals,
    next_version, auth.uid(), now()
  )
  on conflict (lead_id) do update set
    variant = excluded.variant,
    fuel_type = excluded.fuel_type,
    transmission = excluded.transmission,
    colour_preference = excluded.colour_preference,
    usage = excluded.usage,
    delivery_timeline = excluded.delivery_timeline,
    purchase_timeline = excluded.purchase_timeline,
    budget_min = excluded.budget_min,
    budget_max = excluded.budget_max,
    preferred_brand = excluded.preferred_brand,
    purchase_type = excluded.purchase_type,
    finance_required = excluded.finance_required,
    finance_note = excluded.finance_note,
    exchange_required = excluded.exchange_required,
    exchange_vehicle_id = excluded.exchange_vehicle_id,
    expected_exchange_value = excluded.expected_exchange_value,
    insurance_preference = excluded.insurance_preference,
    rto_preference = excluded.rto_preference,
    preferred_services = excluded.preferred_services,
    test_drive_required = excluded.test_drive_required,
    competitors = excluded.competitors,
    version = excluded.version,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  result := jsonb_build_object('lead_id', lead_row.id, 'version', next_version, 'replayed', false);
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  values (
    lead_row.organization_id, lead_row.customer_id, lead_row.id, 'LEAD_REQUIREMENTS_UPDATED', auth.uid(),
    jsonb_build_object('version', next_version)
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    lead_row.organization_id, auth.uid(), 'lead.requirements_updated', 'lead', lead_row.id::text,
    lead_row.branch_id, target_request_id,
    jsonb_build_object(
      'lead_id', lead_row.id,
      'before', before_json,
      'result', result
    )
  );
  return result;
end;
$$;
revoke all on function public.update_lead_requirements(uuid, bigint, jsonb, uuid) from public, anon;
grant execute on function public.update_lead_requirements(uuid, bigint, jsonb, uuid) to authenticated;

-- --- 4. Patch the live functions ---------------------------------------------
create function pg_temp.patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  occurrences integer := (char_length(definition) - char_length(replace(definition, old_text, ''))) / char_length(old_text);
begin
  if occurrences <> 1 then
    raise exception 'PATCH_ANCHOR_% for %: expected 1 occurrence, found %',
      md5(old_text), target, occurrences;
  end if;
  execute replace(definition, old_text, new_text);
  if position(new_text in pg_get_functiondef(target)) = 0 then
    raise exception 'PATCH_NOT_APPLIED for %', target;
  end if;
end;
$$;

-- update_customer_360: whatsapp number and vehicle details.
select pg_temp.patch_function(
  'public.update_customer_360(uuid,timestamp with time zone,jsonb,uuid)',
  $old$  input_model_year integer;
$old$,
  $new$  input_model_year integer;
  input_fuel_type text;
  input_transmission text;
  input_odometer_km integer;
  input_ownership text;
  input_purchase_year integer;
  whatsapp_value text;
  normalized_whatsapp_value text;
$new$
);
select pg_temp.patch_function(
  'public.update_customer_360(uuid,timestamp with time zone,jsonb,uuid)',
  $old$  previous_additional_fields := customer_row.additional_fields;
$old$,
  $new$  -- WhatsApp: an absent key keeps the stored number; null or blank means
  -- "same as the primary phone".
  whatsapp_value := customer_row.whatsapp_phone;
  normalized_whatsapp_value := customer_row.normalized_whatsapp_phone;
  if target_payload ? 'whatsapp_phone' then
    whatsapp_value := nullif(btrim(coalesce(target_payload->>'whatsapp_phone', '')), '');
    normalized_whatsapp_value := case
      when whatsapp_value is null then null
      else app_private.normalize_phone_digits(whatsapp_value)
    end;
    if whatsapp_value is not null
      and (char_length(whatsapp_value) > 32 or normalized_whatsapp_value !~ '^[0-9]{7,15}$') then
      raise exception using errcode = '22023', message = 'CUSTOMER_WHATSAPP_INVALID';
    end if;
  end if;

  previous_additional_fields := customer_row.additional_fields;
$new$
);
select pg_temp.patch_function(
  'public.update_customer_360(uuid,timestamp with time zone,jsonb,uuid)',
  $old$      additional_fields = coalesce(target_payload->'additional_fields', customer_row.additional_fields),
$old$,
  $new$      additional_fields = coalesce(target_payload->'additional_fields', customer_row.additional_fields),
      whatsapp_phone = whatsapp_value,
      normalized_whatsapp_phone = normalized_whatsapp_value,
$new$
);
select pg_temp.patch_function(
  'public.update_customer_360(uuid,timestamp with time zone,jsonb,uuid)',
  $old$    if input_model_year is not null and input_model_year not between 1900 and 2100 then
      raise exception using errcode = '22023', message = 'CUSTOMER_VEHICLE_YEAR_INVALID';
    end if;
$old$,
  $new$    if input_model_year is not null and input_model_year not between 1900 and 2100 then
      raise exception using errcode = '22023', message = 'CUSTOMER_VEHICLE_YEAR_INVALID';
    end if;
    input_fuel_type := nullif(left(btrim(coalesce(vehicle_input->>'fuel_type', '')), 40), '');
    input_transmission := nullif(left(btrim(coalesce(vehicle_input->>'transmission', '')), 40), '');
    input_odometer_km := nullif(vehicle_input->>'odometer_km', '')::integer;
    input_ownership := nullif(left(btrim(coalesce(vehicle_input->>'ownership', '')), 40), '');
    input_purchase_year := nullif(vehicle_input->>'purchase_year', '')::integer;
    if (input_odometer_km is not null and input_odometer_km not between 0 and 5000000)
      or (input_purchase_year is not null and input_purchase_year not between 1900 and 2100)
      or char_length(coalesce(input_fuel_type, 'xx')) < 2
      or char_length(coalesce(input_transmission, 'xx')) < 2
      or char_length(coalesce(input_ownership, 'xx')) < 2
    then
      raise exception using errcode = '22023', message = 'CUSTOMER_VEHICLE_DETAILS_INVALID';
    end if;
$new$
);
select pg_temp.patch_function(
  'public.update_customer_360(uuid,timestamp with time zone,jsonb,uuid)',
  $old$        organization_id, customer_id, registration, normalized_registration, brand, model, variant, model_year
      ) values (
        customer_row.organization_id, customer_row.id, input_registration,
        nullif(upper(regexp_replace(coalesce(input_registration, ''), '[^A-Za-z0-9]', '', 'g')), ''),
        input_brand, input_model, input_variant, input_model_year
      );$old$,
  $new$        organization_id, customer_id, registration, normalized_registration, brand, model, variant, model_year,
        fuel_type, transmission, odometer_km, ownership, purchase_year
      ) values (
        customer_row.organization_id, customer_row.id, input_registration,
        nullif(upper(regexp_replace(coalesce(input_registration, ''), '[^A-Za-z0-9]', '', 'g')), ''),
        input_brand, input_model, input_variant, input_model_year,
        input_fuel_type, input_transmission, input_odometer_km, input_ownership, input_purchase_year
      );$new$
);
select pg_temp.patch_function(
  'public.update_customer_360(uuid,timestamp with time zone,jsonb,uuid)',
  $old$          model_year = input_model_year
      where id = input_vehicle_id$old$,
  $new$          model_year = input_model_year,
          fuel_type = input_fuel_type,
          transmission = input_transmission,
          odometer_km = input_odometer_km,
          ownership = input_ownership,
          purchase_year = input_purchase_year
      where id = input_vehicle_id$new$
);
select pg_temp.patch_function(
  'public.update_customer_360(uuid,timestamp with time zone,jsonb,uuid)',
  $old$jsonb_build_array('full_name', 'primary_phone', 'primary_email', 'contacts',$old$,
  $new$jsonb_build_array('full_name', 'primary_phone', 'primary_email', 'whatsapp_phone', 'contacts',$new$
);

-- get_customer_360_edit_data: return the new fields to the edit dialog.
select pg_temp.patch_function(
  'public.get_customer_360_edit_data(uuid)',
  $old$      'primary_email', customer_row.primary_email,
$old$,
  $new$      'primary_email', customer_row.primary_email,
      'whatsapp_phone', customer_row.whatsapp_phone,
$new$
);
select pg_temp.patch_function(
  'public.get_customer_360_edit_data(uuid)',
  $old$        'model_year', vehicle_row.model_year,
$old$,
  $new$        'model_year', vehicle_row.model_year,
        'fuel_type', vehicle_row.fuel_type,
        'transmission', vehicle_row.transmission,
        'odometer_km', vehicle_row.odometer_km,
        'ownership', vehicle_row.ownership,
        'purchase_year', vehicle_row.purchase_year,
$new$
);

-- Customer 360 read model.
select pg_temp.patch_function(
  'app_private.get_customer_360_legacy_20260824(uuid)',
  $old$      'primary_email', customer_row.primary_email,
      'created_at', customer_row.created_at,
$old$,
  $new$      'primary_email', customer_row.primary_email,
      'whatsapp_phone', customer_row.whatsapp_phone,
      'created_at', customer_row.created_at,
$new$
);
select pg_temp.patch_function(
  'app_private.get_customer_360_legacy_20260824(uuid)',
  $old$        'model_year', vehicle_row.model_year,
$old$,
  $new$        'model_year', vehicle_row.model_year,
        'fuel_type', vehicle_row.fuel_type,
        'transmission', vehicle_row.transmission,
        'odometer_km', vehicle_row.odometer_km,
        'ownership', vehicle_row.ownership,
        'purchase_year', vehicle_row.purchase_year,
$new$
);
select pg_temp.patch_function(
  'app_private.get_customer_360_legacy_20260824(uuid)',
  $old$          'assigned_user_name', profile_row.full_name,
          'created_at', lead_row.created_at,
          'updated_at', lead_row.updated_at
        ) as data
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
      left join public.teams team_row$old$,
  $new$          'assigned_user_name', profile_row.full_name,
          'assigned_user_phone', profile_row.phone,
          'requirements', app_private.lead_requirements_json(lead_row.id),
          -- The latest live exchange for this customer; valuation is owned by
          -- the Exchange team, so only holders of exchange.view see it.
          'exchange_case', case
            when app_private.has_permission(lead_row.organization_id, 'exchange.view') then (
              select jsonb_build_object(
                'id', exchange_row.id,
                'status', exchange_row.status,
                'vehicle_id', exchange_row.vehicle_id,
                'customer_expected_value', exchange_row.customer_expected_value,
                'estimated_value', exchange_row.estimated_value,
                'accepted_value', exchange_row.accepted_value,
                'odometer_km', exchange_row.odometer_km,
                'fuel_type', exchange_row.fuel_type,
                'ownership', exchange_row.ownership,
                'updated_at', exchange_row.updated_at
              )
              from public.exchange_cases exchange_row
              where exchange_row.organization_id = lead_row.organization_id
                and exchange_row.customer_id = lead_row.customer_id
                and exchange_row.deleted_at is null
                and exchange_row.status <> 'CANCELLED'
              order by exchange_row.updated_at desc, exchange_row.id
              limit 1
            )
          end,
          'created_at', lead_row.created_at,
          'updated_at', lead_row.updated_at
        ) as data
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
      left join public.teams team_row$new$
);
select pg_temp.patch_function(
  'app_private.get_customer_360_legacy_20260824(uuid)',
  $old$          'recording_status', recording_row.status,
          'transcript_status', transcript_row.status
        ) as data$old$,
  $new$          'recording_status', recording_row.status,
          'transcript_status', transcript_row.status,
          'ai_summary', (
            select summary_row.summary
            from public.ai_call_summaries summary_row
            where summary_row.organization_id = call_row.organization_id
              and summary_row.call_id = call_row.id
            order by summary_row.created_at desc, summary_row.id
            limit 1
          )
        ) as data$new$
);

-- Lead detail: requirements travel with the lead.
select pg_temp.patch_function(
  'public.get_lead_detail_workspace(uuid)',
  $old$    'latest_ai_summary', latest_ai_summary$old$,
  $new$    'latest_ai_summary', latest_ai_summary,
    'requirements', app_private.lead_requirements_json(lead_row.id)$new$
);

-- WhatsApp goes to the customer's WhatsApp number when one is set.
select pg_temp.patch_function(
  'public.open_lead_whatsapp_conversation(uuid,text)',
  $old$  contact_phone := regexp_replace(coalesce(lead_row.normalized_phone, lead_row.phone, ''), '[^0-9]', '', 'g');$old$,
  $new$  contact_phone := regexp_replace(coalesce(
    (
      select customer_row.normalized_whatsapp_phone
      from public.customers customer_row
      where customer_row.id = lead_row.customer_id
        and customer_row.organization_id = lead_row.organization_id
        and customer_row.deleted_at is null
    ),
    lead_row.normalized_phone,
    lead_row.phone,
    ''
  ), '[^0-9]', '', 'g');$new$
);

commit;
