begin;

insert into public.permissions (permission_key, module, description) values
  ('customer_care.view', 'customer-care', 'View customer-care cases within authorized scope'),
  ('customer_care.manage', 'customer-care', 'Create, assign and progress customer-care cases'),
  ('customer_care.escalate', 'customer-care', 'Escalate a customer-care case within authority scope')
on conflict (permission_key) do update
set module = excluded.module, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row cross join public.permissions permission_row
where role_row.organization_id is not null and role_row.system_role
  and permission_row.permission_key in (
    'customer_care.view', 'customer_care.manage', 'customer_care.escalate'
  )
  and (
    role_row.role_key in ('client_admin', 'system_administrator', 'customer_relationship_manager')
    or (
      role_row.role_key in ('business_owner', 'gm_sales', 'showroom_manager')
      and permission_row.permission_key = 'customer_care.view'
    )
  )
on conflict do nothing;

create or replace function app_private.apply_default_customer_care_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is not null and new.system_role then
    insert into public.role_permissions (role_id, permission_id)
    select new.id, permission_row.id
    from public.permissions permission_row
    where permission_row.permission_key = any(case
      when new.role_key in ('client_admin', 'system_administrator', 'customer_relationship_manager')
        then array['customer_care.view', 'customer_care.manage', 'customer_care.escalate']
      when new.role_key in ('business_owner', 'gm_sales', 'showroom_manager')
        then array['customer_care.view']
      else '{}'::text[]
    end)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists roles_apply_default_customer_care_permissions on public.roles;
create trigger roles_apply_default_customer_care_permissions
after insert or update of role_key, system_role on public.roles
for each row execute function app_private.apply_default_customer_care_permissions();

create table public.customer_care_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id),
  booking_id uuid references public.bookings(id),
  vehicle_id uuid references public.customer_vehicles(id),
  case_number text not null,
  case_type text not null,
  priority text not null default 'NORMAL',
  status text not null default 'NEW',
  assigned_user_id uuid references public.profiles(id),
  subject text not null,
  description text not null,
  resolution text,
  sla_due_at timestamptz not null,
  first_contacted_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  version bigint not null default 1,
  created_by uuid not null references public.profiles(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, case_number),
  unique (organization_id, id),
  check (case_type in (
    'DELIVERY_FOLLOWUP', 'COMPLAINT', 'FEEDBACK', 'DOCUMENTATION_QUERY',
    'REVIEW_REQUEST', 'SALES_EXPERIENCE', 'OTHER'
  )),
  check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  check (status in ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'CUSTOMER_CONTACTED', 'RESOLVED', 'CLOSED')),
  check (char_length(btrim(subject)) between 3 and 180),
  check (char_length(btrim(description)) between 5 and 4000),
  check (resolution is null or char_length(btrim(resolution)) between 5 and 4000),
  check (version > 0),
  check (first_contacted_at is null or first_contacted_at >= created_at),
  check (resolved_at is null or resolved_at >= created_at),
  check (closed_at is null or (resolved_at is not null and closed_at >= resolved_at))
);

alter table public.feedback_requests
  add column if not exists customer_case_id uuid,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();
alter table public.complaints
  add column if not exists customer_case_id uuid,
  add column if not exists version bigint not null default 1;
alter table public.escalations
  add column if not exists customer_case_id uuid,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

create unique index customer_care_case_id_org_unique_idx
  on public.customer_care_cases (organization_id, id);
create unique index feedback_requests_case_unique_idx
  on public.feedback_requests (organization_id, customer_case_id)
  where customer_case_id is not null;
create unique index complaints_case_unique_idx
  on public.complaints (organization_id, customer_case_id)
  where customer_case_id is not null;
create unique index customer_care_open_escalation_unique_idx
  on public.escalations (organization_id, customer_case_id)
  where customer_case_id is not null and status = 'OPEN';
create unique index customer_care_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action like 'customer_care.%';
create index customer_care_workspace_page_idx
  on public.customer_care_cases (
    organization_id, branch_id, status, priority, updated_at desc, id desc
  ) where deleted_at is null;
create index customer_care_sla_idx
  on public.customer_care_cases (organization_id, sla_due_at, id)
  where deleted_at is null and status not in ('RESOLVED', 'CLOSED');
create index customer_care_customer_idx
  on public.customer_care_cases (organization_id, customer_id, created_at desc, id desc)
  where deleted_at is null;

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order)
values ('customer_care_cases', 'DELETE', 515)
on conflict (table_name) do update
set disposition = excluded.disposition, delete_order = excluded.delete_order;

alter table public.customer_care_cases
  add constraint customer_care_cases_branch_org_fk
  foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid,
  add constraint customer_care_cases_customer_org_fk
  foreign key (organization_id, customer_id)
  references public.customers (organization_id, id) not valid,
  add constraint customer_care_cases_booking_org_fk
  foreign key (organization_id, booking_id)
  references public.bookings (organization_id, id) not valid,
  add constraint customer_care_cases_assignee_org_fk
  foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid,
  add constraint customer_care_cases_creator_org_fk
  foreign key (organization_id, created_by)
  references public.profiles (organization_id, id) not valid,
  add constraint customer_care_cases_vehicle_org_fk
  foreign key (organization_id, customer_id, vehicle_id)
  references public.customer_vehicles (organization_id, customer_id, id) not valid;
alter table public.feedback_requests
  add constraint feedback_requests_customer_case_org_fk
  foreign key (organization_id, customer_case_id)
  references public.customer_care_cases (organization_id, id) not valid;
alter table public.complaints
  add constraint complaints_customer_case_org_fk
  foreign key (organization_id, customer_case_id)
  references public.customer_care_cases (organization_id, id) not valid;
alter table public.escalations
  add constraint escalations_customer_case_org_fk
  foreign key (organization_id, customer_case_id)
  references public.customer_care_cases (organization_id, id) not valid;

create or replace function app_private.customer_care_transition_allowed(
  current_status text,
  next_status text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (upper(current_status), upper(next_status)) in (
    ('NEW', 'ASSIGNED'), ('NEW', 'IN_PROGRESS'),
    ('ASSIGNED', 'IN_PROGRESS'), ('IN_PROGRESS', 'CUSTOMER_CONTACTED'),
    ('CUSTOMER_CONTACTED', 'IN_PROGRESS'), ('CUSTOMER_CONTACTED', 'RESOLVED'),
    ('IN_PROGRESS', 'RESOLVED'), ('RESOLVED', 'CLOSED')
  );
$$;

create or replace function app_private.customer_care_request_fingerprint(payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(coalesce(payload, '{}'::jsonb)::text, 'UTF8')),
    'hex'
  );
$$;

create or replace function app_private.replay_customer_care_request(
  target_organization_id uuid,
  target_action text,
  target_request_id uuid,
  target_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare previous_action text; previous_metadata jsonb;
begin
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  select audit_row.action, audit_row.metadata into previous_action, previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = auth.uid() and audit_row.request_id = target_request_id
    and audit_row.action like 'customer_care.%'
  limit 1;
  if previous_action is null then return null; end if;
  if previous_action <> target_action
    or previous_metadata->>'fingerprint' is distinct from target_fingerprint
  then raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED'; end if;
  return coalesce(previous_metadata->'result', '{}'::jsonb)
    || jsonb_build_object('replayed', true);
end;
$$;

create or replace function public.get_customer_care_workspace_page(
  target_view text default 'OPEN',
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'updated:desc',
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_view text := upper(btrim(coalesce(target_view, 'OPEN')));
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if normalized_view not in (
      'ALL', 'OPEN', 'SLA_RISK', 'FEEDBACK', 'REVIEW_REQUEST',
      'COMPLAINT', 'ESCALATED', 'RESOLVED', 'CLOSED'
    )
    or char_length(normalized_search) > 160
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort not in ('updated:desc', 'sla:asc', 'created:desc', 'priority:desc')
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_QUERY'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.view')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then raise exception using errcode = '42501', message = 'CUSTOMER_CARE_VIEW_PERMISSION_REQUIRED'; end if;

  with authorized as materialized (
    select case_row.id, case_row.organization_id, case_row.branch_id,
      case_row.customer_id, case_row.booking_id, case_row.vehicle_id,
      case_row.case_number, case_row.case_type, case_row.priority, case_row.status,
      case_row.assigned_user_id, case_row.subject, case_row.description,
      case_row.resolution, case_row.sla_due_at, case_row.first_contacted_at,
      case_row.resolved_at, case_row.closed_at, case_row.version,
      case_row.created_at, case_row.updated_at,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      booking_row.booking_number,
      concat_ws(' ', vehicle_row.brand, vehicle_row.model, vehicle_row.registration) as vehicle,
      profile_row.full_name as assigned_user_name,
      exists (
        select 1 from public.escalations escalation_row
        where escalation_row.organization_id = case_row.organization_id
          and escalation_row.customer_case_id = case_row.id
          and escalation_row.status = 'OPEN'
      ) as escalated
    from public.customer_care_cases case_row
    join public.customers customer_row
      on customer_row.organization_id = case_row.organization_id
     and customer_row.id = case_row.customer_id and customer_row.deleted_at is null
    left join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id
     and booking_row.id = case_row.booking_id and booking_row.deleted_at is null
    left join public.customer_vehicles vehicle_row
      on vehicle_row.organization_id = case_row.organization_id
     and vehicle_row.customer_id = case_row.customer_id and vehicle_row.id = case_row.vehicle_id
    left join public.profiles profile_row
      on profile_row.organization_id = case_row.organization_id
     and profile_row.id = case_row.assigned_user_id
    where case_row.organization_id = current_organization_id and case_row.deleted_at is null
      and app_private.can_access_record(
        case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
      )
      and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
      and (
        normalized_search = ''
        or position(normalized_search in lower(case_row.case_number)) > 0
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or position(normalized_search in lower(coalesce(booking_row.booking_number, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), filtered as materialized (
    select authorized_row.* from authorized authorized_row
    where case normalized_view
      when 'ALL' then true
      when 'OPEN' then authorized_row.status not in ('RESOLVED', 'CLOSED')
      when 'SLA_RISK' then authorized_row.status not in ('RESOLVED', 'CLOSED')
        and authorized_row.sla_due_at <= now()
      when 'FEEDBACK' then authorized_row.case_type = 'FEEDBACK'
      when 'REVIEW_REQUEST' then authorized_row.case_type = 'REVIEW_REQUEST'
      when 'COMPLAINT' then authorized_row.case_type = 'COMPLAINT'
      when 'ESCALATED' then authorized_row.escalated
      else authorized_row.status = normalized_view
    end
  ), numbered as (
    select filtered_row.*, row_number() over (order by
      case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
      case when target_sort = 'sla:asc' then filtered_row.sla_due_at end asc,
      case when target_sort = 'created:desc' then filtered_row.created_at end desc,
      case filtered_row.priority when 'URGENT' then 4 when 'HIGH' then 3
        when 'NORMAL' then 2 else 1 end desc,
      filtered_row.id desc
    ) as page_order from filtered filtered_row
  ), page_rows as (
    select numbered_row.* from numbered numbered_row order by page_order
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'records', coalesce((select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_order)
      from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'kpis', jsonb_build_object(
      'open', (select count(*) from authorized where status not in ('RESOLVED', 'CLOSED')),
      'followups_due', case when app_private.has_permission(
        current_organization_id, 'followup.view'
      ) then (select count(*) from public.followups followup_row
        where followup_row.organization_id = current_organization_id
          and followup_row.status in ('OPEN', 'OVERDUE')
          and timezone(target_timezone, followup_row.due_at)::date
            = timezone(target_timezone, now())::date
          and app_private.can_access_record(
            followup_row.organization_id, followup_row.branch_id,
            followup_row.team_id, followup_row.assigned_user_id
          )
          and (
            followup_row.lead_id is null
            or app_private.can_access_lead(followup_row.lead_id)
          )
          and (
            followup_row.customer_id is null
            or app_private.can_access_customer(
              followup_row.organization_id, followup_row.customer_id
            )
          )) else 0 end,
      'feedback_pending', (select count(*) from authorized
        where case_type = 'FEEDBACK' and status not in ('RESOLVED', 'CLOSED')),
      'review_pending', (select count(*) from authorized
        where case_type = 'REVIEW_REQUEST' and status not in ('RESOLVED', 'CLOSED')),
      'complaints_open', (select count(*) from authorized
        where case_type = 'COMPLAINT' and status not in ('RESOLVED', 'CLOSED')),
      'sla_risk', (select count(*) from authorized
        where status not in ('RESOLVED', 'CLOSED') and sla_due_at <= now()),
      'resolved_today', (select count(*) from authorized where resolved_at is not null
        and timezone(target_timezone, resolved_at)::date = timezone(target_timezone, now())::date),
      'average_resolution_hours', (select coalesce(round(avg(
        extract(epoch from (resolved_at - created_at)) / 3600
      )::numeric, 1), 0) from authorized where resolved_at is not null)
    ),
    'status_chart', coalesce((select jsonb_agg(jsonb_build_object(
      'name', initcap(replace(status, '_', ' ')), 'value', status_count
    ) order by status_count desc) from (
      select status, count(*) status_count from authorized group by status
    ) status_rows), '[]'::jsonb),
    'activity_chart', coalesce((select jsonb_agg(jsonb_build_object(
      'name', to_char(day_value, 'DD Mon'),
      'value', (select count(*) from authorized
        where timezone(target_timezone, created_at)::date = day_value),
      'secondary', (select count(*) from authorized
        where resolved_at is not null and timezone(target_timezone, resolved_at)::date = day_value)
    ) order by day_value) from generate_series(
      timezone(target_timezone, now())::date - 13,
      timezone(target_timezone, now())::date, interval '1 day'
    ) day_value), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.get_customer_care_customer_options(
  target_search text default '', target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid; normalized_search text := lower(btrim(coalesce(target_search, ''))); result jsonb;
begin
  if char_length(normalized_search) > 160 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_OPTION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then raise exception using errcode = '42501', message = 'CUSTOMER_CARE_MANAGE_PERMISSION_REQUIRED'; end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
    select customer_row.id as customer_id, customer_row.full_name as customer_name,
      customer_row.primary_phone as phone, booking_row.id as booking_id,
      booking_row.booking_number, booking_row.branch_id,
      vehicle_row.id as vehicle_id,
      concat_ws(' ', vehicle_row.brand, vehicle_row.model, vehicle_row.registration) as vehicle,
      customer_row.updated_at
    from public.customers customer_row
    join lateral (
      select source_booking.* from public.bookings source_booking
      where source_booking.organization_id = customer_row.organization_id
        and source_booking.customer_id = customer_row.id and source_booking.deleted_at is null
        and app_private.can_access_record(
          source_booking.organization_id, source_booking.branch_id,
          source_booking.team_id, source_booking.assigned_user_id
        )
      order by source_booking.updated_at desc, source_booking.id desc limit 1
    ) booking_row on true
    left join lateral (
      select source_vehicle.* from public.customer_vehicles source_vehicle
      where source_vehicle.organization_id = customer_row.organization_id
        and source_vehicle.customer_id = customer_row.id
      order by source_vehicle.created_at desc, source_vehicle.id desc limit 1
    ) vehicle_row on true
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and app_private.can_access_customer(customer_row.organization_id, customer_row.id)
      and (
        normalized_search = ''
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
    order by customer_row.updated_at desc, customer_row.id desc limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.create_customer_care_case(
  target_customer_id uuid,
  target_booking_id uuid,
  target_vehicle_id uuid,
  target_case_type text,
  target_priority text,
  target_subject text,
  target_description text,
  target_assigned_user_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  booking_row public.bookings%rowtype;
  normalized_type text := upper(btrim(coalesce(target_case_type, '')));
  normalized_priority text := upper(btrim(coalesce(target_priority, 'NORMAL')));
  normalized_subject text := btrim(coalesce(target_subject, ''));
  normalized_description text := btrim(coalesce(target_description, ''));
  effective_assignee_id uuid;
  case_id uuid := gen_random_uuid();
  case_number text;
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_customer_id is null or target_booking_id is null or target_request_id is null
    or normalized_type not in (
      'DELIVERY_FOLLOWUP', 'COMPLAINT', 'FEEDBACK', 'DOCUMENTATION_QUERY',
      'REVIEW_REQUEST', 'SALES_EXPERIENCE', 'OTHER'
    ) or normalized_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
    or char_length(normalized_subject) not between 3 and 180
    or char_length(normalized_description) not between 5 and 4000
  then raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_INPUT'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then raise exception using errcode = '42501', message = 'CUSTOMER_CARE_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.customer_care_request_fingerprint(jsonb_build_object(
    'customer_id', target_customer_id, 'booking_id', target_booking_id,
    'vehicle_id', target_vehicle_id, 'case_type', normalized_type,
    'priority', normalized_priority, 'subject', normalized_subject,
    'description', normalized_description, 'assigned_user_id', target_assigned_user_id
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_customer_care_request(
    current_organization_id, 'customer_care.created', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into booking_row from public.bookings source_row
  where source_row.organization_id = current_organization_id
    and source_row.id = target_booking_id and source_row.customer_id = target_customer_id
    and source_row.deleted_at is null
  for share;
  if not found then raise exception using errcode = 'P0002', message = 'CUSTOMER_CARE_BOOKING_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    booking_row.organization_id, booking_row.branch_id,
    booking_row.team_id, booking_row.assigned_user_id
  ) or not app_private.can_access_customer(current_organization_id, target_customer_id)
  then raise exception using errcode = '42501', message = 'CUSTOMER_CARE_SCOPE_DENIED'; end if;
  if target_vehicle_id is not null and not exists (
    select 1 from public.customer_vehicles vehicle_row
    where vehicle_row.organization_id = current_organization_id
      and vehicle_row.customer_id = target_customer_id and vehicle_row.id = target_vehicle_id
  ) then raise exception using errcode = '23514', message = 'CUSTOMER_CARE_VEHICLE_MISMATCH'; end if;
  effective_assignee_id := coalesce(target_assigned_user_id, auth.uid());
  if not exists (
    select 1 from public.profiles profile_row
    where profile_row.organization_id = current_organization_id
      and profile_row.id = effective_assignee_id and profile_row.active
      and profile_row.deleted_at is null
      and exists (
        select 1 from public.user_role_assignments assignment_row
        where assignment_row.organization_id = current_organization_id
          and assignment_row.user_id = profile_row.id and assignment_row.active
          and (
            assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
            or (
              assignment_row.data_scope = 'ONE_BRANCH'
              and assignment_row.scope_branch_id = booking_row.branch_id
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and booking_row.branch_id = any(assignment_row.selected_branch_ids)
            )
            or profile_row.id = auth.uid()
          )
      )
  ) then raise exception using errcode = '42501', message = 'CUSTOMER_CARE_ASSIGNEE_INELIGIBLE'; end if;
  case_number := 'CC-' || to_char(timezone('UTC', now()), 'YYYYMMDD') || '-'
    || upper(substr(replace(case_id::text, '-', ''), 1, 8));
  insert into public.customer_care_cases (
    id, organization_id, branch_id, customer_id, booking_id, vehicle_id,
    case_number, case_type, priority, status, assigned_user_id,
    subject, description, sla_due_at, created_by
  ) values (
    case_id, current_organization_id, booking_row.branch_id, target_customer_id,
    target_booking_id, target_vehicle_id, case_number, normalized_type,
    normalized_priority, 'ASSIGNED', effective_assignee_id,
    normalized_subject, normalized_description,
    now() + case normalized_priority when 'URGENT' then interval '4 hours'
      when 'HIGH' then interval '8 hours' when 'NORMAL' then interval '24 hours'
      else interval '48 hours' end,
    auth.uid()
  );
  if normalized_type = 'COMPLAINT' then
    insert into public.complaints (
      organization_id, branch_id, customer_id, booking_id, assigned_user_id,
      category, description, priority, status, customer_case_id
    ) values (
      current_organization_id, booking_row.branch_id, target_customer_id,
      target_booking_id, effective_assignee_id, 'CUSTOMER_CARE',
      normalized_description, normalized_priority, 'OPEN', case_id
    );
  elsif normalized_type = 'FEEDBACK' then
    insert into public.feedback_requests (
      organization_id, branch_id, customer_id, booking_id,
      channel, status, customer_case_id
    ) values (
      current_organization_id, booking_row.branch_id, target_customer_id,
      target_booking_id, 'MANUAL', 'PENDING', case_id
    );
  end if;
  result := jsonb_build_object(
    'id', case_id, 'case_number', case_number, 'status', 'ASSIGNED',
    'version', 1, 'replayed', false
  );
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, target_customer_id, booking_row.lead_id,
    'CUSTOMER_CARE_CASE_CREATED', auth.uid(),
    jsonb_build_object('case_id', case_id, 'case_type', normalized_type)
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'customer_care.created',
    'customer_care_case', case_id::text, booking_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.update_customer_care_case(
  target_case_id uuid,
  expected_version bigint,
  target_status text,
  target_priority text,
  target_resolution text,
  target_feedback_rating smallint,
  target_feedback_comments text,
  target_escalation_reason text,
  target_escalation_severity text,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  case_row public.customer_care_cases%rowtype;
  normalized_status text := upper(btrim(coalesce(target_status, '')));
  normalized_priority text := upper(btrim(coalesce(target_priority, '')));
  normalized_resolution text := nullif(btrim(coalesce(target_resolution, '')), '');
  normalized_reason text := nullif(btrim(coalesce(target_reason, '')), '');
  normalized_escalation_reason text := nullif(btrim(coalesce(target_escalation_reason, '')), '');
  normalized_escalation_severity text := upper(btrim(coalesce(target_escalation_severity, '')));
  fingerprint text;
  replay_result jsonb;
  result jsonb;
  previous_status text;
begin
  if target_case_id is null or expected_version is null or expected_version < 1
    or target_request_id is null
    or normalized_status not in ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'CUSTOMER_CONTACTED', 'RESOLVED', 'CLOSED')
    or normalized_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
    or char_length(coalesce(normalized_resolution, '')) > 4000
    or char_length(coalesce(target_feedback_comments, '')) > 4000
    or (target_feedback_rating is not null and target_feedback_rating not between 1 and 5)
    or char_length(coalesce(normalized_reason, '')) > 1000
    or char_length(coalesce(normalized_escalation_reason, '')) > 1000
    or (normalized_escalation_reason is not null and normalized_escalation_severity not in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
  then raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_UPDATE'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.manage')
  then raise exception using errcode = '42501', message = 'CUSTOMER_CARE_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.customer_care_request_fingerprint(jsonb_build_object(
    'case_id', target_case_id, 'expected_version', expected_version,
    'status', normalized_status, 'priority', normalized_priority,
    'resolution', normalized_resolution, 'feedback_rating', target_feedback_rating,
    'feedback_comments', target_feedback_comments,
    'escalation_reason', normalized_escalation_reason,
    'escalation_severity', normalized_escalation_severity, 'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_customer_care_request(
    current_organization_id, 'customer_care.updated', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into case_row from public.customer_care_cases source_row
  where source_row.organization_id = current_organization_id
    and source_row.id = target_case_id and source_row.deleted_at is null
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'CUSTOMER_CARE_CASE_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
  ) or not app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
  then raise exception using errcode = '42501', message = 'CUSTOMER_CARE_SCOPE_DENIED'; end if;
  if case_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'CUSTOMER_CARE_VERSION_CONFLICT';
  end if;
  if normalized_status <> case_row.status and not app_private.customer_care_transition_allowed(
    case_row.status, normalized_status
  ) then raise exception using errcode = '23514', message = 'INVALID_CUSTOMER_CARE_TRANSITION'; end if;
  if normalized_status <> case_row.status and char_length(coalesce(normalized_reason, '')) < 3 then
    raise exception using errcode = '22023', message = 'CUSTOMER_CARE_CHANGE_REASON_REQUIRED';
  end if;
  if normalized_status in ('RESOLVED', 'CLOSED')
    and char_length(coalesce(normalized_resolution, case_row.resolution, '')) < 5
  then raise exception using errcode = '22023', message = 'CUSTOMER_CARE_RESOLUTION_REQUIRED'; end if;
  if normalized_escalation_reason is not null
    and not app_private.has_permission(current_organization_id, 'customer_care.escalate')
  then raise exception using errcode = '42501', message = 'CUSTOMER_CARE_ESCALATE_PERMISSION_REQUIRED'; end if;

  previous_status := case_row.status;

  update public.customer_care_cases set
    status = normalized_status,
    priority = normalized_priority,
    resolution = coalesce(normalized_resolution, resolution),
    first_contacted_at = case
      when normalized_status = 'CUSTOMER_CONTACTED' and first_contacted_at is null then now()
      else first_contacted_at end,
    resolved_at = case when normalized_status = 'RESOLVED' then coalesce(resolved_at, now()) else resolved_at end,
    closed_at = case when normalized_status = 'CLOSED' then coalesce(closed_at, now()) else closed_at end,
    version = version + 1, updated_at = now()
  where id = case_row.id returning * into case_row;
  if case_row.case_type = 'COMPLAINT' then
    update public.complaints set
      priority = normalized_priority,
      status = case when normalized_status in ('RESOLVED', 'CLOSED') then 'RESOLVED' else 'OPEN' end,
      resolution = case_row.resolution,
      version = version + 1, updated_at = now()
    where organization_id = current_organization_id and customer_case_id = case_row.id;
  elsif case_row.case_type = 'FEEDBACK' then
    update public.feedback_requests set
      status = case when normalized_status in ('RESOLVED', 'CLOSED') then 'COMPLETED' else status end,
      rating = coalesce(target_feedback_rating, rating),
      comments = coalesce(nullif(btrim(coalesce(target_feedback_comments, '')), ''), comments),
      completed_at = case when normalized_status in ('RESOLVED', 'CLOSED')
        then coalesce(completed_at, now()) else completed_at end,
      version = version + 1, updated_at = now()
    where organization_id = current_organization_id and customer_case_id = case_row.id;
  end if;
  if normalized_escalation_reason is not null then
    insert into public.escalations (
      organization_id, branch_id, resource_type, resource_id,
      assigned_user_id, reason, severity, status, customer_case_id
    ) values (
      current_organization_id, case_row.branch_id, 'customer_care_case', case_row.id,
      case_row.assigned_user_id, normalized_escalation_reason,
      normalized_escalation_severity, 'OPEN', case_row.id
    ) on conflict (organization_id, customer_case_id) where customer_case_id is not null and status = 'OPEN'
      do update set reason = excluded.reason, severity = excluded.severity,
        version = public.escalations.version + 1, updated_at = now();
  end if;
  if normalized_status in ('RESOLVED', 'CLOSED') then
    update public.escalations set status = 'RESOLVED', resolved_at = coalesce(resolved_at, now()),
      version = version + 1, updated_at = now()
    where organization_id = current_organization_id and customer_case_id = case_row.id
      and status = 'OPEN';
  end if;
  result := jsonb_build_object(
    'id', case_row.id, 'case_number', case_row.case_number,
    'status', case_row.status, 'version', case_row.version, 'replayed', false
  );
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) select current_organization_id, case_row.customer_id, booking_row.lead_id,
    'CUSTOMER_CARE_CASE_UPDATED', auth.uid(), jsonb_build_object(
      'case_id', case_row.id, 'from_status', previous_status,
      'to_status', case_row.status, 'reason', normalized_reason
    ) from public.bookings booking_row
    where booking_row.organization_id = current_organization_id and booking_row.id = case_row.booking_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'customer_care.updated',
    'customer_care_case', case_row.id::text, case_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result, 'reason', normalized_reason)
  );
  return result;
end;
$$;

alter table public.customer_care_cases enable row level security;
alter table public.customer_care_cases force row level security;
create policy customer_care_cases_read on public.customer_care_cases
for select to authenticated using (
  deleted_at is null
  and app_private.has_permission(organization_id, 'customer_care.view')
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(organization_id, branch_id, null, assigned_user_id)
  and app_private.can_access_customer(organization_id, customer_id)
);
revoke insert, update, delete, truncate on public.customer_care_cases from anon, authenticated;
revoke insert, update, delete, truncate on public.feedback_requests from anon, authenticated;
revoke insert, update, delete, truncate on public.complaints from anon, authenticated;
revoke insert, update, delete, truncate on public.escalations from anon, authenticated;

-- Preserve every previously introduced tenant topic while adding customer-care.
create or replace function app_private.realtime_topic_organization()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare current_topic text; topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(current_topic,
    '^organization:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):(leads|customers|communications|work|notifications|integrations|support|administration|inventory|sales|operations|customer-care)$');
  return case when topic_match is null then null else topic_match[1]::uuid end;
exception when others then return null; end;
$$;
create or replace function app_private.realtime_topic_resource()
returns text language plpgsql stable security definer set search_path = '' as $$
declare current_topic text; topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(current_topic,
    '^organization:[0-9a-fA-F-]{36}:(leads|customers|communications|work|notifications|integrations|support|administration|inventory|sales|operations|customer-care)$');
  return case when topic_match is null then null else topic_match[1] end;
exception when others then return null; end;
$$;
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists crm_tenant_broadcast_read on realtime.messages';
    execute $policy$
      create policy crm_tenant_broadcast_read on realtime.messages for select to authenticated using (
        realtime.messages.extension = 'broadcast'
        and app_private.can_access_organization(app_private.realtime_topic_organization())
        and case app_private.realtime_topic_resource()
          when 'leads' then app_private.has_permission(app_private.realtime_topic_organization(), 'lead.view')
          when 'customers' then app_private.has_permission(app_private.realtime_topic_organization(), 'customer.view')
          when 'communications' then app_private.has_permission(app_private.realtime_topic_organization(), 'message.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'call.view')
          when 'work' then app_private.has_permission(app_private.realtime_topic_organization(), 'lead.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'followup.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'appointment.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'task.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'test_drive.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'test_drive.manage')
          when 'notifications' then true
          when 'integrations' then app_private.has_permission(app_private.realtime_topic_organization(), 'integration.view')
          when 'support' then app_private.has_permission(app_private.realtime_topic_organization(), 'support.request') or app_private.has_permission(app_private.realtime_topic_organization(), 'support.approve')
          when 'administration' then app_private.tenant_user_mode_allowed(auth.uid(), 'CLIENT_ADMIN_BOOTSTRAP') or app_private.has_permission(app_private.realtime_topic_organization(), 'branch.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'team.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'user.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'role.manage')
          when 'inventory' then app_private.has_permission(app_private.realtime_topic_organization(), 'inventory.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'inventory.stock_check')
          when 'sales' then app_private.has_permission(app_private.realtime_topic_organization(), 'quotation.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'quotation.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'booking.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'booking.manage')
          when 'operations' then app_private.has_permission(app_private.realtime_topic_organization(), 'finance.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'finance.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'insurance.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'insurance.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'rto.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'rto.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'exchange.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'exchange.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'delivery.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'delivery.manage')
          when 'customer-care' then app_private.has_permission(app_private.realtime_topic_organization(), 'customer_care.view')
          else false
        end
      )
    $policy$;
  end if;
end $$;

drop trigger if exists realtime_customer_care_cases_invalidate on public.customer_care_cases;
create trigger realtime_customer_care_cases_invalidate after insert or update
on public.customer_care_cases for each row
execute function app_private.broadcast_tenant_invalidation('customer-care');
drop trigger if exists realtime_feedback_requests_customer_care_invalidate on public.feedback_requests;
create trigger realtime_feedback_requests_customer_care_invalidate after insert or update
on public.feedback_requests for each row
execute function app_private.broadcast_tenant_invalidation('customer-care');
drop trigger if exists realtime_complaints_customer_care_invalidate on public.complaints;
create trigger realtime_complaints_customer_care_invalidate after insert or update
on public.complaints for each row
execute function app_private.broadcast_tenant_invalidation('customer-care');
drop trigger if exists realtime_escalations_customer_care_invalidate on public.escalations;
create trigger realtime_escalations_customer_care_invalidate after insert or update
on public.escalations for each row
execute function app_private.broadcast_tenant_invalidation('customer-care');

alter table public.customer_care_cases validate constraint customer_care_cases_branch_org_fk;
alter table public.customer_care_cases validate constraint customer_care_cases_customer_org_fk;
alter table public.customer_care_cases validate constraint customer_care_cases_booking_org_fk;
alter table public.customer_care_cases validate constraint customer_care_cases_assignee_org_fk;
alter table public.customer_care_cases validate constraint customer_care_cases_creator_org_fk;
alter table public.customer_care_cases validate constraint customer_care_cases_vehicle_org_fk;
alter table public.feedback_requests validate constraint feedback_requests_customer_case_org_fk;
alter table public.complaints validate constraint complaints_customer_case_org_fk;
alter table public.escalations validate constraint escalations_customer_case_org_fk;

revoke all on function public.get_customer_care_workspace_page(text, text, integer, integer, text, text) from public, anon;
grant execute on function public.get_customer_care_workspace_page(text, text, integer, integer, text, text) to authenticated;
revoke all on function public.get_customer_care_customer_options(text, integer) from public, anon;
grant execute on function public.get_customer_care_customer_options(text, integer) to authenticated;
revoke all on function public.create_customer_care_case(uuid, uuid, uuid, text, text, text, text, uuid, uuid) from public, anon;
grant execute on function public.create_customer_care_case(uuid, uuid, uuid, text, text, text, text, uuid, uuid) to authenticated;
revoke all on function public.update_customer_care_case(uuid, bigint, text, text, text, smallint, text, text, text, text, uuid) from public, anon;
grant execute on function public.update_customer_care_case(uuid, bigint, text, text, text, smallint, text, text, text, text, uuid) to authenticated;
revoke all on function app_private.apply_default_customer_care_permissions() from public, anon, authenticated;
revoke all on function app_private.customer_care_transition_allowed(text, text) from public, anon, authenticated;
revoke all on function app_private.customer_care_request_fingerprint(jsonb) from public, anon, authenticated;
revoke all on function app_private.replay_customer_care_request(uuid, text, uuid, text) from public, anon, authenticated;

commit;
