begin;

-- Migration-time role preset backfill is platform-managed, while all runtime
-- functions below use the authenticated caller and enforce tenant scope.
select set_config('request.jwt.claim.role', 'service_role', false);

-- Escalations are a manager work queue.  The resource itself remains the
-- source of truth; this table records the exception and its accountable
-- resolution only.
insert into public.permissions (permission_key, module, description) values
  ('escalation.view', 'sales', 'View sales escalations within authorized data scope'),
  ('escalation.resolve', 'sales', 'Resolve sales escalations within authorized data scope')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.system_role
  and role_row.role_key in ('team_manager', 'showroom_manager', 'gm_sales')
  and permission_row.permission_key in ('escalation.view', 'escalation.resolve')
on conflict do nothing;

create or replace function app_private.apply_default_sales_escalation_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is not null
    and new.system_role
    and new.role_key in ('team_manager', 'showroom_manager', 'gm_sales')
  then
    insert into public.role_permissions (role_id, permission_id)
    select new.id, permission_row.id
    from public.permissions permission_row
    where permission_row.permission_key in ('escalation.view', 'escalation.resolve')
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists roles_apply_default_sales_escalation_permissions on public.roles;
create trigger roles_apply_default_sales_escalation_permissions
after insert or update of role_key, system_role on public.roles
for each row execute function app_private.apply_default_sales_escalation_permissions();

create index if not exists escalations_workspace_page_idx
  on public.escalations (organization_id, status, severity, updated_at desc, id desc);
create index if not exists escalations_resource_lookup_idx
  on public.escalations (organization_id, resource_type, resource_id);
create unique index if not exists sales_escalation_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action like 'sales_escalation.%';

-- Scope checks deliberately follow the resource, rather than trusting the
-- denormalized escalation branch or assignee.  That prevents a manager from
-- learning about a record just because an escalation was reassigned.
create or replace function app_private.can_access_sales_escalation(
  target_organization_id uuid,
  target_escalation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.escalations escalation_row
    join public.customer_care_cases case_row
      on escalation_row.resource_type = 'customer_care_case'
     and case_row.organization_id = escalation_row.organization_id
     and case_row.id = escalation_row.resource_id
     and case_row.deleted_at is null
    left join public.bookings case_booking_row
      on case_booking_row.organization_id = case_row.organization_id
     and case_booking_row.id = case_row.booking_id
     and case_booking_row.deleted_at is null
    left join public.leads case_lead_row
      on case_lead_row.organization_id = case_row.organization_id
     and case_lead_row.id = case_booking_row.lead_id
     and case_lead_row.deleted_at is null
    where escalation_row.organization_id = target_organization_id
      and escalation_row.id = target_escalation_id
      and app_private.can_access_record(
        case_row.organization_id, case_row.branch_id,
        case_lead_row.team_id, case_row.assigned_user_id
      )
      and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
    union all
    select 1
    from public.escalations escalation_row
    join public.leads lead_row
      on escalation_row.resource_type = 'lead'
     and lead_row.organization_id = escalation_row.organization_id
     and lead_row.id = escalation_row.resource_id
     and lead_row.deleted_at is null
    where escalation_row.organization_id = target_organization_id
      and escalation_row.id = target_escalation_id
      and app_private.can_access_record(
        lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
      )
    union all
    select 1
    from public.escalations escalation_row
    join public.quotations quotation_row
      on escalation_row.resource_type = 'quotation'
     and quotation_row.organization_id = escalation_row.organization_id
     and quotation_row.id = escalation_row.resource_id
     and quotation_row.deleted_at is null
    where escalation_row.organization_id = target_organization_id
      and escalation_row.id = target_escalation_id
      and app_private.can_access_record(
        quotation_row.organization_id, quotation_row.branch_id,
        quotation_row.team_id, quotation_row.assigned_user_id
      )
      and app_private.can_access_customer(quotation_row.organization_id, quotation_row.customer_id)
    union all
    select 1
    from public.escalations escalation_row
    join public.bookings booking_row
      on escalation_row.resource_type = 'booking'
     and booking_row.organization_id = escalation_row.organization_id
     and booking_row.id = escalation_row.resource_id
     and booking_row.deleted_at is null
    where escalation_row.organization_id = target_organization_id
      and escalation_row.id = target_escalation_id
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
      and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id)
  );
$$;

alter table public.escalations enable row level security;
drop policy if exists escalations_read on public.escalations;
create policy escalations_read on public.escalations
for select to authenticated using (
  app_private.has_permission(organization_id, 'escalation.view')
  and app_private.can_access_sales_escalation(organization_id, id)
);

create or replace function public.get_sales_escalation_workspace_page(
  target_search text default '',
  target_status text default 'OPEN',
  target_severity text default 'ALL',
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_status text := upper(btrim(coalesce(target_status, 'OPEN')));
  normalized_severity text := upper(btrim(coalesce(target_severity, 'ALL')));
begin
  if char_length(normalized_search) > 160
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or normalized_status not in ('ALL', 'OPEN', 'RESOLVED')
    or normalized_severity not in ('ALL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
    or target_sort not in ('updated:desc', 'created:desc', 'severity:desc')
  then raise exception using errcode = '22023', message = 'INVALID_SALES_ESCALATION_QUERY'; end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'escalation.view')
  then raise exception using errcode = '42501', message = 'SALES_ESCALATION_VIEW_PERMISSION_REQUIRED'; end if;

  return (
    with authorized as materialized (
      select escalation_row.id, escalation_row.organization_id, escalation_row.branch_id,
        escalation_row.resource_type, escalation_row.resource_id,
        escalation_row.assigned_user_id, escalation_row.reason, escalation_row.severity,
        escalation_row.status, escalation_row.resolved_at, escalation_row.version,
        escalation_row.created_at, escalation_row.updated_at,
        case_row.case_number as reference, case_row.subject as subject,
        'Customer care case'::text as resource_label,
        customer_row.full_name as customer_name, case_assignee.full_name as assigned_user_name,
        case_team.name as team_name
      from public.escalations escalation_row
      join public.customer_care_cases case_row
        on escalation_row.resource_type = 'customer_care_case'
       and case_row.organization_id = escalation_row.organization_id
       and case_row.id = escalation_row.resource_id and case_row.deleted_at is null
      join public.customers customer_row
        on customer_row.organization_id = case_row.organization_id
       and customer_row.id = case_row.customer_id and customer_row.deleted_at is null
      left join public.bookings case_booking_row
        on case_booking_row.organization_id = case_row.organization_id
       and case_booking_row.id = case_row.booking_id and case_booking_row.deleted_at is null
      left join public.leads case_lead_row
        on case_lead_row.organization_id = case_row.organization_id
       and case_lead_row.id = case_booking_row.lead_id and case_lead_row.deleted_at is null
      left join public.teams case_team
        on case_team.organization_id = case_row.organization_id and case_team.id = case_lead_row.team_id
      left join public.profiles case_assignee
        on case_assignee.organization_id = case_row.organization_id and case_assignee.id = case_row.assigned_user_id
      where escalation_row.organization_id = current_organization_id
        and app_private.can_access_record(case_row.organization_id, case_row.branch_id, case_lead_row.team_id, case_row.assigned_user_id)
        and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
      union all
      select escalation_row.id, escalation_row.organization_id, escalation_row.branch_id,
        escalation_row.resource_type, escalation_row.resource_id,
        escalation_row.assigned_user_id, escalation_row.reason, escalation_row.severity,
        escalation_row.status, escalation_row.resolved_at, escalation_row.version,
        escalation_row.created_at, escalation_row.updated_at,
        left(lead_row.id::text, 8) as reference, lead_row.interested_model as subject,
        'Lead'::text as resource_label,
        lead_row.customer_name, lead_assignee.full_name as assigned_user_name, lead_team.name as team_name
      from public.escalations escalation_row
      join public.leads lead_row
        on escalation_row.resource_type = 'lead'
       and lead_row.organization_id = escalation_row.organization_id
       and lead_row.id = escalation_row.resource_id and lead_row.deleted_at is null
      left join public.teams lead_team
        on lead_team.organization_id = lead_row.organization_id and lead_team.id = lead_row.team_id
      left join public.profiles lead_assignee
        on lead_assignee.organization_id = lead_row.organization_id and lead_assignee.id = lead_row.assigned_user_id
      where escalation_row.organization_id = current_organization_id
        and app_private.can_access_record(lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id)
      union all
      select escalation_row.id, escalation_row.organization_id, escalation_row.branch_id,
        escalation_row.resource_type, escalation_row.resource_id,
        escalation_row.assigned_user_id, escalation_row.reason, escalation_row.severity,
        escalation_row.status, escalation_row.resolved_at, escalation_row.version,
        escalation_row.created_at, escalation_row.updated_at,
        quotation_row.quotation_number as reference, quotation_row.status as subject,
        'Quotation'::text as resource_label,
        customer_row.full_name as customer_name, quotation_assignee.full_name as assigned_user_name,
        quotation_team.name as team_name
      from public.escalations escalation_row
      join public.quotations quotation_row
        on escalation_row.resource_type = 'quotation'
       and quotation_row.organization_id = escalation_row.organization_id
       and quotation_row.id = escalation_row.resource_id and quotation_row.deleted_at is null
      join public.customers customer_row
        on customer_row.organization_id = quotation_row.organization_id
       and customer_row.id = quotation_row.customer_id and customer_row.deleted_at is null
      left join public.teams quotation_team
        on quotation_team.organization_id = quotation_row.organization_id and quotation_team.id = quotation_row.team_id
      left join public.profiles quotation_assignee
        on quotation_assignee.organization_id = quotation_row.organization_id and quotation_assignee.id = quotation_row.assigned_user_id
      where escalation_row.organization_id = current_organization_id
        and app_private.can_access_record(quotation_row.organization_id, quotation_row.branch_id, quotation_row.team_id, quotation_row.assigned_user_id)
        and app_private.can_access_customer(quotation_row.organization_id, quotation_row.customer_id)
      union all
      select escalation_row.id, escalation_row.organization_id, escalation_row.branch_id,
        escalation_row.resource_type, escalation_row.resource_id,
        escalation_row.assigned_user_id, escalation_row.reason, escalation_row.severity,
        escalation_row.status, escalation_row.resolved_at, escalation_row.version,
        escalation_row.created_at, escalation_row.updated_at,
        booking_row.booking_number as reference, booking_row.status as subject,
        'Booking'::text as resource_label,
        customer_row.full_name as customer_name, booking_assignee.full_name as assigned_user_name,
        booking_team.name as team_name
      from public.escalations escalation_row
      join public.bookings booking_row
        on escalation_row.resource_type = 'booking'
       and booking_row.organization_id = escalation_row.organization_id
       and booking_row.id = escalation_row.resource_id and booking_row.deleted_at is null
      join public.customers customer_row
        on customer_row.organization_id = booking_row.organization_id
       and customer_row.id = booking_row.customer_id and customer_row.deleted_at is null
      left join public.teams booking_team
        on booking_team.organization_id = booking_row.organization_id and booking_team.id = booking_row.team_id
      left join public.profiles booking_assignee
        on booking_assignee.organization_id = booking_row.organization_id and booking_assignee.id = booking_row.assigned_user_id
      where escalation_row.organization_id = current_organization_id
        and app_private.can_access_record(booking_row.organization_id, booking_row.branch_id, booking_row.team_id, booking_row.assigned_user_id)
        and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id)
    ), filtered as materialized (
      select authorized_row.*
      from authorized authorized_row
      where (normalized_status = 'ALL' or authorized_row.status = normalized_status)
        and (normalized_severity = 'ALL' or authorized_row.severity = normalized_severity)
        and (
          normalized_search = ''
          or position(normalized_search in lower(authorized_row.reference)) > 0
          or position(normalized_search in lower(authorized_row.customer_name)) > 0
          or position(normalized_search in lower(authorized_row.reason)) > 0
          or position(normalized_search in lower(coalesce(authorized_row.assigned_user_name, ''))) > 0
        )
    ), numbered as (
      select filtered_row.*, row_number() over (order by
        case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
        case when target_sort = 'created:desc' then filtered_row.created_at end desc,
        case filtered_row.severity when 'CRITICAL' then 4 when 'HIGH' then 3 when 'MEDIUM' then 2 else 1 end desc,
        filtered_row.id desc
      ) as page_order
      from filtered filtered_row
    ), page_rows as (
      select numbered_row.* from numbered numbered_row
      order by page_order
      limit target_page_size offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'organization_id', current_organization_id,
      'records', coalesce((select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_order) from page_rows page_row), '[]'::jsonb),
      'total', (select count(*) from filtered),
      'kpis', jsonb_build_object(
        'open', (select count(*) from authorized where status = 'OPEN'),
        'critical', (select count(*) from authorized where status = 'OPEN' and severity = 'CRITICAL'),
        'high', (select count(*) from authorized where status = 'OPEN' and severity = 'HIGH'),
        'unassigned', (select count(*) from authorized where status = 'OPEN' and assigned_user_id is null),
        'resolved_today', (select count(*) from authorized where status = 'RESOLVED' and resolved_at >= date_trunc('day', now()))
      )
    )
  );
end;
$$;

create or replace function public.resolve_sales_escalation(
  target_escalation_id uuid,
  expected_version bigint,
  target_resolution text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  escalation_row public.escalations%rowtype;
  normalized_resolution text := nullif(btrim(coalesce(target_resolution, '')), '');
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_escalation_id is null or expected_version is null or expected_version < 1
    or target_request_id is null
    or char_length(coalesce(normalized_resolution, '')) not between 5 and 2000
  then raise exception using errcode = '22023', message = 'INVALID_SALES_ESCALATION_RESOLUTION'; end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'escalation.resolve')
  then raise exception using errcode = '42501', message = 'SALES_ESCALATION_RESOLVE_PERMISSION_REQUIRED'; end if;

  fingerprint := md5(jsonb_build_object(
    'escalation_id', target_escalation_id,
    'expected_version', expected_version,
    'resolution', normalized_resolution
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  select audit_row.metadata->'result' into replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'sales_escalation.resolved'
    and audit_row.metadata->>'fingerprint' = fingerprint
  limit 1;
  if replay_result is not null then return replay_result || jsonb_build_object('replayed', true); end if;

  select * into escalation_row
  from public.escalations source_row
  where source_row.organization_id = current_organization_id and source_row.id = target_escalation_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'SALES_ESCALATION_NOT_FOUND'; end if;
  if not app_private.can_access_sales_escalation(current_organization_id, escalation_row.id) then
    raise exception using errcode = '42501', message = 'SALES_ESCALATION_SCOPE_DENIED'; end if;
  if escalation_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'SALES_ESCALATION_VERSION_CONFLICT'; end if;
  if escalation_row.status <> 'OPEN' then
    raise exception using errcode = '23514', message = 'SALES_ESCALATION_ALREADY_RESOLVED'; end if;

  update public.escalations
  set status = 'RESOLVED', resolved_at = now(), version = version + 1, updated_at = now()
  where id = escalation_row.id
  returning * into escalation_row;
  result := jsonb_build_object(
    'id', escalation_row.id,
    'status', escalation_row.status,
    'version', escalation_row.version,
    'resolution', normalized_resolution,
    'replayed', false
  );
  insert into public.activities (
    organization_id, customer_id, activity_type, actor_id, metadata
  )
  select current_organization_id, case_row.customer_id, 'SALES_ESCALATION_RESOLVED', auth.uid(),
    jsonb_build_object('escalation_id', escalation_row.id, 'resolution', normalized_resolution)
  from public.customer_care_cases case_row
  where escalation_row.resource_type = 'customer_care_case'
    and case_row.organization_id = current_organization_id and case_row.id = escalation_row.resource_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'sales_escalation.resolved', 'escalation', escalation_row.id::text,
    escalation_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result, 'resolution', normalized_resolution)
  );
  return result;
end;
$$;

revoke all on function app_private.apply_default_sales_escalation_permissions() from public, anon, authenticated;
revoke all on function app_private.can_access_sales_escalation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_sales_escalation_workspace_page(text, text, text, integer, integer, text) from public, anon;
grant execute on function public.get_sales_escalation_workspace_page(text, text, text, integer, integer, text) to authenticated;
revoke all on function public.resolve_sales_escalation(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.resolve_sales_escalation(uuid, bigint, text, uuid) to authenticated;

commit;
