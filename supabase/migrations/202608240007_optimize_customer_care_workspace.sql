-- The original branch-first index is useful for branch managers, but it cannot
-- serve organization-wide or own-record queues without scanning every branch.
create index concurrently if not exists customer_care_org_status_updated_page_idx
  on public.customer_care_cases (organization_id, status, updated_at desc, id desc)
  where deleted_at is null;
create index concurrently if not exists customer_care_org_owner_status_updated_page_idx
  on public.customer_care_cases (
    organization_id, assigned_user_id, status, updated_at desc, id desc
  )
  where deleted_at is null and assigned_user_id is not null;
create index concurrently if not exists customer_care_org_type_status_updated_page_idx
  on public.customer_care_cases (
    organization_id, case_type, status, updated_at desc, id desc
  )
  where deleted_at is null;
create index concurrently if not exists customer_care_org_created_activity_idx
  on public.customer_care_cases (organization_id, created_at, id)
  where deleted_at is null;
create index concurrently if not exists customer_care_org_resolved_activity_idx
  on public.customer_care_cases (organization_id, resolved_at, id)
  where deleted_at is null and resolved_at is not null;
create index concurrently if not exists customer_care_case_number_trgm_idx
  on public.customer_care_cases using gin (case_number gin_trgm_ops)
  where deleted_at is null;
create index concurrently if not exists bookings_booking_number_trgm_active_idx
  on public.bookings using gin (booking_number gin_trgm_ops)
  where deleted_at is null;

begin;

-- Resolve scope once for an RPC. Only assignments whose role grants both the
-- requested customer-care permission and customer.view can widen the result.
-- This prevents a broad assignment without customer-care authority from being
-- combined with an unrelated narrow permission assignment.
create or replace function app_private.customer_care_actor_scope(
  target_organization_id uuid,
  target_permission text
)
returns table (
  actor_id uuid,
  organization_wide boolean,
  branch_ids uuid[],
  own_records boolean,
  own_record_branch_ids uuid[],
  own_team boolean,
  team_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_actor_id uuid := auth.uid();
  normalized_permission text := lower(btrim(coalesce(target_permission, '')));
  support_access boolean := false;
  eligible_assignment_exists boolean := false;
  resolved_organization_wide boolean := false;
  resolved_branch_ids uuid[] := '{}'::uuid[];
  resolved_own_records boolean := false;
  resolved_own_record_branch_ids uuid[] := '{}'::uuid[];
  resolved_own_team boolean := false;
  resolved_team_ids uuid[] := '{}'::uuid[];
begin
  if current_actor_id is null
    or target_organization_id is null
    or normalized_permission not in (
      'customer_care.view', 'customer_care.manage', 'customer_care.escalate'
    )
    or not app_private.can_access_organization(target_organization_id)
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_CARE_SCOPE_REQUIRED';
  end if;

  support_access := app_private.has_active_approved_support_session(
    target_organization_id
  );

  with eligible_assignments as materialized (
    select assignment_row.id, assignment_row.data_scope,
      assignment_row.scope_branch_id, assignment_row.selected_branch_ids
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = current_actor_id
      and assignment_row.active
      and exists (
        select 1
        from public.role_permissions role_permission_row
        join public.permissions permission_row
          on permission_row.id = role_permission_row.permission_id
        where role_permission_row.role_id = assignment_row.role_id
          and permission_row.permission_key = normalized_permission
      )
      and exists (
        select 1
        from public.role_permissions role_permission_row
        join public.permissions permission_row
          on permission_row.id = role_permission_row.permission_id
        where role_permission_row.role_id = assignment_row.role_id
          and permission_row.permission_key = 'customer.view'
      )
  )
  select
    exists (select 1 from eligible_assignments),
    coalesce(bool_or(
      assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
    ), false),
    coalesce(bool_or(assignment_row.data_scope = 'OWN_RECORDS'), false),
    coalesce(bool_or(assignment_row.data_scope = 'OWN_TEAM'), false)
  into eligible_assignment_exists, resolved_organization_wide,
    resolved_own_records, resolved_own_team
  from eligible_assignments assignment_row;

  if not support_access and not eligible_assignment_exists then
    raise exception using errcode = '42501', message = 'CUSTOMER_CARE_SCOPE_REQUIRED';
  end if;

  select coalesce(array_agg(branch_row.id order by branch_row.id), '{}'::uuid[])
  into resolved_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = target_organization_id
    and branch_row.active
    and branch_row.deleted_at is null
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.organization_id = target_organization_id
        and assignment_row.user_id = current_actor_id
        and assignment_row.active
        and exists (
          select 1
          from public.role_permissions role_permission_row
          join public.permissions permission_row
            on permission_row.id = role_permission_row.permission_id
          where role_permission_row.role_id = assignment_row.role_id
            and permission_row.permission_key = normalized_permission
        )
        and exists (
          select 1
          from public.role_permissions role_permission_row
          join public.permissions permission_row
            on permission_row.id = role_permission_row.permission_id
          where role_permission_row.role_id = assignment_row.role_id
            and permission_row.permission_key = 'customer.view'
        )
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
    );

  if resolved_own_records then
    select coalesce(array_agg(branch_row.id order by branch_row.id), '{}'::uuid[])
    into resolved_own_record_branch_ids
    from public.branches branch_row
    where branch_row.organization_id = target_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and (
        exists (
          select 1
          from public.user_branch_access access_row
          where access_row.organization_id = target_organization_id
            and access_row.user_id = current_actor_id
            and access_row.branch_id = branch_row.id
            and access_row.active
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

  if resolved_own_team then
    select coalesce(array_agg(member_row.team_id order by member_row.team_id), '{}'::uuid[])
    into resolved_team_ids
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
    join public.branches branch_row
      on branch_row.id = team_row.branch_id
     and branch_row.organization_id = team_row.organization_id
    where member_row.organization_id = target_organization_id
      and member_row.user_id = current_actor_id
      and member_row.active
      and team_row.active
      and branch_row.active
      and branch_row.deleted_at is null;
  end if;

  return query select
    current_actor_id,
    support_access or resolved_organization_wide,
    resolved_branch_ids,
    resolved_own_records,
    resolved_own_record_branch_ids,
    resolved_own_team,
    resolved_team_ids;
end;
$$;

revoke all on function app_private.customer_care_actor_scope(uuid, text)
  from public, anon, authenticated;

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
  current_actor_id uuid;
  scope_organization_wide boolean := false;
  scope_branch_ids uuid[] := '{}'::uuid[];
  scope_own_records boolean := false;
  scope_own_record_branch_ids uuid[] := '{}'::uuid[];
  scope_own_team boolean := false;
  scope_team_ids uuid[] := '{}'::uuid[];
  normalized_view text := upper(btrim(coalesce(target_view, 'OPEN')));
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  escaped_search text;
  search_phone_digits text;
  local_today date;
  today_start timestamptz;
  tomorrow_start timestamptz;
  activity_start timestamptz;
  followup_permission_scope record;
  lead_permission_scope record;
  can_view_followups boolean := false;
  can_view_leads boolean := false;
  result jsonb;
begin
  if normalized_view not in (
      'ALL', 'OPEN', 'SLA_RISK', 'FEEDBACK', 'REVIEW_REQUEST',
      'COMPLAINT', 'ESCALATED', 'RESOLVED', 'CLOSED'
    )
    or char_length(normalized_search) > 160
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort is null
    or target_sort not in ('updated:desc', 'sla:asc', 'created:desc', 'priority:desc')
    or target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.view')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_CARE_VIEW_PERMISSION_REQUIRED';
  end if;

  select scope_row.actor_id, scope_row.organization_wide, scope_row.branch_ids,
    scope_row.own_records, scope_row.own_record_branch_ids,
    scope_row.own_team, scope_row.team_ids
  into current_actor_id, scope_organization_wide, scope_branch_ids,
    scope_own_records, scope_own_record_branch_ids, scope_own_team, scope_team_ids
  from app_private.customer_care_actor_scope(
    current_organization_id, 'customer_care.view'
  ) scope_row;

  select * into followup_permission_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['followup.view']::text[]
  );
  select * into lead_permission_scope
  from app_private.resolve_permission_record_scope(
    current_organization_id,
    array['lead.view']::text[]
  );

  escaped_search := replace(replace(replace(normalized_search, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  local_today := pg_catalog.timezone(target_timezone, now())::date;
  today_start := pg_catalog.timezone(target_timezone, local_today::timestamp);
  tomorrow_start := pg_catalog.timezone(target_timezone, (local_today + 1)::timestamp);
  activity_start := pg_catalog.timezone(
    target_timezone, (local_today - 13)::timestamp
  );
  can_view_followups := coalesce(followup_permission_scope.granted, false);
  can_view_leads := coalesce(lead_permission_scope.granted, false);

  with scoped_lead_customer_ids as materialized (
    select distinct lead_row.customer_id
    from public.leads lead_row
    where not scope_organization_wide
      and lead_row.organization_id = current_organization_id
      and lead_row.customer_id is not null
      and lead_row.deleted_at is null
      and (
        lead_row.branch_id = any(scope_branch_ids)
        or (
          scope_own_records
          and lead_row.assigned_user_id = current_actor_id
        )
        or (
          scope_own_team
          and lead_row.team_id = any(scope_team_ids)
        )
      )
  ), authorized_customer_ids as materialized (
    select customer_row.id
    from public.customers customer_row
    left join scoped_lead_customer_ids scoped_customer
      on scoped_customer.customer_id = customer_row.id
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and (scope_organization_wide or scoped_customer.customer_id is not null)
  ), open_escalated_case_ids as materialized (
    select escalation_row.customer_case_id as id
    from public.escalations escalation_row
    where escalation_row.organization_id = current_organization_id
      and escalation_row.customer_case_id is not null
      and escalation_row.status = 'OPEN'
  ), authorized_cases as materialized (
    select case_row.id, case_row.branch_id, case_row.customer_id,
      case_row.booking_id, case_row.case_number, case_row.case_type,
      case_row.priority, case_row.status, case_row.assigned_user_id,
      case_row.sla_due_at, case_row.resolved_at, case_row.created_at,
      case_row.updated_at, escalation_row.id is not null as escalated
    from public.customer_care_cases case_row
    join authorized_customer_ids customer_scope on customer_scope.id = case_row.customer_id
    left join open_escalated_case_ids escalation_row on escalation_row.id = case_row.id
    where case_row.organization_id = current_organization_id
      and case_row.deleted_at is null
      and (
        scope_organization_wide
        or case_row.branch_id = any(scope_branch_ids)
        or (
          scope_own_records
          and case_row.assigned_user_id = current_actor_id
          and case_row.branch_id = any(scope_own_record_branch_ids)
        )
      )
  ), matching_customer_ids as materialized (
    select customer_row.id
    from public.customers customer_row
    join authorized_customer_ids customer_scope on customer_scope.id = customer_row.id
    where normalized_search <> ''
      and (
        customer_row.normalized_name like '%' || escaped_search || '%' escape E'\\'
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone)
            = search_phone_digits
        )
      )
  ), matching_booking_ids as materialized (
    select booking_row.id
    from public.bookings booking_row
    where normalized_search <> ''
      and booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.booking_number ilike
        '%' || escaped_search || '%' escape E'\\'
  ), filtered_cases as materialized (
    select case_row.*
    from authorized_cases case_row
    where case normalized_view
      when 'ALL' then true
      when 'OPEN' then case_row.status not in ('RESOLVED', 'CLOSED')
      when 'SLA_RISK' then case_row.status not in ('RESOLVED', 'CLOSED')
        and case_row.sla_due_at <= now()
      when 'FEEDBACK' then case_row.case_type = 'FEEDBACK'
      when 'REVIEW_REQUEST' then case_row.case_type = 'REVIEW_REQUEST'
      when 'COMPLAINT' then case_row.case_type = 'COMPLAINT'
      when 'ESCALATED' then case_row.escalated
      else case_row.status = normalized_view
    end
      and (
        normalized_search = ''
        or case_row.case_number ilike
          '%' || escaped_search || '%' escape E'\\'
        or case_row.customer_id in (
          select matching_row.id from matching_customer_ids matching_row
        )
        or case_row.booking_id in (
          select matching_row.id from matching_booking_ids matching_row
        )
      )
  ), page_ids as materialized (
    select case_row.id
    from filtered_cases case_row
    order by
      case when target_sort = 'updated:desc' then case_row.updated_at end desc nulls last,
      case when target_sort = 'sla:asc' then case_row.sla_due_at end asc nulls last,
      case when target_sort = 'created:desc' then case_row.created_at end desc nulls last,
      case case_row.priority when 'URGENT' then 4 when 'HIGH' then 3
        when 'NORMAL' then 2 else 1 end desc,
      case_row.id desc
    limit target_page_size
    offset ((target_page - 1)::bigint * target_page_size)
  ), page_rows as materialized (
    select case_row.id, case_row.organization_id, case_row.branch_id,
      case_row.customer_id, case_row.booking_id, case_row.vehicle_id,
      case_row.case_number, case_row.case_type, case_row.priority,
      case_row.status, case_row.assigned_user_id, case_row.subject,
      case_row.description, case_row.resolution, case_row.sla_due_at,
      case_row.first_contacted_at, case_row.resolved_at, case_row.closed_at,
      case_row.version, case_row.created_at, case_row.updated_at,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      booking_row.booking_number,
      concat_ws(
        ' ', vehicle_row.brand, vehicle_row.model, vehicle_row.registration
      ) as vehicle,
      profile_row.full_name as assigned_user_name,
      escalation_row.id is not null as escalated
    from page_ids page_id
    join public.customer_care_cases case_row
      on case_row.organization_id = current_organization_id
     and case_row.id = page_id.id
     and case_row.deleted_at is null
    join public.customers customer_row
      on customer_row.organization_id = case_row.organization_id
     and customer_row.id = case_row.customer_id
     and customer_row.deleted_at is null
    left join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id
     and booking_row.id = case_row.booking_id
     and booking_row.deleted_at is null
    left join public.customer_vehicles vehicle_row
      on vehicle_row.organization_id = case_row.organization_id
     and vehicle_row.customer_id = case_row.customer_id
     and vehicle_row.id = case_row.vehicle_id
    left join public.profiles profile_row
      on profile_row.organization_id = case_row.organization_id
     and profile_row.id = case_row.assigned_user_id
     and profile_row.active
     and profile_row.deleted_at is null
    left join open_escalated_case_ids escalation_row on escalation_row.id = case_row.id
  ), case_summary as (
    select
      count(*) filter (where status not in ('RESOLVED', 'CLOSED'))::bigint as open,
      count(*) filter (
        where case_type = 'FEEDBACK' and status not in ('RESOLVED', 'CLOSED')
      )::bigint as feedback_pending,
      count(*) filter (
        where case_type = 'REVIEW_REQUEST' and status not in ('RESOLVED', 'CLOSED')
      )::bigint as review_pending,
      count(*) filter (
        where case_type = 'COMPLAINT' and status not in ('RESOLVED', 'CLOSED')
      )::bigint as complaints_open,
      count(*) filter (
        where status not in ('RESOLVED', 'CLOSED') and sla_due_at <= now()
      )::bigint as sla_risk,
      count(*) filter (
        where resolved_at >= today_start and resolved_at < tomorrow_start
      )::bigint as resolved_today,
      coalesce(round((avg(
        extract(epoch from (resolved_at - created_at)) / 3600
      ) filter (where resolved_at is not null))::numeric, 1), 0)
        as average_resolution_hours
    from authorized_cases
  ), followup_summary as (
    select count(*)::bigint as followups_due
    from public.followups followup_row
    left join authorized_customer_ids customer_scope
      on customer_scope.id = followup_row.customer_id
    left join public.leads lead_row
      on lead_row.organization_id = followup_row.organization_id
     and lead_row.id = followup_row.lead_id
     and lead_row.deleted_at is null
    left join authorized_customer_ids lead_customer_scope
      on lead_customer_scope.id = lead_row.customer_id
    where can_view_followups
      and followup_row.organization_id = current_organization_id
      and followup_row.status in ('OPEN', 'OVERDUE')
      and followup_row.due_at >= today_start
      and followup_row.due_at < tomorrow_start
      and (
        scope_organization_wide
        or followup_row.branch_id = any(scope_branch_ids)
        or (
          scope_own_team
          and followup_row.team_id = any(scope_team_ids)
        )
        or (
          scope_own_records
          and followup_row.assigned_user_id = current_actor_id
          and followup_row.branch_id = any(scope_own_record_branch_ids)
        )
      )
      and (
        followup_permission_scope.organization_wide
        or followup_row.branch_id = any(
          followup_permission_scope.branch_scope_ids
        )
        or followup_row.team_id = any(followup_permission_scope.team_scope_ids)
        or (
          followup_permission_scope.own_records
          and followup_row.assigned_user_id = current_actor_id
          and followup_row.branch_id = any(
            followup_permission_scope.own_record_branch_ids
          )
        )
      )
      and (followup_row.customer_id is null or customer_scope.id is not null)
      and (
        followup_row.lead_id is null
        or (
          can_view_leads
          and lead_row.id is not null
              and (
                scope_organization_wide
                or lead_row.branch_id = any(scope_branch_ids)
            or (scope_own_team and lead_row.team_id = any(scope_team_ids))
            or (
              scope_own_records
              and lead_row.assigned_user_id = current_actor_id
                  and lead_row.branch_id = any(scope_own_record_branch_ids)
                )
              )
              and (
                lead_permission_scope.organization_wide
                or lead_row.branch_id = any(lead_permission_scope.branch_scope_ids)
                or lead_row.team_id = any(lead_permission_scope.team_scope_ids)
                or (
                  lead_permission_scope.own_records
                  and lead_row.assigned_user_id = current_actor_id
                  and lead_row.branch_id = any(
                    lead_permission_scope.own_record_branch_ids
                  )
                )
              )
              and (lead_row.customer_id is null or lead_customer_scope.id is not null)
        )
      )
  ), status_counts as (
    select status, count(*)::bigint as case_count
    from authorized_cases
    group by status
  ), created_activity as (
    select pg_catalog.timezone(target_timezone, created_at)::date as day_value,
      count(*)::bigint as opened_count
    from authorized_cases
    where created_at >= activity_start and created_at < tomorrow_start
    group by pg_catalog.timezone(target_timezone, created_at)::date
  ), resolved_activity as (
    select pg_catalog.timezone(target_timezone, resolved_at)::date as day_value,
      count(*)::bigint as resolved_count
    from authorized_cases
    where resolved_at >= activity_start and resolved_at < tomorrow_start
    group by pg_catalog.timezone(target_timezone, resolved_at)::date
  ), activity_days as (
    select generated_day::date as day_value
    from generate_series(local_today - 13, local_today, interval '1 day') generated_day
  )
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', page_row.id,
        'organization_id', page_row.organization_id,
        'branch_id', page_row.branch_id,
        'customer_id', page_row.customer_id,
        'booking_id', page_row.booking_id,
        'vehicle_id', page_row.vehicle_id,
        'case_number', page_row.case_number,
        'case_type', page_row.case_type,
        'priority', page_row.priority,
        'status', page_row.status,
        'assigned_user_id', page_row.assigned_user_id,
        'subject', page_row.subject,
        'description', page_row.description,
        'resolution', page_row.resolution,
        'sla_due_at', page_row.sla_due_at,
        'first_contacted_at', page_row.first_contacted_at,
        'resolved_at', page_row.resolved_at,
        'closed_at', page_row.closed_at,
        'version', page_row.version,
        'created_at', page_row.created_at,
        'updated_at', page_row.updated_at,
        'customer_name', page_row.customer_name,
        'phone', page_row.phone,
        'booking_number', page_row.booking_number,
        'vehicle', page_row.vehicle,
        'assigned_user_name', page_row.assigned_user_name,
        'escalated', page_row.escalated
      ) order by
        case when target_sort = 'updated:desc' then page_row.updated_at end desc nulls last,
        case when target_sort = 'sla:asc' then page_row.sla_due_at end asc nulls last,
        case when target_sort = 'created:desc' then page_row.created_at end desc nulls last,
        case page_row.priority when 'URGENT' then 4 when 'HIGH' then 3
          when 'NORMAL' then 2 else 1 end desc,
        page_row.id desc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_cases),
    'kpis', jsonb_build_object(
      'open', (select open from case_summary),
      'followups_due', (select followups_due from followup_summary),
      'feedback_pending', (select feedback_pending from case_summary),
      'review_pending', (select review_pending from case_summary),
      'complaints_open', (select complaints_open from case_summary),
      'sla_risk', (select sla_risk from case_summary),
      'resolved_today', (select resolved_today from case_summary),
      'average_resolution_hours', (
        select average_resolution_hours from case_summary
      )
    ),
    'status_chart', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', initcap(replace(status_row.status, '_', ' ')),
        'value', status_row.case_count
      ) order by status_row.case_count desc, status_row.status)
      from status_counts status_row
    ), '[]'::jsonb),
    'activity_chart', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', to_char(day_row.day_value, 'DD Mon'),
        'value', coalesce(created_row.opened_count, 0),
        'secondary', coalesce(resolved_row.resolved_count, 0)
      ) order by day_row.day_value)
      from activity_days day_row
      left join created_activity created_row on created_row.day_value = day_row.day_value
      left join resolved_activity resolved_row on resolved_row.day_value = day_row.day_value
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.get_customer_care_customer_options(
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
  current_actor_id uuid;
  scope_organization_wide boolean := false;
  scope_branch_ids uuid[] := '{}'::uuid[];
  scope_own_records boolean := false;
  scope_own_record_branch_ids uuid[] := '{}'::uuid[];
  scope_own_team boolean := false;
  scope_team_ids uuid[] := '{}'::uuid[];
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  escaped_search text;
  search_phone_digits text;
  result jsonb;
begin
  if char_length(normalized_search) > 160
    or target_limit is null or target_limit not between 1 and 25
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_OPTION_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_CARE_MANAGE_PERMISSION_REQUIRED';
  end if;

  select scope_row.actor_id, scope_row.organization_wide, scope_row.branch_ids,
    scope_row.own_records, scope_row.own_record_branch_ids,
    scope_row.own_team, scope_row.team_ids
  into current_actor_id, scope_organization_wide, scope_branch_ids,
    scope_own_records, scope_own_record_branch_ids, scope_own_team, scope_team_ids
  from app_private.customer_care_actor_scope(
    current_organization_id, 'customer_care.manage'
  ) scope_row;

  escaped_search := replace(replace(replace(normalized_search, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);

  with scoped_lead_customer_ids as materialized (
    select distinct lead_row.customer_id
    from public.leads lead_row
    where not scope_organization_wide
      and lead_row.organization_id = current_organization_id
      and lead_row.customer_id is not null
      and lead_row.deleted_at is null
      and (
        lead_row.branch_id = any(scope_branch_ids)
        or (scope_own_records and lead_row.assigned_user_id = current_actor_id)
        or (scope_own_team and lead_row.team_id = any(scope_team_ids))
      )
  ), authorized_customer_ids as materialized (
    select customer_row.id
    from public.customers customer_row
    left join scoped_lead_customer_ids scoped_customer
      on scoped_customer.customer_id = customer_row.id
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and (scope_organization_wide or scoped_customer.customer_id is not null)
  ), option_rows as materialized (
    select customer_row.id as customer_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      booking_row.id as booking_id,
      booking_row.booking_number,
      booking_row.branch_id,
      vehicle_row.id as vehicle_id,
      concat_ws(
        ' ', vehicle_row.brand, vehicle_row.model, vehicle_row.registration
      ) as vehicle,
      customer_row.updated_at
    from public.customers customer_row
    join authorized_customer_ids customer_scope on customer_scope.id = customer_row.id
    join lateral (
      select source_booking.id, source_booking.booking_number,
        source_booking.branch_id, source_booking.assigned_user_id,
        source_booking.team_id, source_booking.updated_at
      from public.bookings source_booking
      where source_booking.organization_id = current_organization_id
        and source_booking.customer_id = customer_row.id
        and source_booking.deleted_at is null
        and (
          scope_organization_wide
          or source_booking.branch_id = any(scope_branch_ids)
          or (scope_own_team and source_booking.team_id = any(scope_team_ids))
          or (
            scope_own_records
            and source_booking.assigned_user_id = current_actor_id
            and source_booking.branch_id = any(scope_own_record_branch_ids)
          )
        )
      order by source_booking.updated_at desc, source_booking.id desc
      limit 1
    ) booking_row on true
    left join lateral (
      select source_vehicle.id, source_vehicle.brand, source_vehicle.model,
        source_vehicle.registration
      from public.customer_vehicles source_vehicle
      where source_vehicle.organization_id = current_organization_id
        and source_vehicle.customer_id = customer_row.id
      order by source_vehicle.created_at desc, source_vehicle.id desc
      limit 1
    ) vehicle_row on true
    where normalized_search = ''
      or customer_row.normalized_name
        like '%' || escaped_search || '%' escape E'\\'
      or booking_row.booking_number ilike
        '%' || escaped_search || '%' escape E'\\'
      or (
        search_phone_digits <> ''
        and app_private.normalize_phone_digits(customer_row.normalized_phone)
          = search_phone_digits
      )
    order by customer_row.updated_at desc, customer_row.id desc
    limit target_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'customer_id', option_row.customer_id,
    'customer_name', option_row.customer_name,
    'phone', option_row.phone,
    'booking_id', option_row.booking_id,
    'booking_number', option_row.booking_number,
    'branch_id', option_row.branch_id,
    'vehicle_id', option_row.vehicle_id,
    'vehicle', option_row.vehicle,
    'updated_at', option_row.updated_at
  ) order by option_row.updated_at desc, option_row.customer_id desc), '[]'::jsonb)
  into result
  from option_rows option_row;

  return result;
end;
$$;

create or replace function public.get_customer_care_dashboard_summary(
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
  scope_organization_wide boolean := false;
  scope_branch_ids uuid[] := '{}'::uuid[];
  scope_own_records boolean := false;
  scope_own_record_branch_ids uuid[] := '{}'::uuid[];
  scope_own_team boolean := false;
  scope_team_ids uuid[] := '{}'::uuid[];
  local_today date;
  today_start timestamptz;
  tomorrow_start timestamptz;
  result jsonb;
begin
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_DASHBOARD_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.view')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_CARE_VIEW_PERMISSION_REQUIRED';
  end if;

  select scope_row.actor_id, scope_row.organization_wide, scope_row.branch_ids,
    scope_row.own_records, scope_row.own_record_branch_ids,
    scope_row.own_team, scope_row.team_ids
  into current_actor_id, scope_organization_wide, scope_branch_ids,
    scope_own_records, scope_own_record_branch_ids, scope_own_team, scope_team_ids
  from app_private.customer_care_actor_scope(
    current_organization_id, 'customer_care.view'
  ) scope_row;

  local_today := pg_catalog.timezone(target_timezone, now())::date;
  today_start := pg_catalog.timezone(target_timezone, local_today::timestamp);
  tomorrow_start := pg_catalog.timezone(target_timezone, (local_today + 1)::timestamp);

  with scoped_lead_customer_ids as materialized (
    select distinct lead_row.customer_id
    from public.leads lead_row
    where not scope_organization_wide
      and lead_row.organization_id = current_organization_id
      and lead_row.customer_id is not null
      and lead_row.deleted_at is null
      and (
        lead_row.branch_id = any(scope_branch_ids)
        or (scope_own_records and lead_row.assigned_user_id = current_actor_id)
        or (scope_own_team and lead_row.team_id = any(scope_team_ids))
      )
  ), authorized_customer_ids as materialized (
    select customer_row.id
    from public.customers customer_row
    left join scoped_lead_customer_ids scoped_customer
      on scoped_customer.customer_id = customer_row.id
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and (scope_organization_wide or scoped_customer.customer_id is not null)
  ), open_escalated_case_ids as materialized (
    select escalation_row.customer_case_id as id
    from public.escalations escalation_row
    where escalation_row.organization_id = current_organization_id
      and escalation_row.customer_case_id is not null
      and escalation_row.status = 'OPEN'
  ), case_facts as materialized (
    select case_row.id, case_row.case_number, case_row.case_type,
      case_row.priority, case_row.status, case_row.branch_id,
      case_row.customer_id, case_row.assigned_user_id, case_row.sla_due_at,
      case_row.created_at, case_row.first_contacted_at, case_row.resolved_at,
      case_row.updated_at, feedback_row.rating as feedback_rating,
      escalation_row.id is not null as escalated
    from public.customer_care_cases case_row
    join authorized_customer_ids customer_scope on customer_scope.id = case_row.customer_id
    left join public.feedback_requests feedback_row
      on feedback_row.organization_id = case_row.organization_id
     and feedback_row.customer_case_id = case_row.id
    left join open_escalated_case_ids escalation_row on escalation_row.id = case_row.id
    where case_row.organization_id = current_organization_id
      and case_row.deleted_at is null
      and (
        scope_organization_wide
        or case_row.branch_id = any(scope_branch_ids)
        or (
          scope_own_records
          and case_row.assigned_user_id = current_actor_id
          and case_row.branch_id = any(scope_own_record_branch_ids)
        )
      )
  ), dashboard_ids as materialized (
    select case_row.id
    from case_facts case_row
    where case_row.status not in ('RESOLVED', 'CLOSED')
    order by
      (case_row.escalated or case_row.sla_due_at <= now()) desc,
      case case_row.priority when 'URGENT' then 4 when 'HIGH' then 3
        when 'NORMAL' then 2 else 1 end desc,
      case_row.sla_due_at asc,
      case_row.updated_at desc,
      case_row.id desc
    limit 25
  ), dashboard_records as materialized (
    select case_row.id, case_row.organization_id, case_row.branch_id,
      case_row.customer_id, case_row.booking_id, case_row.vehicle_id,
      case_row.case_number, case_row.case_type, case_row.priority,
      case_row.status, case_row.assigned_user_id, case_row.subject,
      case_row.description, case_row.resolution, case_row.sla_due_at,
      case_row.first_contacted_at, case_row.resolved_at, case_row.closed_at,
      case_row.version, case_row.created_at, case_row.updated_at,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      booking_row.booking_number,
      concat_ws(
        ' ', vehicle_row.brand, vehicle_row.model, vehicle_row.registration
      ) as vehicle,
      profile_row.full_name as assigned_user_name,
      escalation_row.id is not null as escalated
    from dashboard_ids dashboard_id
    join public.customer_care_cases case_row
      on case_row.organization_id = current_organization_id
     and case_row.id = dashboard_id.id
     and case_row.deleted_at is null
    join public.customers customer_row
      on customer_row.organization_id = case_row.organization_id
     and customer_row.id = case_row.customer_id
     and customer_row.deleted_at is null
    left join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id
     and booking_row.id = case_row.booking_id
     and booking_row.deleted_at is null
    left join public.customer_vehicles vehicle_row
      on vehicle_row.organization_id = case_row.organization_id
     and vehicle_row.customer_id = case_row.customer_id
     and vehicle_row.id = case_row.vehicle_id
    left join public.profiles profile_row
      on profile_row.organization_id = case_row.organization_id
     and profile_row.id = case_row.assigned_user_id
     and profile_row.active
     and profile_row.deleted_at is null
    left join open_escalated_case_ids escalation_row on escalation_row.id = case_row.id
  ), dashboard_summary as (
    select
      count(*) filter (
        where first_contacted_at >= today_start
          and first_contacted_at < tomorrow_start
      )::bigint as feedback_calls_today,
      count(*) filter (
        where status not in ('RESOLVED', 'CLOSED') and case_type = 'FEEDBACK'
      )::bigint as feedback_pending,
      count(*) filter (
        where status not in ('RESOLVED', 'CLOSED')
          and case_type = 'SALES_EXPERIENCE'
      )::bigint as enquiry_feedback_due,
      count(*) filter (
        where status not in ('RESOLVED', 'CLOSED')
          and case_type = 'DELIVERY_FOLLOWUP'
      )::bigint as delivery_feedback_due,
      count(*) filter (
        where status not in ('RESOLVED', 'CLOSED') and case_type = 'COMPLAINT'
      )::bigint as complaints_open,
      count(*) filter (
        where status not in ('RESOLVED', 'CLOSED') and escalated
      )::bigint as escalations_open,
      count(*) filter (
        where status not in ('RESOLVED', 'CLOSED')
          and case_type = 'REVIEW_REQUEST'
      )::bigint as review_requests_pending,
      coalesce(round(avg(feedback_rating)::numeric, 1), 0) as satisfaction,
      coalesce(round(
        100.0 * count(*) filter (where feedback_rating >= 4)
          / nullif(count(*) filter (where feedback_rating is not null), 0),
        1
      ), 0) as positive_feedback_percent,
      coalesce(round(
        100.0 * count(*) filter (
          where case_type = 'COMPLAINT' and status in ('RESOLVED', 'CLOSED')
        ) / nullif(count(*) filter (where case_type = 'COMPLAINT'), 0),
        1
      ), 0) as complaint_resolution_percent,
      coalesce(round(
        100.0 * count(*) filter (
          where case_type = 'REVIEW_REQUEST' and status in ('RESOLVED', 'CLOSED')
        ) / nullif(count(*) filter (where case_type = 'REVIEW_REQUEST'), 0),
        1
      ), 0) as review_request_conversion_percent,
      coalesce(round((avg(
        extract(epoch from (first_contacted_at - created_at)) / 3600
      ) filter (where first_contacted_at is not null))::numeric, 1), 0)
        as average_response_hours,
      count(*) filter (where feedback_rating is not null)::bigint as ratings_received
    from case_facts
  ), test_drive_summary as (
    select count(*)::bigint as test_drive_feedback_due
    from public.test_drives drive_row
    join authorized_customer_ids customer_scope on customer_scope.id = drive_row.customer_id
    left join public.test_drive_feedback feedback_row
      on feedback_row.organization_id = drive_row.organization_id
     and feedback_row.test_drive_id = drive_row.id
    where drive_row.organization_id = current_organization_id
      and drive_row.status = 'COMPLETED'
      and feedback_row.id is null
      and (
        scope_organization_wide
        or drive_row.branch_id = any(scope_branch_ids)
        or (scope_own_team and drive_row.team_id = any(scope_team_ids))
        or (
          scope_own_records
          and drive_row.assigned_user_id = current_actor_id
          and drive_row.branch_id = any(scope_own_record_branch_ids)
        )
      )
  ), status_counts as (
    select status, count(*)::bigint as case_count
    from case_facts
    group by status
  ), rating_counts as (
    select rating_value,
      count(*) filter (where feedback_rating = rating_value)::bigint as rating_count
    from generate_series(5, 1, -1) rating_value
    left join case_facts on true
    group by rating_value
  ), issue_counts as (
    select case_type, count(*)::bigint as case_count
    from case_facts
    group by case_type
    order by case_count desc, case_type
    limit 5
  ), consultant_counts as materialized (
    select assigned_user_id,
      count(*) filter (where feedback_rating is not null)::bigint as rating_count,
      coalesce(round(avg(feedback_rating)::numeric, 1), 0) as average_rating
    from case_facts
    where assigned_user_id is not null
    group by assigned_user_id
    having count(*) filter (where feedback_rating is not null) > 0
    order by rating_count desc, average_rating desc, assigned_user_id
    limit 5
  ), consultant_rows as (
    select profile_row.full_name as assigned_user_name,
      consultant_row.rating_count, consultant_row.average_rating,
      consultant_row.assigned_user_id
    from consultant_counts consultant_row
    join public.profiles profile_row
      on profile_row.organization_id = current_organization_id
     and profile_row.id = consultant_row.assigned_user_id
     and profile_row.active
     and profile_row.deleted_at is null
  )
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', record_row.id,
        'organization_id', record_row.organization_id,
        'branch_id', record_row.branch_id,
        'customer_id', record_row.customer_id,
        'booking_id', record_row.booking_id,
        'vehicle_id', record_row.vehicle_id,
        'case_number', record_row.case_number,
        'case_type', record_row.case_type,
        'priority', record_row.priority,
        'status', record_row.status,
        'assigned_user_id', record_row.assigned_user_id,
        'subject', record_row.subject,
        'description', record_row.description,
        'resolution', record_row.resolution,
        'sla_due_at', record_row.sla_due_at,
        'first_contacted_at', record_row.first_contacted_at,
        'resolved_at', record_row.resolved_at,
        'closed_at', record_row.closed_at,
        'version', record_row.version,
        'created_at', record_row.created_at,
        'updated_at', record_row.updated_at,
        'customer_name', record_row.customer_name,
        'phone', record_row.phone,
        'booking_number', record_row.booking_number,
        'vehicle', record_row.vehicle,
        'assigned_user_name', record_row.assigned_user_name,
        'escalated', record_row.escalated
      ) order by
        (record_row.escalated or record_row.sla_due_at <= now()) desc,
        case record_row.priority when 'URGENT' then 4 when 'HIGH' then 3
          when 'NORMAL' then 2 else 1 end desc,
        record_row.sla_due_at asc,
        record_row.updated_at desc,
        record_row.id desc
      ) from dashboard_records record_row
    ), '[]'::jsonb),
    'kpis', jsonb_build_object(
      'feedback_calls_today', (
        select feedback_calls_today from dashboard_summary
      ),
      'feedback_pending', (select feedback_pending from dashboard_summary),
      'enquiry_feedback_due', (
        select enquiry_feedback_due from dashboard_summary
      ),
      'test_drive_feedback_due', (
        select test_drive_feedback_due from test_drive_summary
      ),
      'delivery_feedback_due', (
        select delivery_feedback_due from dashboard_summary
      ),
      'complaints_open', (select complaints_open from dashboard_summary),
      'escalations_open', (select escalations_open from dashboard_summary),
      'review_requests_pending', (
        select review_requests_pending from dashboard_summary
      )
    ),
    'scores', jsonb_build_object(
      'satisfaction', (select satisfaction from dashboard_summary),
      'positive_feedback_percent', (
        select positive_feedback_percent from dashboard_summary
      ),
      'complaint_resolution_percent', (
        select complaint_resolution_percent from dashboard_summary
      ),
      'review_request_conversion_percent', (
        select review_request_conversion_percent from dashboard_summary
      ),
      'average_response_hours', (
        select average_response_hours from dashboard_summary
      ),
      'ratings_received', (select ratings_received from dashboard_summary)
    ),
    'status_chart', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', initcap(replace(status_row.status, '_', ' ')),
        'value', status_row.case_count
      ) order by status_row.case_count desc, status_row.status)
      from status_counts status_row
    ), '[]'::jsonb),
    'rating_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', rating_row.rating_value::text || ' star',
        'value', rating_row.rating_count
      ) order by rating_row.rating_value desc)
      from rating_counts rating_row
    ), '[]'::jsonb),
    'issue_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', initcap(replace(issue_row.case_type, '_', ' ')),
        'value', issue_row.case_count
      ) order by issue_row.case_count desc, issue_row.case_type)
      from issue_counts issue_row
    ), '[]'::jsonb),
    'attention', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', attention_row.id,
        'case_number', attention_row.case_number,
        'customer_name', attention_row.customer_name,
        'case_type', attention_row.case_type,
        'priority', attention_row.priority,
        'sla_due_at', attention_row.sla_due_at,
        'assigned_user_name', attention_row.assigned_user_name
      ) order by
        (attention_row.sla_due_at <= now()) desc,
        case attention_row.priority when 'URGENT' then 4 when 'HIGH' then 3
          when 'NORMAL' then 2 else 1 end desc,
        attention_row.sla_due_at asc,
        attention_row.id desc
      )
      from (
        select record_row.*
        from dashboard_records record_row
        where record_row.escalated or record_row.sla_due_at <= now()
        order by
          (record_row.sla_due_at <= now()) desc,
          case record_row.priority when 'URGENT' then 4 when 'HIGH' then 3
            when 'NORMAL' then 2 else 1 end desc,
          record_row.sla_due_at asc,
          record_row.id desc
        limit 5
      ) attention_row
    ), '[]'::jsonb),
    'consultant_performance', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', consultant_row.assigned_user_name,
        'value', consultant_row.rating_count,
        'secondary', consultant_row.average_rating
      ) order by consultant_row.rating_count desc,
        consultant_row.average_rating desc,
        consultant_row.assigned_user_name,
        consultant_row.assigned_user_id)
      from consultant_rows consultant_row
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_customer_care_workspace_page(
  text, text, integer, integer, text, text
) from public, anon;
grant execute on function public.get_customer_care_workspace_page(
  text, text, integer, integer, text, text
) to authenticated;
revoke all on function public.get_customer_care_customer_options(text, integer)
  from public, anon;
grant execute on function public.get_customer_care_customer_options(text, integer)
  to authenticated;
revoke all on function public.get_customer_care_dashboard_summary(text)
  from public, anon;
grant execute on function public.get_customer_care_dashboard_summary(text)
  to authenticated;

commit;
