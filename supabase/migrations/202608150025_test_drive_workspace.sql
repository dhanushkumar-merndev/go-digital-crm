begin;

-- Test drives remain a separately authorized sales workflow. Existing custom
-- roles keep explicit control; frozen tenant roles are backfilled below.
insert into public.permissions (permission_key, module, description)
values ('test_drive.manage', 'test-drives', 'Schedule and progress test drives within authorized data scope')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.system_role
  and role_row.role_key in (
    'client_admin', 'system_administrator', 'showroom_manager',
    'team_manager', 'sales_consultant'
  )
  and permission_row.permission_key = 'test_drive.manage'
on conflict do nothing;

create or replace function app_private.apply_default_test_drive_role_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is not null
    and new.system_role
    and new.role_key in (
      'client_admin', 'system_administrator', 'showroom_manager',
      'team_manager', 'sales_consultant'
    )
  then
    insert into public.role_permissions (role_id, permission_id)
    select new.id, permission_row.id
    from public.permissions permission_row
    where permission_row.permission_key = 'test_drive.manage'
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists roles_apply_default_test_drive_permissions on public.roles;
create trigger roles_apply_default_test_drive_permissions
after insert or update of role_key, system_role on public.roles
for each row execute function app_private.apply_default_test_drive_role_permissions();

alter table public.test_drive_appointments
  add column if not exists version bigint not null default 1,
  add column if not exists expected_duration_minutes integer not null default 60,
  add column if not exists start_location jsonb,
  add column if not exists vehicle_registration text,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.test_drives
  add column if not exists version bigint not null default 1,
  add column if not exists route_finalized_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.test_drive_feedback
  add column if not exists driving_experience_rating smallint,
  add column if not exists comfort_rating smallint,
  add column if not exists features_rating smallint,
  add column if not exists performance_rating smallint,
  add column if not exists price_perception_rating smallint,
  add column if not exists overall_rating smallint,
  add column if not exists competitor_compared text,
  add column if not exists purchase_intent text,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

alter table public.test_drive_appointments drop constraint if exists test_drive_appointments_status_check;
alter table public.test_drive_appointments
  add constraint test_drive_appointments_status_check
  check (status in ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED')) not valid;
alter table public.test_drive_appointments drop constraint if exists test_drive_appointments_schedule_check;
alter table public.test_drive_appointments
  add constraint test_drive_appointments_schedule_check
  check (
    version > 0
    and expected_duration_minutes between 15 and 480
    and (vehicle_registration is null or char_length(btrim(vehicle_registration)) between 4 and 24)
    and (
      status <> 'CANCELLED'
      or (
        cancelled_at is not null
        and char_length(btrim(cancellation_reason)) between 5 and 1000
      )
    )
  ) not valid;

alter table public.test_drives drop constraint if exists test_drives_status_check;
alter table public.test_drives
  add constraint test_drives_status_check
  check (status in ('READY', 'ACTIVE', 'COMPLETED', 'CANCELLED')) not valid;
alter table public.test_drives drop constraint if exists test_drives_lifecycle_check;
alter table public.test_drives
  add constraint test_drives_lifecycle_check
  check (
    version > 0
    and (start_odometer is null or start_odometer between 0 and 2000000)
    and (end_odometer is null or end_odometer between 0 and 2000000)
    and (end_odometer is null or start_odometer is null or end_odometer >= start_odometer)
    and (distance_meters is null or distance_meters >= 0)
    and (duration_seconds is null or duration_seconds >= 0)
    and (route_finalized_at is null or status = 'COMPLETED')
    and (
      status <> 'CANCELLED'
      or (
        cancelled_at is not null
        and char_length(btrim(cancellation_reason)) between 5 and 1000
      )
    )
  ) not valid;

alter table public.test_drive_feedback drop constraint if exists test_drive_feedback_detail_check;
alter table public.test_drive_feedback
  add constraint test_drive_feedback_detail_check
  check (
    version > 0
    and (driving_experience_rating is null or driving_experience_rating between 1 and 5)
    and (comfort_rating is null or comfort_rating between 1 and 5)
    and (features_rating is null or features_rating between 1 and 5)
    and (performance_rating is null or performance_rating between 1 and 5)
    and (price_perception_rating is null or price_perception_rating between 1 and 5)
    and (overall_rating is null or overall_rating between 1 and 5)
    and (competitor_compared is null or char_length(btrim(competitor_compared)) <= 160)
    and (comments is null or char_length(btrim(comments)) <= 2000)
    and (
      purchase_intent is null
      or purchase_intent in ('HIGHLY_INTERESTED', 'INTERESTED', 'CONSIDERING', 'NOT_INTERESTED')
    )
  ) not valid;

create unique index if not exists test_drive_appointments_org_id_unique_idx
  on public.test_drive_appointments (organization_id, id);
create unique index if not exists test_drives_org_id_unique_idx
  on public.test_drives (organization_id, id);
create index if not exists test_drive_appointments_workspace_idx
  on public.test_drive_appointments (organization_id, status, scheduled_at, id);
create index if not exists test_drive_appointments_scope_workspace_idx
  on public.test_drive_appointments (organization_id, branch_id, team_id, scheduled_at, id);
create index if not exists test_drives_workspace_idx
  on public.test_drives (organization_id, status, updated_at desc, id desc);
create index if not exists test_drives_owner_workspace_idx
  on public.test_drives (organization_id, assigned_user_id, status, updated_at desc, id desc);
create unique index if not exists test_drives_one_per_appointment_idx
  on public.test_drives (organization_id, appointment_id)
  where appointment_id is not null;
create unique index if not exists test_drive_active_vehicle_idx
  on public.test_drive_appointments (organization_id, stock_unit_id)
  where stock_unit_id is not null and status = 'ACTIVE';
create unique index if not exists test_drive_mutation_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action like 'test_drive.%';

alter table public.test_drive_appointments drop constraint if exists test_drive_appointments_branch_org_fk;
alter table public.test_drive_appointments
  add constraint test_drive_appointments_branch_org_fk
  foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.test_drive_appointments drop constraint if exists test_drive_appointments_team_org_fk;
alter table public.test_drive_appointments
  add constraint test_drive_appointments_team_org_fk
  foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.test_drive_appointments drop constraint if exists test_drive_appointments_customer_org_fk;
alter table public.test_drive_appointments
  add constraint test_drive_appointments_customer_org_fk
  foreign key (organization_id, customer_id)
  references public.customers (organization_id, id) not valid;
alter table public.test_drive_appointments drop constraint if exists test_drive_appointments_lead_org_fk;
alter table public.test_drive_appointments
  add constraint test_drive_appointments_lead_org_fk
  foreign key (organization_id, lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.test_drive_appointments drop constraint if exists test_drive_appointments_assignee_org_fk;
alter table public.test_drive_appointments
  add constraint test_drive_appointments_assignee_org_fk
  foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.test_drive_appointments drop constraint if exists test_drive_appointments_stock_org_fk;
alter table public.test_drive_appointments
  add constraint test_drive_appointments_stock_org_fk
  foreign key (organization_id, stock_unit_id)
  references public.stock_units (organization_id, id) not valid;

alter table public.test_drives drop constraint if exists test_drives_appointment_org_fk;
alter table public.test_drives
  add constraint test_drives_appointment_org_fk
  foreign key (organization_id, appointment_id)
  references public.test_drive_appointments (organization_id, id) not valid;
alter table public.test_drives drop constraint if exists test_drives_branch_org_fk;
alter table public.test_drives
  add constraint test_drives_branch_org_fk
  foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.test_drives drop constraint if exists test_drives_team_org_fk;
alter table public.test_drives
  add constraint test_drives_team_org_fk
  foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.test_drives drop constraint if exists test_drives_customer_org_fk;
alter table public.test_drives
  add constraint test_drives_customer_org_fk
  foreign key (organization_id, customer_id)
  references public.customers (organization_id, id) not valid;
alter table public.test_drives drop constraint if exists test_drives_lead_org_fk;
alter table public.test_drives
  add constraint test_drives_lead_org_fk
  foreign key (organization_id, lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.test_drives drop constraint if exists test_drives_assignee_org_fk;
alter table public.test_drives
  add constraint test_drives_assignee_org_fk
  foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid;

create or replace function app_private.test_drive_request_fingerprint(payload jsonb)
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

create or replace function app_private.replay_test_drive_request(
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
declare
  previous_action text;
  previous_metadata jsonb;
begin
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  select audit_row.action, audit_row.metadata
    into previous_action, previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action like 'test_drive.%'
  limit 1;
  if previous_action is null then return null; end if;
  if previous_action <> target_action
    or previous_metadata->>'fingerprint' is distinct from target_fingerprint
  then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return coalesce(previous_metadata->'result', '{}'::jsonb)
    || jsonb_build_object('replayed', true);
end;
$$;

create or replace function app_private.valid_test_drive_location(target_location jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  latitude double precision;
  longitude double precision;
begin
  if target_location is null then return true; end if;
  if jsonb_typeof(target_location) <> 'object'
    or octet_length(target_location::text) > 2000
  then return false; end if;
  if target_location ? 'label' and (
    jsonb_typeof(target_location->'label') <> 'string'
    or char_length(btrim(target_location->>'label')) not between 1 and 240
  ) then return false; end if;
  if (target_location ? 'latitude') <> (target_location ? 'longitude') then return false; end if;
  if target_location ? 'latitude' then
    if jsonb_typeof(target_location->'latitude') <> 'number'
      or jsonb_typeof(target_location->'longitude') <> 'number'
    then return false; end if;
    latitude := (target_location->>'latitude')::double precision;
    longitude := (target_location->>'longitude')::double precision;
    if latitude not between -90 and 90 or longitude not between -180 and 180 then
      return false;
    end if;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

drop policy if exists test_drive_appointments_read on public.test_drive_appointments;
create policy test_drive_appointments_read on public.test_drive_appointments
for select to authenticated using (
  app_private.has_permission(organization_id, 'test_drive.manage')
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(organization_id, branch_id, team_id, assigned_user_id)
  and app_private.can_access_customer(organization_id, customer_id)
  and (lead_id is null or app_private.can_access_lead(lead_id))
);

revoke insert, update, delete on public.test_drive_appointments from anon, authenticated;
revoke insert, update, delete on public.test_drives from anon, authenticated;
revoke insert, update, delete on public.test_drive_feedback from anon, authenticated;
revoke insert, update, delete on public.test_drive_route_summaries from anon, authenticated;
revoke insert, update, delete on public.test_drive_route_points from anon, authenticated;
revoke insert, update, delete on public.live_tracking_sessions from anon, authenticated;

create or replace function public.get_test_drive_workspace_page(
  target_view text default 'TODAY',
  target_search text default '',
  target_model text default '',
  target_from_date date default null,
  target_to_date date default null,
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'scheduled:asc',
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_model text := lower(btrim(coalesce(target_model, '')));
  search_uuid uuid;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if upper(coalesce(target_view, '')) not in ('TODAY', 'UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED')
    or char_length(normalized_search) > 160
    or char_length(normalized_model) > 120
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
    or target_sort not in ('scheduled:asc', 'scheduled:desc', 'updated:desc', 'customer:asc')
    or target_timezone not in ('Asia/Kolkata', 'UTC')
    or (target_from_date is not null and target_to_date is not null and target_from_date > target_to_date)
    or (target_from_date is not null and target_to_date is not null and target_to_date > target_from_date + 366)
  then
    raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_QUERY';
  end if;
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'TEST_DRIVE_VIEW_PERMISSION_REQUIRED';
  end if;

  with authorized as materialized (
    select
      drive_row.id,
      drive_row.organization_id,
      drive_row.appointment_id,
      drive_row.customer_id,
      drive_row.lead_id,
      drive_row.branch_id,
      drive_row.team_id,
      drive_row.assigned_user_id,
      drive_row.status,
      drive_row.version,
      appointment_row.scheduled_at,
      appointment_row.expected_duration_minutes,
      appointment_row.stock_unit_id,
      appointment_row.vehicle_registration,
      appointment_row.start_location,
      appointment_row.destination,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as assigned_user_name,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      stock_row.vin,
      stock_row.chassis_number,
      stock_row.color,
      drive_row.started_at,
      drive_row.reached_at,
      drive_row.completed_at,
      drive_row.start_odometer,
      drive_row.end_odometer,
      drive_row.distance_meters,
      drive_row.duration_seconds,
      drive_row.start_anchor,
      drive_row.reached_anchor,
      drive_row.end_anchor,
      drive_row.route_finalized_at,
      summary_row.id as route_summary_id,
      summary_row.point_count,
      feedback_row.id as feedback_id,
      feedback_row.overall_rating,
      feedback_row.purchase_intent,
      drive_row.cancelled_at,
      drive_row.cancellation_reason,
      drive_row.updated_at,
      case
        when drive_row.status = 'ACTIVE' then 'ANCHORS_ONLY_ACTIVE'
        when drive_row.status = 'COMPLETED' and summary_row.id is null then 'ROUTE_UPLOAD_PENDING'
        when summary_row.id is not null then 'ROUTE_FINALIZED'
        else 'NOT_STARTED'
      end as gps_status,
      (
        select quotation_row.status
        from public.quotations quotation_row
        where quotation_row.organization_id = drive_row.organization_id
          and quotation_row.customer_id = drive_row.customer_id
          and quotation_row.created_at >= coalesce(drive_row.completed_at, drive_row.created_at)
        order by quotation_row.created_at desc, quotation_row.id desc
        limit 1
      ) as quotation_status
    from public.test_drives drive_row
    join public.test_drive_appointments appointment_row
      on appointment_row.id = drive_row.appointment_id
     and appointment_row.organization_id = drive_row.organization_id
    join public.customers customer_row
      on customer_row.id = drive_row.customer_id
     and customer_row.organization_id = drive_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = drive_row.branch_id
     and branch_row.organization_id = drive_row.organization_id
    left join public.teams team_row
      on team_row.id = drive_row.team_id
     and team_row.organization_id = drive_row.organization_id
    join public.profiles profile_row
      on profile_row.id = drive_row.assigned_user_id
     and profile_row.organization_id = drive_row.organization_id
    left join public.stock_units stock_row
      on stock_row.id = appointment_row.stock_unit_id
     and stock_row.organization_id = drive_row.organization_id
    left join public.vehicle_variants variant_row
      on variant_row.id = stock_row.variant_id
     and variant_row.organization_id = stock_row.organization_id
    left join public.vehicle_models model_row
      on model_row.id = variant_row.model_id
     and model_row.organization_id = variant_row.organization_id
    left join public.vehicle_brands brand_row
      on brand_row.id = model_row.brand_id
     and brand_row.organization_id = model_row.organization_id
    left join public.test_drive_route_summaries summary_row
      on summary_row.test_drive_id = drive_row.id
     and summary_row.organization_id = drive_row.organization_id
    left join public.test_drive_feedback feedback_row
      on feedback_row.test_drive_id = drive_row.id
     and feedback_row.organization_id = drive_row.organization_id
    where drive_row.organization_id = current_organization_id
      and app_private.can_access_record(
        drive_row.organization_id,
        drive_row.branch_id,
        drive_row.team_id,
        drive_row.assigned_user_id
      )
      and (target_from_date is null or timezone(target_timezone, appointment_row.scheduled_at)::date >= target_from_date)
      and (target_to_date is null or timezone(target_timezone, appointment_row.scheduled_at)::date <= target_to_date)
      and (
        normalized_model = ''
        or position(normalized_model in lower(coalesce(brand_row.name, ''))) > 0
        or position(normalized_model in lower(coalesce(model_row.name, ''))) > 0
        or position(normalized_model in lower(coalesce(variant_row.name, ''))) > 0
      )
      and (
        normalized_search = ''
        or drive_row.id = search_uuid
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or position(normalized_search in lower(coalesce(stock_row.vin, ''))) > 0
        or position(normalized_search in lower(coalesce(appointment_row.vehicle_registration, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), filtered as materialized (
    select authorized_row.*
    from authorized authorized_row
    where case upper(target_view)
      when 'TODAY' then authorized_row.status = 'READY'
        and timezone(target_timezone, authorized_row.scheduled_at)::date
          = timezone(target_timezone, now())::date
      when 'UPCOMING' then authorized_row.status = 'READY'
        and timezone(target_timezone, authorized_row.scheduled_at)::date
          > timezone(target_timezone, now())::date
      when 'ACTIVE' then authorized_row.status = 'ACTIVE'
      when 'COMPLETED' then authorized_row.status = 'COMPLETED'
      when 'CANCELLED' then authorized_row.status = 'CANCELLED'
      else false
    end
  ), numbered as (
    select filtered_row.*,
      row_number() over (order by
        case when target_sort = 'scheduled:asc' then filtered_row.scheduled_at end asc,
        case when target_sort = 'scheduled:desc' then filtered_row.scheduled_at end desc,
        case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
        case when target_sort = 'customer:asc' then lower(filtered_row.customer_name) end asc,
        filtered_row.id desc
      ) as page_order
    from filtered filtered_row
  ), page_rows as (
    select numbered_row.*
    from numbered numbered_row
    order by numbered_row.page_order
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_row.page_order)
      from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'organization_id', current_organization_id,
    'timezone', target_timezone,
    'kpis', jsonb_build_object(
      'today', (select count(*) from authorized where status = 'READY'
        and timezone(target_timezone, scheduled_at)::date = timezone(target_timezone, now())::date),
      'upcoming', (select count(*) from authorized where status = 'READY'
        and timezone(target_timezone, scheduled_at)::date > timezone(target_timezone, now())::date),
      'active', (select count(*) from authorized where status = 'ACTIVE'),
      'completed_this_month', (select count(*) from authorized where status = 'COMPLETED'
        and date_trunc('month', timezone(target_timezone, completed_at))
          = date_trunc('month', timezone(target_timezone, now()))),
      'cancelled', (select count(*) from authorized where status = 'CANCELLED'),
      'converted', (select count(*) from authorized where status = 'COMPLETED' and quotation_status is not null)
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.get_test_drive_lead_options(
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if char_length(normalized_search) > 160 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_LEAD_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
    select lead_row.id as lead_id,
      lead_row.customer_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model,
      branch_row.name as branch_name,
      profile_row.full_name as assigned_user_name,
      lead_row.updated_at
    from public.leads lead_row
    join public.customers customer_row
      on customer_row.id = lead_row.customer_id
     and customer_row.organization_id = lead_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = lead_row.branch_id
     and branch_row.organization_id = lead_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    join public.profiles profile_row
      on profile_row.id = lead_row.assigned_user_id
     and profile_row.organization_id = lead_row.organization_id
     and profile_row.active
     and profile_row.deleted_at is null
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.lifecycle_status <> 'Lost'
      and app_private.can_access_record(
        lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or position(normalized_search in lower(coalesce(lead_row.interested_model, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
    order by lead_row.updated_at desc, lead_row.id desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.get_test_drive_vehicle_options(
  target_branch_id uuid,
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if target_branch_id is null or char_length(normalized_search) > 120 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_VEHICLE_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not app_private.can_access_branch(current_organization_id, target_branch_id)
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_VEHICLE_SCOPE_DENIED'; end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.received_at desc nulls last), '[]'::jsonb)
    into result
  from (
    select stock_row.id as stock_unit_id,
      stock_row.branch_id,
      stock_row.vin,
      stock_row.chassis_number,
      stock_row.color,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      stock_row.received_at
    from public.stock_units stock_row
    join public.vehicle_variants variant_row
      on variant_row.id = stock_row.variant_id
     and variant_row.organization_id = stock_row.organization_id
     and variant_row.active
    join public.vehicle_models model_row
      on model_row.id = variant_row.model_id
     and model_row.organization_id = variant_row.organization_id
     and model_row.active
    join public.vehicle_brands brand_row
      on brand_row.id = model_row.brand_id
     and brand_row.organization_id = model_row.organization_id
     and brand_row.active
    where stock_row.organization_id = current_organization_id
      and stock_row.branch_id = target_branch_id
      and stock_row.status = 'AVAILABLE'
      and stock_row.deleted_at is null
      and not exists (
        select 1 from public.test_drive_appointments appointment_row
        where appointment_row.organization_id = stock_row.organization_id
          and appointment_row.stock_unit_id = stock_row.id
          and appointment_row.status = 'ACTIVE'
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(stock_row.vin)) > 0
        or position(normalized_search in lower(stock_row.chassis_number)) > 0
        or position(normalized_search in lower(model_row.name)) > 0
        or position(normalized_search in lower(variant_row.name)) > 0
      )
    order by stock_row.received_at desc nulls last, stock_row.id desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.create_test_drive(
  target_lead_id uuid,
  target_stock_unit_id uuid,
  target_scheduled_at timestamptz,
  target_expected_duration_minutes integer,
  target_vehicle_registration text,
  target_start_location jsonb,
  target_destination jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  lead_row public.leads%rowtype;
  stock_row public.stock_units%rowtype;
  appointment_row public.test_drive_appointments%rowtype;
  drive_row public.test_drives%rowtype;
  normalized_registration text := upper(btrim(coalesce(target_vehicle_registration, '')));
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if target_request_id is null or target_lead_id is null or target_stock_unit_id is null
    or target_scheduled_at is null
    or target_expected_duration_minutes not between 15 and 480
    or target_scheduled_at < now() - interval '15 minutes'
    or target_scheduled_at > now() + interval '1 year'
    or normalized_registration !~ '^[A-Z0-9 -]{4,24}$'
    or not app_private.valid_test_drive_location(target_start_location)
    or not app_private.valid_test_drive_location(target_destination)
  then raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_INPUT'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;
  select * into lead_row
  from public.leads source_row
  where source_row.id = target_lead_id
    and source_row.organization_id = current_organization_id
    and source_row.customer_id is not null
    and source_row.assigned_user_id is not null
    and source_row.deleted_at is null
    and source_row.lifecycle_status <> 'Lost';
  if not found then raise exception using errcode = 'P0002', message = 'TEST_DRIVE_LEAD_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
  ) then raise exception using errcode = '42501', message = 'TEST_DRIVE_SCOPE_DENIED'; end if;
  if not exists (
    select 1 from public.customers customer_row
    where customer_row.id = lead_row.customer_id
      and customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
  ) or not exists (
    select 1 from public.profiles profile_row
    where profile_row.id = lead_row.assigned_user_id
      and profile_row.organization_id = current_organization_id
      and profile_row.active
      and profile_row.deleted_at is null
  ) then raise exception using errcode = '42501', message = 'TEST_DRIVE_RELATION_DENIED'; end if;

  fingerprint := app_private.test_drive_request_fingerprint(jsonb_build_object(
    'lead_id', target_lead_id,
    'stock_unit_id', target_stock_unit_id,
    'scheduled_at', target_scheduled_at,
    'duration', target_expected_duration_minutes,
    'registration', normalized_registration,
    'start_location', target_start_location,
    'destination', target_destination
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_test_drive_request(
    current_organization_id, 'test_drive.created', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':test-drive-stock:' || target_stock_unit_id::text, 0
  ));
  select * into stock_row
  from public.stock_units source_row
  where source_row.id = target_stock_unit_id
    and source_row.organization_id = current_organization_id
    and source_row.branch_id = lead_row.branch_id
    and source_row.status = 'AVAILABLE'
    and source_row.deleted_at is null
  for update;
  if not found then raise exception using errcode = '23514', message = 'TEST_DRIVE_VEHICLE_UNAVAILABLE'; end if;
  if exists (
    select 1 from public.test_drive_appointments existing_row
    where existing_row.organization_id = current_organization_id
      and existing_row.stock_unit_id = target_stock_unit_id
      and existing_row.status in ('SCHEDULED', 'ACTIVE')
      and existing_row.scheduled_at < target_scheduled_at + make_interval(mins => target_expected_duration_minutes)
      and existing_row.scheduled_at + make_interval(mins => existing_row.expected_duration_minutes) > target_scheduled_at
  ) then raise exception using errcode = '23P01', message = 'TEST_DRIVE_VEHICLE_SCHEDULE_CONFLICT'; end if;

  insert into public.test_drive_appointments (
    organization_id, branch_id, team_id, customer_id, lead_id,
    assigned_user_id, stock_unit_id, scheduled_at, status, destination,
    expected_duration_minutes, start_location, vehicle_registration, created_by
  ) values (
    current_organization_id, lead_row.branch_id, lead_row.team_id, lead_row.customer_id,
    lead_row.id, lead_row.assigned_user_id, stock_row.id, target_scheduled_at,
    'SCHEDULED', target_destination, target_expected_duration_minutes,
    target_start_location, normalized_registration, auth.uid()
  ) returning * into appointment_row;
  insert into public.test_drives (
    organization_id, branch_id, team_id, appointment_id, customer_id,
    lead_id, assigned_user_id, status
  ) values (
    current_organization_id, lead_row.branch_id, lead_row.team_id, appointment_row.id,
    lead_row.customer_id, lead_row.id, lead_row.assigned_user_id, 'READY'
  ) returning * into drive_row;
  if lead_row.lifecycle_status not in ('Appointment Scheduled', 'Transferred to Sales') then
    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      current_organization_id, lead_row.id, lead_row.lifecycle_status,
      'Appointment Scheduled', auth.uid(), 'Test drive scheduled'
    );
    update public.leads set lifecycle_status = 'Appointment Scheduled', updated_at = clock_timestamp()
    where id = lead_row.id and organization_id = current_organization_id;
  end if;
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, lead_row.customer_id, lead_row.id,
    'TEST_DRIVE_SCHEDULED', auth.uid(), jsonb_build_object(
      'test_drive_id', drive_row.id,
      'appointment_id', appointment_row.id,
      'scheduled_at', target_scheduled_at,
      'stock_unit_id', stock_row.id
    )
  );
  result := jsonb_build_object(
    'id', drive_row.id,
    'appointment_id', appointment_row.id,
    'version', drive_row.version,
    'status', drive_row.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'test_drive.created', 'test_drive',
    drive_row.id::text, drive_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result,
      'stock_unit_id', stock_row.id, 'assigned_user_id', drive_row.assigned_user_id)
  );
  return result;
end;
$$;

create or replace function public.cancel_test_drive(
  target_test_drive_id uuid,
  expected_version bigint,
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
  drive_row public.test_drives%rowtype;
  normalized_reason text := btrim(coalesce(target_reason, ''));
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_test_drive_id is null or expected_version is null or expected_version < 1
    or target_request_id is null or char_length(normalized_reason) not between 5 and 1000
  then raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_CANCELLATION'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.test_drive_request_fingerprint(jsonb_build_object(
    'test_drive_id', target_test_drive_id, 'expected_version', expected_version, 'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_test_drive_request(
    current_organization_id, 'test_drive.cancelled', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into drive_row from public.test_drives source_row
  where source_row.id = target_test_drive_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'TEST_DRIVE_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
  ) then raise exception using errcode = '42501', message = 'TEST_DRIVE_SCOPE_DENIED'; end if;
  if drive_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'TEST_DRIVE_VERSION_CONFLICT';
  end if;
  if drive_row.status <> 'READY' then
    raise exception using errcode = '23514', message = 'TEST_DRIVE_CANCELLATION_NOT_ALLOWED';
  end if;
  update public.test_drives set status = 'CANCELLED', cancelled_at = now(),
    cancellation_reason = normalized_reason, version = version + 1, updated_at = now()
  where id = drive_row.id returning * into drive_row;
  update public.test_drive_appointments set status = 'CANCELLED', cancelled_at = drive_row.cancelled_at,
    cancellation_reason = normalized_reason, version = version + 1, updated_at = now()
  where id = drive_row.appointment_id and organization_id = drive_row.organization_id;
  result := jsonb_build_object('id', drive_row.id, 'version', drive_row.version,
    'status', drive_row.status, 'replayed', false);
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  values (drive_row.organization_id, drive_row.customer_id, drive_row.lead_id,
    'TEST_DRIVE_CANCELLED', auth.uid(), jsonb_build_object('test_drive_id', drive_row.id, 'reason', normalized_reason));
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    drive_row.organization_id, auth.uid(), 'test_drive.cancelled', 'test_drive', drive_row.id::text,
    drive_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result, 'reason', normalized_reason)
  );
  return result;
end;
$$;

-- The v2 anchor boundary is the only authenticated lifecycle writer. It adds
-- optimistic concurrency and replay safety without weakening the validated
-- legacy route parser used by finalization.
create or replace function public.record_test_drive_anchor_v2(
  target_test_drive_id uuid,
  anchor_kind text,
  latitude double precision,
  longitude double precision,
  recorded_at timestamptz,
  odometer integer,
  expected_version bigint,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  drive_row public.test_drives%rowtype;
  anchor jsonb;
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_test_drive_id is null or anchor_kind not in ('start', 'reached', 'end')
    or recorded_at is null or recorded_at > now() + interval '5 minutes'
    or recorded_at < now() - interval '7 days'
    or latitude is null or longitude is null
    or latitude not between -90 and 90 or longitude not between -180 and 180
    or (odometer is not null and odometer not between 0 and 2000000)
    or expected_version is null or expected_version < 1 or target_request_id is null
    or (anchor_kind in ('start', 'end') and odometer is null)
    or (anchor_kind = 'reached' and odometer is not null)
  then raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_ANCHOR'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.test_drive_request_fingerprint(jsonb_build_object(
    'test_drive_id', target_test_drive_id, 'kind', anchor_kind,
    'latitude', latitude, 'longitude', longitude, 'recorded_at', recorded_at,
    'odometer', odometer, 'expected_version', expected_version
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_test_drive_request(
    current_organization_id, 'test_drive.anchor.' || anchor_kind, target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into drive_row from public.test_drives source_row
  where source_row.id = target_test_drive_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'TEST_DRIVE_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
  ) then raise exception using errcode = '42501', message = 'TEST_DRIVE_SCOPE_DENIED'; end if;
  if drive_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'TEST_DRIVE_VERSION_CONFLICT';
  end if;
  anchor := jsonb_build_object('latitude', latitude, 'longitude', longitude, 'recorded_at', recorded_at);
  if anchor_kind = 'start' then
    if drive_row.status <> 'READY' then raise exception using errcode = '23514', message = 'INVALID_START_TRANSITION'; end if;
    if not exists (
      select 1 from public.test_drive_appointments appointment_row
      join public.stock_units stock_row
        on stock_row.id = appointment_row.stock_unit_id
       and stock_row.organization_id = appointment_row.organization_id
       and stock_row.branch_id = appointment_row.branch_id
       and stock_row.status = 'AVAILABLE'
       and stock_row.deleted_at is null
      where appointment_row.id = drive_row.appointment_id
        and appointment_row.organization_id = drive_row.organization_id
        and appointment_row.status = 'SCHEDULED'
    ) then raise exception using errcode = '23514', message = 'TEST_DRIVE_VEHICLE_UNAVAILABLE'; end if;
    update public.test_drives set status = 'ACTIVE', started_at = recorded_at,
      start_anchor = anchor, start_odometer = odometer, version = version + 1, updated_at = now()
    where id = drive_row.id returning * into drive_row;
    update public.test_drive_appointments set status = 'ACTIVE', version = version + 1, updated_at = now()
    where id = drive_row.appointment_id and organization_id = drive_row.organization_id;
  elsif anchor_kind = 'reached' then
    if drive_row.status <> 'ACTIVE' or drive_row.reached_at is not null
      or drive_row.started_at is null or recorded_at < drive_row.started_at
    then raise exception using errcode = '23514', message = 'INVALID_REACHED_TRANSITION'; end if;
    update public.test_drives set reached_at = recorded_at, reached_anchor = anchor,
      version = version + 1, updated_at = now()
    where id = drive_row.id returning * into drive_row;
  else
    if drive_row.status <> 'ACTIVE' or drive_row.started_at is null
      or drive_row.start_odometer is null or odometer < drive_row.start_odometer
      or recorded_at < drive_row.started_at
      or recorded_at > drive_row.started_at + interval '24 hours'
      or (drive_row.reached_at is not null and recorded_at < drive_row.reached_at)
    then raise exception using errcode = '23514', message = 'INVALID_END_TRANSITION'; end if;
    update public.test_drives set status = 'COMPLETED', completed_at = recorded_at,
      end_anchor = anchor, end_odometer = odometer,
      duration_seconds = greatest(0, extract(epoch from recorded_at - drive_row.started_at)::integer),
      distance_meters = (odometer - drive_row.start_odometer) * 1000,
      version = version + 1, updated_at = now()
    where id = drive_row.id returning * into drive_row;
    update public.test_drive_appointments set status = 'COMPLETED', version = version + 1, updated_at = now()
    where id = drive_row.appointment_id and organization_id = drive_row.organization_id;
    update public.live_tracking_sessions set ended_at = coalesce(ended_at, recorded_at)
    where organization_id = drive_row.organization_id
      and test_drive_id = drive_row.id and ended_at is null;
  end if;
  result := jsonb_build_object('id', drive_row.id, 'version', drive_row.version,
    'status', drive_row.status, 'replayed', false);
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  values (drive_row.organization_id, drive_row.customer_id, drive_row.lead_id,
    'TEST_DRIVE_' || upper(anchor_kind), auth.uid(),
    jsonb_build_object('test_drive_id', drive_row.id, 'recorded_at', recorded_at));
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    drive_row.organization_id, auth.uid(), 'test_drive.anchor.' || anchor_kind,
    'test_drive', drive_row.id::text, drive_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result, 'recorded_at', recorded_at)
  );
  return result;
end;
$$;

create or replace function public.finalize_test_drive_route_v2(
  target_test_drive_id uuid,
  route_points jsonb,
  encoded_polyline text,
  expected_version bigint,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  drive_row public.test_drives%rowtype;
  summary_id uuid;
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_test_drive_id is null or expected_version is null or expected_version < 1
    or target_request_id is null or route_points is null or jsonb_typeof(route_points) <> 'array'
    or jsonb_array_length(route_points) > 2000
    or (encoded_polyline is not null and char_length(encoded_polyline) > 100000)
  then raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_ROUTE'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.test_drive_request_fingerprint(jsonb_build_object(
    'test_drive_id', target_test_drive_id, 'route_points', route_points,
    'encoded_polyline', encoded_polyline, 'expected_version', expected_version
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_test_drive_request(
    current_organization_id, 'test_drive.route.finalized', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into drive_row from public.test_drives source_row
  where source_row.id = target_test_drive_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'TEST_DRIVE_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
  ) then raise exception using errcode = '42501', message = 'TEST_DRIVE_SCOPE_DENIED'; end if;
  if drive_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'TEST_DRIVE_VERSION_CONFLICT';
  end if;
  if drive_row.status <> 'COMPLETED' or drive_row.route_finalized_at is not null then
    raise exception using errcode = '23514', message = 'TEST_DRIVE_ROUTE_FINALIZATION_NOT_ALLOWED';
  end if;
  summary_id := public.finalize_test_drive_route(target_test_drive_id, route_points, encoded_polyline);
  update public.test_drives set route_finalized_at = now(), version = version + 1, updated_at = now()
  where id = drive_row.id returning * into drive_row;
  result := jsonb_build_object('id', drive_row.id, 'route_summary_id', summary_id,
    'version', drive_row.version, 'status', drive_row.status, 'replayed', false);
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    drive_row.organization_id, auth.uid(), 'test_drive.route.finalized', 'test_drive',
    drive_row.id::text, drive_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result,
      'summary_id', summary_id, 'point_count', jsonb_array_length(route_points))
  );
  return result;
end;
$$;

create or replace function public.save_test_drive_feedback(
  target_test_drive_id uuid,
  expected_version bigint,
  target_driving_experience_rating integer,
  target_comfort_rating integer,
  target_features_rating integer,
  target_performance_rating integer,
  target_price_perception_rating integer,
  target_overall_rating integer,
  target_comments text,
  target_competitor_compared text,
  target_purchase_intent text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  drive_row public.test_drives%rowtype;
  feedback_row public.test_drive_feedback%rowtype;
  normalized_comments text := nullif(btrim(coalesce(target_comments, '')), '');
  normalized_competitor text := nullif(btrim(coalesce(target_competitor_compared, '')), '');
  normalized_intent text := upper(btrim(coalesce(target_purchase_intent, '')));
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_test_drive_id is null or expected_version is null or expected_version < 1
    or target_request_id is null
    or target_driving_experience_rating not between 1 and 5
    or target_comfort_rating not between 1 and 5
    or target_features_rating not between 1 and 5
    or target_performance_rating not between 1 and 5
    or target_price_perception_rating not between 1 and 5
    or target_overall_rating not between 1 and 5
    or char_length(coalesce(normalized_comments, '')) > 2000
    or char_length(coalesce(normalized_competitor, '')) > 160
    or normalized_intent not in ('HIGHLY_INTERESTED', 'INTERESTED', 'CONSIDERING', 'NOT_INTERESTED')
  then raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_FEEDBACK'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.test_drive_request_fingerprint(jsonb_build_object(
    'test_drive_id', target_test_drive_id, 'expected_version', expected_version,
    'driving', target_driving_experience_rating, 'comfort', target_comfort_rating,
    'features', target_features_rating, 'performance', target_performance_rating,
    'price', target_price_perception_rating, 'overall', target_overall_rating,
    'comments', normalized_comments, 'competitor', normalized_competitor,
    'purchase_intent', normalized_intent
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_test_drive_request(
    current_organization_id, 'test_drive.feedback.saved', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into drive_row from public.test_drives source_row
  where source_row.id = target_test_drive_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'TEST_DRIVE_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
  ) then raise exception using errcode = '42501', message = 'TEST_DRIVE_SCOPE_DENIED'; end if;
  if drive_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'TEST_DRIVE_VERSION_CONFLICT';
  end if;
  if drive_row.status <> 'COMPLETED' or drive_row.route_finalized_at is null then
    raise exception using errcode = '23514', message = 'TEST_DRIVE_FEEDBACK_NOT_ALLOWED';
  end if;
  insert into public.test_drive_feedback (
    organization_id, test_drive_id, vehicle_rating, consultant_rating, comments,
    driving_experience_rating, comfort_rating, features_rating, performance_rating,
    price_perception_rating, overall_rating, competitor_compared, purchase_intent
  ) values (
    drive_row.organization_id, drive_row.id, target_driving_experience_rating,
    target_overall_rating, normalized_comments, target_driving_experience_rating,
    target_comfort_rating, target_features_rating, target_performance_rating,
    target_price_perception_rating, target_overall_rating, normalized_competitor, normalized_intent
  )
  on conflict (test_drive_id) do update set
    vehicle_rating = excluded.vehicle_rating,
    consultant_rating = excluded.consultant_rating,
    comments = excluded.comments,
    driving_experience_rating = excluded.driving_experience_rating,
    comfort_rating = excluded.comfort_rating,
    features_rating = excluded.features_rating,
    performance_rating = excluded.performance_rating,
    price_perception_rating = excluded.price_perception_rating,
    overall_rating = excluded.overall_rating,
    competitor_compared = excluded.competitor_compared,
    purchase_intent = excluded.purchase_intent,
    version = public.test_drive_feedback.version + 1,
    updated_at = now()
  returning * into feedback_row;
  update public.test_drives set version = version + 1, updated_at = now()
  where id = drive_row.id returning * into drive_row;
  result := jsonb_build_object('id', drive_row.id, 'feedback_id', feedback_row.id,
    'version', drive_row.version, 'status', drive_row.status, 'replayed', false);
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  values (drive_row.organization_id, drive_row.customer_id, drive_row.lead_id,
    'TEST_DRIVE_FEEDBACK_SAVED', auth.uid(),
    jsonb_build_object('test_drive_id', drive_row.id, 'overall_rating', target_overall_rating,
      'purchase_intent', normalized_intent));
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    drive_row.organization_id, auth.uid(), 'test_drive.feedback.saved', 'test_drive',
    drive_row.id::text, drive_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result,
      'overall_rating', target_overall_rating, 'purchase_intent', normalized_intent)
  );
  return result;
end;
$$;

-- Existing authenticated clients must use the versioned boundaries above.
revoke all on function public.record_test_drive_anchor(
  uuid, text, double precision, double precision, timestamptz, integer
) from authenticated;
revoke all on function public.finalize_test_drive_route(uuid, jsonb, text) from authenticated;

revoke all on function public.get_test_drive_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) from public, anon;
grant execute on function public.get_test_drive_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) to authenticated;
revoke all on function public.get_test_drive_lead_options(text, integer) from public, anon;
grant execute on function public.get_test_drive_lead_options(text, integer) to authenticated;
revoke all on function public.get_test_drive_vehicle_options(uuid, text, integer) from public, anon;
grant execute on function public.get_test_drive_vehicle_options(uuid, text, integer) to authenticated;
revoke all on function public.create_test_drive(
  uuid, uuid, timestamptz, integer, text, jsonb, jsonb, uuid
) from public, anon;
grant execute on function public.create_test_drive(
  uuid, uuid, timestamptz, integer, text, jsonb, jsonb, uuid
) to authenticated;
revoke all on function public.cancel_test_drive(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.cancel_test_drive(uuid, bigint, text, uuid) to authenticated;
revoke all on function public.record_test_drive_anchor_v2(
  uuid, text, double precision, double precision, timestamptz, integer, bigint, uuid
) from public, anon;
grant execute on function public.record_test_drive_anchor_v2(
  uuid, text, double precision, double precision, timestamptz, integer, bigint, uuid
) to authenticated;
revoke all on function public.finalize_test_drive_route_v2(
  uuid, jsonb, text, bigint, uuid
) from public, anon;
grant execute on function public.finalize_test_drive_route_v2(
  uuid, jsonb, text, bigint, uuid
) to authenticated;
revoke all on function public.save_test_drive_feedback(
  uuid, bigint, integer, integer, integer, integer, integer, integer, text, text, text, uuid
) from public, anon;
grant execute on function public.save_test_drive_feedback(
  uuid, bigint, integer, integer, integer, integer, integer, integer, text, text, text, uuid
) to authenticated;

drop trigger if exists realtime_test_drive_appointments_invalidate on public.test_drive_appointments;
create trigger realtime_test_drive_appointments_invalidate
after insert or update on public.test_drive_appointments
for each row execute function app_private.broadcast_tenant_invalidation('work');
drop trigger if exists realtime_test_drives_invalidate on public.test_drives;
create trigger realtime_test_drives_invalidate
after insert or update on public.test_drives
for each row execute function app_private.broadcast_tenant_invalidation('work');
drop trigger if exists realtime_test_drive_summaries_invalidate on public.test_drive_route_summaries;
create trigger realtime_test_drive_summaries_invalidate
after insert or update on public.test_drive_route_summaries
for each row execute function app_private.broadcast_tenant_invalidation('work');
drop trigger if exists realtime_test_drive_feedback_invalidate on public.test_drive_feedback;
create trigger realtime_test_drive_feedback_invalidate
after insert or update on public.test_drive_feedback
for each row execute function app_private.broadcast_tenant_invalidation('work');

commit;
