begin;

create or replace function app_private.normalize_phone_digits(input_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(coalesce(input_value, ''), '[^0-9]', '', 'g');
$$;
revoke all on function app_private.normalize_phone_digits(text)
  from public, anon;
-- Leads can still be inserted by scoped browser sessions. PostgreSQL may need to
-- evaluate this immutable helper while maintaining the expression index, so the
-- minimum execution privilege is retained without exposing the private schema.
grant execute on function app_private.normalize_phone_digits(text)
  to authenticated, service_role;

-- Customer remains the durable identity. Matching columns are intentionally not
-- unique because a household may legitimately share a phone number or email.
create index if not exists customers_org_updated_idx
  on public.customers (organization_id, updated_at desc, id)
  where deleted_at is null;
create index if not exists customers_org_email_idx
  on public.customers (organization_id, normalized_email)
  where deleted_at is null and normalized_email is not null;
create index if not exists customers_org_phone_digits_idx
  on public.customers (
    organization_id,
    app_private.normalize_phone_digits(normalized_phone)
  )
  where deleted_at is null and normalized_phone is not null;
create index if not exists leads_org_phone_digits_idx
  on public.leads (
    organization_id,
    app_private.normalize_phone_digits(normalized_phone)
  )
  where deleted_at is null;
create index if not exists leads_customer_updated_idx
  on public.leads (organization_id, customer_id, updated_at desc, id)
  where deleted_at is null and customer_id is not null;
create index if not exists calls_customer_started_idx
  on public.calls (organization_id, customer_id, started_at desc, id)
  where customer_id is not null;
create index if not exists conversations_customer_created_idx
  on public.conversations (organization_id, customer_id, created_at desc, id);
create index if not exists followups_customer_due_idx
  on public.followups (organization_id, customer_id, due_at desc, id)
  where customer_id is not null;
create index if not exists appointments_customer_scheduled_idx
  on public.appointments (organization_id, customer_id, scheduled_at desc, id);
create index if not exists test_drives_customer_created_idx
  on public.test_drives (organization_id, customer_id, created_at desc, id);
create index if not exists quotations_customer_updated_idx
  on public.quotations (organization_id, customer_id, updated_at desc, id);
create index if not exists bookings_customer_updated_idx
  on public.bookings (organization_id, customer_id, updated_at desc, id)
  where deleted_at is null;
create index if not exists customer_vehicles_customer_created_idx
  on public.customer_vehicles (organization_id, customer_id, created_at desc, id);
create index if not exists activities_customer_occurred_idx
  on public.activities (organization_id, customer_id, occurred_at desc, id)
  where customer_id is not null;
create unique index if not exists customer_resolution_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null
    and action in ('customer.created_and_linked', 'customer.link.reviewed');

-- Creating a customer is a reviewed lead-resolution decision, never an open
-- table insert from the browser. Child writes likewise remain behind focused RPCs.
drop policy if exists customers_insert on public.customers;
revoke insert, update on public.customers from anon, authenticated;
revoke insert, update on public.customer_contacts from anon, authenticated;
revoke insert, update on public.customer_addresses from anon, authenticated;
revoke insert, update on public.customer_vehicles from anon, authenticated;

-- Preserve the existing result contract while consistently comparing stored
-- phone digits and requiring the caller to be able to see the source lead.
create or replace function public.possible_customer_matches(target_lead_id uuid)
returns table (
  customer_id uuid,
  full_name text,
  masked_phone text,
  masked_email text,
  match_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
  lead_phone_digits text;
  lead_email_normalized text;
begin
  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(lead_row.organization_id, 'customer.view')
    or not app_private.has_permission(lead_row.organization_id, 'customer.link')
    or not app_private.can_access_record(
      lead_row.organization_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  lead_phone_digits := app_private.normalize_phone_digits(lead_row.normalized_phone);
  lead_email_normalized := nullif(lower(btrim(coalesce(lead_row.email, ''))), '');

  return query
  select
    customer_row.id,
    customer_row.full_name,
    case
      when customer_row.primary_phone is null then null
      when char_length(customer_row.primary_phone) <= 5 then repeat('•', char_length(customer_row.primary_phone))
      else left(customer_row.primary_phone, 3)
        || repeat('•', greatest(char_length(customer_row.primary_phone) - 5, 3))
        || right(customer_row.primary_phone, 2)
    end,
    case
      when customer_row.primary_email is null then null
      else left(customer_row.primary_email, 2)
        || '•••@'
        || split_part(customer_row.primary_email, '@', 2)
    end,
    case
      when app_private.normalize_phone_digits(customer_row.normalized_phone) = lead_phone_digits
        and lead_email_normalized is not null
        and customer_row.normalized_email = lead_email_normalized
        then 'PHONE_AND_EMAIL'
      when app_private.normalize_phone_digits(customer_row.normalized_phone) = lead_phone_digits
        then 'PHONE'
      else 'EMAIL'
    end
  from public.customers customer_row
  where customer_row.organization_id = lead_row.organization_id
    and customer_row.deleted_at is null
    and (
      (
        lead_phone_digits <> ''
        and app_private.normalize_phone_digits(customer_row.normalized_phone) = lead_phone_digits
      )
      or (
        lead_email_normalized is not null
        and customer_row.normalized_email = lead_email_normalized
      )
    )
  order by customer_row.updated_at desc, customer_row.id
  limit 10;
end;
$$;

revoke all on function public.possible_customer_matches(uuid) from public, anon;
grant execute on function public.possible_customer_matches(uuid) to authenticated;
-- The legacy linker did not prove that a chosen UUID was one of the reviewed
-- candidates or perform optimistic concurrency. Keep it unavailable after the
-- atomic resolution workflow is installed.
revoke all on function public.link_lead_to_customer(uuid, uuid, text)
  from public, anon, authenticated;

-- Resolves the complete possible-match decision atomically. CREATE_NEW remains
-- valid even when possible matches exist, but that explicit choice and its
-- reason are auditable. LINK_EXISTING can only target an actual exact candidate.
create or replace function public.resolve_lead_customer(
  target_lead_id uuid,
  expected_lead_updated_at timestamptz,
  resolution text,
  resolution_reason text,
  target_request_id uuid,
  target_customer_id uuid default null,
  new_customer jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
  selected_customer public.customers%rowtype;
  new_customer_id uuid;
  normalized_name text;
  phone_value text;
  phone_digits text;
  email_value text;
  possible_match_count integer := 0;
  request_fingerprint text;
  previous_resolution public.audit_logs%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if resolution not in ('LINK_EXISTING', 'CREATE_NEW') then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_RESOLUTION';
  end if;
  if char_length(btrim(coalesce(resolution_reason, ''))) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'RESOLUTION_REASON_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(new_customer, '{}'::jsonb)) <> 'object'
    or (
      select count(*) > 8
      from jsonb_object_keys(coalesce(new_customer, '{}'::jsonb)) payload_key
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_PAYLOAD';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(coalesce(new_customer, '{}'::jsonb)) payload_key
    where payload_key not in ('full_name', 'primary_phone', 'primary_email')
  ) or exists (
    select 1
    from jsonb_each(coalesce(new_customer, '{}'::jsonb)) payload_entry
    where jsonb_typeof(payload_entry.value) not in ('string', 'null')
  ) then
    raise exception using errcode = '22023', message = 'CUSTOMER_FIELD_FORBIDDEN';
  end if;

  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  request_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        jsonb_build_object(
          'lead_id', target_lead_id,
          'expected_lead_updated_at', expected_lead_updated_at,
          'resolution', resolution,
          'resolution_reason', btrim(resolution_reason),
          'target_customer_id', target_customer_id,
          'new_customer', coalesce(new_customer, '{}'::jsonb)
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
  select * into previous_resolution
  from public.audit_logs audit_row
  where audit_row.organization_id = lead_row.organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action in ('customer.created_and_linked', 'customer.link.reviewed')
  limit 1;
  if found then
    if previous_resolution.metadata->>'request_fingerprint' is distinct from request_fingerprint then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object(
      'customer_id', previous_resolution.resource_id::uuid,
      'lead_id', target_lead_id,
      'resolution', previous_resolution.metadata->>'resolution',
      'possible_match_count', coalesce((previous_resolution.metadata->>'possible_match_count')::integer, 0),
      'replayed', true
    );
  end if;
  if lead_row.customer_id is not null then
    raise exception using errcode = '23505', message = 'LEAD_ALREADY_LINKED';
  end if;
  if expected_lead_updated_at is null or lead_row.updated_at <> expected_lead_updated_at then
    raise exception using errcode = '40001', message = 'LEAD_VERSION_CONFLICT';
  end if;
  if not app_private.has_permission(lead_row.organization_id, 'customer.link')
    or not app_private.can_access_record(
      lead_row.organization_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  phone_digits := app_private.normalize_phone_digits(lead_row.normalized_phone);
  email_value := nullif(lower(btrim(coalesce(lead_row.email, ''))), '');
  select count(*) into possible_match_count
  from public.customers customer_row
  where customer_row.organization_id = lead_row.organization_id
    and customer_row.deleted_at is null
    and (
      (
        phone_digits <> ''
        and app_private.normalize_phone_digits(customer_row.normalized_phone) = phone_digits
      )
      or (email_value is not null and customer_row.normalized_email = email_value)
    );

  if resolution = 'LINK_EXISTING' then
    if target_customer_id is null then
      raise exception using errcode = '22023', message = 'CUSTOMER_ID_REQUIRED';
    end if;
    select * into selected_customer
    from public.customers customer_row
    where customer_row.id = target_customer_id
      and customer_row.organization_id = lead_row.organization_id
      and customer_row.deleted_at is null
      and (
        (
          phone_digits <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone) = phone_digits
        )
        or (email_value is not null and customer_row.normalized_email = email_value)
      );
    if not found then
      raise exception using errcode = '23503', message = 'CUSTOMER_NOT_POSSIBLE_MATCH';
    end if;
    new_customer_id := selected_customer.id;
  else
    if not app_private.has_permission(lead_row.organization_id, 'customer.create') then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    if target_customer_id is not null then
      raise exception using errcode = '22023', message = 'CUSTOMER_ID_NOT_ALLOWED';
    end if;

    normalized_name := btrim(coalesce(nullif(new_customer->>'full_name', ''), lead_row.customer_name));
    phone_value := btrim(coalesce(nullif(new_customer->>'primary_phone', ''), lead_row.phone));
    phone_digits := app_private.normalize_phone_digits(phone_value);
    email_value := nullif(lower(btrim(coalesce(nullif(new_customer->>'primary_email', ''), lead_row.email))), '');
    if char_length(normalized_name) not between 2 and 160 then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_NAME';
    end if;
    if char_length(phone_value) > 24
      or phone_value !~ '^[0-9+(). -]+$'
      or phone_digits !~ '^[0-9]{7,15}$'
    then
      raise exception using errcode = '22023', message = 'INVALID_PHONE';
    end if;
    if email_value is not null and (
      char_length(email_value) > 254
      or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ) then
      raise exception using errcode = '22023', message = 'INVALID_EMAIL';
    end if;

    insert into public.customers (
      organization_id,
      full_name,
      primary_phone,
      normalized_phone,
      primary_email,
      created_by
    ) values (
      lead_row.organization_id,
      normalized_name,
      phone_value,
      phone_digits,
      email_value,
      auth.uid()
    ) returning id into new_customer_id;

    insert into public.customer_contacts (
      organization_id, customer_id, type, value, normalized_value, is_primary
    ) values (
      lead_row.organization_id, new_customer_id, 'PHONE', phone_value, phone_digits, true
    );
    if email_value is not null then
      insert into public.customer_contacts (
        organization_id, customer_id, type, value, normalized_value, is_primary
      ) values (
        lead_row.organization_id, new_customer_id, 'EMAIL', email_value, email_value, true
      );
    end if;
  end if;

  perform set_config('app.link_customer_rpc', 'on', true);
  update public.leads
  set customer_id = new_customer_id, updated_at = now()
  where id = lead_row.id;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    lead_row.organization_id,
    new_customer_id,
    lead_row.id,
    case when resolution = 'CREATE_NEW' then 'CUSTOMER_CREATED_AND_LINKED' else 'CUSTOMER_LINKED' end,
    auth.uid(),
    jsonb_build_object('resolution', resolution)
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    lead_row.organization_id,
    auth.uid(),
    case when resolution = 'CREATE_NEW' then 'customer.created_and_linked' else 'customer.link.reviewed' end,
    'customer',
    new_customer_id::text,
    lead_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'lead_id', lead_row.id,
      'resolution', resolution,
      'reason', btrim(resolution_reason),
      'possible_match_count', possible_match_count,
      'request_fingerprint', request_fingerprint
    )
  );

  return jsonb_build_object(
    'customer_id', new_customer_id,
    'lead_id', lead_row.id,
    'resolution', resolution,
    'possible_match_count', possible_match_count,
    'replayed', false
  );
end;
$$;

revoke all on function public.resolve_lead_customer(uuid, timestamptz, text, text, uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.resolve_lead_customer(uuid, timestamptz, text, text, uuid, uuid, jsonb)
  to authenticated;

create or replace function public.get_customer_workspace_page(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'updated:desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  lead_access boolean;
  booking_access boolean;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if target_sort not in ('updated:desc', 'updated:asc', 'created:desc', 'created:asc', 'name:asc', 'name:desc') then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_SORT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.organization_id is not null
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  lead_access := app_private.has_permission(current_organization_id, 'lead.view');
  booking_access := app_private.has_permission(current_organization_id, 'booking.view')
    or app_private.has_permission(current_organization_id, 'booking.manage');

  with authorized_customers as materialized (
    select customer_row.*
    from public.customers customer_row
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and app_private.can_access_customer(customer_row.organization_id, customer_row.id)
      and (
        normalized_search = ''
        or customer_row.id = search_uuid
        or customer_row.normalized_name ilike '%' || normalized_search || '%'
        or customer_row.normalized_email = normalized_search
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone)
            = search_phone_digits
        )
      )
  ), accessible_leads as materialized (
    select
      lead_row.id,
      lead_row.customer_id,
      lead_row.lifecycle_status,
      lead_row.interested_model,
      lead_row.updated_at,
      branch_row.name as branch_name,
      profile_row.full_name as assigned_user_name
    from public.leads lead_row
    join authorized_customers customer_row on customer_row.id = lead_row.customer_id
    join public.branches branch_row
      on branch_row.id = lead_row.branch_id
     and branch_row.organization_id = lead_row.organization_id
    left join public.profiles profile_row
      on profile_row.id = lead_row.assigned_user_id
     and profile_row.organization_id = lead_row.organization_id
    where lead_access
      and lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and app_private.can_access_record(
        lead_row.organization_id,
        lead_row.branch_id,
        lead_row.team_id,
        lead_row.assigned_user_id
      )
  ), latest_leads as (
    select distinct on (lead_row.customer_id)
      lead_row.customer_id,
      lead_row.id,
      lead_row.lifecycle_status,
      lead_row.interested_model,
      lead_row.updated_at,
      lead_row.branch_name,
      lead_row.assigned_user_name
    from accessible_leads lead_row
    order by lead_row.customer_id, lead_row.updated_at desc, lead_row.id
  ), lead_counts as (
    select
      lead_row.customer_id,
      count(*) as lead_count,
      count(*) filter (where lead_row.lifecycle_status <> 'Lost') as active_lead_count
    from accessible_leads lead_row
    group by lead_row.customer_id
  ), accessible_bookings as materialized (
    select booking_row.customer_id, booking_row.updated_at
    from public.bookings booking_row
    join authorized_customers customer_row on customer_row.id = booking_row.customer_id
    where booking_access
      and booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and app_private.can_access_record(
        booking_row.organization_id,
        booking_row.branch_id,
        booking_row.team_id,
        booking_row.assigned_user_id
      )
  ), booking_counts as (
    select
      booking_row.customer_id,
      count(*) as booking_count,
      max(booking_row.updated_at) as updated_at
    from accessible_bookings booking_row
    group by booking_row.customer_id
  ), vehicle_counts as (
    select vehicle_row.customer_id, count(*) as vehicle_count
    from public.customer_vehicles vehicle_row
    join authorized_customers customer_row on customer_row.id = vehicle_row.customer_id
    where vehicle_row.organization_id = current_organization_id
    group by vehicle_row.customer_id
  ), enriched_customers as materialized (
    select
      customer_row.id,
      customer_row.full_name,
      customer_row.primary_phone,
      customer_row.primary_email,
      customer_row.created_at,
      customer_row.updated_at,
      greatest(
        customer_row.updated_at,
        coalesce(latest_lead.updated_at, '-infinity'::timestamptz),
        coalesce(booking_summary.updated_at, '-infinity'::timestamptz)
      ) as last_activity_at,
      latest_lead.id as current_lead_id,
      latest_lead.lifecycle_status::text as current_lead_status,
      latest_lead.interested_model,
      latest_lead.branch_name,
      latest_lead.assigned_user_name,
      coalesce(lead_summary.lead_count, 0)::integer as lead_count,
      coalesce(lead_summary.active_lead_count, 0)::integer as active_lead_count,
      coalesce(booking_summary.booking_count, 0)::integer as booking_count,
      coalesce(vehicle_summary.vehicle_count, 0)::integer as vehicle_count
    from authorized_customers customer_row
    left join latest_leads latest_lead on latest_lead.customer_id = customer_row.id
    left join lead_counts lead_summary on lead_summary.customer_id = customer_row.id
    left join booking_counts booking_summary on booking_summary.customer_id = customer_row.id
    left join vehicle_counts vehicle_summary on vehicle_summary.customer_id = customer_row.id
  ), page_rows as (
    select *
    from enriched_customers
    order by
      case when target_sort = 'updated:desc' then last_activity_at end desc nulls last,
      case when target_sort = 'updated:asc' then last_activity_at end asc nulls last,
      case when target_sort = 'created:desc' then created_at end desc,
      case when target_sort = 'created:asc' then created_at end asc,
      case when target_sort = 'name:asc' then lower(full_name) end asc,
      case when target_sort = 'name:desc' then lower(full_name) end desc,
      id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'full_name', page_row.full_name,
            'primary_phone', page_row.primary_phone,
            'primary_email', page_row.primary_email,
            'created_at', page_row.created_at,
            'last_activity_at', page_row.last_activity_at,
            'current_lead_id', page_row.current_lead_id,
            'current_lead_status', page_row.current_lead_status,
            'interested_model', page_row.interested_model,
            'branch_name', page_row.branch_name,
            'assigned_user_name', page_row.assigned_user_name,
            'lead_count', page_row.lead_count,
            'booking_count', page_row.booking_count,
            'vehicle_count', page_row.vehicle_count
          ) order by
            case when target_sort = 'updated:desc' then page_row.last_activity_at end desc nulls last,
            case when target_sort = 'updated:asc' then page_row.last_activity_at end asc nulls last,
            case when target_sort = 'created:desc' then page_row.created_at end desc,
            case when target_sort = 'created:asc' then page_row.created_at end asc,
            case when target_sort = 'name:asc' then lower(page_row.full_name) end asc,
            case when target_sort = 'name:desc' then lower(page_row.full_name) end desc,
            page_row.id asc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    'total', (select count(*) from enriched_customers),
    'kpis', jsonb_build_object(
      'customers', (select count(*) from enriched_customers),
      'active_opportunities', (select coalesce(sum(active_lead_count), 0) from enriched_customers),
      'customers_with_bookings', (select count(*) from enriched_customers where booking_count > 0),
      'vehicles', (select coalesce(sum(vehicle_count), 0) from enriched_customers)
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_customer_workspace_page(text, integer, integer, text)
  from public, anon;
grant execute on function public.get_customer_workspace_page(text, integer, integer, text)
  to authenticated;

create or replace function public.get_customer_360(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  customer_row public.customers%rowtype;
  lead_access boolean;
  call_access boolean;
  message_access boolean;
  test_drive_access boolean;
  quotation_access boolean;
  booking_access boolean;
  document_access boolean;
  current_opportunity jsonb := null;
  contacts_data jsonb := '[]'::jsonb;
  addresses_data jsonb := '[]'::jsonb;
  vehicles_data jsonb := '[]'::jsonb;
  custom_fields_data jsonb := '[]'::jsonb;
  leads_data jsonb := '[]'::jsonb;
  calls_data jsonb := '[]'::jsonb;
  conversations_data jsonb := '[]'::jsonb;
  followups_data jsonb := '[]'::jsonb;
  appointments_data jsonb := '[]'::jsonb;
  test_drives_data jsonb := '[]'::jsonb;
  quotations_data jsonb := '[]'::jsonb;
  bookings_data jsonb := '[]'::jsonb;
  documents_data jsonb := '[]'::jsonb;
  notes_data jsonb := '[]'::jsonb;
  timeline_data jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into customer_row
  from public.customers
  where id = target_customer_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;
  if not app_private.has_permission(customer_row.organization_id, 'customer.view')
    or not app_private.can_access_customer(customer_row.organization_id, customer_row.id)
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  lead_access := app_private.has_permission(customer_row.organization_id, 'lead.view');
  call_access := app_private.has_permission(customer_row.organization_id, 'call.view');
  message_access := app_private.has_permission(customer_row.organization_id, 'message.view');
  test_drive_access := app_private.has_permission(customer_row.organization_id, 'test_drive.manage');
  quotation_access := app_private.has_permission(customer_row.organization_id, 'quotation.view')
    or app_private.has_permission(customer_row.organization_id, 'quotation.manage');
  booking_access := app_private.has_permission(customer_row.organization_id, 'booking.view')
    or app_private.has_permission(customer_row.organization_id, 'booking.manage');
  document_access := app_private.has_permission(customer_row.organization_id, 'document.download');

  select coalesce(jsonb_agg(item.data order by item.is_primary desc, item.created_at, item.id), '[]'::jsonb)
    into contacts_data
  from (
    select
      contact_row.id,
      contact_row.is_primary,
      contact_row.created_at,
      jsonb_build_object(
        'id', contact_row.id,
        'type', contact_row.type,
        'value', contact_row.value,
        'is_primary', contact_row.is_primary
      ) as data
    from public.customer_contacts contact_row
    where contact_row.organization_id = customer_row.organization_id
      and contact_row.customer_id = customer_row.id
  ) item;

  select coalesce(jsonb_agg(item.data order by item.created_at, item.id), '[]'::jsonb)
    into addresses_data
  from (
    select
      address_row.id,
      address_row.created_at,
      jsonb_build_object(
        'id', address_row.id,
        'address_type', address_row.address_type,
        'address', case
          when jsonb_typeof(address_row.address) = 'object' then address_row.address
          else '{}'::jsonb
        end
      ) as data
    from public.customer_addresses address_row
    where address_row.organization_id = customer_row.organization_id
      and address_row.customer_id = customer_row.id
  ) item;

  select coalesce(jsonb_agg(item.data order by item.created_at desc, item.id), '[]'::jsonb)
    into vehicles_data
  from (
    select
      vehicle_row.id,
      vehicle_row.created_at,
      jsonb_build_object(
        'id', vehicle_row.id,
        'registration', vehicle_row.registration,
        'brand', vehicle_row.brand,
        'model', vehicle_row.model,
        'variant', vehicle_row.variant,
        'model_year', vehicle_row.model_year,
        'created_at', vehicle_row.created_at
      ) as data
    from public.customer_vehicles vehicle_row
    where vehicle_row.organization_id = customer_row.organization_id
      and vehicle_row.customer_id = customer_row.id
    order by vehicle_row.created_at desc, vehicle_row.id
    limit 50
  ) item;

  select coalesce(jsonb_agg(item.data order by item.label, item.id), '[]'::jsonb)
    into custom_fields_data
  from (
    select
      definition_row.id,
      definition_row.label,
      jsonb_build_object(
        'definition_id', definition_row.id,
        'field_key', definition_row.field_key,
        'label', definition_row.label,
        'field_type', definition_row.field_type,
        'value', value_row.value
      ) as data
    from public.custom_field_definitions definition_row
    left join public.custom_field_values value_row
      on value_row.definition_id = definition_row.id
     and value_row.organization_id = definition_row.organization_id
     and upper(value_row.resource_type) = 'CUSTOMER'
     and value_row.resource_id = customer_row.id
    where definition_row.organization_id = customer_row.organization_id
      and upper(definition_row.module) = 'CUSTOMERS'
      and definition_row.active
      and value_row.id is not null
  ) item;

  if lead_access then
    select item.data into current_opportunity
    from (
      select
        lead_row.updated_at,
        lead_row.id,
        jsonb_build_object(
          'id', lead_row.id,
          'source', lead_row.source,
          'source_detail', lead_row.source_detail,
          'campaign', lead_row.campaign,
          'interested_model', lead_row.interested_model,
          'lifecycle_status', lead_row.lifecycle_status,
          'temperature', lead_row.temperature,
          'work_state', case
            when lead_row.first_contacted_at is null
              and lead_row.sla_due_at is not null
              and now() > lead_row.sla_due_at then 'SLA_RISK'
            when lead_row.first_contacted_at is null
              and now() >= lead_row.created_at + interval '24 hours' then 'PENDING'
            when lead_row.first_contacted_at is null then 'NEW_TODAY'
            else null
          end,
          'branch_name', branch_row.name,
          'team_name', team_row.name,
          'assigned_user_id', lead_row.assigned_user_id,
          'assigned_user_name', profile_row.full_name,
          'created_at', lead_row.created_at,
          'updated_at', lead_row.updated_at
        ) as data
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
      left join public.teams team_row
        on team_row.id = lead_row.team_id
       and team_row.organization_id = lead_row.organization_id
      left join public.profiles profile_row
        on profile_row.id = lead_row.assigned_user_id
       and profile_row.organization_id = lead_row.organization_id
      where lead_row.organization_id = customer_row.organization_id
        and lead_row.customer_id = customer_row.id
        and lead_row.deleted_at is null
        and app_private.can_access_record(
          lead_row.organization_id,
          lead_row.branch_id,
          lead_row.team_id,
          lead_row.assigned_user_id
        )
      order by lead_row.updated_at desc, lead_row.id
      limit 1
    ) item;

    select coalesce(jsonb_agg(item.data order by item.updated_at desc, item.id), '[]'::jsonb)
      into leads_data
    from (
      select
        lead_row.id,
        lead_row.updated_at,
        jsonb_build_object(
          'id', lead_row.id,
          'source', lead_row.source,
          'source_detail', lead_row.source_detail,
          'campaign', lead_row.campaign,
          'interested_model', lead_row.interested_model,
          'lifecycle_status', lead_row.lifecycle_status,
          'temperature', lead_row.temperature,
          'branch_name', branch_row.name,
          'assigned_user_name', profile_row.full_name,
          'created_at', lead_row.created_at,
          'updated_at', lead_row.updated_at
        ) as data
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
      left join public.profiles profile_row
        on profile_row.id = lead_row.assigned_user_id
       and profile_row.organization_id = lead_row.organization_id
      where lead_row.organization_id = customer_row.organization_id
        and lead_row.customer_id = customer_row.id
        and lead_row.deleted_at is null
        and app_private.can_access_record(
          lead_row.organization_id,
          lead_row.branch_id,
          lead_row.team_id,
          lead_row.assigned_user_id
        )
      order by lead_row.updated_at desc, lead_row.id
      limit 100
    ) item;

    select coalesce(jsonb_agg(item.data order by item.due_at desc, item.id), '[]'::jsonb)
      into followups_data
    from (
      select
        followup_row.id,
        followup_row.due_at,
        jsonb_build_object(
          'id', followup_row.id,
          'lead_id', followup_row.lead_id,
          'reason', followup_row.reason,
          'due_at', followup_row.due_at,
          'status', followup_row.status,
          'completed_at', followup_row.completed_at,
          'assigned_user_name', profile_row.full_name
        ) as data
      from public.followups followup_row
      left join public.profiles profile_row
        on profile_row.id = followup_row.assigned_user_id
       and profile_row.organization_id = followup_row.organization_id
      where followup_row.organization_id = customer_row.organization_id
        and followup_row.customer_id = customer_row.id
        and app_private.can_access_record(
          followup_row.organization_id,
          followup_row.branch_id,
          followup_row.team_id,
          followup_row.assigned_user_id
        )
        and (followup_row.lead_id is null or app_private.can_access_lead(followup_row.lead_id))
      order by followup_row.due_at desc, followup_row.id
      limit 100
    ) item;
  end if;

  select coalesce(jsonb_agg(item.data order by item.scheduled_at desc, item.id), '[]'::jsonb)
    into appointments_data
  from (
    select
      appointment_row.id,
      appointment_row.scheduled_at,
      jsonb_build_object(
        'id', appointment_row.id,
        'lead_id', appointment_row.lead_id,
        'appointment_type', appointment_row.appointment_type,
        'scheduled_at', appointment_row.scheduled_at,
        'status', appointment_row.status,
        'attendance_status', appointment_row.attendance_status,
        'assigned_user_name', profile_row.full_name,
        'branch_name', branch_row.name
      ) as data
    from public.appointments appointment_row
    join public.branches branch_row
      on branch_row.id = appointment_row.branch_id
     and branch_row.organization_id = appointment_row.organization_id
    left join public.profiles profile_row
      on profile_row.id = appointment_row.assigned_user_id
     and profile_row.organization_id = appointment_row.organization_id
    where appointment_row.organization_id = customer_row.organization_id
      and appointment_row.customer_id = customer_row.id
      and app_private.can_access_record(
        appointment_row.organization_id,
        appointment_row.branch_id,
        appointment_row.team_id,
        appointment_row.assigned_user_id
      )
      and (
        appointment_row.lead_id is null
        or (lead_access and app_private.can_access_lead(appointment_row.lead_id))
      )
    order by appointment_row.scheduled_at desc, appointment_row.id
    limit 100
  ) item;

  if call_access then
    select coalesce(jsonb_agg(item.data order by item.started_at desc, item.id), '[]'::jsonb)
      into calls_data
    from (
      select
        call_row.id,
        call_row.started_at,
        jsonb_build_object(
          'id', call_row.id,
          'lead_id', call_row.lead_id,
          'direction', call_row.direction,
          'call_source', call_row.call_source,
          'started_at', call_row.started_at,
          'ended_at', call_row.ended_at,
          'duration_seconds', call_row.duration_seconds,
          'outcome', call_row.outcome,
          'status', call_row.status,
          'assigned_user_name', profile_row.full_name,
          'recording_status', recording_row.status,
          'transcript_status', transcript_row.status
        ) as data
      from public.calls call_row
      left join public.profiles profile_row
        on profile_row.id = call_row.assigned_user_id
       and profile_row.organization_id = call_row.organization_id
      left join lateral (
        select recording_source.status
        from public.call_recordings recording_source
        where recording_source.organization_id = call_row.organization_id
          and recording_source.call_id = call_row.id
        order by recording_source.created_at desc, recording_source.id
        limit 1
      ) recording_row on true
      left join lateral (
        select transcript_source.status
        from public.call_transcripts transcript_source
        where transcript_source.organization_id = call_row.organization_id
          and transcript_source.call_id = call_row.id
        order by transcript_source.created_at desc, transcript_source.id
        limit 1
      ) transcript_row on true
      where call_row.organization_id = customer_row.organization_id
        and call_row.customer_id = customer_row.id
        and app_private.can_access_call(call_row.organization_id, call_row.id)
      order by call_row.started_at desc, call_row.id
      limit 100
    ) item;
  end if;

  if message_access then
    select coalesce(jsonb_agg(item.data order by item.created_at desc, item.id), '[]'::jsonb)
      into conversations_data
    from (
      select
        conversation_row.id,
        conversation_row.created_at,
        jsonb_build_object(
          'id', conversation_row.id,
          'lead_id', conversation_row.lead_id,
          'channel', conversation_row.channel,
          'status', conversation_row.status,
          'assigned_user_name', profile_row.full_name,
          'message_count', message_summary.message_count,
          'latest_message_at', message_summary.latest_message_at,
          'created_at', conversation_row.created_at
        ) as data
      from public.conversations conversation_row
      left join public.profiles profile_row
        on profile_row.id = conversation_row.assigned_user_id
       and profile_row.organization_id = conversation_row.organization_id
      left join lateral (
        select count(*) as message_count, max(message_row.sent_at) as latest_message_at
        from public.conversation_messages message_row
        where message_row.organization_id = conversation_row.organization_id
          and message_row.conversation_id = conversation_row.id
      ) message_summary on true
      where conversation_row.organization_id = customer_row.organization_id
        and conversation_row.customer_id = customer_row.id
        and app_private.can_access_conversation(conversation_row.organization_id, conversation_row.id)
      order by conversation_row.created_at desc, conversation_row.id
      limit 50
    ) item;
  end if;

  if test_drive_access then
    select coalesce(jsonb_agg(item.data order by item.created_at desc, item.id), '[]'::jsonb)
      into test_drives_data
    from (
      select
        drive_row.id,
        drive_row.created_at,
        jsonb_build_object(
          'id', drive_row.id,
          'lead_id', drive_row.lead_id,
          'status', drive_row.status,
          'started_at', drive_row.started_at,
          'completed_at', drive_row.completed_at,
          'distance_meters', drive_row.distance_meters,
          'duration_seconds', drive_row.duration_seconds,
          'assigned_user_name', profile_row.full_name,
          'branch_name', branch_row.name
        ) as data
      from public.test_drives drive_row
      join public.branches branch_row
        on branch_row.id = drive_row.branch_id
       and branch_row.organization_id = drive_row.organization_id
      left join public.profiles profile_row
        on profile_row.id = drive_row.assigned_user_id
       and profile_row.organization_id = drive_row.organization_id
      where drive_row.organization_id = customer_row.organization_id
        and drive_row.customer_id = customer_row.id
        and app_private.can_access_test_drive(drive_row.organization_id, drive_row.id)
      order by drive_row.created_at desc, drive_row.id
      limit 50
    ) item;
  end if;

  if quotation_access then
    select coalesce(jsonb_agg(item.data order by item.updated_at desc, item.id), '[]'::jsonb)
      into quotations_data
    from (
      select
        quotation_row.id,
        quotation_row.updated_at,
        jsonb_build_object(
          'id', quotation_row.id,
          'lead_id', quotation_row.lead_id,
          'quotation_number', quotation_row.quotation_number,
          'status', quotation_row.status,
          'current_version', quotation_row.current_version,
          'total_amount', quotation_row.total_amount,
          'approval_status', quotation_row.approval_status,
          'created_at', quotation_row.created_at,
          'updated_at', quotation_row.updated_at
        ) as data
      from public.quotations quotation_row
      where quotation_row.organization_id = customer_row.organization_id
        and quotation_row.customer_id = customer_row.id
        and app_private.can_access_quotation(quotation_row.organization_id, quotation_row.id)
      order by quotation_row.updated_at desc, quotation_row.id
      limit 50
    ) item;
  end if;

  if booking_access then
    select coalesce(jsonb_agg(item.data order by item.updated_at desc, item.id), '[]'::jsonb)
      into bookings_data
    from (
      select
        booking_row.id,
        booking_row.updated_at,
        jsonb_build_object(
          'id', booking_row.id,
          'lead_id', booking_row.lead_id,
          'booking_number', booking_row.booking_number,
          'status', booking_row.status,
          'booking_amount', booking_row.booking_amount,
          'total_value', booking_row.total_value,
          'finance_required', booking_row.finance_required,
          'exchange_required', booking_row.exchange_required,
          'expected_delivery_date', booking_row.expected_delivery_date,
          'created_at', booking_row.created_at,
          'updated_at', booking_row.updated_at
        ) as data
      from public.bookings booking_row
      where booking_row.organization_id = customer_row.organization_id
        and booking_row.customer_id = customer_row.id
        and booking_row.deleted_at is null
        and app_private.can_access_booking(booking_row.organization_id, booking_row.id)
      order by booking_row.updated_at desc, booking_row.id
      limit 50
    ) item;
  end if;

  if document_access then
    select coalesce(jsonb_agg(item.data order by item.created_at desc, item.id), '[]'::jsonb)
      into documents_data
    from (
      select
        object_row.id,
        object_row.created_at,
        jsonb_build_object(
          'id', object_row.id,
          'file_name', object_row.original_file_name,
          'mime_type', object_row.mime_type,
          'size_bytes', object_row.size_bytes,
          'created_at', object_row.created_at
        ) as data
      from public.object_files object_row
      where object_row.organization_id = customer_row.organization_id
        and lower(object_row.resource_type) = 'customer'
        and object_row.resource_id = customer_row.id
        and object_row.deleted_at is null
        and (
          object_row.branch_id is null
          or app_private.can_access_branch(object_row.organization_id, object_row.branch_id)
        )
      order by object_row.created_at desc, object_row.id
      limit 100
    ) item;
  end if;

  select coalesce(jsonb_agg(item.data order by item.created_at desc, item.id), '[]'::jsonb)
    into notes_data
  from (
    select
      note_row.id,
      note_row.created_at,
      jsonb_build_object(
        'id', note_row.id,
        'body', note_row.body,
        'created_by_name', profile_row.full_name,
        'created_at', note_row.created_at
      ) as data
    from public.notes note_row
    left join public.profiles profile_row
      on profile_row.id = note_row.created_by
     and profile_row.organization_id = note_row.organization_id
    where note_row.organization_id = customer_row.organization_id
      and lower(note_row.resource_type) = 'customer'
      and note_row.resource_id = customer_row.id
      and note_row.deleted_at is null
    order by note_row.created_at desc, note_row.id
    limit 100
  ) item;

  select coalesce(jsonb_agg(item.data order by item.occurred_at desc, item.id), '[]'::jsonb)
    into timeline_data
  from (
    select
      activity_row.id,
      activity_row.occurred_at,
      jsonb_build_object(
        'id', activity_row.id,
        'lead_id', activity_row.lead_id,
        'activity_type', activity_row.activity_type,
        'actor_name', profile_row.full_name,
        'occurred_at', activity_row.occurred_at
      ) as data
    from public.activities activity_row
    left join public.profiles profile_row
      on profile_row.id = activity_row.actor_id
     and profile_row.organization_id = activity_row.organization_id
    where activity_row.organization_id = customer_row.organization_id
      and activity_row.customer_id = customer_row.id
      and (
        (
          activity_row.lead_id is null
          and activity_row.activity_type in (
            'CUSTOMER_CREATED',
            'CUSTOMER_CREATED_AND_LINKED',
            'CUSTOMER_LINKED',
            'CUSTOMER_UPDATED',
            'NOTE_ADDED'
          )
        )
        or (lead_access and app_private.can_access_lead(activity_row.lead_id))
      )
    order by activity_row.occurred_at desc, activity_row.id
    limit 200
  ) item;

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', customer_row.id,
      'full_name', customer_row.full_name,
      'primary_phone', customer_row.primary_phone,
      'primary_email', customer_row.primary_email,
      'created_at', customer_row.created_at,
      'updated_at', customer_row.updated_at
    ),
    'current_opportunity', current_opportunity,
    'section_access', jsonb_build_object(
      'overview', true,
      'leads', lead_access,
      'calls', call_access,
      'conversations', message_access,
      'followups', lead_access,
      'appointments', true,
      'test_drives', test_drive_access,
      'quotations', quotation_access,
      'bookings', booking_access,
      'vehicles', true,
      'documents', document_access,
      'notes', true,
      'timeline', true,
      'exchange', false,
      'finance', false,
      'insurance', false,
      'rto', false,
      'delivery', false,
      'customer_care', false
    ),
    'contacts', contacts_data,
    'addresses', addresses_data,
    'vehicles', vehicles_data,
    'custom_fields', custom_fields_data,
    'leads', leads_data,
    'calls', calls_data,
    'conversations', conversations_data,
    'followups', followups_data,
    'appointments', appointments_data,
    'test_drives', test_drives_data,
    'quotations', quotations_data,
    'bookings', bookings_data,
    'documents', documents_data,
    'notes', notes_data,
    'timeline', timeline_data
  );
end;
$$;

revoke all on function public.get_customer_360(uuid) from public, anon;
grant execute on function public.get_customer_360(uuid) to authenticated;

commit;
