-- Organization-wide operational queues and their KPI bundles apply date/search
-- scope before the status tab. Keep updated_at directly after the tenant key so
-- that default ordering and bounded date windows remain indexable. Branch and
-- owner indexes keep scoped users off unrelated case history.
create index concurrently if not exists finance_cases_org_updated_page_idx
  on public.finance_cases (organization_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists insurance_cases_org_updated_page_idx
  on public.insurance_cases (organization_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists rto_cases_org_updated_page_idx
  on public.rto_cases (organization_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists exchange_cases_org_updated_page_idx
  on public.exchange_cases (organization_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists delivery_cases_org_updated_page_idx
  on public.delivery_cases (organization_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists finance_cases_branch_updated_page_idx
  on public.finance_cases (organization_id, branch_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists insurance_cases_branch_updated_page_idx
  on public.insurance_cases (organization_id, branch_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists rto_cases_branch_updated_page_idx
  on public.rto_cases (organization_id, branch_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists exchange_cases_branch_updated_page_idx
  on public.exchange_cases (organization_id, branch_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists delivery_cases_branch_updated_page_idx
  on public.delivery_cases (organization_id, branch_id, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists finance_cases_owner_updated_page_idx
  on public.finance_cases (organization_id, assigned_user_id, updated_at desc, id desc)
  where deleted_at is null and assigned_user_id is not null;
create index concurrently if not exists insurance_cases_owner_updated_page_idx
  on public.insurance_cases (organization_id, assigned_user_id, updated_at desc, id desc)
  where deleted_at is null and assigned_user_id is not null;
create index concurrently if not exists rto_cases_owner_updated_page_idx
  on public.rto_cases (organization_id, assigned_user_id, updated_at desc, id desc)
  where deleted_at is null and assigned_user_id is not null;
create index concurrently if not exists exchange_cases_owner_updated_page_idx
  on public.exchange_cases (organization_id, assigned_user_id, updated_at desc, id desc)
  where deleted_at is null and assigned_user_id is not null;
create index concurrently if not exists delivery_cases_owner_updated_page_idx
  on public.delivery_cases (organization_id, assigned_user_id, updated_at desc, id desc)
  where deleted_at is null and assigned_user_id is not null;

begin;

-- Resolve the actor's record and customer scope once per workspace request.
-- Operational case rows do not carry team_id, so OWN_TEAM does not grant case
-- record access by itself; it still participates in the existing customer
-- visibility rule through the customer's scoped leads.
create or replace function app_private.operational_case_actor_scope(
  target_organization_id uuid,
  target_department text
)
returns table (
  actor_id uuid,
  full_branch_ids uuid[],
  own_record_branch_ids uuid[],
  all_customers boolean,
  customer_branch_ids uuid[],
  customer_own_record_branch_ids uuid[],
  customer_own_records boolean,
  customer_own_team boolean,
  customer_team_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_actor_id uuid := auth.uid();
  support_access boolean := false;
  department_permission_key text := case upper(btrim(coalesce(target_department, '')))
    when 'FINANCE' then 'finance.view'
    when 'INSURANCE' then 'insurance.view'
    when 'RTO' then 'rto.view'
    when 'EXCHANGE' then 'exchange.view'
    when 'DELIVERY' then 'delivery.view'
  end;
  case_organization_wide boolean := false;
  case_owns_records boolean := false;
  customer_organization_wide boolean := false;
  customer_owns_records boolean := false;
  customer_owns_team boolean := false;
  resolved_full_branch_ids uuid[] := '{}'::uuid[];
  resolved_actor_member_branch_ids uuid[] := '{}'::uuid[];
  resolved_customer_branch_ids uuid[] := '{}'::uuid[];
  resolved_customer_team_ids uuid[] := '{}'::uuid[];
begin
  if current_actor_id is null
    or target_organization_id is null
    or department_permission_key is null
    or not app_private.can_access_organization(target_organization_id)
  then
    raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_SCOPE_REQUIRED';
  end if;

  support_access := app_private.has_active_approved_support_session(target_organization_id);

  select
    coalesce(bool_or(assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')), false),
    coalesce(bool_or(assignment_row.data_scope = 'OWN_RECORDS'), false)
  into case_organization_wide, case_owns_records
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  join public.role_permissions role_permission_row
    on role_permission_row.role_id = role_row.id
  join public.permissions permission_row
    on permission_row.id = role_permission_row.permission_id
   and permission_row.permission_key = department_permission_key
  where assignment_row.organization_id = target_organization_id
    and assignment_row.user_id = current_actor_id
    and assignment_row.active;

  select
    coalesce(bool_or(assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')), false),
    coalesce(bool_or(assignment_row.data_scope = 'OWN_RECORDS'), false),
    coalesce(bool_or(assignment_row.data_scope = 'OWN_TEAM'), false)
  into customer_organization_wide, customer_owns_records, customer_owns_team
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  join public.role_permissions role_permission_row
    on role_permission_row.role_id = role_row.id
  join public.permissions permission_row
    on permission_row.id = role_permission_row.permission_id
   and permission_row.permission_key = 'customer.view'
  where assignment_row.organization_id = target_organization_id
    and assignment_row.user_id = current_actor_id
    and assignment_row.active;

  select coalesce(array_agg(branch_row.id order by branch_row.id), '{}'::uuid[])
  into resolved_full_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = target_organization_id
    and branch_row.active
    and branch_row.deleted_at is null
    and (
      support_access
      or case_organization_wide
      or exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        join public.role_permissions role_permission_row
          on role_permission_row.role_id = role_row.id
        join public.permissions permission_row
          on permission_row.id = role_permission_row.permission_id
         and permission_row.permission_key = department_permission_key
        where assignment_row.organization_id = target_organization_id
          and assignment_row.user_id = current_actor_id
          and assignment_row.active
          and (
            (
              assignment_row.data_scope = 'ONE_BRANCH'
              and assignment_row.scope_branch_id = branch_row.id
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and branch_row.id = any(
                coalesce(assignment_row.selected_branch_ids, '{}'::uuid[])
              )
            )
          )
      )
    );

  if case_owns_records or customer_owns_records then
    select coalesce(array_agg(branch_row.id order by branch_row.id), '{}'::uuid[])
    into resolved_actor_member_branch_ids
    from public.branches branch_row
    where branch_row.organization_id = target_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and (
        exists (
          select 1
          from public.user_branch_access branch_access_row
          where branch_access_row.organization_id = target_organization_id
            and branch_access_row.user_id = current_actor_id
            and branch_access_row.branch_id = branch_row.id
            and branch_access_row.active
        )
        or exists (
          select 1
          from public.team_members member_row
          join public.teams team_row
            on team_row.id = member_row.team_id
           and team_row.organization_id = member_row.organization_id
          where member_row.organization_id = target_organization_id
            and member_row.user_id = current_actor_id
            and member_row.active
            and team_row.active
            and team_row.branch_id = branch_row.id
        )
      );
  end if;

  select coalesce(array_agg(scope_row.branch_id order by scope_row.branch_id), '{}'::uuid[])
  into resolved_customer_branch_ids
  from (
    select distinct assignment_row.scope_branch_id as branch_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = role_row.id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'customer.view'
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = current_actor_id
      and assignment_row.active
      and assignment_row.data_scope = 'ONE_BRANCH'
      and assignment_row.scope_branch_id is not null
    union
    select distinct selected_branch.branch_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = role_row.id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'customer.view'
    cross join lateral unnest(
      coalesce(assignment_row.selected_branch_ids, '{}'::uuid[])
    ) selected_branch(branch_id)
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = current_actor_id
      and assignment_row.active
      and assignment_row.data_scope = 'SELECTED_BRANCHES'
  ) scope_row
  join public.branches branch_row
    on branch_row.id = scope_row.branch_id
   and branch_row.organization_id = target_organization_id
   and branch_row.active
   and branch_row.deleted_at is null;

  if customer_owns_team then
    select coalesce(array_agg(member_row.team_id order by member_row.team_id), '{}'::uuid[])
    into resolved_customer_team_ids
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
     and team_row.active
    join public.branches branch_row
      on branch_row.id = team_row.branch_id
     and branch_row.organization_id = team_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    where member_row.organization_id = target_organization_id
      and member_row.user_id = current_actor_id
      and member_row.active;
  end if;

  return query select
    current_actor_id,
    resolved_full_branch_ids,
    case when case_owns_records
      then resolved_actor_member_branch_ids else '{}'::uuid[] end,
    support_access or customer_organization_wide,
    resolved_customer_branch_ids,
    case when customer_owns_records
      then resolved_actor_member_branch_ids else '{}'::uuid[] end,
    customer_owns_records,
    customer_owns_team,
    resolved_customer_team_ids;
end;
$$;

revoke all on function app_private.operational_case_actor_scope(uuid, text)
  from public, anon, authenticated;

create or replace function public.get_operational_case_workspace_page(
  target_department text,
  target_status text default 'OPEN',
  target_search text default '',
  target_from_date date default null,
  target_to_date date default null,
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
  current_actor_id uuid;
  allowed_full_branch_ids uuid[] := '{}'::uuid[];
  allowed_own_record_branch_ids uuid[] := '{}'::uuid[];
  can_access_all_customers boolean := false;
  allowed_customer_branch_ids uuid[] := '{}'::uuid[];
  allowed_customer_own_record_branch_ids uuid[] := '{}'::uuid[];
  can_access_own_customers boolean := false;
  can_access_team_customers boolean := false;
  allowed_customer_team_ids uuid[] := '{}'::uuid[];
  normalized_department text := upper(btrim(coalesce(target_department, '')));
  normalized_status text := upper(btrim(coalesce(target_status, '')));
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_name_pattern text;
  normalized_phone_search text;
  target_resource_type text;
  from_timestamp timestamptz;
  to_timestamp_exclusive timestamptz;
  local_today date;
  today_start timestamptz;
  tomorrow_start timestamptz;
  month_start timestamptz;
  next_month_start timestamptz;
  result jsonb;
begin
  if normalized_department not in ('FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY')
    or (
      normalized_status not in ('ALL', 'OPEN', 'DOCUMENTS', 'ACTION_DUE', 'COMPLETED')
      and not app_private.operational_case_status_valid(normalized_department, normalized_status)
    )
    or char_length(normalized_search) > 160
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort is null
    or target_sort not in ('updated:desc', 'updated:asc', 'due:asc', 'customer:asc', 'priority:desc')
    or target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC')
    or (
      target_from_date is not null
      and target_to_date is not null
      and target_from_date > target_to_date
    )
    or (
      target_from_date is not null
      and target_to_date is not null
      and target_to_date > target_from_date + 366
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.operational_case_permission(
      current_organization_id, normalized_department, 'VIEW'
    )
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_VIEW_PERMISSION_REQUIRED';
  end if;

  select
    scope_row.actor_id,
    scope_row.full_branch_ids,
    scope_row.own_record_branch_ids,
    scope_row.all_customers,
    scope_row.customer_branch_ids,
    scope_row.customer_own_record_branch_ids,
    scope_row.customer_own_records,
    scope_row.customer_own_team,
    scope_row.customer_team_ids
  into
    current_actor_id,
    allowed_full_branch_ids,
    allowed_own_record_branch_ids,
    can_access_all_customers,
    allowed_customer_branch_ids,
    allowed_customer_own_record_branch_ids,
    can_access_own_customers,
    can_access_team_customers,
    allowed_customer_team_ids
  from app_private.operational_case_actor_scope(
    current_organization_id, normalized_department
  ) scope_row;

  normalized_phone_search := app_private.normalize_phone_digits(normalized_search);
  normalized_name_pattern := replace(
    replace(replace(normalized_search, '!', '!!'), '%', '!%'), '_', '!_'
  );
  target_resource_type := lower(normalized_department) || '_case';
  from_timestamp := case when target_from_date is null then null
    else pg_catalog.timezone(target_timezone, target_from_date::timestamp) end;
  to_timestamp_exclusive := case when target_to_date is null then null
    else pg_catalog.timezone(target_timezone, (target_to_date + 1)::timestamp) end;
  local_today := pg_catalog.timezone(target_timezone, now())::date;
  today_start := pg_catalog.timezone(target_timezone, local_today::timestamp);
  tomorrow_start := pg_catalog.timezone(target_timezone, (local_today + 1)::timestamp);
  month_start := pg_catalog.timezone(
    target_timezone,
    pg_catalog.date_trunc('month', local_today::timestamp)
  );
  next_month_start := pg_catalog.timezone(
    target_timezone,
    pg_catalog.date_trunc('month', local_today::timestamp) + interval '1 month'
  );

  with scoped_lead_customers as materialized (
    select distinct lead_row.customer_id
    from public.leads lead_row
    where not can_access_all_customers
      and lead_row.organization_id = current_organization_id
      and lead_row.customer_id is not null
      and lead_row.deleted_at is null
      and (
        (
          can_access_own_customers
          and lead_row.assigned_user_id = current_actor_id
          and lead_row.branch_id = any(allowed_customer_own_record_branch_ids)
        )
        or (
          can_access_team_customers
          and lead_row.team_id = any(allowed_customer_team_ids)
        )
        or lead_row.branch_id = any(allowed_customer_branch_ids)
      )
  ), authorized_customer_ids as not materialized (
    select customer_row.id
    from public.customers customer_row
    left join scoped_lead_customers scoped_customer
      on scoped_customer.customer_id = customer_row.id
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and (can_access_all_customers or scoped_customer.customer_id is not null)
  ), matching_customers as materialized (
    select customer_row.id
    from public.customers customer_row
    join authorized_customer_ids authorized_row on authorized_row.id = customer_row.id
    where normalized_search <> ''
      and (
        customer_row.normalized_name
          ilike '%' || normalized_name_pattern || '%' escape '!'
        or (
          normalized_phone_search <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone)
            = normalized_phone_search
        )
      )
  ), customer_sort_keys as materialized (
    select customer_row.id, customer_row.normalized_name as search_name
    from public.customers customer_row
    join authorized_customer_ids authorized_row on authorized_row.id = customer_row.id
    where target_sort = 'customer:asc'
  ), case_rows as materialized (
    select
      'FINANCE'::text as department,
      'finance_case'::text as resource_type,
      case_row.id,
      case_row.organization_id,
      case_row.branch_id,
      case_row.booking_id,
      case_row.customer_id,
      case_row.assigned_user_id,
      case_row.status,
      case_row.version,
      case_row.priority,
      case_row.due_at,
      case_row.created_at,
      case_row.updated_at,
      customer_sort_scope.search_name as customer_sort_name,
      app_private.operational_case_terminal('FINANCE', case_row.status) as terminal
    from public.finance_cases case_row
    join authorized_customer_ids customer_scope on customer_scope.id = case_row.customer_id
    left join customer_sort_keys customer_sort_scope
      on customer_sort_scope.id = case_row.customer_id
    join public.bookings booking_scope
      on booking_scope.organization_id = case_row.organization_id
     and booking_scope.id = case_row.booking_id
     and booking_scope.deleted_at is null
    where normalized_department = 'FINANCE'
      and case_row.organization_id = current_organization_id
      and case_row.deleted_at is null
      and (
        case_row.branch_id = any(allowed_full_branch_ids)
        or (
          case_row.assigned_user_id = current_actor_id
          and case_row.branch_id = any(allowed_own_record_branch_ids)
        )
      )
      and (from_timestamp is null or case_row.updated_at >= from_timestamp)
      and (to_timestamp_exclusive is null or case_row.updated_at < to_timestamp_exclusive)
      and (
        normalized_search = ''
        or position(normalized_search in lower(case_row.id::text)) > 0
        or case_row.customer_id in (select matching_row.id from matching_customers matching_row)
        or position(normalized_search in lower(booking_scope.booking_number)) > 0
      )
    union all
    select
      'INSURANCE'::text, 'insurance_case'::text, case_row.id,
      case_row.organization_id, case_row.branch_id, case_row.booking_id,
      case_row.customer_id, case_row.assigned_user_id, case_row.status,
      case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
      case_row.updated_at, customer_sort_scope.search_name,
      app_private.operational_case_terminal('INSURANCE', case_row.status)
    from public.insurance_cases case_row
    join authorized_customer_ids customer_scope on customer_scope.id = case_row.customer_id
    left join customer_sort_keys customer_sort_scope
      on customer_sort_scope.id = case_row.customer_id
    join public.bookings booking_scope
      on booking_scope.organization_id = case_row.organization_id
     and booking_scope.id = case_row.booking_id
     and booking_scope.deleted_at is null
    where normalized_department = 'INSURANCE'
      and case_row.organization_id = current_organization_id
      and case_row.deleted_at is null
      and (
        case_row.branch_id = any(allowed_full_branch_ids)
        or (
          case_row.assigned_user_id = current_actor_id
          and case_row.branch_id = any(allowed_own_record_branch_ids)
        )
      )
      and (from_timestamp is null or case_row.updated_at >= from_timestamp)
      and (to_timestamp_exclusive is null or case_row.updated_at < to_timestamp_exclusive)
      and (
        normalized_search = ''
        or position(normalized_search in lower(case_row.id::text)) > 0
        or case_row.customer_id in (select matching_row.id from matching_customers matching_row)
        or position(normalized_search in lower(booking_scope.booking_number)) > 0
      )
    union all
    select
      'RTO'::text, 'rto_case'::text, case_row.id,
      case_row.organization_id, case_row.branch_id, case_row.booking_id,
      case_row.customer_id, case_row.assigned_user_id, case_row.status,
      case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
      case_row.updated_at, customer_sort_scope.search_name,
      app_private.operational_case_terminal('RTO', case_row.status)
    from public.rto_cases case_row
    join authorized_customer_ids customer_scope on customer_scope.id = case_row.customer_id
    left join customer_sort_keys customer_sort_scope
      on customer_sort_scope.id = case_row.customer_id
    join public.bookings booking_scope
      on booking_scope.organization_id = case_row.organization_id
     and booking_scope.id = case_row.booking_id
     and booking_scope.deleted_at is null
    where normalized_department = 'RTO'
      and case_row.organization_id = current_organization_id
      and case_row.deleted_at is null
      and (
        case_row.branch_id = any(allowed_full_branch_ids)
        or (
          case_row.assigned_user_id = current_actor_id
          and case_row.branch_id = any(allowed_own_record_branch_ids)
        )
      )
      and (from_timestamp is null or case_row.updated_at >= from_timestamp)
      and (to_timestamp_exclusive is null or case_row.updated_at < to_timestamp_exclusive)
      and (
        normalized_search = ''
        or position(normalized_search in lower(case_row.id::text)) > 0
        or case_row.customer_id in (select matching_row.id from matching_customers matching_row)
        or position(normalized_search in lower(booking_scope.booking_number)) > 0
      )
    union all
    select
      'EXCHANGE'::text, 'exchange_case'::text, case_row.id,
      case_row.organization_id, case_row.branch_id, case_row.booking_id,
      case_row.customer_id, case_row.assigned_user_id, case_row.status,
      case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
      case_row.updated_at, customer_sort_scope.search_name,
      app_private.operational_case_terminal('EXCHANGE', case_row.status)
    from public.exchange_cases case_row
    join authorized_customer_ids customer_scope on customer_scope.id = case_row.customer_id
    left join customer_sort_keys customer_sort_scope
      on customer_sort_scope.id = case_row.customer_id
    left join public.bookings booking_scope
      on booking_scope.organization_id = case_row.organization_id
     and booking_scope.id = case_row.booking_id
     and booking_scope.deleted_at is null
    where normalized_department = 'EXCHANGE'
      and case_row.organization_id = current_organization_id
      and case_row.deleted_at is null
      and (
        case_row.branch_id = any(allowed_full_branch_ids)
        or (
          case_row.assigned_user_id = current_actor_id
          and case_row.branch_id = any(allowed_own_record_branch_ids)
        )
      )
      and (from_timestamp is null or case_row.updated_at >= from_timestamp)
      and (to_timestamp_exclusive is null or case_row.updated_at < to_timestamp_exclusive)
      and (
        normalized_search = ''
        or position(normalized_search in lower(case_row.id::text)) > 0
        or case_row.customer_id in (select matching_row.id from matching_customers matching_row)
        or position(normalized_search in lower(coalesce(booking_scope.booking_number, ''))) > 0
      )
    union all
    select
      'DELIVERY'::text, 'delivery_case'::text, case_row.id,
      case_row.organization_id, case_row.branch_id, case_row.booking_id,
      case_row.customer_id, case_row.assigned_user_id, case_row.status,
      case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
      case_row.updated_at, customer_sort_scope.search_name,
      app_private.operational_case_terminal('DELIVERY', case_row.status)
    from public.delivery_cases case_row
    join authorized_customer_ids customer_scope on customer_scope.id = case_row.customer_id
    left join customer_sort_keys customer_sort_scope
      on customer_sort_scope.id = case_row.customer_id
    join public.bookings booking_scope
      on booking_scope.organization_id = case_row.organization_id
     and booking_scope.id = case_row.booking_id
     and booking_scope.deleted_at is null
    where normalized_department = 'DELIVERY'
      and case_row.organization_id = current_organization_id
      and case_row.deleted_at is null
      and (
        case_row.branch_id = any(allowed_full_branch_ids)
        or (
          case_row.assigned_user_id = current_actor_id
          and case_row.branch_id = any(allowed_own_record_branch_ids)
        )
      )
      and (from_timestamp is null or case_row.updated_at >= from_timestamp)
      and (to_timestamp_exclusive is null or case_row.updated_at < to_timestamp_exclusive)
      and (
        normalized_search = ''
        or position(normalized_search in lower(case_row.id::text)) > 0
        or case_row.customer_id in (select matching_row.id from matching_customers matching_row)
        or position(normalized_search in lower(booking_scope.booking_number)) > 0
      )
  ), documented_cases as materialized (
    select file_row.resource_id
    from public.object_files file_row
    join case_rows case_row on case_row.id = file_row.resource_id
    where file_row.organization_id = current_organization_id
      and file_row.resource_type = target_resource_type
      and file_row.deleted_at is null
    group by file_row.resource_id
  ), authorized as materialized (
    select case_row.*, documented_row.resource_id is not null as has_document
    from case_rows case_row
    left join documented_cases documented_row on documented_row.resource_id = case_row.id
  ), filtered as materialized (
    select authorized_row.*
    from authorized authorized_row
    where case normalized_status
      when 'ALL' then true
      when 'OPEN' then not authorized_row.terminal
      when 'DOCUMENTS' then
        authorized_row.status in ('DOCUMENTS_PENDING', 'QUOTE_PENDING', 'NEW')
        or not authorized_row.has_document
      when 'ACTION_DUE' then
        not authorized_row.terminal
        and authorized_row.due_at is not null
        and authorized_row.due_at <= now()
      when 'COMPLETED' then authorized_row.terminal
      else authorized_row.status = normalized_status
    end
  ), page_slice as materialized (
    select filtered_row.*
    from filtered filtered_row
    order by
      case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
      case when target_sort = 'updated:asc' then filtered_row.updated_at end asc,
      case when target_sort = 'due:asc' then filtered_row.due_at end asc nulls last,
      case when target_sort = 'customer:asc' then filtered_row.customer_sort_name end asc,
      case filtered_row.priority
        when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1
      end desc,
      filtered_row.id desc
    limit target_page_size
    offset (target_page - 1)::bigint * target_page_size
  ), page_rows as materialized (
    select page_slice_row.*, row_number() over (order by
      case when target_sort = 'updated:desc' then page_slice_row.updated_at end desc,
      case when target_sort = 'updated:asc' then page_slice_row.updated_at end asc,
      case when target_sort = 'due:asc' then page_slice_row.due_at end asc nulls last,
      case when target_sort = 'customer:asc' then page_slice_row.customer_sort_name end asc,
      case page_slice_row.priority
        when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1
      end desc,
      page_slice_row.id desc
    ) as page_order
    from page_slice page_slice_row
  ), enriched_page as materialized (
    select
      page_row.department,
      page_row.resource_type,
      page_row.id,
      page_row.organization_id,
      page_row.branch_id,
      page_row.booking_id,
      page_row.customer_id,
      page_row.assigned_user_id,
      page_row.status,
      page_row.version,
      page_row.priority,
      page_row.due_at,
      page_row.created_at,
      page_row.updated_at,
      booking_row.booking_number,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      profile_row.full_name as assigned_user_name,
      case page_row.department
        when 'FINANCE' then jsonb_strip_nulls(jsonb_build_object(
          'lender', finance_row.lender,
          'application_reference', finance_row.application_reference,
          'approved_amount', finance_row.approved_amount,
          'disbursed_at', finance_row.disbursed_at,
          'notes', finance_row.notes
        ))
        when 'INSURANCE' then jsonb_strip_nulls(jsonb_build_object(
          'vehicle_id', insurance_row.vehicle_id,
          'insurer', insurance_row.insurer,
          'policy_number', insurance_row.policy_number,
          'policy_start', insurance_row.policy_start,
          'policy_end', insurance_row.policy_end,
          'notes', insurance_row.notes
        ))
        when 'RTO' then jsonb_strip_nulls(jsonb_build_object(
          'vehicle_id', rto_row.vehicle_id,
          'registration_number', rto_row.registration_number,
          'submitted_at', rto_row.submitted_at,
          'completed_at', rto_row.completed_at,
          'notes', rto_row.notes
        ))
        when 'EXCHANGE' then jsonb_strip_nulls(jsonb_build_object(
          'vehicle_id', exchange_row.vehicle_id,
          'estimated_value', exchange_row.estimated_value,
          'accepted_value', exchange_row.accepted_value,
          'notes', exchange_row.notes,
          'evaluation', (
            select jsonb_build_object(
              'inspection', evaluation_row.inspection,
              'quoted_value', evaluation_row.quoted_value,
              'created_at', evaluation_row.created_at
            )
            from public.exchange_evaluations evaluation_row
            where evaluation_row.organization_id = page_row.organization_id
              and evaluation_row.exchange_case_id = page_row.id
            order by evaluation_row.created_at desc, evaluation_row.id desc
            limit 1
          )
        ))
        when 'DELIVERY' then jsonb_strip_nulls(jsonb_build_object(
          'vehicle_id', delivery_row.vehicle_id,
          'scheduled_at', delivery_row.scheduled_at,
          'delivered_at', delivery_row.delivered_at,
          'signature_file_id', delivery_row.signature_file_id,
          'notes', delivery_row.notes,
          'checklist_total', (
            select count(*)
            from public.delivery_checklist_items item_row
            where item_row.organization_id = page_row.organization_id
              and item_row.delivery_id = page_row.id
          ),
          'checklist_completed', (
            select count(*)
            from public.delivery_checklist_items item_row
            where item_row.organization_id = page_row.organization_id
              and item_row.delivery_id = page_row.id
              and item_row.completed
          )
        ))
      end as details,
      (
        select count(*)
        from public.object_files file_row
        where file_row.organization_id = page_row.organization_id
          and file_row.resource_type = page_row.resource_type
          and file_row.resource_id = page_row.id
          and file_row.deleted_at is null
      ) as document_count,
      page_row.page_order
    from page_rows page_row
    join public.customers customer_row
      on customer_row.organization_id = page_row.organization_id
     and customer_row.id = page_row.customer_id
     and customer_row.deleted_at is null
    left join public.bookings booking_row
      on booking_row.organization_id = page_row.organization_id
     and booking_row.id = page_row.booking_id
     and booking_row.deleted_at is null
    left join public.profiles profile_row
      on profile_row.organization_id = page_row.organization_id
     and profile_row.id = page_row.assigned_user_id
    left join public.finance_cases finance_row
      on page_row.department = 'FINANCE'
     and finance_row.organization_id = page_row.organization_id
     and finance_row.id = page_row.id
     and finance_row.deleted_at is null
    left join public.insurance_cases insurance_row
      on page_row.department = 'INSURANCE'
     and insurance_row.organization_id = page_row.organization_id
     and insurance_row.id = page_row.id
     and insurance_row.deleted_at is null
    left join public.rto_cases rto_row
      on page_row.department = 'RTO'
     and rto_row.organization_id = page_row.organization_id
     and rto_row.id = page_row.id
     and rto_row.deleted_at is null
    left join public.exchange_cases exchange_row
      on page_row.department = 'EXCHANGE'
     and exchange_row.organization_id = page_row.organization_id
     and exchange_row.id = page_row.id
     and exchange_row.deleted_at is null
    left join public.delivery_cases delivery_row
      on page_row.department = 'DELIVERY'
     and delivery_row.organization_id = page_row.organization_id
     and delivery_row.id = page_row.id
     and delivery_row.deleted_at is null
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'department', enriched_row.department,
        'resource_type', enriched_row.resource_type,
        'id', enriched_row.id,
        'organization_id', enriched_row.organization_id,
        'branch_id', enriched_row.branch_id,
        'booking_id', enriched_row.booking_id,
        'customer_id', enriched_row.customer_id,
        'assigned_user_id', enriched_row.assigned_user_id,
        'status', enriched_row.status,
        'version', enriched_row.version,
        'priority', enriched_row.priority,
        'due_at', enriched_row.due_at,
        'created_at', enriched_row.created_at,
        'updated_at', enriched_row.updated_at,
        'booking_number', enriched_row.booking_number,
        'customer_name', enriched_row.customer_name,
        'phone', enriched_row.phone,
        'assigned_user_name', enriched_row.assigned_user_name,
        'details', enriched_row.details,
        'document_count', enriched_row.document_count
      ) order by enriched_row.page_order)
      from enriched_page enriched_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'organization_id', current_organization_id,
    'department', normalized_department,
    'kpis', jsonb_build_object(
      'open', (select count(*) from authorized where not terminal),
      'pending_documents', (
        select count(*) from authorized
        where status in ('DOCUMENTS_PENDING', 'QUOTE_PENDING', 'NEW')
          or not has_document
      ),
      'overdue', (
        select count(*) from authorized
        where due_at < now() and not terminal
      ),
      'due_today', (
        select count(*) from authorized
        where due_at >= today_start
          and due_at < tomorrow_start
          and not terminal
      ),
      'completed_this_month', (
        select count(*) from authorized
        where terminal
          and updated_at >= month_start
          and updated_at < next_month_start
      )
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_operational_case_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) from public, anon;
grant execute on function public.get_operational_case_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) to authenticated;

commit;
