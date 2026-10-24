begin;

-- A lead is registered to an individual or to a company. The type belongs to
-- the enquiry, not the customer: one lead still tracks one vehicle, so a
-- company that wants ten cars is ten independent leads, each marked COMPANY
-- and each carrying its own company profile and funding mode (a company
-- vehicle is commonly leased rather than bought outright or on a loan).
--
-- Lead and follow-up lists gain an Individual / Company filter. Their bodies
-- are text-patched from the deployed pg_get_functiondef output; every list
-- function gets one trailing `target_buyer_type` argument with a default, so
-- callers that do not pass it (the mobile app) keep working.

-- --- 1. Buyer type on the lead ------------------------------------------------
create type public.lead_buyer_type as enum ('INDIVIDUAL', 'COMPANY');

alter table public.leads
  add column buyer_type public.lead_buyer_type not null default 'INDIVIDUAL';

-- Company leads are the minority, so the Company filter walks this instead of
-- the whole scope. Individual is served by the existing updated_at indexes.
create index leads_org_company_updated_idx
  on public.leads (organization_id, updated_at desc, id desc)
  where deleted_at is null and buyer_type = 'COMPANY';

-- --- 2. Company profile, 1:1 with the lead ------------------------------------
create table public.lead_company_profiles (
  lead_id uuid primary key references public.leads (id),
  organization_id uuid not null references public.organizations (id),
  company_name text not null,
  company_type text,
  industry text,
  gstin text,
  pan text,
  contact_person text,
  contact_designation text,
  company_phone text,
  company_email text,
  address_line text,
  city text,
  state text,
  postal_code text,
  funding_mode text,
  lease_type text,
  lessor_name text,
  lease_tenure_months integer,
  version bigint not null default 1 check (version > 0),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_company_profiles_lead_org_fk
    foreign key (organization_id, lead_id) references public.leads (organization_id, id),
  constraint lead_company_profiles_text_check check (
    char_length(btrim(company_name)) between 2 and 160
    and coalesce(char_length(company_type), 0) <= 60
    and coalesce(char_length(industry), 0) <= 80
    and coalesce(char_length(contact_person), 0) <= 120
    and coalesce(char_length(contact_designation), 0) <= 80
    and coalesce(char_length(company_phone), 0) <= 20
    and coalesce(char_length(company_email), 0) <= 160
    and coalesce(char_length(address_line), 0) <= 240
    and coalesce(char_length(city), 0) <= 80
    and coalesce(char_length(state), 0) <= 80
    and coalesce(char_length(postal_code), 0) <= 10
    and coalesce(char_length(lessor_name), 0) <= 120
  ),
  constraint lead_company_profiles_tax_id_check check (
    (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
    and (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
  ),
  -- Lease details exist only on a leased vehicle.
  constraint lead_company_profiles_funding_check check (
    (funding_mode is null or funding_mode in ('OUTRIGHT', 'LOAN', 'LEASE'))
    and (lease_type is null or lease_type in ('OPERATING', 'FINANCE'))
    and (lease_tenure_months is null or lease_tenure_months between 1 and 120)
    and (
      funding_mode = 'LEASE'
      or (lease_type is null and lessor_name is null and lease_tenure_months is null)
    )
  )
);
create index lead_company_profiles_org_idx on public.lead_company_profiles (organization_id);

alter table public.lead_company_profiles enable row level security;
create policy lead_company_profiles_select on public.lead_company_profiles
  for select to authenticated
  using (
    app_private.has_permission(organization_id, 'lead.view')
    and app_private.can_access_lead(lead_id)
  );
revoke all on public.lead_company_profiles from anon, authenticated;
grant select on public.lead_company_profiles to authenticated;

create or replace function app_private.lead_company_json(target_lead_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'company_name', c.company_name,
    'company_type', c.company_type,
    'industry', c.industry,
    'gstin', c.gstin,
    'pan', c.pan,
    'contact_person', c.contact_person,
    'contact_designation', c.contact_designation,
    'company_phone', c.company_phone,
    'company_email', c.company_email,
    'address_line', c.address_line,
    'city', c.city,
    'state', c.state,
    'postal_code', c.postal_code,
    'funding_mode', c.funding_mode,
    'lease_type', c.lease_type,
    'lessor_name', c.lessor_name,
    'lease_tenure_months', c.lease_tenure_months,
    'version', c.version,
    'updated_at', c.updated_at
  )
  from public.lead_company_profiles c
  where c.lead_id = target_lead_id;
$$;
revoke all on function app_private.lead_company_json(uuid) from public, anon, authenticated;

-- --- 3. Register a lead as a company, or back to an individual -----------------
-- Registering back to INDIVIDUAL keeps the company profile: business data is
-- never hard-deleted, and re-registering finds the details still there.
create or replace function public.set_lead_buyer_type(
  target_lead_id uuid,
  target_buyer_type text,
  expected_version bigint,
  target_company jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
  current_row public.lead_company_profiles%rowtype;
  profile_found boolean;
  previous_metadata jsonb;
  company_name_value text;
  gstin_value text;
  pan_value text;
  funding_value text;
  lease_type_value text;
  lessor_value text;
  tenure_value integer;
  next_version bigint;
  before_json jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_lead_id is null or target_request_id is null
    or target_buyer_type is null or target_buyer_type not in ('INDIVIDUAL', 'COMPANY')
    or (target_buyer_type = 'COMPANY' and jsonb_typeof(target_company) is distinct from 'object')
  then
    raise exception using errcode = '22023', message = 'LEAD_BUYER_TYPE_INVALID';
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
    and action = 'lead.buyer_type_updated';
  if found then
    if previous_metadata->>'lead_id' is distinct from target_lead_id::text then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata->'result', '{}'::jsonb) || jsonb_build_object('replayed', true);
  end if;

  select * into current_row
  from public.lead_company_profiles
  where lead_id = target_lead_id
  for update;
  profile_found := found;
  if (profile_found and current_row.version is distinct from expected_version)
    or (not profile_found and expected_version is not null)
  then
    raise exception using errcode = 'PT409', message = 'LEAD_COMPANY_VERSION_CONFLICT';
  end if;

  if target_buyer_type = 'INDIVIDUAL' and lead_row.buyer_type = 'INDIVIDUAL' then
    raise exception using errcode = '22023', message = 'LEAD_BUYER_TYPE_UNCHANGED';
  end if;

  before_json := jsonb_build_object(
    'buyer_type', lead_row.buyer_type,
    'company', app_private.lead_company_json(lead_row.id)
  );
  next_version := current_row.version;

  if target_buyer_type = 'COMPANY' then
    company_name_value := nullif(btrim(target_company->>'company_name'), '');
    gstin_value := nullif(upper(regexp_replace(coalesce(target_company->>'gstin', ''), '\s', '', 'g')), '');
    pan_value := nullif(upper(regexp_replace(coalesce(target_company->>'pan', ''), '\s', '', 'g')), '');
    funding_value := nullif(btrim(target_company->>'funding_mode'), '');
    if company_name_value is null or char_length(company_name_value) not between 2 and 160 then
      raise exception using errcode = '22023', message = 'LEAD_COMPANY_NAME_REQUIRED';
    end if;
    if gstin_value is not null
      and gstin_value !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
      raise exception using errcode = '22023', message = 'LEAD_COMPANY_GSTIN_INVALID';
    end if;
    if pan_value is not null and pan_value !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
      raise exception using errcode = '22023', message = 'LEAD_COMPANY_PAN_INVALID';
    end if;
    if funding_value is not null and funding_value not in ('OUTRIGHT', 'LOAN', 'LEASE') then
      raise exception using errcode = '22023', message = 'LEAD_COMPANY_FUNDING_INVALID';
    end if;
    -- Lease details are dropped rather than rejected when the vehicle is not
    -- leased, so switching the funding mode in the form cannot strand them.
    if funding_value = 'LEASE' then
      lease_type_value := nullif(btrim(target_company->>'lease_type'), '');
      lessor_value := nullif(btrim(target_company->>'lessor_name'), '');
      tenure_value := nullif(target_company->>'lease_tenure_months', '')::integer;
      if (lease_type_value is not null and lease_type_value not in ('OPERATING', 'FINANCE'))
        or (tenure_value is not null and tenure_value not between 1 and 120)
      then
        raise exception using errcode = '22023', message = 'LEAD_COMPANY_LEASE_INVALID';
      end if;
    end if;

    next_version := coalesce(current_row.version, 0) + 1;
    insert into public.lead_company_profiles as c (
      lead_id, organization_id, company_name, company_type, industry, gstin, pan,
      contact_person, contact_designation, company_phone, company_email,
      address_line, city, state, postal_code,
      funding_mode, lease_type, lessor_name, lease_tenure_months,
      version, updated_by, updated_at
    ) values (
      lead_row.id, lead_row.organization_id, company_name_value,
      nullif(btrim(target_company->>'company_type'), ''),
      nullif(btrim(target_company->>'industry'), ''),
      gstin_value,
      pan_value,
      nullif(btrim(target_company->>'contact_person'), ''),
      nullif(btrim(target_company->>'contact_designation'), ''),
      nullif(btrim(target_company->>'company_phone'), ''),
      nullif(lower(btrim(target_company->>'company_email')), ''),
      nullif(btrim(target_company->>'address_line'), ''),
      nullif(btrim(target_company->>'city'), ''),
      nullif(btrim(target_company->>'state'), ''),
      nullif(btrim(target_company->>'postal_code'), ''),
      funding_value, lease_type_value, lessor_value, tenure_value,
      next_version, auth.uid(), now()
    )
    on conflict (lead_id) do update set
      company_name = excluded.company_name,
      company_type = excluded.company_type,
      industry = excluded.industry,
      gstin = excluded.gstin,
      pan = excluded.pan,
      contact_person = excluded.contact_person,
      contact_designation = excluded.contact_designation,
      company_phone = excluded.company_phone,
      company_email = excluded.company_email,
      address_line = excluded.address_line,
      city = excluded.city,
      state = excluded.state,
      postal_code = excluded.postal_code,
      funding_mode = excluded.funding_mode,
      lease_type = excluded.lease_type,
      lessor_name = excluded.lessor_name,
      lease_tenure_months = excluded.lease_tenure_months,
      version = excluded.version,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;
  end if;

  update public.leads
  set buyer_type = target_buyer_type::public.lead_buyer_type,
      updated_at = now()
  where id = lead_row.id;

  result := jsonb_build_object(
    'lead_id', lead_row.id,
    'buyer_type', target_buyer_type,
    'version', next_version,
    'replayed', false
  );
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  values (
    lead_row.organization_id, lead_row.customer_id, lead_row.id,
    case
      when target_buyer_type = 'INDIVIDUAL' then 'LEAD_REGISTERED_AS_INDIVIDUAL'
      when lead_row.buyer_type = 'COMPANY' then 'LEAD_COMPANY_UPDATED'
      else 'LEAD_REGISTERED_AS_COMPANY'
    end,
    auth.uid(),
    jsonb_strip_nulls(jsonb_build_object('company_name', company_name_value, 'version', next_version))
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    lead_row.organization_id, auth.uid(), 'lead.buyer_type_updated', 'lead', lead_row.id::text,
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
revoke all on function public.set_lead_buyer_type(uuid, text, bigint, jsonb, uuid) from public, anon;
grant execute on function public.set_lead_buyer_type(uuid, text, bigint, jsonb, uuid) to authenticated;

-- A company buying several vehicles is several leads. The second one should
-- not need its company retyped, so the dialog offers the identity fields of
-- the newest company profile on another lead of the same customer or mobile.
-- Only leads the caller can already see are read: a suggestion must not widen
-- access to a sibling lead. Funding is per vehicle and is never suggested.
create or replace function public.get_lead_company_suggestion(target_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.can_access_lead(lead_row.id) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  return (
    select jsonb_build_object(
      'source_lead_id', c.lead_id,
      'company_name', c.company_name,
      'company_type', c.company_type,
      'industry', c.industry,
      'gstin', c.gstin,
      'pan', c.pan,
      'contact_person', c.contact_person,
      'contact_designation', c.contact_designation,
      'company_phone', c.company_phone,
      'company_email', c.company_email,
      'address_line', c.address_line,
      'city', c.city,
      'state', c.state,
      'postal_code', c.postal_code
    )
    from public.leads sibling_row
    join public.lead_company_profiles c on c.lead_id = sibling_row.id
    where sibling_row.organization_id = lead_row.organization_id
      and sibling_row.id <> lead_row.id
      and sibling_row.deleted_at is null
      and (
        (lead_row.customer_id is not null and sibling_row.customer_id = lead_row.customer_id)
        or (lead_row.normalized_phone <> '' and sibling_row.normalized_phone = lead_row.normalized_phone)
      )
      and app_private.can_access_lead(sibling_row.id)
    order by c.updated_at desc, c.lead_id desc
    limit 1
  );
end;
$$;
revoke all on function public.get_lead_company_suggestion(uuid) from public, anon;
grant execute on function public.get_lead_company_suggestion(uuid) to authenticated;

-- --- 4. Patch the deployed readers ----------------------------------------------
-- `edits` is a flat list of (old text, new text, expected occurrences). Every
-- anchor must occur exactly as often as stated and every new text must be in
-- the result, so a moved target fails loudly instead of silently no-opping.
-- A patch that changes the argument list creates a second overload; the old
-- one is dropped and its grants are re-applied to the new one.
create or replace function pg_temp.patch_function(
  target regprocedure,
  edits text[],
  grant_to text[]
)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  old_identity text := target::text;
  function_schema text;
  function_name text;
  existing_oids oid[];
  created_oids oid[];
  new_target regprocedure;
  occurrences integer;
  i integer;
begin
  select n.nspname, p.proname into function_schema, function_name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.oid = target;

  if cardinality(edits) % 3 <> 0 then
    raise exception 'PATCH_EDITS_MALFORMED for %', old_identity;
  end if;
  for i in 0 .. cardinality(edits) / 3 - 1 loop
    occurrences := (char_length(definition) - char_length(replace(definition, edits[i * 3 + 1], '')))
      / char_length(edits[i * 3 + 1]);
    if occurrences <> edits[i * 3 + 3]::integer then
      raise exception 'PATCH_ANCHOR_COUNT for % edit %: expected %, found %',
        old_identity, i + 1, edits[i * 3 + 3], occurrences;
    end if;
    definition := replace(definition, edits[i * 3 + 1], edits[i * 3 + 2]);
  end loop;
  select array_agg(p.oid) into existing_oids
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = function_schema and p.proname = function_name;
  execute definition;

  -- Same argument list: replaced in place. A new one: exactly one new overload.
  select coalesce(array_agg(p.oid), '{}') into created_oids
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = function_schema and p.proname = function_name
    and p.oid <> all(existing_oids);
  if cardinality(created_oids) > 1 then
    raise exception 'PATCH_AMBIGUOUS_OVERLOAD for %', old_identity;
  end if;
  new_target := coalesce(created_oids[1], target::oid)::regprocedure;
  for i in 0 .. cardinality(edits) / 3 - 1 loop
    if position(edits[i * 3 + 2] in pg_get_functiondef(new_target)) = 0 then
      raise exception 'PATCH_NOT_APPLIED for % edit %', old_identity, i + 1;
    end if;
  end loop;

  if new_target <> target then
    execute format('drop function %s', old_identity);
    execute format('revoke all on function %s from public, anon, authenticated', new_target);
    if cardinality(grant_to) > 0 then
      execute format('grant execute on function %s to %s', new_target, array_to_string(grant_to, ', '));
    end if;
  end if;
end;
$$;

-- Lead list, sales roles.
select pg_temp.patch_function(
  'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)',
  array[
    $o$target_include_records boolean DEFAULT true, target_include_kpis boolean DEFAULT true)$o$,
    $n$target_include_records boolean DEFAULT true, target_include_kpis boolean DEFAULT true, target_buyer_type text DEFAULT 'all'::text)$n$,
    '1',

    $o$    or target_temperature is null or target_temperature not in ('all', 'HOT', 'WARM', 'COLD', 'DORMANT')
$o$,
    $n$    or target_temperature is null or target_temperature not in ('all', 'HOT', 'WARM', 'COLD', 'DORMANT')
    or target_buyer_type is null or target_buyer_type not in ('all', 'INDIVIDUAL', 'COMPANY')
$n$,
    '1',

    $o$        then ' and lead_row.temperature::text = ' || quote_literal(target_temperature) else '' end
$o$,
    $n$        then ' and lead_row.temperature::text = ' || quote_literal(target_temperature) else '' end
      || case when target_buyer_type <> 'all'
        then ' and lead_row.buyer_type = ' || quote_literal(target_buyer_type) || '::public.lead_buyer_type' else '' end
$n$,
    '1',

    $o$        lead_row.updated_at,
        count(*) over (partition by coalesce($o$,
    $n$        lead_row.updated_at,
        lead_row.buyer_type,
        count(*) over (partition by coalesce($n$,
    '1',

    $o$      and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
$o$,
    $n$      and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
      and (target_buyer_type = 'all' or lead_row.buyer_type::text = target_buyer_type)
$n$,
    '1',

    $o$        lead_row.lost_reason,
        lead_row.assigned_user_id,
        stage_row.is_handoff_read_only,$o$,
    $n$        lead_row.lost_reason,
        lead_row.buyer_type,
        -- Per page row only; shown beside the customer on a company lead.
        case when lead_row.buyer_type = 'COMPANY' then (
          select company_row.company_name
          from public.lead_company_profiles company_row
          where company_row.lead_id = lead_row.id
        ) end as company_name,
        lead_row.assigned_user_id,
        stage_row.is_handoff_read_only,$n$,
    '1',

    $o$          'lost_reason', lost_reason,
          'work_state', work_state,$o$,
    $n$          'lost_reason', lost_reason,
          'buyer_type', buyer_type,
          'company_name', company_name,
          'work_state', work_state,$n$,
    '1'
  ],
  array[]::text[]
);

-- Lead list, every other role.
select pg_temp.patch_function(
  'public.get_lead_workspace_page_v2_legacy(integer,integer,text,text,text,text,text,text,text,date,date)',
  array[
    $o$target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date)$o$,
    $n$target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date, target_buyer_type text DEFAULT 'all'::text)$n$,
    '1',

    $o$    or target_temperature is null or target_temperature not in ('all', 'HOT', 'WARM', 'COLD')
$o$,
    $n$    or target_temperature is null or target_temperature not in ('all', 'HOT', 'WARM', 'COLD')
    or target_buyer_type is null or target_buyer_type not in ('all', 'INDIVIDUAL', 'COMPANY')
$n$,
    '1',

    $o$        lead_row.created_at, lead_row.updated_at, lead_row.next_followup_at,
        case$o$,
    $n$        lead_row.created_at, lead_row.updated_at, lead_row.next_followup_at,
        lead_row.buyer_type,
        case$n$,
    '1',

    $o$      and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
$o$,
    $n$      and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
      and (target_buyer_type = 'all' or lead_row.buyer_type::text = target_buyer_type)
$n$,
    '1',

    $o$          'lost_reason', lost_reason, 'work_state', work_state, 'lead_stage', lead_stage,$o$,
    $n$          'lost_reason', lost_reason, 'work_state', work_state, 'lead_stage', lead_stage,
          'buyer_type', buyer_type,$n$,
    '1'
  ],
  array['authenticated', 'service_role']
);

-- Lead list, public router.
select pg_temp.patch_function(
  'public.get_lead_workspace_page_v2(integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)',
  array[
    $o$target_include_records boolean DEFAULT true, target_include_kpis boolean DEFAULT true)$o$,
    $n$target_include_records boolean DEFAULT true, target_include_kpis boolean DEFAULT true, target_buyer_type text DEFAULT 'all'::text)$n$,
    '1',

    $o$      target_include_records,
      target_include_kpis
    );$o$,
    $n$      target_include_records,
      target_include_kpis,
      target_buyer_type
    );$n$,
    '1',

    $o$    target_followup_from,
    target_followup_to
  );$o$,
    $n$    target_followup_from,
    target_followup_to,
    target_buyer_type
  );$n$,
    '1'
  ],
  array['authenticated', 'service_role']
);

-- Follow-up list: Sales Consultant and Telecaller fast paths share one shape.
-- A follow-up with no lead belongs to a person, so it counts as INDIVIDUAL.
select pg_temp.patch_function(
  format(
    'app_private.%s(uuid,uuid,uuid[],boolean,text,text,text,uuid,uuid,uuid,integer,integer,text,text,text,text,text,date,date)',
    function_name
  )::regprocedure,
  array[
    $o$target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date)$o$,
    $n$target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date, target_buyer_type text DEFAULT 'all'::text)$n$,
    '1',

    $o$    or target_temperature is distinct from 'all';$o$,
    $n$    or target_temperature is distinct from 'all'
    or target_buyer_type is distinct from 'all';$n$,
    '1',

    $o$        and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
$o$,
    $n$        and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
        and (target_buyer_type = 'all'
          or coalesce(lead_row.buyer_type::text, 'INDIVIDUAL') = target_buyer_type)
$n$,
    '1'
  ],
  array[]::text[]
)
from unnest(array[
  'get_sales_consultant_followup_workspace_filtered_page',
  'get_telecaller_followup_workspace_filtered_page'
]) as function_name;

-- Follow-up list, manager and admin roles.
select pg_temp.patch_function(
  'app_private.get_scoped_followup_workspace_filtered_page(uuid,text,text,text,uuid,uuid,uuid,integer,integer,text,text,text,text,text,date,date)',
  array[
    $o$target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date)$o$,
    $n$target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date, target_buyer_type text DEFAULT 'all'::text)$n$,
    '1',

    $o$        lead_row.temperature::text as lead_temperature,
$o$,
    $n$        lead_row.temperature::text as lead_temperature,
        lead_row.buyer_type::text as lead_buyer_type,
$n$,
    '1',

    $o$          or record_row.lead_temperature = target_temperature
        )
$o$,
    $n$          or record_row.lead_temperature = target_temperature
        )
        and (
          target_buyer_type = 'all'
          or coalesce(record_row.lead_buyer_type, 'INDIVIDUAL') = target_buyer_type
        )
$n$,
    '1'
  ],
  array[]::text[]
);

-- Follow-up list, public router.
select pg_temp.patch_function(
  'public.get_followup_workspace_filtered_page(text,text,text,uuid,uuid,uuid,integer,integer,text,text,text,text,text,date,date)',
  array[
    $o$target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date)$o$,
    $n$target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date, target_buyer_type text DEFAULT 'all'::text)$n$,
    '1',

    $o$  if target_temperature not in ('all', 'HOT', 'WARM', 'COLD')
$o$,
    $n$  if target_temperature not in ('all', 'HOT', 'WARM', 'COLD')
    or target_buyer_type is null or target_buyer_type not in ('all', 'INDIVIDUAL', 'COMPANY')
$n$,
    '1',

    $o$      target_followup_to
    );$o$,
    $n$      target_followup_to,
      target_buyer_type
    );$n$,
    '2',

    $o$    target_followup_to
  );$o$,
    $n$    target_followup_to,
    target_buyer_type
  );$n$,
    '1'
  ],
  array['authenticated', 'service_role']
);

-- Lead detail and Customer 360 carry the buyer type and company with the lead.
select pg_temp.patch_function(
  'public.get_lead_detail_workspace(uuid)',
  array[
    $o$    'requirements', app_private.lead_requirements_json(lead_row.id),$o$,
    $n$    'requirements', app_private.lead_requirements_json(lead_row.id),
    'buyer_type', lead_row.buyer_type,
    'company', app_private.lead_company_json(lead_row.id),$n$,
    '1'
  ],
  array[]::text[]
);

select pg_temp.patch_function(
  'app_private.get_customer_360_legacy_20260824(uuid)',
  array[
    $o$          'requirements', app_private.lead_requirements_json(lead_row.id),$o$,
    $n$          'requirements', app_private.lead_requirements_json(lead_row.id),
          'buyer_type', lead_row.buyer_type,
          'company', app_private.lead_company_json(lead_row.id),$n$,
    '1'
  ],
  array[]::text[]
);

select pg_temp.patch_function(
  'public.get_lead_journey(uuid,timestamp with time zone,uuid,integer)',
  array[
    $o$        when 'LEAD_REQUIREMENTS_UPDATED' then 'Requirements updated'
$o$,
    $n$        when 'LEAD_REQUIREMENTS_UPDATED' then 'Requirements updated'
        when 'LEAD_REGISTERED_AS_COMPANY' then
          'Registered as company' || coalesce(': ' || nullif(activity_row.metadata ->> 'company_name', ''), '')
        when 'LEAD_REGISTERED_AS_INDIVIDUAL' then 'Registered as individual'
        when 'LEAD_COMPANY_UPDATED' then 'Company details updated'
$n$,
    '1'
  ],
  array[]::text[]
);

drop function pg_temp.patch_function(regprocedure, text[], text[]);

notify pgrst, 'reload schema';
commit;
