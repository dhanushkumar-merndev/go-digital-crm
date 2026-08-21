-- Dedicated Sales Consultant exchange request workspace.

alter table public.exchange_cases
  add column if not exists fuel_type text,
  add column if not exists ownership text,
  add column if not exists odometer_km integer,
  add column if not exists customer_expected_value numeric(14,2);

alter table public.exchange_cases drop constraint if exists exchange_cases_workflow_check;
alter table public.exchange_cases add constraint exchange_cases_workflow_check check (
  version > 0
  and priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
  and status in (
    'DRAFT', 'REQUESTED', 'INSPECTION_SCHEDULED', 'EVALUATED', 'OFFERED',
    'ACCEPTED', 'REJECTED', 'CANCELLED'
  )
  and (estimated_value is null or estimated_value between 0 and 10000000000)
  and (accepted_value is null or accepted_value between 0 and 10000000000)
  and (customer_expected_value is null or customer_expected_value between 0 and 10000000000)
  and (odometer_km is null or odometer_km between 0 and 5000000)
  and (fuel_type is null or char_length(btrim(fuel_type)) between 2 and 40)
  and (ownership is null or char_length(btrim(ownership)) between 2 and 40)
  and (notes is null or char_length(btrim(notes)) <= 4000)
) not valid;

create or replace function app_private.operational_case_status_valid(
  target_department text,
  target_status text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case upper(coalesce(target_department, ''))
    when 'FINANCE' then upper(coalesce(target_status, '')) in (
      'DOCUMENTS_PENDING', 'APPLICATION_SUBMITTED', 'UNDER_REVIEW',
      'APPROVED', 'DISBURSED', 'REJECTED', 'CANCELLED'
    )
    when 'INSURANCE' then upper(coalesce(target_status, '')) in (
      'QUOTE_PENDING', 'QUOTE_SHARED', 'CUSTOMER_ACCEPTED', 'POLICY_ISSUED', 'CANCELLED'
    )
    when 'RTO' then upper(coalesce(target_status, '')) in (
      'NEW', 'DOCUMENTS_PENDING', 'SUBMITTED', 'IN_PROCESS', 'REGISTERED', 'CANCELLED'
    )
    when 'EXCHANGE' then upper(coalesce(target_status, '')) in (
      'DRAFT', 'REQUESTED', 'INSPECTION_SCHEDULED', 'EVALUATED', 'OFFERED',
      'ACCEPTED', 'REJECTED', 'CANCELLED'
    )
    when 'DELIVERY' then upper(coalesce(target_status, '')) in (
      'PLANNING', 'CHECKLIST_PENDING', 'READY', 'SCHEDULED', 'DELIVERED', 'CANCELLED'
    )
    else false
  end;
$$;

create or replace function app_private.operational_case_transition_allowed(
  target_department text,
  current_status text,
  next_status text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case upper(coalesce(target_department, ''))
    when 'FINANCE' then (upper(current_status), upper(next_status)) in (
      ('DOCUMENTS_PENDING', 'APPLICATION_SUBMITTED'),
      ('APPLICATION_SUBMITTED', 'UNDER_REVIEW'), ('UNDER_REVIEW', 'APPROVED'),
      ('APPROVED', 'DISBURSED'), ('DOCUMENTS_PENDING', 'REJECTED'),
      ('APPLICATION_SUBMITTED', 'REJECTED'), ('UNDER_REVIEW', 'REJECTED'),
      ('DOCUMENTS_PENDING', 'CANCELLED'), ('APPLICATION_SUBMITTED', 'CANCELLED'),
      ('UNDER_REVIEW', 'CANCELLED'), ('APPROVED', 'CANCELLED')
    )
    when 'INSURANCE' then (upper(current_status), upper(next_status)) in (
      ('QUOTE_PENDING', 'QUOTE_SHARED'), ('QUOTE_SHARED', 'CUSTOMER_ACCEPTED'),
      ('CUSTOMER_ACCEPTED', 'POLICY_ISSUED'), ('QUOTE_PENDING', 'CANCELLED'),
      ('QUOTE_SHARED', 'CANCELLED'), ('CUSTOMER_ACCEPTED', 'CANCELLED')
    )
    when 'RTO' then (upper(current_status), upper(next_status)) in (
      ('NEW', 'DOCUMENTS_PENDING'), ('DOCUMENTS_PENDING', 'SUBMITTED'),
      ('SUBMITTED', 'IN_PROCESS'), ('IN_PROCESS', 'REGISTERED'),
      ('NEW', 'CANCELLED'), ('DOCUMENTS_PENDING', 'CANCELLED'),
      ('SUBMITTED', 'CANCELLED'), ('IN_PROCESS', 'CANCELLED')
    )
    when 'EXCHANGE' then (upper(current_status), upper(next_status)) in (
      ('DRAFT', 'REQUESTED'), ('DRAFT', 'CANCELLED'),
      ('REQUESTED', 'INSPECTION_SCHEDULED'), ('INSPECTION_SCHEDULED', 'EVALUATED'),
      ('EVALUATED', 'OFFERED'), ('OFFERED', 'ACCEPTED'),
      ('REQUESTED', 'REJECTED'), ('INSPECTION_SCHEDULED', 'REJECTED'),
      ('EVALUATED', 'REJECTED'), ('OFFERED', 'REJECTED'),
      ('REQUESTED', 'CANCELLED'), ('INSPECTION_SCHEDULED', 'CANCELLED')
    )
    when 'DELIVERY' then (upper(current_status), upper(next_status)) in (
      ('PLANNING', 'CHECKLIST_PENDING'), ('CHECKLIST_PENDING', 'READY'),
      ('READY', 'SCHEDULED'), ('SCHEDULED', 'DELIVERED'),
      ('PLANNING', 'CANCELLED'), ('CHECKLIST_PENDING', 'CANCELLED'),
      ('READY', 'CANCELLED'), ('SCHEDULED', 'CANCELLED')
    )
    else false
  end;
$$;

create or replace function public.get_sales_exchange_options(
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare normalized_search text := lower(btrim(coalesce(target_search, '')));
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'INVALID_EXCHANGE_OPTION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
    or not app_private.has_permission(current_organization_id, 'exchange.request')
  then
    raise exception using errcode = '42501', message = 'EXCHANGE_REQUEST_PERMISSION_REQUIRED';
  end if;

  select coalesce(jsonb_agg(option_row.data order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
    select
      greatest(booking_row.updated_at, coalesce(case_row.updated_at, booking_row.updated_at)) as updated_at,
      jsonb_build_object(
        'booking_id', booking_row.id,
        'booking_number', booking_row.booking_number,
        'branch_id', booking_row.branch_id,
        'branch_name', branch_row.name,
        'customer_id', customer_row.id,
        'customer_name', customer_row.full_name,
        'phone', customer_row.primary_phone,
        'email', customer_row.primary_email,
        'consultant_name', consultant_row.full_name,
        'case_id', case_row.id,
        'case_status', case_row.status,
        'case_version', case_row.version,
        'vehicle_id', case_row.vehicle_id,
        'fuel_type', case_row.fuel_type,
        'ownership', case_row.ownership,
        'odometer_km', case_row.odometer_km,
        'customer_expected_value', case_row.customer_expected_value,
        'estimated_value', case_row.estimated_value,
        'accepted_value', case_row.accepted_value,
        'notes', case_row.notes,
        'created_at', case_row.created_at,
        'updated_at', case_row.updated_at,
        'address', (
          select address_row.address
          from public.customer_addresses address_row
          where address_row.organization_id = customer_row.organization_id
            and address_row.customer_id = customer_row.id
          order by (address_row.address_type = 'HOME') desc, address_row.created_at desc
          limit 1
        ),
        'vehicles', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', vehicle_row.id,
            'registration', vehicle_row.registration,
            'brand', vehicle_row.brand,
            'model', vehicle_row.model,
            'variant', vehicle_row.variant,
            'model_year', vehicle_row.model_year
          ) order by vehicle_row.created_at desc, vehicle_row.id)
          from public.customer_vehicles vehicle_row
          where vehicle_row.organization_id = customer_row.organization_id
            and vehicle_row.customer_id = customer_row.id
        ), '[]'::jsonb),
        'evaluation', (
          select jsonb_build_object(
            'evaluator_name', evaluator_row.full_name,
            'inspection', evaluation_row.inspection,
            'quoted_value', evaluation_row.quoted_value,
            'created_at', evaluation_row.created_at
          )
          from public.exchange_evaluations evaluation_row
          left join public.profiles evaluator_row
            on evaluator_row.organization_id = evaluation_row.organization_id
           and evaluator_row.id = evaluation_row.evaluator_id
          where evaluation_row.organization_id = case_row.organization_id
            and evaluation_row.exchange_case_id = case_row.id
          order by evaluation_row.created_at desc, evaluation_row.id desc
          limit 1
        ),
        'documents', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', file_row.id,
            'file_name', file_row.file_name,
            'mime_type', file_row.mime_type,
            'size_bytes', file_row.size_bytes,
            'created_at', file_row.created_at
          ) order by file_row.created_at desc, file_row.id)
          from public.object_files file_row
          where file_row.organization_id = case_row.organization_id
            and file_row.resource_type = 'exchange_case'
            and file_row.resource_id = case_row.id
            and file_row.deleted_at is null
        ), '[]'::jsonb)
      ) as data
    from public.bookings booking_row
    join public.customers customer_row
      on customer_row.organization_id = booking_row.organization_id
     and customer_row.id = booking_row.customer_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.organization_id = booking_row.organization_id
     and branch_row.id = booking_row.branch_id
     and branch_row.deleted_at is null
    left join public.profiles consultant_row
      on consultant_row.organization_id = booking_row.organization_id
     and consultant_row.id = booking_row.assigned_user_id
    left join lateral (
      select exchange_row.*
      from public.exchange_cases exchange_row
      where exchange_row.organization_id = booking_row.organization_id
        and exchange_row.booking_id = booking_row.id
        and exchange_row.deleted_at is null
      order by exchange_row.updated_at desc, exchange_row.id desc
      limit 1
    ) case_row on true
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.exchange_required
      and booking_row.status in (
        'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED', 'READY_FOR_DELIVERY'
      )
      and booking_row.assigned_user_id = auth.uid()
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
      and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id)
      and (
        normalized_search = ''
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and position(
            app_private.normalize_phone_digits(normalized_search)
            in app_private.normalize_phone_digits(customer_row.primary_phone)
          ) > 0
        )
      )
    order by greatest(booking_row.updated_at, coalesce(case_row.updated_at, booking_row.updated_at)) desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.save_sales_exchange_request(
  target_booking_id uuid,
  target_case_id uuid,
  expected_version bigint,
  target_vehicle_id uuid,
  target_registration text,
  target_brand text,
  target_model text,
  target_variant text,
  target_model_year integer,
  target_fuel_type text,
  target_ownership text,
  target_odometer_km integer,
  target_customer_expected_value numeric,
  target_notes text,
  target_action text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare booking_row public.bookings%rowtype;
declare case_row public.exchange_cases%rowtype;
declare normalized_action text := upper(btrim(coalesce(target_action, '')));
declare normalized_reg text := nullif(upper(btrim(coalesce(target_registration, ''))), '');
declare normalized_brand text := nullif(btrim(coalesce(target_brand, '')), '');
declare normalized_model text := nullif(btrim(coalesce(target_model, '')), '');
declare normalized_variant text := nullif(btrim(coalesce(target_variant, '')), '');
declare normalized_fuel text := nullif(btrim(coalesce(target_fuel_type, '')), '');
declare normalized_ownership text := nullif(btrim(coalesce(target_ownership, '')), '');
declare normalized_notes text := nullif(btrim(coalesce(target_notes, '')), '');
declare effective_vehicle_id uuid;
declare effective_status text;
declare result jsonb;
declare fingerprint text;
declare replay_result jsonb;
declare case_exists boolean := false;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_booking_id is null or target_request_id is null
    or normalized_action not in ('SAVE_DRAFT', 'REQUEST_EVALUATION', 'ACCEPT_OFFER')
    or char_length(coalesce(normalized_reg, '')) > 24
    or char_length(coalesce(normalized_brand, '')) > 100
    or char_length(coalesce(normalized_model, '')) > 100
    or char_length(coalesce(normalized_variant, '')) > 120
    or char_length(coalesce(normalized_notes, '')) > 4000
    or (target_model_year is not null and target_model_year not between 1950 and 2100)
    or (target_odometer_km is not null and target_odometer_km not between 0 and 5000000)
    or (target_customer_expected_value is not null
      and target_customer_expected_value not between 0 and 10000000000)
  then
    raise exception using errcode = '22023', message = 'INVALID_SALES_EXCHANGE_REQUEST';
  end if;
  if normalized_action in ('REQUEST_EVALUATION', 'ACCEPT_OFFER') and (
    normalized_reg is null or normalized_brand is null or normalized_model is null
    or normalized_fuel is null or normalized_ownership is null
    or target_odometer_km is null or target_customer_expected_value is null
  ) then
    raise exception using errcode = '22023', message = 'EXCHANGE_REQUIRED_FIELDS_MISSING';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
    or not app_private.has_permission(current_organization_id, 'exchange.request')
  then
    raise exception using errcode = '42501', message = 'EXCHANGE_REQUEST_PERMISSION_REQUIRED';
  end if;

  fingerprint := app_private.operational_case_request_fingerprint(jsonb_build_object(
    'booking_id', target_booking_id, 'case_id', target_case_id,
    'expected_version', expected_version, 'vehicle_id', target_vehicle_id,
    'registration', normalized_reg, 'brand', normalized_brand,
    'model', normalized_model, 'variant', normalized_variant, 'model_year', target_model_year,
    'fuel_type', normalized_fuel, 'ownership', normalized_ownership,
    'odometer_km', target_odometer_km,
    'customer_expected_value', target_customer_expected_value,
    'notes', normalized_notes, 'action', normalized_action
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_operational_case_request(
    current_organization_id, 'case.sales_exchange.saved', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':sales-exchange:' || target_booking_id::text, 0
  ));

  select * into booking_row
  from public.bookings source_row
  where source_row.organization_id = current_organization_id
    and source_row.id = target_booking_id
    and source_row.deleted_at is null
    and source_row.exchange_required
    and source_row.assigned_user_id = auth.uid()
    and source_row.status in (
      'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED', 'READY_FOR_DELIVERY'
    )
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'EXCHANGE_BOOKING_NOT_FOUND';
  end if;
  if not app_private.can_access_record(
    booking_row.organization_id, booking_row.branch_id,
    booking_row.team_id, booking_row.assigned_user_id
  ) or not app_private.can_access_customer(
    booking_row.organization_id, booking_row.customer_id
  ) then
    raise exception using errcode = '42501', message = 'EXCHANGE_REQUEST_SCOPE_DENIED';
  end if;

  select * into case_row
  from public.exchange_cases source_row
  where source_row.organization_id = current_organization_id
    and source_row.booking_id = target_booking_id
    and source_row.deleted_at is null
    and (target_case_id is null or source_row.id = target_case_id)
  order by source_row.updated_at desc, source_row.id desc
  limit 1
  for update;
  case_exists := found;
  if target_case_id is not null and not case_exists then
    raise exception using errcode = 'P0002', message = 'EXCHANGE_CASE_NOT_FOUND';
  end if;
  if case_exists and case_row.assigned_user_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'EXCHANGE_REQUEST_OWNER_REQUIRED';
  end if;
  if case_exists and (expected_version is null or case_row.version <> expected_version) then
    raise exception using errcode = '40001', message = 'OPERATIONAL_CASE_VERSION_CONFLICT';
  end if;

  if target_vehicle_id is not null then
    select vehicle_row.id into effective_vehicle_id
    from public.customer_vehicles vehicle_row
    where vehicle_row.organization_id = current_organization_id
      and vehicle_row.customer_id = booking_row.customer_id
      and vehicle_row.id = target_vehicle_id
    for update;
    if effective_vehicle_id is null then
      raise exception using errcode = '23514', message = 'EXCHANGE_VEHICLE_MISMATCH';
    end if;
    update public.customer_vehicles set
      registration = coalesce(normalized_reg, registration),
      normalized_registration = case when normalized_reg is null then customer_vehicles.normalized_registration
        else app_private.normalize_inventory_identifier(normalized_reg) end,
      brand = coalesce(normalized_brand, brand), model = coalesce(normalized_model, model),
      variant = coalesce(normalized_variant, variant), model_year = coalesce(target_model_year, model_year)
    where organization_id = current_organization_id and id = effective_vehicle_id;
  elsif normalized_reg is not null or normalized_brand is not null or normalized_model is not null then
    insert into public.customer_vehicles (
      organization_id, customer_id, registration, normalized_registration,
      brand, model, variant, model_year
    ) values (
      current_organization_id, booking_row.customer_id, normalized_reg,
      case when normalized_reg is null then null
        else app_private.normalize_inventory_identifier(normalized_reg) end,
      normalized_brand, normalized_model, normalized_variant, target_model_year
    ) returning id into effective_vehicle_id;
  end if;

  if not case_exists then
    effective_status := case when normalized_action = 'SAVE_DRAFT' then 'DRAFT' else 'REQUESTED' end;
    if normalized_action = 'ACCEPT_OFFER' then
      raise exception using errcode = '23514', message = 'EXCHANGE_OFFER_NOT_READY';
    end if;
    insert into public.exchange_cases (
      organization_id, branch_id, booking_id, customer_id, assigned_user_id,
      status, vehicle_id, priority, notes, created_by, fuel_type, ownership,
      odometer_km, customer_expected_value
    ) values (
      current_organization_id, booking_row.branch_id, booking_row.id,
      booking_row.customer_id, auth.uid(), effective_status, effective_vehicle_id,
      'NORMAL', normalized_notes, auth.uid(), normalized_fuel, normalized_ownership,
      target_odometer_km, target_customer_expected_value
    ) returning * into case_row;
  else
    if normalized_action = 'SAVE_DRAFT' and case_row.status <> 'DRAFT' then
      raise exception using errcode = '23514', message = 'EXCHANGE_DRAFT_LOCKED_AFTER_REQUEST';
    elsif normalized_action = 'REQUEST_EVALUATION' and case_row.status not in ('DRAFT', 'REQUESTED') then
      raise exception using errcode = '23514', message = 'EXCHANGE_EVALUATION_ALREADY_IN_PROGRESS';
    elsif normalized_action = 'ACCEPT_OFFER' and case_row.status <> 'OFFERED' then
      raise exception using errcode = '23514', message = 'EXCHANGE_OFFER_NOT_READY';
    end if;
    effective_status := case normalized_action
      when 'SAVE_DRAFT' then 'DRAFT'
      when 'REQUEST_EVALUATION' then 'REQUESTED'
      else 'ACCEPTED'
    end;
    update public.exchange_cases set
      status = effective_status,
      vehicle_id = coalesce(effective_vehicle_id, vehicle_id),
      fuel_type = coalesce(normalized_fuel, fuel_type),
      ownership = coalesce(normalized_ownership, ownership),
      odometer_km = coalesce(target_odometer_km, odometer_km),
      customer_expected_value = coalesce(target_customer_expected_value, customer_expected_value),
      accepted_value = case when effective_status = 'ACCEPTED'
        then coalesce(accepted_value, estimated_value) else accepted_value end,
      notes = normalized_notes,
      version = version + 1,
      updated_at = now()
    where organization_id = current_organization_id and id = case_row.id
    returning * into case_row;
  end if;

  result := jsonb_build_object(
    'id', case_row.id, 'department', 'EXCHANGE', 'status', case_row.status,
    'version', case_row.version, 'assigned_user_id', case_row.assigned_user_id,
    'replayed', false
  );
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, booking_row.customer_id, booking_row.lead_id,
    case when normalized_action = 'SAVE_DRAFT' then 'EXCHANGE_DRAFT_SAVED'
      when normalized_action = 'REQUEST_EVALUATION' then 'EXCHANGE_EVALUATION_REQUESTED'
      else 'EXCHANGE_OFFER_ACCEPTED' end,
    auth.uid(), jsonb_build_object('case_id', case_row.id, 'booking_id', booking_row.id)
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'case.sales_exchange.saved',
    'exchange_case', case_row.id::text, booking_row.branch_id,
    target_request_id, jsonb_build_object('fingerprint', fingerprint, 'result', result,
      'action', normalized_action)
  );
  return result;
end;
$$;

revoke all on function public.get_sales_exchange_options(text, integer) from public, anon;
grant execute on function public.get_sales_exchange_options(text, integer) to authenticated;
revoke all on function public.save_sales_exchange_request(
  uuid, uuid, bigint, uuid, text, text, text, text, integer, text, text,
  integer, numeric, text, text, uuid
) from public, anon;
grant execute on function public.save_sales_exchange_request(
  uuid, uuid, bigint, uuid, text, text, text, text, integer, text, text,
  integer, numeric, text, text, uuid
) to authenticated;

alter table public.exchange_cases validate constraint exchange_cases_workflow_check;
