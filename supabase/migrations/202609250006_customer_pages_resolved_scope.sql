-- The Customers page and the customer lookup called app_private.can_access_customer
-- once per customer in the organization, and can_access_record once per lead and
-- booking. can_access_customer runs a correlated lead subquery that calls
-- has_owned_lead per lead, so at 75k customers a Sales Consultant's Customers page
-- hit the 8 s statement timeout and the lookup took 1-2 s.
--
-- Both functions now resolve the actor's scope once per request and filter on
-- arrays:
--   * customer visibility keeps can_access_customer's rule exactly: every active
--     role assignment counts, an ORGANIZATION / ALL_BRANCHES assignment or an
--     approved support session sees all customers, otherwise the customer needs a
--     live lead in one of the actor's branches or teams, or one the actor owns or
--     has owned (lead_assignments / lead_assignment_history);
--   * lead and booking rows use the permission-scoped resolver, the same rule the
--     lead workspace and pickers already apply;
--   * the lookup keeps its Customer 360 rule (customer_360_visible), evaluated
--     from the customer.view scope resolved once.
-- Bodies are the deployed definitions with only those predicates replaced.

create index if not exists lead_assignments_org_assignee_idx
  on public.lead_assignments (organization_id, assigned_user_id, lead_id);

create index if not exists lead_assignment_history_org_previous_owner_all_idx
  on public.lead_assignment_history (organization_id, previous_owner_id, lead_id);

create index if not exists lead_assignment_history_org_new_owner_lead_idx
  on public.lead_assignment_history (organization_id, new_owner_id, lead_id);

-- Leads the actor owns or has owned: has_owned_lead's rule as one set.
create or replace function app_private.actor_owned_lead_ids(target_organization_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owned uuid[];
begin
  select coalesce(array_agg(distinct owned_row.lead_id), array[]::uuid[])
    into owned
  from (
    select assignment_row.lead_id
    from public.lead_assignments assignment_row
    where assignment_row.organization_id = target_organization_id
      and assignment_row.assigned_user_id = auth.uid()
    union all
    select history_row.lead_id
    from public.lead_assignment_history history_row
    where history_row.organization_id = target_organization_id
      and history_row.previous_owner_id = auth.uid()
    union all
    select history_row.lead_id
    from public.lead_assignment_history history_row
    where history_row.organization_id = target_organization_id
      and history_row.new_owner_id = auth.uid()
  ) owned_row;
  return owned;
end;
$$;

revoke all on function app_private.actor_owned_lead_ids(uuid) from public, anon;
grant execute on function app_private.actor_owned_lead_ids(uuid) to authenticated, service_role;

-- can_access_customer's scope, resolved once. customer_ids_all is true when every
-- customer in the organization is visible; otherwise a customer is visible when
-- one of its live leads matches branch_ids, team_ids, or (own_records) is owned.
create or replace function app_private.resolve_customer_access_scope(target_organization_id uuid)
returns table (
  customer_ids_all boolean,
  branch_ids uuid[],
  team_ids uuid[],
  own_records boolean,
  organization_access boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  has_access boolean;
  sees_all boolean;
  scoped_branches uuid[];
  scoped_teams uuid[] := array[]::uuid[];
  own_scope boolean;
  team_scope boolean;
begin
  has_access := actor_id is not null
    and app_private.can_access_organization(target_organization_id);
  if not coalesce(has_access, false) then
    return query select false, array[]::uuid[], array[]::uuid[], false, false;
    return;
  end if;

  select
    coalesce(bool_or(assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')), false),
    coalesce(bool_or(assignment_row.data_scope = 'OWN_RECORDS'), false),
    coalesce(bool_or(assignment_row.data_scope = 'OWN_TEAM'), false)
    into sees_all, own_scope, team_scope
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  where assignment_row.user_id = actor_id
    and assignment_row.organization_id = target_organization_id
    and assignment_row.active;

  sees_all := sees_all
    or app_private.has_active_approved_support_session(target_organization_id);

  select coalesce(array_agg(distinct branch_id), array[]::uuid[])
    into scoped_branches
  from (
    select assignment_row.scope_branch_id as branch_id
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.user_id = actor_id
      and assignment_row.organization_id = target_organization_id
      and assignment_row.active
      and assignment_row.data_scope = 'ONE_BRANCH'
    union all
    select unnest(assignment_row.selected_branch_ids)
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.user_id = actor_id
      and assignment_row.organization_id = target_organization_id
      and assignment_row.active
      and assignment_row.data_scope = 'SELECTED_BRANCHES'
  ) branch_row
  where branch_id is not null;

  if team_scope then
    select coalesce(array_agg(distinct member_row.team_id), array[]::uuid[])
      into scoped_teams
    from public.team_members member_row
    where member_row.organization_id = target_organization_id
      and member_row.user_id = actor_id
      and member_row.active;
  end if;

  return query select sees_all, scoped_branches, scoped_teams, own_scope, true;
end;
$$;

revoke all on function app_private.resolve_customer_access_scope(uuid) from public, anon;
grant execute on function app_private.resolve_customer_access_scope(uuid)
  to authenticated, service_role;

create or replace function public.get_customer_workspace_page(
  target_search text default ''::text,
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'updated:desc'::text
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  current_organization_id uuid;
  actor_id uuid := auth.uid();
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  lead_access boolean;
  booking_access boolean;
  customer_scope record;
  lead_scope record;
  booking_scope record;
  owned_lead_ids uuid[] := array[]::uuid[];
  active_branch_ids uuid[];
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

  -- Scope is resolved once here; the query below only compares arrays.
  select * into customer_scope
  from app_private.resolve_customer_access_scope(current_organization_id);
  select * into lead_scope
  from app_private.resolve_permission_record_scope(current_organization_id, array['lead.view']);
  select * into booking_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id, array['booking.view', 'booking.manage']
  );
  if customer_scope.own_records then
    owned_lead_ids := app_private.actor_owned_lead_ids(current_organization_id);
  end if;
  select coalesce(array_agg(branch_row.id), array[]::uuid[]) into active_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and branch_row.active
    and branch_row.deleted_at is null;

  with scoped_customers as materialized (
    select distinct lead_row.customer_id
    from public.leads lead_row
    where customer_scope.organization_access
      and not customer_scope.customer_ids_all
      and lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.customer_id is not null
      and (
        lead_row.branch_id = any(customer_scope.branch_ids)
        or lead_row.team_id = any(customer_scope.team_ids)
        or (
          customer_scope.own_records
          and (lead_row.assigned_user_id = actor_id or lead_row.id = any(owned_lead_ids))
        )
      )
  ), authorized_customers as materialized (
    select customer_row.*
    from public.customers customer_row
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and customer_scope.organization_access
      and (
        customer_scope.customer_ids_all
        or customer_row.id in (select scoped_row.customer_id from scoped_customers scoped_row)
      )
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
      and coalesce(lead_scope.granted, false)
      and lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.branch_id = any(active_branch_ids)
      and (
        lead_scope.organization_wide
        or lead_row.branch_id = any(lead_scope.branch_scope_ids)
        or lead_row.team_id = any(lead_scope.team_scope_ids)
        or (
          lead_scope.own_records
          and lead_row.assigned_user_id = actor_id
          and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
        )
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
      and coalesce(booking_scope.granted, false)
      and booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and (booking_row.branch_id is null or booking_row.branch_id = any(active_branch_ids))
      and (
        booking_scope.organization_wide
        or booking_row.branch_id = any(booking_scope.branch_scope_ids)
        or booking_row.team_id = any(booking_scope.team_scope_ids)
        or (
          booking_scope.own_records
          and booking_row.assigned_user_id = actor_id
          and (
            booking_row.branch_id is null
            or booking_row.branch_id = any(booking_scope.own_record_branch_ids)
          )
        )
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
$function$;

create or replace function public.search_authorized_customers(
  target_search text,
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  current_organization_id uuid;
  actor_id uuid := auth.uid();
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  customer_scope record;
  profile_scope record;
  owned_lead_ids uuid[] := array[]::uuid[];
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) not between 2 and 160 then
    raise exception using errcode = '22023', message = 'GLOBAL_CUSTOMER_SEARCH_REQUIRES_2_TO_160_CHARACTERS';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  select profile_row.organization_id
  into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.organization_id is not null
    and profile_row.active
    and profile_row.deleted_at is null;

  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_VIEW_PERMISSION_REQUIRED';
  end if;

  -- can_access_customer's scope and Customer 360's customer.view scope, each
  -- resolved once instead of per matching customer.
  select * into customer_scope
  from app_private.resolve_customer_access_scope(current_organization_id);
  select * into profile_scope
  from app_private.resolve_permission_record_scope(current_organization_id, array['customer.view']);
  if customer_scope.own_records or coalesce(profile_scope.own_records, false) then
    owned_lead_ids := app_private.actor_owned_lead_ids(current_organization_id);
  end if;

  with candidate_rows as materialized (
    select
      customer_row.id,
      customer_row.full_name,
      customer_row.primary_phone,
      customer_row.primary_email,
      customer_row.updated_at
    from public.customers customer_row
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and customer_scope.organization_access
      and coalesce(profile_scope.granted, false)
      and (
        customer_row.id = search_uuid
        or customer_row.normalized_name ilike '%' || normalized_search || '%'
        or customer_row.normalized_email = normalized_search
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone) = search_phone_digits
        )
      )
  ), matched_rows as materialized (
    select candidate_row.*
    from candidate_rows candidate_row
    where (
        customer_scope.customer_ids_all
        or exists (
          select 1
          from public.leads lead_row
          where lead_row.organization_id = current_organization_id
            and lead_row.customer_id = candidate_row.id
            and lead_row.deleted_at is null
            and (
              lead_row.branch_id = any(customer_scope.branch_ids)
              or lead_row.team_id = any(customer_scope.team_ids)
              or (
                customer_scope.own_records
                and (lead_row.assigned_user_id = actor_id or lead_row.id = any(owned_lead_ids))
              )
            )
        )
      )
      -- Listing a customer that Customer 360 will refuse to open is a dead
      -- end, so the lookup applies that page's own rule as well.
      and (
        coalesce(profile_scope.organization_wide, false)
        or exists (
          select 1
          from public.leads lead_row
          join public.branches branch_row
            on branch_row.id = lead_row.branch_id
           and branch_row.organization_id = lead_row.organization_id
           and branch_row.active
           and branch_row.deleted_at is null
          where lead_row.organization_id = current_organization_id
            and lead_row.customer_id = candidate_row.id
            and lead_row.deleted_at is null
            and (
              lead_row.branch_id = any(profile_scope.branch_scope_ids)
              or lead_row.team_id = any(profile_scope.team_scope_ids)
              or (
                profile_scope.own_records
                and lead_row.branch_id = any(profile_scope.own_record_branch_ids)
                and (lead_row.assigned_user_id = actor_id or lead_row.id = any(owned_lead_ids))
              )
            )
        )
      )
    order by candidate_row.updated_at desc, candidate_row.id desc
    limit target_page_size + 1
    offset (target_page - 1) * target_page_size
  ), page_rows as (
    select *
    from matched_rows
    order by updated_at desc, id desc
    limit target_page_size
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
            'updated_at', page_row.updated_at
          )
          order by page_row.updated_at desc, page_row.id desc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    'has_next', (select count(*) > target_page_size from matched_rows)
  ) into result;

  return result;
end;
$function$;
