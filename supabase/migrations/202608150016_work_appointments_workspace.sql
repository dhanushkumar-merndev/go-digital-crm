begin;

-- Follow-ups and appointments are first-class work resources.  Dedicated
-- permissions keep work authority separate from lead/customer visibility.
insert into public.permissions (permission_key, module, description) values
  ('followup.view', 'appointments', 'View follow-ups within authorized data scope'),
  ('followup.create', 'appointments', 'Schedule follow-ups within authorized data scope'),
  ('followup.update', 'appointments', 'Reschedule or edit authorized follow-ups'),
  ('followup.complete', 'appointments', 'Complete owned follow-ups'),
  ('followup.cancel', 'appointments', 'Cancel authorized follow-ups'),
  ('followup.assign', 'appointments', 'Assign or reassign follow-ups within authority scope'),
  ('followup.override_complete', 'appointments', 'Complete another user follow-up with an audited manager override'),
  ('appointment.view', 'appointments', 'View appointments within authorized data scope'),
  ('appointment.create', 'appointments', 'Schedule appointments within authorized data scope'),
  ('appointment.update', 'appointments', 'Confirm, reschedule, or update authorized appointments'),
  ('appointment.complete', 'appointments', 'Complete authorized appointments'),
  ('appointment.cancel', 'appointments', 'Cancel authorized appointments'),
  ('appointment.assign', 'appointments', 'Assign or reassign appointments within authority scope')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

-- Backfill the frozen system-role presets. Custom roles remain explicitly
-- controlled by tenant administrators.
insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
join public.permissions permission_row on (
  role_row.organization_id is not null
  and role_row.system_role
  and (
    (
      role_row.role_key in ('client_admin', 'system_administrator')
      and permission_row.permission_key in (
        'followup.view', 'followup.create', 'followup.update', 'followup.complete',
        'followup.cancel', 'followup.assign', 'followup.override_complete',
        'appointment.view', 'appointment.create', 'appointment.update',
        'appointment.complete', 'appointment.cancel', 'appointment.assign'
      )
    )
    or (
      role_row.role_key in ('telecaller_bdc', 'sales_consultant')
      and permission_row.permission_key in (
        'followup.view', 'followup.create', 'followup.update', 'followup.complete',
        'followup.cancel', 'appointment.view', 'appointment.create',
        'appointment.update', 'appointment.complete', 'appointment.cancel'
      )
    )
    or (
      role_row.role_key in ('team_manager', 'showroom_manager')
      and permission_row.permission_key in (
        'followup.view', 'followup.create', 'followup.update', 'followup.cancel',
        'followup.assign', 'appointment.view', 'appointment.create',
        'appointment.update', 'appointment.complete', 'appointment.cancel',
        'appointment.assign'
      )
    )
    or (
      role_row.role_key = 'customer_relationship_manager'
      and permission_row.permission_key in (
        'followup.view', 'followup.create', 'followup.update',
        'followup.complete', 'followup.cancel'
      )
    )
    or (
      role_row.role_key in ('gm_sales', 'business_owner')
      and permission_row.permission_key in ('followup.view', 'appointment.view')
    )
  )
)
on conflict do nothing;

-- New tenants are provisioned after migrations have run. This trigger applies
-- only to frozen system roles and therefore does not broaden custom roles.
create or replace function app_private.apply_default_work_role_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  permission_keys text[] := '{}';
begin
  if new.organization_id is null or not new.system_role then
    return new;
  end if;

  permission_keys := case
    when new.role_key in ('client_admin', 'system_administrator') then array[
      'followup.view', 'followup.create', 'followup.update', 'followup.complete',
      'followup.cancel', 'followup.assign', 'followup.override_complete',
      'appointment.view', 'appointment.create', 'appointment.update',
      'appointment.complete', 'appointment.cancel', 'appointment.assign'
    ]
    when new.role_key in ('telecaller_bdc', 'sales_consultant') then array[
      'followup.view', 'followup.create', 'followup.update', 'followup.complete',
      'followup.cancel', 'appointment.view', 'appointment.create',
      'appointment.update', 'appointment.complete', 'appointment.cancel'
    ]
    when new.role_key in ('team_manager', 'showroom_manager') then array[
      'followup.view', 'followup.create', 'followup.update', 'followup.cancel',
      'followup.assign', 'appointment.view', 'appointment.create',
      'appointment.update', 'appointment.complete', 'appointment.cancel',
      'appointment.assign'
    ]
    when new.role_key = 'customer_relationship_manager' then array[
      'followup.view', 'followup.create', 'followup.update',
      'followup.complete', 'followup.cancel'
    ]
    when new.role_key in ('gm_sales', 'business_owner') then array[
      'followup.view', 'appointment.view'
    ]
    else '{}'::text[]
  end;

  insert into public.role_permissions (role_id, permission_id)
  select new.id, permission_row.id
  from public.permissions permission_row
  where permission_row.permission_key = any(permission_keys)
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists roles_apply_default_work_permissions on public.roles;
create trigger roles_apply_default_work_permissions
after insert or update of role_key, system_role on public.roles
for each row execute function app_private.apply_default_work_role_permissions();

alter table public.followups
  add column version bigint not null default 1 check (version > 0),
  add column priority text not null default 'NORMAL',
  add column completion_note text,
  add column cancellation_reason text,
  add column cancelled_at timestamptz;

alter table public.appointments
  add column version bigint not null default 1 check (version > 0),
  add column created_by uuid references public.profiles(id),
  add column confirmed_at timestamptz,
  add column arrived_at timestamptz,
  add column completed_at timestamptz,
  add column cancelled_at timestamptz,
  add column cancellation_reason text;

alter table public.followups
  add constraint followups_priority_allowed
  check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')) not valid;
alter table public.followups validate constraint followups_priority_allowed;

-- NOT VALID protects migration availability if an older deployment contains
-- an out-of-contract appointment value while still enforcing all new writes.
alter table public.appointments
  add constraint appointments_status_allowed
  check (status in ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')) not valid;
alter table public.appointments
  add constraint appointments_attendance_allowed
  check (
    attendance_status is null
    or attendance_status in ('NOT_ARRIVED', 'ARRIVED', 'COMPLETED', 'NO_SHOW')
  ) not valid;

create index followups_org_status_due_page_idx
  on public.followups (organization_id, status, due_at, id);
create index followups_org_branch_team_due_page_idx
  on public.followups (organization_id, branch_id, team_id, due_at, id);
create index appointments_org_status_scheduled_page_idx
  on public.appointments (organization_id, status, scheduled_at, id);
create index appointments_org_branch_team_scheduled_page_idx
  on public.appointments (organization_id, branch_id, team_id, scheduled_at, id);

drop policy if exists followups_read on public.followups;
create policy followups_read on public.followups
for select to authenticated using (
  app_private.has_permission(organization_id, 'followup.view')
  and app_private.can_access_record(organization_id, branch_id, team_id, assigned_user_id)
  and (
    lead_id is null
    or app_private.can_access_lead(lead_id)
  )
  and (
    customer_id is null
    or (
      app_private.has_permission(organization_id, 'customer.view')
      and app_private.can_access_customer(organization_id, customer_id)
    )
  )
);

drop policy if exists appointments_read on public.appointments;
create policy appointments_read on public.appointments
for select to authenticated using (
  app_private.has_permission(organization_id, 'appointment.view')
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(organization_id, branch_id, team_id, assigned_user_id)
  and app_private.can_access_customer(organization_id, customer_id)
  and (
    lead_id is null
    or app_private.can_access_lead(lead_id)
  )
);

-- Writes are intentionally RPC-only. No broad insert/update/delete policy is
-- installed, and table grants are closed explicitly for defense in depth.
revoke insert, update, delete on public.followups from anon, authenticated;
revoke insert, update, delete on public.appointments from anon, authenticated;

create or replace function app_private.current_tenant_organization()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select profile_row.organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.organization_id is not null
    and profile_row.active
    and profile_row.deleted_at is null;
$$;

create or replace function app_private.user_can_receive_work(
  target_organization_id uuid,
  target_branch_id uuid,
  target_team_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile_row
    where profile_row.id = target_user_id
      and profile_row.organization_id = target_organization_id
      and profile_row.active
      and profile_row.deleted_at is null
      and (
        (
          target_team_id is not null
          and exists (
            select 1
            from public.teams team_row
            join public.team_members member_row
              on member_row.organization_id = team_row.organization_id
             and member_row.team_id = team_row.id
             and member_row.user_id = target_user_id
             and member_row.active
            where team_row.id = target_team_id
              and team_row.organization_id = target_organization_id
              and team_row.branch_id = target_branch_id
              and team_row.active
          )
        )
        or (
          target_team_id is null
          and (
            exists (
              select 1
              from public.user_branch_access access_row
              where access_row.organization_id = target_organization_id
                and access_row.user_id = target_user_id
                and access_row.branch_id = target_branch_id
            )
            or exists (
              select 1
              from public.user_role_assignments assignment_row
              where assignment_row.organization_id = target_organization_id
                and assignment_row.user_id = target_user_id
                and assignment_row.active
                and (
                  assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
                  or (
                    assignment_row.data_scope = 'ONE_BRANCH'
                    and assignment_row.scope_branch_id = target_branch_id
                  )
                  or (
                    assignment_row.data_scope = 'SELECTED_BRANCHES'
                    and target_branch_id = any(assignment_row.selected_branch_ids)
                  )
                )
            )
          )
        )
      )
  );
$$;

create or replace function app_private.validate_work_tenant_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  linked_lead public.leads%rowtype;
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.branch_id is distinct from old.branch_id
    or new.team_id is distinct from old.team_id
    or new.lead_id is distinct from old.lead_id
    or new.customer_id is distinct from old.customer_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  ) then
    raise exception using errcode = '42501', message = 'WORK_IDENTITY_IMMUTABLE';
  end if;
  if not exists (
    select 1 from public.branches branch_row
    where branch_row.id = new.branch_id
      and branch_row.organization_id = new.organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'WORK_BRANCH_NOT_IN_ORGANIZATION';
  end if;
  if new.team_id is not null and not exists (
    select 1 from public.teams team_row
    where team_row.id = new.team_id
      and team_row.organization_id = new.organization_id
      and team_row.branch_id = new.branch_id
      and team_row.active
  ) then
    raise exception using errcode = '23503', message = 'WORK_TEAM_NOT_IN_BRANCH';
  end if;
  if new.lead_id is not null then
    select * into linked_lead
    from public.leads lead_row
    where lead_row.id = new.lead_id
      and lead_row.organization_id = new.organization_id
      and lead_row.deleted_at is null;
    if not found then
      raise exception using errcode = '23503', message = 'WORK_LEAD_NOT_IN_ORGANIZATION';
    end if;
    if linked_lead.branch_id <> new.branch_id
      or linked_lead.team_id is distinct from new.team_id
      or (
        new.customer_id is not null
        and linked_lead.customer_id is distinct from new.customer_id
      )
    then
      raise exception using errcode = '23514', message = 'WORK_LEAD_CONTEXT_MISMATCH';
    end if;
  end if;
  if new.customer_id is not null and not exists (
    select 1 from public.customers customer_row
    where customer_row.id = new.customer_id
      and customer_row.organization_id = new.organization_id
      and customer_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'WORK_CUSTOMER_NOT_IN_ORGANIZATION';
  end if;
  if not app_private.user_can_receive_work(
    new.organization_id,
    new.branch_id,
    new.team_id,
    new.assigned_user_id
  ) then
    raise exception using errcode = '23503', message = 'WORK_ASSIGNEE_INVALID';
  end if;
  if new.created_by is not null and not exists (
    select 1 from public.profiles creator_row
    where creator_row.id = new.created_by
      and creator_row.organization_id = new.organization_id
      and creator_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'WORK_CREATOR_INVALID';
  end if;
  if tg_table_name = 'followups' then
    if new.status = 'COMPLETED' and new.completed_at is null then
      raise exception using errcode = '23514', message = 'FOLLOWUP_COMPLETION_TIMESTAMP_REQUIRED';
    end if;
    if new.status = 'CANCELLED'
      and (new.cancelled_at is null or nullif(btrim(new.cancellation_reason), '') is null)
    then
      raise exception using errcode = '23514', message = 'FOLLOWUP_CANCELLATION_DETAILS_REQUIRED';
    end if;
  elsif tg_table_name = 'appointments' then
    if new.status = 'COMPLETED'
      and (new.completed_at is null or new.attendance_status <> 'COMPLETED')
    then
      raise exception using errcode = '23514', message = 'APPOINTMENT_COMPLETION_DETAILS_REQUIRED';
    end if;
    if new.status = 'CANCELLED'
      and (new.cancelled_at is null or nullif(btrim(new.cancellation_reason), '') is null)
    then
      raise exception using errcode = '23514', message = 'APPOINTMENT_CANCELLATION_DETAILS_REQUIRED';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists followups_validate_tenant_integrity on public.followups;
create trigger followups_validate_tenant_integrity
before insert or update on public.followups
for each row execute function app_private.validate_work_tenant_integrity();

drop trigger if exists appointments_validate_tenant_integrity on public.appointments;
create trigger appointments_validate_tenant_integrity
before insert or update on public.appointments
for each row execute function app_private.validate_work_tenant_integrity();

create or replace function app_private.work_request_fingerprint(payload jsonb)
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

create or replace function app_private.replay_work_request(
  target_organization_id uuid,
  target_action text,
  target_request_id uuid,
  target_fingerprint text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  audit_metadata jsonb;
begin
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  select audit_row.metadata into audit_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = target_action
    and audit_row.request_id = target_request_id
  order by audit_row.created_at desc, audit_row.id desc
  limit 1;

  if found then
    if audit_metadata->>'request_fingerprint' is distinct from target_fingerprint then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_set(
      coalesce(audit_metadata->'result', '{}'::jsonb),
      '{replayed}',
      'true'::jsonb,
      true
    );
  end if;

  return null;
end;
$$;

create or replace function public.get_followup_workspace_page(
  target_search text default '',
  target_status text default 'all',
  target_priority text default 'all',
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null,
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
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  day_start timestamptz;
  day_end timestamptz;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if target_status not in ('all', 'overdue', 'today', 'upcoming', 'completed', 'cancelled') then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_FILTER';
  end if;
  if target_priority not in ('all', 'LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_PRIORITY_FILTER';
  end if;
  if target_sort not in (
    'scheduled:asc', 'scheduled:desc', 'updated:desc',
    'updated:asc', 'customer:asc', 'customer:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_WORK_SORT';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', now() at time zone target_timezone) at time zone target_timezone;
  day_end := day_start + interval '1 day';

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'followup.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if target_team_id is not null
    and not app_private.can_access_team(current_organization_id, target_team_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;

  with accessible_records as materialized (
    select
      followup_row.id,
      followup_row.version,
      followup_row.lead_id,
      followup_row.customer_id,
      coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer') as customer_name,
      coalesce(customer_row.primary_phone, lead_row.phone) as phone,
      lead_row.interested_model,
      followup_row.reason,
      followup_row.priority,
      followup_row.due_at,
      case
        when followup_row.status = 'OPEN' and followup_row.due_at < now() then 'OVERDUE'
        else followup_row.status
      end as display_status,
      followup_row.status,
      followup_row.assigned_user_id,
      assigned_profile.full_name as assigned_user_name,
      followup_row.created_by,
      creator_profile.full_name as created_by_name,
      followup_row.branch_id,
      branch_row.name as branch_name,
      followup_row.team_id,
      team_row.name as team_name,
      followup_row.completed_at,
      followup_row.cancelled_at,
      followup_row.updated_at
    from public.followups followup_row
    join public.branches branch_row
      on branch_row.id = followup_row.branch_id
     and branch_row.organization_id = followup_row.organization_id
    left join public.teams team_row
      on team_row.id = followup_row.team_id
     and team_row.organization_id = followup_row.organization_id
    left join public.leads lead_row
      on lead_row.id = followup_row.lead_id
     and lead_row.organization_id = followup_row.organization_id
     and lead_row.deleted_at is null
    left join public.customers customer_row
      on customer_row.id = followup_row.customer_id
     and customer_row.organization_id = followup_row.organization_id
     and customer_row.deleted_at is null
    join public.profiles assigned_profile
      on assigned_profile.id = followup_row.assigned_user_id
     and assigned_profile.organization_id = followup_row.organization_id
    left join public.profiles creator_profile
      on creator_profile.id = followup_row.created_by
     and creator_profile.organization_id = followup_row.organization_id
    where followup_row.organization_id = current_organization_id
      and app_private.can_access_record(
        followup_row.organization_id,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.assigned_user_id
      )
      and (followup_row.lead_id is null or app_private.can_access_lead(followup_row.lead_id))
      and (
        followup_row.customer_id is null
        or (
          app_private.has_permission(followup_row.organization_id, 'customer.view')
          and app_private.can_access_customer(
            followup_row.organization_id,
            followup_row.customer_id
          )
        )
      )
  ), scope_filtered as materialized (
    select record_row.*
    from accessible_records record_row
    where (target_branch_id is null or record_row.branch_id = target_branch_id)
      and (target_team_id is null or record_row.team_id = target_team_id)
      and (target_owner_id is null or record_row.assigned_user_id = target_owner_id)
      and (target_priority = 'all' or record_row.priority = target_priority)
  ), filtered_records as materialized (
    select record_row.*
    from scope_filtered record_row
    where (
      normalized_search = ''
      or record_row.id = search_uuid
      or record_row.lead_id = search_uuid
      or lower(record_row.customer_name) ilike '%' || normalized_search || '%'
      or (
        search_phone_digits <> ''
        and app_private.normalize_phone_digits(record_row.phone) like search_phone_digits || '%'
      )
    )
    and case target_status
      when 'overdue' then record_row.status = 'OPEN' and record_row.due_at < now()
      when 'today' then record_row.status = 'OPEN'
        and record_row.due_at >= day_start and record_row.due_at < day_end
      when 'upcoming' then record_row.status = 'OPEN' and record_row.due_at >= day_end
      when 'completed' then record_row.status = 'COMPLETED'
      when 'cancelled' then record_row.status = 'CANCELLED'
      else true
    end
  ), page_rows as (
    select record_row.*
    from filtered_records record_row
    order by
      case when target_sort = 'scheduled:asc' then record_row.due_at end asc,
      case when target_sort = 'scheduled:desc' then record_row.due_at end desc,
      case when target_sort = 'updated:desc' then record_row.updated_at end desc,
      case when target_sort = 'updated:asc' then record_row.updated_at end asc,
      case when target_sort = 'customer:asc' then lower(record_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(record_row.customer_name) end desc,
      record_row.id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(to_jsonb(page_row) order by
        case when target_sort = 'scheduled:asc' then page_row.due_at end asc,
        case when target_sort = 'scheduled:desc' then page_row.due_at end desc,
        case when target_sort = 'updated:desc' then page_row.updated_at end desc,
        case when target_sort = 'updated:asc' then page_row.updated_at end asc,
        case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
        case when target_sort = 'customer:desc' then lower(page_row.customer_name) end desc,
        page_row.id asc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_records),
    'kpis', jsonb_build_object(
      'overdue', (select count(*) from scope_filtered where status = 'OPEN' and due_at < now()),
      'today', (select count(*) from scope_filtered where status = 'OPEN' and due_at >= day_start and due_at < day_end),
      'upcoming', (select count(*) from scope_filtered where status = 'OPEN' and due_at >= day_end),
      'completed_today', (
        select count(*) from scope_filtered
        where status = 'COMPLETED' and completed_at >= day_start and completed_at < day_end
      )
    ),
    'filters', jsonb_build_object(
      'branches', coalesce((
        select jsonb_agg(jsonb_build_object('id', branch_id, 'name', branch_name) order by branch_name)
        from (select distinct branch_id, branch_name from accessible_records) branch_filter
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object('id', team_id, 'name', team_name, 'branch_id', branch_id) order by team_name)
        from (
          select distinct team_id, team_name, branch_id from accessible_records where team_id is not null
        ) team_filter
      ), '[]'::jsonb),
      'owners', coalesce((
        select jsonb_agg(jsonb_build_object('id', assigned_user_id, 'name', assigned_user_name) order by assigned_user_name)
        from (select distinct assigned_user_id, assigned_user_name from accessible_records) owner_filter
      ), '[]'::jsonb)
    ),
    'timezone', target_timezone
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_followup_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) from public, anon;
grant execute on function public.get_followup_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) to authenticated;

create or replace function public.get_appointment_workspace_page(
  target_search text default '',
  target_status text default 'all',
  target_appointment_type text default 'all',
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null,
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
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  day_start timestamptz;
  day_end timestamptz;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if target_status not in (
    'all', 'today', 'upcoming', 'confirmed', 'arrived', 'completed',
    'no-show', 'rescheduled', 'cancelled'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_FILTER';
  end if;
  if target_appointment_type not in ('all', 'Showroom Visit', 'Test Drive') then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TYPE_FILTER';
  end if;
  if target_sort not in (
    'scheduled:asc', 'scheduled:desc', 'updated:desc',
    'updated:asc', 'customer:asc', 'customer:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_WORK_SORT';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', now() at time zone target_timezone) at time zone target_timezone;
  day_end := day_start + interval '1 day';

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'appointment.view')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if target_team_id is not null
    and not app_private.can_access_team(current_organization_id, target_team_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;

  with accessible_records as materialized (
    select
      appointment_row.id,
      appointment_row.version,
      appointment_row.lead_id,
      appointment_row.customer_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model,
      appointment_row.appointment_type,
      appointment_row.scheduled_at,
      appointment_row.status,
      coalesce(appointment_row.attendance_status, 'NOT_ARRIVED') as attendance_status,
      appointment_row.notes,
      appointment_row.assigned_user_id,
      assigned_profile.full_name as assigned_user_name,
      appointment_row.created_by,
      creator_profile.full_name as created_by_name,
      appointment_row.branch_id,
      branch_row.name as branch_name,
      appointment_row.team_id,
      team_row.name as team_name,
      appointment_row.confirmed_at,
      appointment_row.arrived_at,
      appointment_row.completed_at,
      appointment_row.cancelled_at,
      appointment_row.updated_at
    from public.appointments appointment_row
    join public.customers customer_row
      on customer_row.id = appointment_row.customer_id
     and customer_row.organization_id = appointment_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = appointment_row.branch_id
     and branch_row.organization_id = appointment_row.organization_id
    left join public.teams team_row
      on team_row.id = appointment_row.team_id
     and team_row.organization_id = appointment_row.organization_id
    left join public.leads lead_row
      on lead_row.id = appointment_row.lead_id
     and lead_row.organization_id = appointment_row.organization_id
     and lead_row.deleted_at is null
    join public.profiles assigned_profile
      on assigned_profile.id = appointment_row.assigned_user_id
     and assigned_profile.organization_id = appointment_row.organization_id
    left join public.profiles creator_profile
      on creator_profile.id = appointment_row.created_by
     and creator_profile.organization_id = appointment_row.organization_id
    where appointment_row.organization_id = current_organization_id
      and app_private.can_access_record(
        appointment_row.organization_id,
        appointment_row.branch_id,
        appointment_row.team_id,
        appointment_row.assigned_user_id
      )
      and app_private.can_access_customer(
        appointment_row.organization_id,
        appointment_row.customer_id
      )
      and (
        appointment_row.lead_id is null
        or app_private.can_access_lead(appointment_row.lead_id)
      )
  ), scope_filtered as materialized (
    select record_row.*
    from accessible_records record_row
    where (target_branch_id is null or record_row.branch_id = target_branch_id)
      and (target_team_id is null or record_row.team_id = target_team_id)
      and (target_owner_id is null or record_row.assigned_user_id = target_owner_id)
      and (
        target_appointment_type = 'all'
        or record_row.appointment_type = target_appointment_type
      )
  ), filtered_records as materialized (
    select record_row.*
    from scope_filtered record_row
    where (
      normalized_search = ''
      or record_row.id = search_uuid
      or record_row.lead_id = search_uuid
      or lower(record_row.customer_name) ilike '%' || normalized_search || '%'
      or (
        search_phone_digits <> ''
        and app_private.normalize_phone_digits(record_row.phone) like search_phone_digits || '%'
      )
    )
    and case target_status
      when 'today' then record_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
        and record_row.scheduled_at >= day_start and record_row.scheduled_at < day_end
      when 'upcoming' then record_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
        and record_row.scheduled_at >= day_end
      when 'confirmed' then record_row.status = 'CONFIRMED'
      when 'arrived' then record_row.attendance_status = 'ARRIVED'
      when 'completed' then record_row.status = 'COMPLETED'
      when 'no-show' then record_row.status = 'NO_SHOW'
      when 'rescheduled' then record_row.status = 'RESCHEDULED'
      when 'cancelled' then record_row.status = 'CANCELLED'
      else true
    end
  ), page_rows as (
    select record_row.*
    from filtered_records record_row
    order by
      case when target_sort = 'scheduled:asc' then record_row.scheduled_at end asc,
      case when target_sort = 'scheduled:desc' then record_row.scheduled_at end desc,
      case when target_sort = 'updated:desc' then record_row.updated_at end desc,
      case when target_sort = 'updated:asc' then record_row.updated_at end asc,
      case when target_sort = 'customer:asc' then lower(record_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(record_row.customer_name) end desc,
      record_row.id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(to_jsonb(page_row) order by
        case when target_sort = 'scheduled:asc' then page_row.scheduled_at end asc,
        case when target_sort = 'scheduled:desc' then page_row.scheduled_at end desc,
        case when target_sort = 'updated:desc' then page_row.updated_at end desc,
        case when target_sort = 'updated:asc' then page_row.updated_at end asc,
        case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
        case when target_sort = 'customer:desc' then lower(page_row.customer_name) end desc,
        page_row.id asc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_records),
    'kpis', jsonb_build_object(
      'today', (
        select count(*) from scope_filtered
        where status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
          and scheduled_at >= day_start and scheduled_at < day_end
      ),
      'upcoming', (
        select count(*) from scope_filtered
        where status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW') and scheduled_at >= day_end
      ),
      'confirmed', (select count(*) from scope_filtered where status = 'CONFIRMED'),
      'completed', (select count(*) from scope_filtered where status = 'COMPLETED'),
      'no_show', (select count(*) from scope_filtered where status = 'NO_SHOW'),
      'arrived', (select count(*) from scope_filtered where attendance_status = 'ARRIVED')
    ),
    'filters', jsonb_build_object(
      'branches', coalesce((
        select jsonb_agg(jsonb_build_object('id', branch_id, 'name', branch_name) order by branch_name)
        from (select distinct branch_id, branch_name from accessible_records) branch_filter
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object('id', team_id, 'name', team_name, 'branch_id', branch_id) order by team_name)
        from (
          select distinct team_id, team_name, branch_id from accessible_records where team_id is not null
        ) team_filter
      ), '[]'::jsonb),
      'owners', coalesce((
        select jsonb_agg(jsonb_build_object('id', assigned_user_id, 'name', assigned_user_name) order by assigned_user_name)
        from (select distinct assigned_user_id, assigned_user_name from accessible_records) owner_filter
      ), '[]'::jsonb)
    ),
    'timezone', target_timezone
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_appointment_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) from public, anon;
grant execute on function public.get_appointment_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) to authenticated;

create or replace function public.get_work_create_options(
  target_kind text,
  target_search text default ''
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
  view_permission text;
  create_permission text;
  assign_permission text;
  lead_access boolean;
  can_assign boolean;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_kind not in ('followups', 'appointments') then
    raise exception using errcode = '22023', message = 'INVALID_WORK_KIND';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  current_organization_id := app_private.current_tenant_organization();
  view_permission := case target_kind
    when 'followups' then 'followup.view'
    else 'appointment.view'
  end;
  create_permission := case target_kind
    when 'followups' then 'followup.create'
    else 'appointment.create'
  end;
  assign_permission := case target_kind
    when 'followups' then 'followup.assign'
    else 'appointment.assign'
  end;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, view_permission)
    or not (
      app_private.has_permission(current_organization_id, create_permission)
      or app_private.has_permission(
        current_organization_id,
        case target_kind when 'followups' then 'followup.update' else 'appointment.update' end
      )
    )
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  lead_access := app_private.has_permission(current_organization_id, 'lead.view');
  can_assign := app_private.has_permission(current_organization_id, assign_permission);

  with lead_entities as materialized (
    select
      lead_row.id as lead_id,
      lead_row.customer_id,
      coalesce(customer_row.full_name, lead_row.customer_name) as customer_name,
      coalesce(customer_row.primary_phone, lead_row.phone) as phone,
      lead_row.interested_model,
      lead_row.branch_id,
      branch_row.name as branch_name,
      lead_row.team_id,
      team_row.name as team_name,
      lead_row.assigned_user_id as default_assigned_user_id,
      lead_row.updated_at
    from public.leads lead_row
    join public.branches branch_row
      on branch_row.id = lead_row.branch_id
     and branch_row.organization_id = lead_row.organization_id
    left join public.teams team_row
      on team_row.id = lead_row.team_id
     and team_row.organization_id = lead_row.organization_id
    left join public.customers customer_row
      on customer_row.id = lead_row.customer_id
     and customer_row.organization_id = lead_row.organization_id
     and customer_row.deleted_at is null
    where lead_access
      and lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.lifecycle_status <> 'Lost'
      and app_private.can_access_lead(lead_row.id)
      and (target_kind = 'followups' or lead_row.customer_id is not null)
      and (
        normalized_search = ''
        or lower(coalesce(customer_row.full_name, lead_row.customer_name))
          ilike '%' || normalized_search || '%'
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(
            coalesce(customer_row.primary_phone, lead_row.phone)
          ) like search_phone_digits || '%'
        )
      )
    order by lead_row.updated_at desc, lead_row.id
    limit 50
  ), customer_entities as materialized (
    select
      null::uuid as lead_id,
      customer_row.id as customer_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      anchor_row.interested_model,
      anchor_row.branch_id,
      branch_row.name as branch_name,
      null::uuid as team_id,
      null::text as team_name,
      auth.uid() as default_assigned_user_id,
      greatest(customer_row.updated_at, anchor_row.updated_at) as updated_at
    from public.customers customer_row
    join lateral (
      select
        lead_row.branch_id,
        lead_row.team_id,
        lead_row.interested_model,
        lead_row.assigned_user_id,
        lead_row.updated_at
      from public.leads lead_row
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
    ) anchor_row on true
    join public.branches branch_row
      on branch_row.id = anchor_row.branch_id
     and branch_row.organization_id = customer_row.organization_id
    where not lead_access
      and customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and app_private.can_access_customer(customer_row.organization_id, customer_row.id)
      and (
        normalized_search = ''
        or customer_row.normalized_name ilike '%' || normalized_search || '%'
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone)
            like search_phone_digits || '%'
        )
      )
    order by greatest(customer_row.updated_at, anchor_row.updated_at) desc, customer_row.id
    limit 50
  ), entities as materialized (
    select * from lead_entities
    union all
    select * from customer_entities
  ), users as materialized (
    select distinct
      profile_row.id,
      profile_row.full_name,
      entity_row.branch_id,
      entity_row.team_id
    from public.profiles profile_row
    join entities entity_row on (
      profile_row.id = auth.uid()
      or (
        can_assign
        and app_private.user_can_receive_work(
          current_organization_id,
          entity_row.branch_id,
          entity_row.team_id,
          profile_row.id
        )
      )
    )
    where profile_row.organization_id = current_organization_id
      and profile_row.active
      and profile_row.deleted_at is null
    order by profile_row.full_name, profile_row.id, entity_row.branch_id, entity_row.team_id
    limit 100
  )
  select jsonb_build_object(
    'entities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lead_id', entity_row.lead_id,
        'customer_id', entity_row.customer_id,
        'customer_name', entity_row.customer_name,
        'phone', entity_row.phone,
        'interested_model', entity_row.interested_model,
        'branch_id', entity_row.branch_id,
        'branch_name', entity_row.branch_name,
        'team_id', entity_row.team_id,
        'team_name', entity_row.team_name,
        'default_assigned_user_id', case
          when can_assign then entity_row.default_assigned_user_id
          else auth.uid()
        end
      ) order by entity_row.updated_at desc, entity_row.customer_name)
      from entities entity_row
    ), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', user_row.id,
        'name', user_row.full_name,
        'branch_id', user_row.branch_id,
        'team_id', user_row.team_id
      ) order by user_row.full_name, user_row.id)
      from users user_row
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_work_create_options(text, text) from public, anon;
grant execute on function public.get_work_create_options(text, text) to authenticated;

create or replace function app_private.refresh_lead_next_followup(
  target_organization_id uuid,
  target_lead_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_due_at timestamptz;
begin
  if target_lead_id is null then
    return;
  end if;
  select min(followup_row.due_at) into next_due_at
  from public.followups followup_row
  where followup_row.organization_id = target_organization_id
    and followup_row.lead_id = target_lead_id
    and followup_row.status = 'OPEN';

  update public.leads lead_row
  set next_followup_at = next_due_at,
      updated_at = clock_timestamp()
  where lead_row.id = target_lead_id
    and lead_row.organization_id = target_organization_id
    and lead_row.next_followup_at is distinct from next_due_at;
end;
$$;

create or replace function public.create_followup(
  target_lead_id uuid,
  target_customer_id uuid,
  target_branch_id uuid,
  target_team_id uuid,
  target_assigned_user_id uuid,
  followup_reason text,
  followup_due_at timestamptz,
  followup_priority text,
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
  resolved_branch_id uuid;
  resolved_team_id uuid;
  resolved_customer_id uuid;
  resolved_assigned_user_id uuid;
  request_fingerprint text;
  replay_result jsonb;
  new_followup public.followups%rowtype;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if char_length(btrim(coalesce(followup_reason, ''))) not between 3 and 240 then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_REASON';
  end if;
  if followup_due_at is null
    or followup_due_at < now() - interval '5 minutes'
    or followup_due_at > now() + interval '2 years'
  then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_DUE_AT';
  end if;
  if followup_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_PRIORITY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'followup.create')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  if target_lead_id is not null then
    select * into lead_row
    from public.leads source_row
    where source_row.id = target_lead_id
      and source_row.organization_id = current_organization_id
      and source_row.deleted_at is null;
    if not found then
      raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
    end if;
    if not app_private.can_access_lead(lead_row.id) then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if target_branch_id is not null and target_branch_id <> lead_row.branch_id then
      raise exception using errcode = '23514', message = 'WORK_BRANCH_MISMATCH';
    end if;
    if target_team_id is not null and target_team_id is distinct from lead_row.team_id then
      raise exception using errcode = '23514', message = 'WORK_TEAM_MISMATCH';
    end if;
    if target_customer_id is not null
      and target_customer_id is distinct from lead_row.customer_id
    then
      raise exception using errcode = '23514', message = 'WORK_CUSTOMER_MISMATCH';
    end if;
    resolved_branch_id := lead_row.branch_id;
    resolved_team_id := lead_row.team_id;
    resolved_customer_id := coalesce(target_customer_id, lead_row.customer_id);
  else
    if target_branch_id is null or target_customer_id is null then
      raise exception using errcode = '22023', message = 'WORK_ANCHOR_REQUIRED';
    end if;
    if not app_private.can_access_branch(current_organization_id, target_branch_id)
      or not app_private.has_permission(current_organization_id, 'customer.view')
      or not app_private.can_access_customer(current_organization_id, target_customer_id)
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if target_team_id is not null and not exists (
      select 1 from public.teams team_row
      where team_row.id = target_team_id
        and team_row.organization_id = current_organization_id
        and team_row.branch_id = target_branch_id
        and team_row.active
    ) then
      raise exception using errcode = '23503', message = 'WORK_TEAM_NOT_IN_BRANCH';
    end if;
    resolved_branch_id := target_branch_id;
    resolved_team_id := target_team_id;
    resolved_customer_id := target_customer_id;
  end if;

  resolved_assigned_user_id := coalesce(target_assigned_user_id, auth.uid());
  if resolved_assigned_user_id <> auth.uid()
    and not app_private.has_permission(current_organization_id, 'followup.assign')
  then
    raise exception using errcode = '42501', message = 'ASSIGN_PERMISSION_REQUIRED';
  end if;
  if not app_private.can_access_record(
    current_organization_id,
    resolved_branch_id,
    resolved_team_id,
    resolved_assigned_user_id
  ) or not app_private.user_can_receive_work(
    current_organization_id,
    resolved_branch_id,
    resolved_team_id,
    resolved_assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'ASSIGNEE_SCOPE_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'lead_id', target_lead_id,
    'customer_id', resolved_customer_id,
    'branch_id', resolved_branch_id,
    'team_id', resolved_team_id,
    'assigned_user_id', resolved_assigned_user_id,
    'reason', btrim(followup_reason),
    'due_at', followup_due_at,
    'priority', followup_priority
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':followup.created:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_organization_id,
    'followup.created',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;

  insert into public.followups (
    organization_id, branch_id, team_id, lead_id, customer_id,
    assigned_user_id, reason, due_at, priority, created_by
  ) values (
    current_organization_id, resolved_branch_id, resolved_team_id, target_lead_id,
    resolved_customer_id, resolved_assigned_user_id, btrim(followup_reason),
    followup_due_at, followup_priority, auth.uid()
  ) returning * into new_followup;

  perform app_private.refresh_lead_next_followup(current_organization_id, target_lead_id);
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id,
    resolved_customer_id,
    target_lead_id,
    'FOLLOWUP_SCHEDULED',
    auth.uid(),
    jsonb_build_object('followup_id', new_followup.id, 'due_at', new_followup.due_at)
  );
  result := jsonb_build_object(
    'id', new_followup.id,
    'version', new_followup.version,
    'status', new_followup.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id,
    auth.uid(),
    'followup.created',
    'followup',
    new_followup.id::text,
    resolved_branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'team_id', resolved_team_id,
      'assigned_user_id', resolved_assigned_user_id
    )
  );
  return result;
end;
$$;

revoke all on function public.create_followup(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, uuid
) from public, anon;
grant execute on function public.create_followup(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, uuid
) to authenticated;

create or replace function public.update_followup(
  target_followup_id uuid,
  expected_version bigint,
  followup_patch jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.followups%rowtype;
  new_reason text;
  new_due_at timestamptz;
  new_priority text;
  new_assigned_user_id uuid;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(followup_patch, '{}'::jsonb)) <> 'object'
    or coalesce(followup_patch, '{}'::jsonb) = '{}'::jsonb
    or exists (
      select 1 from jsonb_object_keys(followup_patch) patch_key
      where patch_key not in ('reason', 'due_at', 'priority', 'assigned_user_id')
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_PATCH';
  end if;

  select * into current_row
  from public.followups followup_row
  where followup_row.id = target_followup_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FOLLOWUP_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_row.organization_id, 'followup.update')
    or not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      current_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'followup_id', target_followup_id,
    'expected_version', expected_version,
    'patch', followup_patch
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':followup.updated:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_row.organization_id,
    'followup.updated',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;
  if expected_version is null or current_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'WORK_VERSION_CONFLICT';
  end if;
  if current_row.status <> 'OPEN' then
    raise exception using errcode = '23514', message = 'FOLLOWUP_TERMINAL';
  end if;

  new_reason := current_row.reason;
  new_due_at := current_row.due_at;
  new_priority := current_row.priority;
  new_assigned_user_id := current_row.assigned_user_id;
  if followup_patch ? 'reason' then
    new_reason := btrim(coalesce(followup_patch->>'reason', ''));
    if char_length(new_reason) not between 3 and 240 then
      raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_REASON';
    end if;
  end if;
  if followup_patch ? 'due_at' then
    begin
      new_due_at := (followup_patch->>'due_at')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_DUE_AT';
    end;
    if new_due_at < now() - interval '5 minutes' or new_due_at > now() + interval '2 years' then
      raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_DUE_AT';
    end if;
  end if;
  if followup_patch ? 'priority' then
    new_priority := followup_patch->>'priority';
    if new_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
      raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_PRIORITY';
    end if;
  end if;
  if followup_patch ? 'assigned_user_id' then
    begin
      new_assigned_user_id := (followup_patch->>'assigned_user_id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_ASSIGNEE';
    end;
    if new_assigned_user_id is distinct from current_row.assigned_user_id
      and not app_private.has_permission(current_row.organization_id, 'followup.assign')
    then
      raise exception using errcode = '42501', message = 'ASSIGN_PERMISSION_REQUIRED';
    end if;
    if not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      new_assigned_user_id
    ) or not app_private.user_can_receive_work(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      new_assigned_user_id
    ) then
      raise exception using errcode = '42501', message = 'ASSIGNEE_SCOPE_DENIED';
    end if;
  end if;

  update public.followups
  set reason = new_reason,
      due_at = new_due_at,
      priority = new_priority,
      assigned_user_id = new_assigned_user_id,
      version = version + 1,
      updated_at = clock_timestamp()
  where id = current_row.id
  returning version into current_row.version;
  perform app_private.refresh_lead_next_followup(current_row.organization_id, current_row.lead_id);

  result := jsonb_build_object(
    'id', current_row.id,
    'version', current_row.version,
    'status', current_row.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_row.organization_id,
    auth.uid(),
    'followup.updated',
    'followup',
    current_row.id::text,
    current_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'changed_fields', (select jsonb_agg(patch_key) from jsonb_object_keys(followup_patch) patch_key),
      'previous_assigned_user_id', current_row.assigned_user_id,
      'assigned_user_id', new_assigned_user_id
    )
  );
  return result;
end;
$$;

revoke all on function public.update_followup(uuid, bigint, jsonb, uuid) from public, anon;
grant execute on function public.update_followup(uuid, bigint, jsonb, uuid) to authenticated;

create or replace function public.complete_followup(
  target_followup_id uuid,
  expected_version bigint,
  completion_note text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.followups%rowtype;
  request_fingerprint text;
  replay_result jsonb;
  manager_override boolean;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if char_length(btrim(coalesce(completion_note, ''))) > 1000 then
    raise exception using errcode = '22023', message = 'COMPLETION_NOTE_TOO_LONG';
  end if;

  select * into current_row
  from public.followups followup_row
  where followup_row.id = target_followup_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FOLLOWUP_NOT_FOUND';
  end if;
  manager_override := current_row.assigned_user_id <> auth.uid();
  if not app_private.has_permission(current_row.organization_id, 'followup.complete')
    or not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      current_row.assigned_user_id
    )
    or (
      manager_override
      and not app_private.has_permission(
        current_row.organization_id,
        'followup.override_complete'
      )
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'followup_id', target_followup_id,
    'expected_version', expected_version,
    'completion_note', nullif(btrim(completion_note), '')
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':followup.completed:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_row.organization_id,
    'followup.completed',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;
  if expected_version is null or current_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'WORK_VERSION_CONFLICT';
  end if;
  if current_row.status <> 'OPEN' then
    raise exception using errcode = '23514', message = 'FOLLOWUP_TERMINAL';
  end if;

  update public.followups
  set status = 'COMPLETED',
      completed_at = clock_timestamp(),
      completion_note = nullif(btrim(completion_note), ''),
      version = version + 1,
      updated_at = clock_timestamp()
  where id = current_row.id
  returning version, completed_at into current_row.version, current_row.completed_at;
  perform app_private.refresh_lead_next_followup(current_row.organization_id, current_row.lead_id);

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_row.organization_id,
    current_row.customer_id,
    current_row.lead_id,
    'FOLLOWUP_COMPLETED',
    auth.uid(),
    jsonb_build_object(
      'followup_id', current_row.id,
      'manager_override', manager_override
    )
  );
  result := jsonb_build_object(
    'id', current_row.id,
    'version', current_row.version,
    'status', 'COMPLETED',
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_row.organization_id,
    auth.uid(),
    'followup.completed',
    'followup',
    current_row.id::text,
    current_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'assigned_user_id', current_row.assigned_user_id,
      'manager_override', manager_override,
      'completion_mode', case when manager_override then 'MANAGER_OVERRIDE' else 'OWNER' end
    )
  );
  return result;
end;
$$;

revoke all on function public.complete_followup(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.complete_followup(uuid, bigint, text, uuid) to authenticated;

create or replace function public.cancel_followup(
  target_followup_id uuid,
  expected_version bigint,
  cancellation_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.followups%rowtype;
  normalized_reason text;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  normalized_reason := btrim(coalesce(cancellation_reason, ''));
  if char_length(normalized_reason) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'CANCELLATION_REASON_REQUIRED';
  end if;

  select * into current_row
  from public.followups followup_row
  where followup_row.id = target_followup_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FOLLOWUP_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_row.organization_id, 'followup.cancel')
    or not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      current_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'followup_id', target_followup_id,
    'expected_version', expected_version,
    'cancellation_reason', normalized_reason
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':followup.cancelled:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_row.organization_id,
    'followup.cancelled',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;
  if expected_version is null or current_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'WORK_VERSION_CONFLICT';
  end if;
  if current_row.status <> 'OPEN' then
    raise exception using errcode = '23514', message = 'FOLLOWUP_TERMINAL';
  end if;

  update public.followups
  set status = 'CANCELLED',
      cancellation_reason = normalized_reason,
      cancelled_at = clock_timestamp(),
      version = version + 1,
      updated_at = clock_timestamp()
  where id = current_row.id
  returning version, cancelled_at into current_row.version, current_row.cancelled_at;
  perform app_private.refresh_lead_next_followup(current_row.organization_id, current_row.lead_id);

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_row.organization_id,
    current_row.customer_id,
    current_row.lead_id,
    'FOLLOWUP_CANCELLED',
    auth.uid(),
    jsonb_build_object('followup_id', current_row.id, 'reason', normalized_reason)
  );
  result := jsonb_build_object(
    'id', current_row.id,
    'version', current_row.version,
    'status', 'CANCELLED',
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_row.organization_id,
    auth.uid(),
    'followup.cancelled',
    'followup',
    current_row.id::text,
    current_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'reason', normalized_reason,
      'assigned_user_id', current_row.assigned_user_id
    )
  );
  return result;
end;
$$;

revoke all on function public.cancel_followup(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.cancel_followup(uuid, bigint, text, uuid) to authenticated;

create or replace function public.create_appointment(
  target_lead_id uuid,
  target_customer_id uuid,
  target_branch_id uuid,
  target_team_id uuid,
  target_assigned_user_id uuid,
  target_appointment_type text,
  target_scheduled_at timestamptz,
  target_notes text,
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
  resolved_branch_id uuid;
  resolved_team_id uuid;
  resolved_customer_id uuid;
  resolved_assigned_user_id uuid;
  normalized_type text;
  normalized_notes text;
  request_fingerprint text;
  replay_result jsonb;
  new_appointment public.appointments%rowtype;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  normalized_type := btrim(coalesce(target_appointment_type, ''));
  normalized_notes := nullif(btrim(coalesce(target_notes, '')), '');
  if normalized_type not in ('Showroom Visit', 'Test Drive') then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TYPE';
  end if;
  if target_scheduled_at is null
    or target_scheduled_at < now() - interval '5 minutes'
    or target_scheduled_at > now() + interval '2 years'
  then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TIME';
  end if;
  if char_length(coalesce(normalized_notes, '')) > 2000 then
    raise exception using errcode = '22023', message = 'APPOINTMENT_NOTES_TOO_LONG';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'appointment.create')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  if target_lead_id is not null then
    select * into lead_row
    from public.leads source_row
    where source_row.id = target_lead_id
      and source_row.organization_id = current_organization_id
      and source_row.deleted_at is null;
    if not found then
      raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
    end if;
    if not app_private.can_access_lead(lead_row.id) then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if lead_row.customer_id is null then
      raise exception using errcode = '23514', message = 'APPOINTMENT_REQUIRES_CUSTOMER_LINK';
    end if;
    if target_customer_id is not null and target_customer_id <> lead_row.customer_id then
      raise exception using errcode = '23514', message = 'WORK_CUSTOMER_MISMATCH';
    end if;
    if target_branch_id is not null and target_branch_id <> lead_row.branch_id then
      raise exception using errcode = '23514', message = 'WORK_BRANCH_MISMATCH';
    end if;
    if target_team_id is not null and target_team_id is distinct from lead_row.team_id then
      raise exception using errcode = '23514', message = 'WORK_TEAM_MISMATCH';
    end if;
    resolved_branch_id := lead_row.branch_id;
    resolved_team_id := lead_row.team_id;
    resolved_customer_id := lead_row.customer_id;
  else
    if target_branch_id is null or target_customer_id is null then
      raise exception using errcode = '22023', message = 'WORK_ANCHOR_REQUIRED';
    end if;
    if not app_private.can_access_branch(current_organization_id, target_branch_id)
      or not app_private.can_access_customer(current_organization_id, target_customer_id)
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if target_team_id is not null and not exists (
      select 1 from public.teams team_row
      where team_row.id = target_team_id
        and team_row.organization_id = current_organization_id
        and team_row.branch_id = target_branch_id
        and team_row.active
    ) then
      raise exception using errcode = '23503', message = 'WORK_TEAM_NOT_IN_BRANCH';
    end if;
    resolved_branch_id := target_branch_id;
    resolved_team_id := target_team_id;
    resolved_customer_id := target_customer_id;
  end if;

  resolved_assigned_user_id := coalesce(target_assigned_user_id, auth.uid());
  if resolved_assigned_user_id <> auth.uid()
    and not app_private.has_permission(current_organization_id, 'appointment.assign')
  then
    raise exception using errcode = '42501', message = 'ASSIGN_PERMISSION_REQUIRED';
  end if;
  if not app_private.can_access_record(
    current_organization_id,
    resolved_branch_id,
    resolved_team_id,
    resolved_assigned_user_id
  ) or not app_private.user_can_receive_work(
    current_organization_id,
    resolved_branch_id,
    resolved_team_id,
    resolved_assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'ASSIGNEE_SCOPE_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'lead_id', target_lead_id,
    'customer_id', resolved_customer_id,
    'branch_id', resolved_branch_id,
    'team_id', resolved_team_id,
    'assigned_user_id', resolved_assigned_user_id,
    'appointment_type', normalized_type,
    'scheduled_at', target_scheduled_at,
    'notes', normalized_notes
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':appointment.created:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_organization_id,
    'appointment.created',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;

  insert into public.appointments (
    organization_id, branch_id, team_id, lead_id, customer_id,
    assigned_user_id, appointment_type, scheduled_at, status,
    attendance_status, notes, created_by
  ) values (
    current_organization_id, resolved_branch_id, resolved_team_id, target_lead_id,
    resolved_customer_id, resolved_assigned_user_id, normalized_type,
    target_scheduled_at, 'SCHEDULED', 'NOT_ARRIVED', normalized_notes, auth.uid()
  ) returning * into new_appointment;

  if target_lead_id is not null
    and app_private.has_permission(current_organization_id, 'lead.update')
    and lead_row.lifecycle_status in ('New', 'Contacted', 'Qualified')
  then
    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      current_organization_id,
      target_lead_id,
      lead_row.lifecycle_status,
      'Appointment Scheduled',
      auth.uid(),
      'Appointment scheduled'
    );
    update public.leads
    set lifecycle_status = 'Appointment Scheduled',
        updated_at = clock_timestamp()
    where id = target_lead_id and organization_id = current_organization_id;
  end if;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id,
    resolved_customer_id,
    target_lead_id,
    'APPOINTMENT_SCHEDULED',
    auth.uid(),
    jsonb_build_object(
      'appointment_id', new_appointment.id,
      'appointment_type', normalized_type,
      'scheduled_at', target_scheduled_at
    )
  );
  result := jsonb_build_object(
    'id', new_appointment.id,
    'version', new_appointment.version,
    'status', new_appointment.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id,
    auth.uid(),
    'appointment.created',
    'appointment',
    new_appointment.id::text,
    resolved_branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'team_id', resolved_team_id,
      'assigned_user_id', resolved_assigned_user_id
    )
  );
  return result;
end;
$$;

revoke all on function public.create_appointment(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, uuid
) from public, anon;
grant execute on function public.create_appointment(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, uuid
) to authenticated;

create or replace function public.update_appointment(
  target_appointment_id uuid,
  expected_version bigint,
  appointment_patch jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.appointments%rowtype;
  new_type text;
  new_scheduled_at timestamptz;
  new_notes text;
  new_assigned_user_id uuid;
  new_status text;
  new_attendance_status text;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(appointment_patch, '{}'::jsonb)) <> 'object'
    or coalesce(appointment_patch, '{}'::jsonb) = '{}'::jsonb
    or exists (
      select 1 from jsonb_object_keys(appointment_patch) patch_key
      where patch_key not in (
        'appointment_type', 'scheduled_at', 'notes', 'assigned_user_id',
        'status', 'attendance_status'
      )
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_PATCH';
  end if;

  select * into current_row
  from public.appointments appointment_row
  where appointment_row.id = target_appointment_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'APPOINTMENT_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_row.organization_id, 'appointment.update')
    or not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      current_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'appointment_id', target_appointment_id,
    'expected_version', expected_version,
    'patch', appointment_patch
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':appointment.updated:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_row.organization_id,
    'appointment.updated',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;
  if expected_version is null or current_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'WORK_VERSION_CONFLICT';
  end if;
  if current_row.status in ('COMPLETED', 'CANCELLED', 'NO_SHOW') then
    raise exception using errcode = '23514', message = 'APPOINTMENT_TERMINAL';
  end if;

  new_type := current_row.appointment_type;
  new_scheduled_at := current_row.scheduled_at;
  new_notes := current_row.notes;
  new_assigned_user_id := current_row.assigned_user_id;
  new_status := current_row.status;
  new_attendance_status := coalesce(current_row.attendance_status, 'NOT_ARRIVED');

  if appointment_patch ? 'appointment_type' then
    new_type := btrim(coalesce(appointment_patch->>'appointment_type', ''));
    if new_type not in ('Showroom Visit', 'Test Drive') then
      raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TYPE';
    end if;
  end if;
  if appointment_patch ? 'scheduled_at' then
    begin
      new_scheduled_at := (appointment_patch->>'scheduled_at')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TIME';
    end;
    if new_scheduled_at < now() - interval '5 minutes'
      or new_scheduled_at > now() + interval '2 years'
    then
      raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TIME';
    end if;
    if new_scheduled_at is distinct from current_row.scheduled_at then
      new_status := 'RESCHEDULED';
      new_attendance_status := 'NOT_ARRIVED';
    end if;
  end if;
  if appointment_patch ? 'notes' then
    new_notes := nullif(btrim(coalesce(appointment_patch->>'notes', '')), '');
    if char_length(coalesce(new_notes, '')) > 2000 then
      raise exception using errcode = '22023', message = 'APPOINTMENT_NOTES_TOO_LONG';
    end if;
  end if;
  if appointment_patch ? 'assigned_user_id' then
    begin
      new_assigned_user_id := (appointment_patch->>'assigned_user_id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_ASSIGNEE';
    end;
    if new_assigned_user_id is distinct from current_row.assigned_user_id
      and not app_private.has_permission(current_row.organization_id, 'appointment.assign')
    then
      raise exception using errcode = '42501', message = 'ASSIGN_PERMISSION_REQUIRED';
    end if;
    if not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      new_assigned_user_id
    ) or not app_private.user_can_receive_work(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      new_assigned_user_id
    ) then
      raise exception using errcode = '42501', message = 'ASSIGNEE_SCOPE_DENIED';
    end if;
  end if;
  if appointment_patch ? 'status' then
    new_status := appointment_patch->>'status';
    if new_status not in ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_SHOW') then
      raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_STATUS';
    end if;
    if new_status = 'NO_SHOW' and current_row.scheduled_at > now() then
      raise exception using errcode = '23514', message = 'APPOINTMENT_NOT_DUE';
    end if;
    if new_status = 'NO_SHOW' then
      new_attendance_status := 'NO_SHOW';
    end if;
  end if;
  if appointment_patch ? 'attendance_status' then
    new_attendance_status := appointment_patch->>'attendance_status';
    if new_attendance_status not in ('NOT_ARRIVED', 'ARRIVED', 'NO_SHOW') then
      raise exception using errcode = '22023', message = 'INVALID_ATTENDANCE_STATUS';
    end if;
    if new_attendance_status = 'NO_SHOW' then
      if current_row.scheduled_at > now() then
        raise exception using errcode = '23514', message = 'APPOINTMENT_NOT_DUE';
      end if;
      new_status := 'NO_SHOW';
    end if;
  end if;

  update public.appointments
  set appointment_type = new_type,
      scheduled_at = new_scheduled_at,
      notes = new_notes,
      assigned_user_id = new_assigned_user_id,
      status = new_status,
      attendance_status = new_attendance_status,
      confirmed_at = case
        when new_status = 'CONFIRMED' and confirmed_at is null then clock_timestamp()
        else confirmed_at
      end,
      arrived_at = case
        when new_attendance_status = 'ARRIVED' and arrived_at is null then clock_timestamp()
        else arrived_at
      end,
      version = version + 1,
      updated_at = clock_timestamp()
  where id = current_row.id
  returning version, status, attendance_status
  into current_row.version, current_row.status, current_row.attendance_status;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_row.organization_id,
    current_row.customer_id,
    current_row.lead_id,
    'APPOINTMENT_UPDATED',
    auth.uid(),
    jsonb_build_object(
      'appointment_id', current_row.id,
      'status', current_row.status,
      'attendance_status', current_row.attendance_status
    )
  );
  result := jsonb_build_object(
    'id', current_row.id,
    'version', current_row.version,
    'status', current_row.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_row.organization_id,
    auth.uid(),
    'appointment.updated',
    'appointment',
    current_row.id::text,
    current_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'changed_fields', (select jsonb_agg(patch_key) from jsonb_object_keys(appointment_patch) patch_key),
      'assigned_user_id', new_assigned_user_id,
      'status', current_row.status,
      'attendance_status', current_row.attendance_status
    )
  );
  return result;
end;
$$;

revoke all on function public.update_appointment(uuid, bigint, jsonb, uuid) from public, anon;
grant execute on function public.update_appointment(uuid, bigint, jsonb, uuid) to authenticated;

create or replace function public.complete_appointment(
  target_appointment_id uuid,
  expected_version bigint,
  completion_note text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.appointments%rowtype;
  normalized_note text;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  normalized_note := nullif(btrim(coalesce(completion_note, '')), '');
  if char_length(coalesce(normalized_note, '')) > 1000 then
    raise exception using errcode = '22023', message = 'COMPLETION_NOTE_TOO_LONG';
  end if;

  select * into current_row
  from public.appointments appointment_row
  where appointment_row.id = target_appointment_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'APPOINTMENT_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_row.organization_id, 'appointment.complete')
    or not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      current_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'appointment_id', target_appointment_id,
    'expected_version', expected_version,
    'completion_note', normalized_note
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':appointment.completed:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_row.organization_id,
    'appointment.completed',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;
  if expected_version is null or current_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'WORK_VERSION_CONFLICT';
  end if;
  if current_row.status in ('COMPLETED', 'CANCELLED', 'NO_SHOW') then
    raise exception using errcode = '23514', message = 'APPOINTMENT_TERMINAL';
  end if;

  update public.appointments
  set status = 'COMPLETED',
      attendance_status = 'COMPLETED',
      arrived_at = coalesce(arrived_at, clock_timestamp()),
      completed_at = clock_timestamp(),
      notes = case
        when normalized_note is null then notes
        when notes is null then normalized_note
        else notes || E'\n\nCompletion: ' || normalized_note
      end,
      version = version + 1,
      updated_at = clock_timestamp()
  where id = current_row.id
  returning version, completed_at into current_row.version, current_row.completed_at;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_row.organization_id,
    current_row.customer_id,
    current_row.lead_id,
    'APPOINTMENT_COMPLETED',
    auth.uid(),
    jsonb_build_object('appointment_id', current_row.id)
  );
  result := jsonb_build_object(
    'id', current_row.id,
    'version', current_row.version,
    'status', 'COMPLETED',
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_row.organization_id,
    auth.uid(),
    'appointment.completed',
    'appointment',
    current_row.id::text,
    current_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'assigned_user_id', current_row.assigned_user_id
    )
  );
  return result;
end;
$$;

revoke all on function public.complete_appointment(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.complete_appointment(uuid, bigint, text, uuid) to authenticated;

create or replace function public.cancel_appointment(
  target_appointment_id uuid,
  expected_version bigint,
  cancellation_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.appointments%rowtype;
  normalized_reason text;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  normalized_reason := btrim(coalesce(cancellation_reason, ''));
  if char_length(normalized_reason) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'CANCELLATION_REASON_REQUIRED';
  end if;

  select * into current_row
  from public.appointments appointment_row
  where appointment_row.id = target_appointment_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'APPOINTMENT_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_row.organization_id, 'appointment.cancel')
    or not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      current_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'appointment_id', target_appointment_id,
    'expected_version', expected_version,
    'cancellation_reason', normalized_reason
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':appointment.cancelled:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_row.organization_id,
    'appointment.cancelled',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;
  if expected_version is null or current_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'WORK_VERSION_CONFLICT';
  end if;
  if current_row.status in ('COMPLETED', 'CANCELLED', 'NO_SHOW') then
    raise exception using errcode = '23514', message = 'APPOINTMENT_TERMINAL';
  end if;

  update public.appointments
  set status = 'CANCELLED',
      cancellation_reason = normalized_reason,
      cancelled_at = clock_timestamp(),
      version = version + 1,
      updated_at = clock_timestamp()
  where id = current_row.id
  returning version, cancelled_at into current_row.version, current_row.cancelled_at;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_row.organization_id,
    current_row.customer_id,
    current_row.lead_id,
    'APPOINTMENT_CANCELLED',
    auth.uid(),
    jsonb_build_object('appointment_id', current_row.id, 'reason', normalized_reason)
  );
  result := jsonb_build_object(
    'id', current_row.id,
    'version', current_row.version,
    'status', 'CANCELLED',
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_row.organization_id,
    auth.uid(),
    'appointment.cancelled',
    'appointment',
    current_row.id::text,
    current_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'reason', normalized_reason,
      'assigned_user_id', current_row.assigned_user_id
    )
  );
  return result;
end;
$$;

revoke all on function public.cancel_appointment(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.cancel_appointment(uuid, bigint, text, uuid) to authenticated;

commit;
