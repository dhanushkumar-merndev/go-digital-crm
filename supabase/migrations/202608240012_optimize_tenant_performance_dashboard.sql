-- Tenant executive dashboards must stay predictable when a dealership has
-- 100k+ leads. These indexes support customer-scope validation and the two
-- scoped work queues that were not fully covered by the existing workspace
-- indexes. CONCURRENTLY keeps these additive builds outside a transaction.
create index concurrently if not exists leads_dashboard_customer_scope_idx
  on public.leads (
    organization_id,
    customer_id,
    branch_id,
    team_id,
    assigned_user_id
  )
  where deleted_at is null and customer_id is not null;

create index concurrently if not exists leads_dashboard_lifecycle_created_idx
  on public.leads (organization_id, lifecycle_status, created_at desc, id desc)
  where deleted_at is null;

create index concurrently if not exists followups_dashboard_team_due_idx
  on public.followups (organization_id, team_id, status, due_at, id)
  where team_id is not null and status in ('OPEN', 'OVERDUE');

begin;

-- Resolve record scope only from active assignments whose role grants one of
-- the requested permissions. This prevents a low-authority assignment with a
-- wide scope from widening a different role's resource permission.
create or replace function app_private.resolve_dashboard_record_scope(
  target_organization_id uuid,
  target_permission_keys text[]
)
returns table (
  granted boolean,
  organization_wide boolean,
  branch_scope_ids uuid[],
  team_scope_ids uuid[],
  own_records boolean,
  own_record_branch_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with request_context as materialized (
    select
      auth.uid() as actor_id,
      target_organization_id is not null
        and coalesce(array_length(target_permission_keys, 1), 0) > 0
        and app_private.can_access_organization(target_organization_id) as organization_access,
      app_private.has_active_approved_support_session(target_organization_id)
        and exists (
          select 1
          from unnest(coalesce(target_permission_keys, array[]::text[])) permission_key
          where app_private.support_session_allows_permission(
            target_organization_id,
            permission_key
          )
        ) as support_access
  ), permitted_assignments as materialized (
    select
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    from request_context context_row
    join public.user_role_assignments assignment_row
      on assignment_row.organization_id = target_organization_id
     and assignment_row.user_id = context_row.actor_id
     and assignment_row.active
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where context_row.organization_access
      and exists (
        select 1
        from public.role_permissions role_permission_row
        join public.permissions permission_row
          on permission_row.id = role_permission_row.permission_id
        where role_permission_row.role_id = assignment_row.role_id
          and permission_row.permission_key = any(
            coalesce(target_permission_keys, array[]::text[])
          )
      )
  ), active_branches as materialized (
    select branch_row.id
    from public.branches branch_row
    where branch_row.organization_id = target_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ), branch_scope as (
    select distinct branch_row.id
    from active_branches branch_row
    cross join request_context context_row
    where context_row.support_access
      or exists (
        select 1
        from permitted_assignments assignment_row
        where assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
          or (
            assignment_row.data_scope = 'ONE_BRANCH'
            and assignment_row.scope_branch_id = branch_row.id
          )
          or (
            assignment_row.data_scope = 'SELECTED_BRANCHES'
            and branch_row.id = any(
              coalesce(assignment_row.selected_branch_ids, array[]::uuid[])
            )
          )
      )
  ), team_scope as (
    select distinct team_row.id, team_row.branch_id
    from request_context context_row
    join public.team_members member_row
      on member_row.organization_id = target_organization_id
     and member_row.user_id = context_row.actor_id
     and member_row.active
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
     and team_row.active
    join active_branches branch_row on branch_row.id = team_row.branch_id
    where exists (
      select 1
      from permitted_assignments assignment_row
      where assignment_row.data_scope = 'OWN_TEAM'
    )
  ), own_record_branch_candidates as (
    select access_row.branch_id
    from request_context context_row
    join public.user_branch_access access_row
      on access_row.organization_id = target_organization_id
     and access_row.user_id = context_row.actor_id
     and access_row.active
    union
    select team_row.branch_id
    from team_scope team_row
    union
    select team_row.branch_id
    from request_context context_row
    join public.team_members member_row
      on member_row.organization_id = target_organization_id
     and member_row.user_id = context_row.actor_id
     and member_row.active
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
     and team_row.active
  ), own_record_branches as (
    select distinct branch_row.id
    from own_record_branch_candidates candidate_row
    join active_branches branch_row on branch_row.id = candidate_row.branch_id
    where exists (
      select 1
      from permitted_assignments assignment_row
      where assignment_row.data_scope = 'OWN_RECORDS'
    )
  )
  select
    context_row.organization_access
      and (
        context_row.support_access
        or exists (select 1 from permitted_assignments)
      ) as granted,
    context_row.support_access
      or exists (
        select 1
        from permitted_assignments assignment_row
        where assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
      ) as organization_wide,
    coalesce(
      (select array_agg(branch_row.id order by branch_row.id) from branch_scope branch_row),
      array[]::uuid[]
    ) as branch_scope_ids,
    coalesce(
      (select array_agg(team_row.id order by team_row.id) from team_scope team_row),
      array[]::uuid[]
    ) as team_scope_ids,
    exists (
      select 1
      from permitted_assignments assignment_row
      where assignment_row.data_scope = 'OWN_RECORDS'
    ) as own_records,
    coalesce(
      (
        select array_agg(branch_row.id order by branch_row.id)
        from own_record_branches branch_row
      ),
      array[]::uuid[]
    ) as own_record_branch_ids
  from request_context context_row;
$$;

revoke all on function app_private.resolve_dashboard_record_scope(uuid, text[])
  from public, anon, authenticated;

-- Operational dashboard cards need only four counts. Avoid routing those
-- counts through operational_case_rows(), which enriches every authorized row
-- and invokes record/customer access helpers per case. Resolve the department
-- and customer scopes once, then aggregate the narrow case facts directly.
create or replace function app_private.tenant_dashboard_operational_counts(
  target_organization_id uuid,
  target_department text,
  target_timezone text
)
returns table (
  open_count bigint,
  overdue_count bigint,
  due_today_count bigint,
  completed_month_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  current_actor_id uuid;
  normalized_department text := upper(btrim(coalesce(target_department, '')));
  allowed_full_branch_ids uuid[] := array[]::uuid[];
  allowed_own_record_branch_ids uuid[] := array[]::uuid[];
  can_access_all_customers boolean := false;
  allowed_customer_branch_ids uuid[] := array[]::uuid[];
  allowed_customer_own_record_branch_ids uuid[] := array[]::uuid[];
  can_access_own_customers boolean := false;
  can_access_team_customers boolean := false;
  allowed_customer_team_ids uuid[] := array[]::uuid[];
  local_today date;
  today_start timestamptz;
  tomorrow_start timestamptz;
  current_month_start timestamptz;
  next_month_start timestamptz;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or target_organization_id is distinct from current_organization_id
    or normalized_department not in (
      'FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY'
    )
    or target_timezone is null
    or target_timezone not in ('Asia/Kolkata', 'UTC')
    or not app_private.operational_case_permission(
      current_organization_id,
      normalized_department,
      'VIEW'
    )
  then
    raise exception using
      errcode = '42501',
      message = 'TENANT_DASHBOARD_OPERATIONAL_ACCESS_REQUIRED';
  end if;

  -- Operational workspaces require customer visibility. Preserve that rule and
  -- fail closed without scanning any case table.
  if not app_private.has_permission(
    current_organization_id,
    'customer.view'
  ) then
    return query select 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
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
    current_organization_id,
    normalized_department
  ) scope_row;

  local_today := timezone(target_timezone, now())::date;
  today_start := timezone(target_timezone, local_today::timestamp);
  tomorrow_start := timezone(target_timezone, (local_today + 1)::timestamp);
  current_month_start := timezone(
    target_timezone,
    date_trunc('month', local_today::timestamp)
  );
  next_month_start := timezone(
    target_timezone,
    date_trunc('month', local_today::timestamp) + interval '1 month'
  );

  return query
  with scoped_lead_customers as materialized (
    select distinct lead_row.customer_id
    from public.leads lead_row
    where not can_access_all_customers
      and lead_row.organization_id = current_organization_id
      and lead_row.customer_id is not null
      and lead_row.deleted_at is null
      and (
        lead_row.branch_id = any(allowed_customer_branch_ids)
        or (
          can_access_own_customers
          and lead_row.assigned_user_id = current_actor_id
          and lead_row.branch_id = any(
            allowed_customer_own_record_branch_ids
          )
        )
        or (
          can_access_team_customers
          and lead_row.team_id = any(allowed_customer_team_ids)
        )
      )
  ), authorized_customer_ids as not materialized (
    select customer_row.id
    from public.customers customer_row
    left join scoped_lead_customers scoped_customer_row
      on scoped_customer_row.customer_id = customer_row.id
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and (
        can_access_all_customers
        or scoped_customer_row.customer_id is not null
      )
  ), case_rows as materialized (
    select
      case_row.status,
      case_row.due_at,
      case_row.updated_at,
      'FINANCE'::text as department
    from public.finance_cases case_row
    join authorized_customer_ids customer_scope
      on customer_scope.id = case_row.customer_id
    join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id
     and booking_row.id = case_row.booking_id
     and booking_row.deleted_at is null
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
    union all
    select
      case_row.status,
      case_row.due_at,
      case_row.updated_at,
      'INSURANCE'::text
    from public.insurance_cases case_row
    join authorized_customer_ids customer_scope
      on customer_scope.id = case_row.customer_id
    join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id
     and booking_row.id = case_row.booking_id
     and booking_row.deleted_at is null
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
    union all
    select
      case_row.status,
      case_row.due_at,
      case_row.updated_at,
      'RTO'::text
    from public.rto_cases case_row
    join authorized_customer_ids customer_scope
      on customer_scope.id = case_row.customer_id
    join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id
     and booking_row.id = case_row.booking_id
     and booking_row.deleted_at is null
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
    union all
    select
      case_row.status,
      case_row.due_at,
      case_row.updated_at,
      'EXCHANGE'::text
    from public.exchange_cases case_row
    join authorized_customer_ids customer_scope
      on customer_scope.id = case_row.customer_id
    left join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id
     and booking_row.id = case_row.booking_id
     and booking_row.deleted_at is null
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
    union all
    select
      case_row.status,
      case_row.due_at,
      case_row.updated_at,
      'DELIVERY'::text
    from public.delivery_cases case_row
    join authorized_customer_ids customer_scope
      on customer_scope.id = case_row.customer_id
    join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id
     and booking_row.id = case_row.booking_id
     and booking_row.deleted_at is null
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
  )
  select
    count(*) filter (
      where not app_private.operational_case_terminal(
        case_row.department,
        case_row.status
      )
    ),
    count(*) filter (
      where case_row.due_at < now()
        and not app_private.operational_case_terminal(
          case_row.department,
          case_row.status
        )
    ),
    count(*) filter (
      where case_row.due_at >= today_start
        and case_row.due_at < tomorrow_start
        and not app_private.operational_case_terminal(
          case_row.department,
          case_row.status
        )
    ),
    count(*) filter (
      where app_private.operational_case_terminal(
          case_row.department,
          case_row.status
        )
        and case_row.updated_at >= current_month_start
        and case_row.updated_at < next_month_start
    )
  from case_rows case_row;
end;
$$;

revoke all on function app_private.tenant_dashboard_operational_counts(
  uuid, text, text
) from public, anon, authenticated;

-- PII-bearing live items use the same permission-bound scopes as the summary,
-- but remain a separate uncached response. Candidate IDs are limited before
-- joining customer/lead display data.
create or replace function app_private.tenant_dashboard_live_items(
  target_organization_id uuid,
  target_timezone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  lead_scope record;
  followup_scope record;
  customer_scope record;
  operational_counts record;
  operational_department text;
  preview_result jsonb := '[]'::jsonb;
  attention_result jsonb := '[]'::jsonb;
begin
  if target_timezone is null
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_TENANT_DASHBOARD_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or target_organization_id is distinct from current_organization_id
  then
    raise exception using
      errcode = '42501',
      message = 'TENANT_DASHBOARD_ACCESS_REQUIRED';
  end if;

  select * into lead_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['lead.view']::text[]
  );
  select * into followup_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['followup.view']::text[]
  );
  select * into customer_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['customer.view']::text[]
  );

  if coalesce(lead_scope.granted, false) then
    with candidate_ids as materialized (
      select lead_row.id, lead_row.updated_at
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and (
          lead_scope.organization_wide
          or lead_row.branch_id = any(lead_scope.branch_scope_ids)
          or lead_row.team_id = any(lead_scope.team_scope_ids)
          or (
            lead_scope.own_records
            and lead_row.assigned_user_id = auth.uid()
            and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
          )
        )
      order by lead_row.updated_at desc, lead_row.id desc
      limit 5
    ), preview_rows as (
      select
        lead_row.id,
        lead_row.customer_name,
        lead_row.phone,
        lead_row.source,
        lead_row.interested_model,
        lead_row.lifecycle_status,
        lead_row.temperature,
        case
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and now() > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and now() >= lead_row.created_at + interval '24 hours' then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state,
        lead_row.next_followup_at,
        lead_row.updated_at
      from candidate_ids candidate_row
      join public.leads lead_row
        on lead_row.organization_id = current_organization_id
       and lead_row.id = candidate_row.id
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', preview_row.id,
          'customer_name', preview_row.customer_name,
          'phone', preview_row.phone,
          'source', preview_row.source,
          'interested_model', preview_row.interested_model,
          'lifecycle_status', preview_row.lifecycle_status,
          'temperature', preview_row.temperature,
          'work_state', preview_row.work_state,
          'next_followup_at', preview_row.next_followup_at,
          'updated_at', preview_row.updated_at
        )
        order by preview_row.updated_at desc, preview_row.id desc
      ),
      '[]'::jsonb
    )
    into preview_result
    from preview_rows preview_row;
  end if;

  if coalesce(followup_scope.granted, false) then
    with attention_candidates as materialized (
      select
        followup_row.id,
        followup_row.due_at,
        followup_row.lead_id,
        followup_row.customer_id
      from public.followups followup_row
      join public.branches branch_row
        on branch_row.id = followup_row.branch_id
       and branch_row.organization_id = followup_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where followup_row.organization_id = current_organization_id
        and followup_row.status in ('OPEN', 'OVERDUE')
        and followup_row.due_at < now()
        and (
          followup_scope.organization_wide
          or followup_row.branch_id = any(followup_scope.branch_scope_ids)
          or followup_row.team_id = any(followup_scope.team_scope_ids)
          or (
            followup_scope.own_records
            and followup_row.assigned_user_id = auth.uid()
            and followup_row.branch_id = any(followup_scope.own_record_branch_ids)
          )
        )
        and (
          followup_row.lead_id is null
          or (
            lead_scope.granted
            and exists (
              select 1
              from public.leads linked_lead_row
              join public.branches linked_branch_row
                on linked_branch_row.id = linked_lead_row.branch_id
               and linked_branch_row.organization_id = linked_lead_row.organization_id
               and linked_branch_row.active
               and linked_branch_row.deleted_at is null
              where linked_lead_row.organization_id = current_organization_id
                and linked_lead_row.id = followup_row.lead_id
                and linked_lead_row.deleted_at is null
                and (
                  lead_scope.organization_wide
                  or linked_lead_row.branch_id = any(lead_scope.branch_scope_ids)
                  or linked_lead_row.team_id = any(lead_scope.team_scope_ids)
                  or (
                    lead_scope.own_records
                    and linked_lead_row.assigned_user_id = auth.uid()
                    and linked_lead_row.branch_id = any(
                      lead_scope.own_record_branch_ids
                    )
                  )
                )
            )
          )
        )
        and (
          followup_row.customer_id is null
          or (
            customer_scope.granted
            and exists (
              select 1
              from public.customers customer_access_row
              where customer_access_row.organization_id = current_organization_id
                and customer_access_row.id = followup_row.customer_id
                and customer_access_row.deleted_at is null
                and (
                  customer_scope.organization_wide
                  or exists (
                    select 1
                    from public.leads customer_lead_row
                    join public.branches customer_branch_row
                      on customer_branch_row.id = customer_lead_row.branch_id
                     and customer_branch_row.organization_id = customer_lead_row.organization_id
                     and customer_branch_row.active
                     and customer_branch_row.deleted_at is null
                    where customer_lead_row.organization_id = current_organization_id
                      and customer_lead_row.customer_id = followup_row.customer_id
                      and customer_lead_row.deleted_at is null
                      and (
                        customer_lead_row.branch_id = any(
                          customer_scope.branch_scope_ids
                        )
                        or customer_lead_row.team_id = any(
                          customer_scope.team_scope_ids
                        )
                        or (
                          customer_scope.own_records
                          and customer_lead_row.assigned_user_id = auth.uid()
                          and customer_lead_row.branch_id = any(
                            customer_scope.own_record_branch_ids
                          )
                        )
                      )
                  )
                )
            )
          )
        )
      order by followup_row.due_at, followup_row.id
      limit 12
    ), attention_rows as (
      select
        candidate_row.id,
        'FOLLOWUP'::text as kind,
        coalesce(customer_row.full_name, lead_row.customer_name) as title,
        'Follow-up was due '
          || to_char(
            timezone(target_timezone, candidate_row.due_at),
            'DD Mon, HH24:MI'
          ) as detail,
        case
          when candidate_row.due_at < now() - interval '1 day' then 'HIGH'
          else 'MEDIUM'
        end as severity,
        candidate_row.due_at as sort_at,
        candidate_row.lead_id
      from attention_candidates candidate_row
      left join public.leads lead_row
        on lead_row.organization_id = current_organization_id
       and lead_row.id = candidate_row.lead_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on customer_row.organization_id = current_organization_id
       and customer_row.id = candidate_row.customer_id
       and customer_row.deleted_at is null
    )
    select coalesce(
      jsonb_agg(
        to_jsonb(attention_row)
        order by attention_row.sort_at, attention_row.id
      ),
      '[]'::jsonb
    )
    into attention_result
    from attention_rows attention_row;
  end if;

  return jsonb_build_object(
    'lead_preview', preview_result,
    'attention', attention_result
  );
end;
$$;

revoke all on function app_private.tenant_dashboard_live_items(uuid, text)
  from public, anon, authenticated;

create or replace function app_private.tenant_performance_dashboard(
  target_days integer,
  target_timezone text,
  include_live_items boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  local_today date;
  day_start timestamptz;
  day_end timestamptz;
  month_start timestamptz;
  month_end timestamptz;
  trend_start timestamptz;
  lead_scope record;
  followup_scope record;
  appointment_scope record;
  call_scope record;
  booking_scope record;
  inventory_scope record;
  test_drive_scope record;
  customer_scope record;
  can_view_leads boolean := false;
  can_view_calls boolean := false;
  can_view_work boolean := false;
  can_view_followups boolean := false;
  can_view_appointments boolean := false;
  can_view_bookings boolean := false;
  can_view_inventory boolean := false;
  can_view_test_drives boolean := false;
  can_view_operations boolean := false;
  lead_open_count bigint := 0;
  lead_new_today_count bigint := 0;
  followup_due_today_count bigint := 0;
  followup_overdue_count bigint := 0;
  appointment_today_count bigint := 0;
  call_today_count bigint := 0;
  booking_month_count bigint := 0;
  booking_month_value numeric := 0;
  test_drive_today_count bigint := 0;
  available_stock_count bigint := 0;
  open_case_count bigint := 0;
  overdue_case_count bigint := 0;
  case_due_today_count bigint := 0;
  case_completed_month_count bigint := 0;
  activity_result jsonb := '[]'::jsonb;
  pipeline_result jsonb := '[]'::jsonb;
  attention_result jsonb := '[]'::jsonb;
  lead_preview_result jsonb := '[]'::jsonb;
  live_result jsonb := '{}'::jsonb;
begin
  if target_days is null
    or target_days not in (7, 14, 30)
    or target_timezone is null
    or target_timezone not in ('Asia/Kolkata', 'UTC')
    or include_live_items is null
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_TENANT_DASHBOARD_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null then
    raise exception using
      errcode = '42501',
      message = 'TENANT_DASHBOARD_ACCESS_REQUIRED';
  end if;

  select * into lead_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['lead.view']::text[]
  );
  select * into call_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['call.view']::text[]
  );
  select * into followup_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['followup.view']::text[]
  );
  select * into appointment_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['appointment.view']::text[]
  );
  select * into booking_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['booking.view', 'booking.manage']::text[]
  );
  select * into inventory_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['inventory.view', 'inventory.stock_check']::text[]
  );
  select * into test_drive_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['test_drive.view', 'test_drive.manage']::text[]
  );
  select * into customer_scope
  from app_private.resolve_dashboard_record_scope(
    current_organization_id,
    array['customer.view']::text[]
  );

  can_view_leads := coalesce(lead_scope.granted, false);
  can_view_calls := coalesce(call_scope.granted, false);
  can_view_followups := coalesce(followup_scope.granted, false);
  can_view_appointments := coalesce(appointment_scope.granted, false);
  can_view_work := can_view_followups or can_view_appointments;
  can_view_bookings := coalesce(booking_scope.granted, false);
  can_view_inventory := coalesce(inventory_scope.granted, false);
  can_view_test_drives := coalesce(test_drive_scope.granted, false);
  can_view_operations := app_private.has_permission(
    current_organization_id,
    'finance.view'
  ) or app_private.has_permission(current_organization_id, 'finance.manage')
    or app_private.has_permission(current_organization_id, 'insurance.view')
    or app_private.has_permission(current_organization_id, 'insurance.manage')
    or app_private.has_permission(current_organization_id, 'rto.view')
    or app_private.has_permission(current_organization_id, 'rto.manage')
    or app_private.has_permission(current_organization_id, 'exchange.view')
    or app_private.has_permission(current_organization_id, 'exchange.manage')
    or app_private.has_permission(current_organization_id, 'delivery.view')
    or app_private.has_permission(current_organization_id, 'delivery.manage');

  if not (
    can_view_leads
    or can_view_calls
    or can_view_work
    or can_view_bookings
    or can_view_inventory
    or can_view_test_drives
    or can_view_operations
  ) then
    raise exception using
      errcode = '42501',
      message = 'TENANT_DASHBOARD_PERMISSION_REQUIRED';
  end if;

  local_today := timezone(target_timezone, now())::date;
  day_start := timezone(target_timezone, local_today::timestamp);
  day_end := timezone(target_timezone, (local_today + 1)::timestamp);
  month_start := timezone(
    target_timezone,
    date_trunc('month', local_today::timestamp)
  );
  month_end := timezone(
    target_timezone,
    date_trunc('month', local_today::timestamp) + interval '1 month'
  );
  trend_start := timezone(
    target_timezone,
    (local_today - (target_days - 1))::timestamp
  );

  if can_view_leads then
    with scoped_leads as materialized (
      select
        lead_row.lifecycle_status,
        lead_row.created_at
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and (
          lead_scope.organization_wide
          or lead_row.branch_id = any(lead_scope.branch_scope_ids)
          or lead_row.team_id = any(lead_scope.team_scope_ids)
          or (
            lead_scope.own_records
            and lead_row.assigned_user_id = auth.uid()
            and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
          )
        )
    ), pipeline as (
      select
        lead_row.lifecycle_status,
        count(*)::bigint as stage_count,
        case lead_row.lifecycle_status
          when 'New' then 1
          when 'Contacted' then 2
          when 'Qualified' then 3
          when 'Appointment Scheduled' then 4
          when 'Transferred to Sales' then 5
          else 6
        end as stage_order
      from scoped_leads lead_row
      where lead_row.lifecycle_status <> 'Lost'
      group by lead_row.lifecycle_status
    )
    select
      count(*) filter (where lead_row.lifecycle_status <> 'Lost'),
      count(*) filter (
        where lead_row.created_at >= day_start
          and lead_row.created_at < day_end
      ),
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'name', app_private.dashboard_lifecycle_label(
                pipeline_row.lifecycle_status::text
              ),
              'value', pipeline_row.stage_count
            )
            order by pipeline_row.stage_order
          )
          from pipeline pipeline_row
        ),
        '[]'::jsonb
      )
    into lead_open_count, lead_new_today_count, pipeline_result
    from scoped_leads lead_row;

    with daily as (
      select
        timezone(target_timezone, lead_row.created_at)::date as day_value,
        count(*)::bigint as value
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and lead_row.created_at >= trend_start
        and lead_row.created_at < day_end
        and (
          lead_scope.organization_wide
          or lead_row.branch_id = any(lead_scope.branch_scope_ids)
          or lead_row.team_id = any(lead_scope.team_scope_ids)
          or (
            lead_scope.own_records
            and lead_row.assigned_user_id = auth.uid()
            and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
          )
        )
      group by 1
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name', to_char(day_row.day_value, 'DD Mon'),
          'value', coalesce(daily.value, 0),
          'secondary', 0
        )
        order by day_row.day_value
      ),
      '[]'::jsonb
    )
    into activity_result
    from generate_series(
      local_today - (target_days - 1),
      local_today,
      interval '1 day'
    ) generated_day(day_timestamp)
    cross join lateral (
      select generated_day.day_timestamp::date as day_value
    ) day_row
    left join daily on daily.day_value = day_row.day_value;
  end if;

  if can_view_followups then
    select
      count(*) filter (
        where followup_row.due_at >= day_start
          and followup_row.due_at < day_end
      ),
      count(*) filter (where followup_row.due_at < now())
    into followup_due_today_count, followup_overdue_count
    from public.followups followup_row
    join public.branches branch_row
      on branch_row.id = followup_row.branch_id
     and branch_row.organization_id = followup_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    where followup_row.organization_id = current_organization_id
      and followup_row.status in ('OPEN', 'OVERDUE')
      and (
        followup_scope.organization_wide
        or followup_row.branch_id = any(followup_scope.branch_scope_ids)
        or followup_row.team_id = any(followup_scope.team_scope_ids)
        or (
          followup_scope.own_records
          and followup_row.assigned_user_id = auth.uid()
          and followup_row.branch_id = any(followup_scope.own_record_branch_ids)
        )
      )
      and (
        followup_row.lead_id is null
        or (
          lead_scope.granted
          and exists (
            select 1
            from public.leads linked_lead_row
            join public.branches linked_branch_row
              on linked_branch_row.id = linked_lead_row.branch_id
             and linked_branch_row.organization_id = linked_lead_row.organization_id
             and linked_branch_row.active
             and linked_branch_row.deleted_at is null
            where linked_lead_row.organization_id = current_organization_id
              and linked_lead_row.id = followup_row.lead_id
              and linked_lead_row.deleted_at is null
              and (
                lead_scope.organization_wide
                or linked_lead_row.branch_id = any(lead_scope.branch_scope_ids)
                or linked_lead_row.team_id = any(lead_scope.team_scope_ids)
                or (
                  lead_scope.own_records
                  and linked_lead_row.assigned_user_id = auth.uid()
                  and linked_lead_row.branch_id = any(
                    lead_scope.own_record_branch_ids
                  )
                )
              )
          )
        )
      )
      and (
        followup_row.customer_id is null
        or (
          customer_scope.granted
          and exists (
            select 1
            from public.customers customer_access_row
            where customer_access_row.organization_id = current_organization_id
              and customer_access_row.id = followup_row.customer_id
              and customer_access_row.deleted_at is null
              and (
                customer_scope.organization_wide
                or exists (
                  select 1
                  from public.leads customer_lead_row
                  join public.branches customer_branch_row
                    on customer_branch_row.id = customer_lead_row.branch_id
                   and customer_branch_row.organization_id = customer_lead_row.organization_id
                   and customer_branch_row.active
                   and customer_branch_row.deleted_at is null
                  where customer_lead_row.organization_id = current_organization_id
                    and customer_lead_row.customer_id = followup_row.customer_id
                    and customer_lead_row.deleted_at is null
                    and (
                      customer_lead_row.branch_id = any(
                        customer_scope.branch_scope_ids
                      )
                      or customer_lead_row.team_id = any(
                        customer_scope.team_scope_ids
                      )
                      or (
                        customer_scope.own_records
                        and customer_lead_row.assigned_user_id = auth.uid()
                        and customer_lead_row.branch_id = any(
                          customer_scope.own_record_branch_ids
                        )
                      )
                    )
                )
              )
          )
        )
      );
  end if;

  if can_view_appointments then
    select count(*)
    into appointment_today_count
    from public.appointments appointment_row
    join public.branches branch_row
      on branch_row.id = appointment_row.branch_id
     and branch_row.organization_id = appointment_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    where appointment_row.organization_id = current_organization_id
      and appointment_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
      and appointment_row.scheduled_at >= day_start
      and appointment_row.scheduled_at < day_end
      and (
        appointment_scope.organization_wide
        or appointment_row.branch_id = any(appointment_scope.branch_scope_ids)
        or appointment_row.team_id = any(appointment_scope.team_scope_ids)
        or (
          appointment_scope.own_records
          and appointment_row.assigned_user_id = auth.uid()
          and appointment_row.branch_id = any(
            appointment_scope.own_record_branch_ids
          )
        )
      )
      and customer_scope.granted
      and exists (
        select 1
        from public.customers customer_access_row
        where customer_access_row.organization_id = current_organization_id
          and customer_access_row.id = appointment_row.customer_id
          and customer_access_row.deleted_at is null
          and (
            customer_scope.organization_wide
            or exists (
              select 1
              from public.leads customer_lead_row
              join public.branches customer_branch_row
                on customer_branch_row.id = customer_lead_row.branch_id
               and customer_branch_row.organization_id = customer_lead_row.organization_id
               and customer_branch_row.active
               and customer_branch_row.deleted_at is null
              where customer_lead_row.organization_id = current_organization_id
                and customer_lead_row.customer_id = appointment_row.customer_id
                and customer_lead_row.deleted_at is null
                and (
                  customer_lead_row.branch_id = any(customer_scope.branch_scope_ids)
                  or customer_lead_row.team_id = any(customer_scope.team_scope_ids)
                  or (
                    customer_scope.own_records
                    and customer_lead_row.assigned_user_id = auth.uid()
                    and customer_lead_row.branch_id = any(
                      customer_scope.own_record_branch_ids
                    )
                  )
                )
            )
          )
      )
      and (
        appointment_row.lead_id is null
        or (
          lead_scope.granted
          and exists (
            select 1
            from public.leads linked_lead_row
            join public.branches linked_branch_row
              on linked_branch_row.id = linked_lead_row.branch_id
             and linked_branch_row.organization_id = linked_lead_row.organization_id
             and linked_branch_row.active
             and linked_branch_row.deleted_at is null
            where linked_lead_row.organization_id = current_organization_id
              and linked_lead_row.id = appointment_row.lead_id
              and linked_lead_row.deleted_at is null
              and (
                lead_scope.organization_wide
                or linked_lead_row.branch_id = any(lead_scope.branch_scope_ids)
                or linked_lead_row.team_id = any(lead_scope.team_scope_ids)
                or (
                  lead_scope.own_records
                  and linked_lead_row.assigned_user_id = auth.uid()
                  and linked_lead_row.branch_id = any(
                    lead_scope.own_record_branch_ids
                  )
                )
              )
          )
        )
      );
  end if;

  if can_view_calls then
    -- Reuse one permission-bound call fact set for both today's KPI and the
    -- activity series. No per-row SECURITY DEFINER access helper is invoked.
    with scoped_calls as materialized (
      select call_row.started_at
      from public.calls call_row
      join public.branches branch_row
        on branch_row.id = call_row.branch_id
       and branch_row.organization_id = call_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where call_row.organization_id = current_organization_id
        and call_row.started_at >= trend_start
        and call_row.started_at < day_end
        and (
          call_scope.organization_wide
          or call_row.branch_id = any(call_scope.branch_scope_ids)
          or call_row.team_id = any(call_scope.team_scope_ids)
          or (
            call_scope.own_records
            and call_row.assigned_user_id = auth.uid()
            and call_row.branch_id = any(call_scope.own_record_branch_ids)
          )
        )
        and (
          call_row.lead_id is null
          or (
            lead_scope.granted
            and exists (
              select 1
              from public.leads linked_lead_row
              join public.branches linked_branch_row
                on linked_branch_row.id = linked_lead_row.branch_id
               and linked_branch_row.organization_id = linked_lead_row.organization_id
               and linked_branch_row.active
               and linked_branch_row.deleted_at is null
              where linked_lead_row.organization_id = current_organization_id
                and linked_lead_row.id = call_row.lead_id
                and linked_lead_row.deleted_at is null
                and (
                  lead_scope.organization_wide
                  or linked_lead_row.branch_id = any(lead_scope.branch_scope_ids)
                  or linked_lead_row.team_id = any(lead_scope.team_scope_ids)
                  or (
                    lead_scope.own_records
                    and linked_lead_row.assigned_user_id = auth.uid()
                    and linked_lead_row.branch_id = any(
                      lead_scope.own_record_branch_ids
                    )
                  )
                )
            )
          )
        )
        and (
          call_row.customer_id is null
          or (
            customer_scope.granted
            and exists (
              select 1
              from public.customers customer_access_row
              where customer_access_row.organization_id = current_organization_id
                and customer_access_row.id = call_row.customer_id
                and customer_access_row.deleted_at is null
                and (
                  customer_scope.organization_wide
                  or exists (
                    select 1
                    from public.leads customer_lead_row
                    join public.branches customer_branch_row
                      on customer_branch_row.id = customer_lead_row.branch_id
                     and customer_branch_row.organization_id = customer_lead_row.organization_id
                     and customer_branch_row.active
                     and customer_branch_row.deleted_at is null
                    where customer_lead_row.organization_id = current_organization_id
                      and customer_lead_row.customer_id = call_row.customer_id
                      and customer_lead_row.deleted_at is null
                      and (
                        customer_lead_row.branch_id = any(
                          customer_scope.branch_scope_ids
                        )
                        or customer_lead_row.team_id = any(
                          customer_scope.team_scope_ids
                        )
                        or (
                          customer_scope.own_records
                          and customer_lead_row.assigned_user_id = auth.uid()
                          and customer_lead_row.branch_id = any(
                            customer_scope.own_record_branch_ids
                          )
                        )
                      )
                  )
                )
            )
          )
        )
    ), daily as (
      select
        timezone(target_timezone, call_row.started_at)::date as day_value,
        count(*)::bigint as value
      from scoped_calls call_row
      group by 1
    )
    select
      (
        select count(*)
        from scoped_calls call_row
        where call_row.started_at >= day_start
          and call_row.started_at < day_end
      ),
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', to_char(day_row.day_value, 'DD Mon'),
            'value', case
              when can_view_leads then coalesce(
                (
                  activity_result
                    -> ((day_row.row_index - 1)::integer)
                    ->> 'value'
                )::bigint,
                0
              )
              else coalesce(daily.value, 0)
            end,
            'secondary', case
              when can_view_leads then coalesce(daily.value, 0)
              else 0
            end
          )
          order by day_row.day_value
        ),
        '[]'::jsonb
      )
    into call_today_count, activity_result
    from generate_series(
      local_today - (target_days - 1),
      local_today,
      interval '1 day'
    ) with ordinality as generated_day(day_timestamp, row_index)
    cross join lateral (
      select
        generated_day.day_timestamp::date as day_value,
        generated_day.row_index as row_index
    ) day_row
    left join daily on daily.day_value = day_row.day_value;
  end if;

  if can_view_bookings then
    select
      count(*),
      coalesce(
        sum(coalesce(booking_row.total_value, booking_row.booking_amount)),
        0
      )
    into booking_month_count, booking_month_value
    from public.bookings booking_row
    join public.branches branch_row
      on branch_row.id = booking_row.branch_id
     and branch_row.organization_id = booking_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= month_start
      and booking_row.created_at < month_end
      and (
        booking_scope.organization_wide
        or booking_row.branch_id = any(booking_scope.branch_scope_ids)
        or booking_row.team_id = any(booking_scope.team_scope_ids)
        or (
          booking_scope.own_records
          and booking_row.assigned_user_id = auth.uid()
          and booking_row.branch_id = any(booking_scope.own_record_branch_ids)
        )
      )
      and customer_scope.granted
      and exists (
        select 1
        from public.customers customer_access_row
        where customer_access_row.organization_id = current_organization_id
          and customer_access_row.id = booking_row.customer_id
          and customer_access_row.deleted_at is null
          and (
            customer_scope.organization_wide
            or exists (
              select 1
              from public.leads customer_lead_row
              join public.branches customer_branch_row
                on customer_branch_row.id = customer_lead_row.branch_id
               and customer_branch_row.organization_id = customer_lead_row.organization_id
               and customer_branch_row.active
               and customer_branch_row.deleted_at is null
              where customer_lead_row.organization_id = current_organization_id
                and customer_lead_row.customer_id = booking_row.customer_id
                and customer_lead_row.deleted_at is null
                and (
                  customer_lead_row.branch_id = any(customer_scope.branch_scope_ids)
                  or customer_lead_row.team_id = any(customer_scope.team_scope_ids)
                  or (
                    customer_scope.own_records
                    and customer_lead_row.assigned_user_id = auth.uid()
                    and customer_lead_row.branch_id = any(
                      customer_scope.own_record_branch_ids
                    )
                  )
                )
            )
          )
      );
  end if;

  if can_view_test_drives then
    select count(*)
    into test_drive_today_count
    from public.test_drive_appointments appointment_row
    join public.branches branch_row
      on branch_row.id = appointment_row.branch_id
     and branch_row.organization_id = appointment_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    where appointment_row.organization_id = current_organization_id
      and appointment_row.scheduled_at >= day_start
      and appointment_row.scheduled_at < day_end
      and appointment_row.status <> 'CANCELLED'
      and (
        test_drive_scope.organization_wide
        or appointment_row.branch_id = any(test_drive_scope.branch_scope_ids)
        or appointment_row.team_id = any(test_drive_scope.team_scope_ids)
        or (
          test_drive_scope.own_records
          and appointment_row.assigned_user_id = auth.uid()
          and appointment_row.branch_id = any(
            test_drive_scope.own_record_branch_ids
          )
        )
      )
      and customer_scope.granted
      and exists (
        select 1
        from public.customers customer_access_row
        where customer_access_row.organization_id = current_organization_id
          and customer_access_row.id = appointment_row.customer_id
          and customer_access_row.deleted_at is null
          and (
            customer_scope.organization_wide
            or exists (
              select 1
              from public.leads customer_lead_row
              join public.branches customer_branch_row
                on customer_branch_row.id = customer_lead_row.branch_id
               and customer_branch_row.organization_id = customer_lead_row.organization_id
               and customer_branch_row.active
               and customer_branch_row.deleted_at is null
              where customer_lead_row.organization_id = current_organization_id
                and customer_lead_row.customer_id = appointment_row.customer_id
                and customer_lead_row.deleted_at is null
                and (
                  customer_lead_row.branch_id = any(customer_scope.branch_scope_ids)
                  or customer_lead_row.team_id = any(customer_scope.team_scope_ids)
                  or (
                    customer_scope.own_records
                    and customer_lead_row.assigned_user_id = auth.uid()
                    and customer_lead_row.branch_id = any(
                      customer_scope.own_record_branch_ids
                    )
                  )
                )
            )
          )
      )
      and (
        appointment_row.lead_id is null
        or (
          lead_scope.granted
          and exists (
            select 1
            from public.leads linked_lead_row
            join public.branches linked_branch_row
              on linked_branch_row.id = linked_lead_row.branch_id
             and linked_branch_row.organization_id = linked_lead_row.organization_id
             and linked_branch_row.active
             and linked_branch_row.deleted_at is null
            where linked_lead_row.organization_id = current_organization_id
              and linked_lead_row.id = appointment_row.lead_id
              and linked_lead_row.deleted_at is null
              and (
                lead_scope.organization_wide
                or linked_lead_row.branch_id = any(lead_scope.branch_scope_ids)
                or linked_lead_row.team_id = any(lead_scope.team_scope_ids)
                or (
                  lead_scope.own_records
                  and linked_lead_row.assigned_user_id = auth.uid()
                  and linked_lead_row.branch_id = any(
                    lead_scope.own_record_branch_ids
                  )
                )
              )
          )
        )
      );
  end if;

  if can_view_inventory then
    select count(*)
    into available_stock_count
    from public.stock_units stock_row
    join public.branches branch_row
      on branch_row.id = stock_row.branch_id
     and branch_row.organization_id = stock_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    where stock_row.organization_id = current_organization_id
      and stock_row.deleted_at is null
      and stock_row.status = 'AVAILABLE'
      and (
        inventory_scope.organization_wide
        or stock_row.branch_id = any(inventory_scope.branch_scope_ids)
        or stock_row.branch_id = any(inventory_scope.own_record_branch_ids)
        or exists (
          select 1
          from public.teams inventory_team_row
          where inventory_team_row.organization_id = current_organization_id
            and inventory_team_row.branch_id = stock_row.branch_id
            and inventory_team_row.id = any(inventory_scope.team_scope_ids)
            and inventory_team_row.active
        )
      );
  end if;

  if can_view_operations then
    foreach operational_department in array array[
      'FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY'
    ]::text[]
    loop
      if app_private.operational_case_permission(
        current_organization_id,
        operational_department,
        'VIEW'
      ) then
        select * into operational_counts
        from app_private.tenant_dashboard_operational_counts(
          current_organization_id,
          operational_department,
          target_timezone
        );

        open_case_count := open_case_count
          + coalesce(operational_counts.open_count, 0);
        overdue_case_count := overdue_case_count
          + coalesce(operational_counts.overdue_count, 0);
        case_due_today_count := case_due_today_count
          + coalesce(operational_counts.due_today_count, 0);
        case_completed_month_count := case_completed_month_count
          + coalesce(operational_counts.completed_month_count, 0);
      end if;
    end loop;
  end if;

  if can_view_bookings then
    with daily as (
      select
        timezone(target_timezone, booking_row.created_at)::date as day_value,
        count(*)::bigint as value
      from public.bookings booking_row
      join public.branches branch_row
        on branch_row.id = booking_row.branch_id
       and branch_row.organization_id = booking_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where booking_row.organization_id = current_organization_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= trend_start
        and booking_row.created_at < day_end
        and (
          booking_scope.organization_wide
          or booking_row.branch_id = any(booking_scope.branch_scope_ids)
          or booking_row.team_id = any(booking_scope.team_scope_ids)
          or (
            booking_scope.own_records
            and booking_row.assigned_user_id = auth.uid()
            and booking_row.branch_id = any(booking_scope.own_record_branch_ids)
          )
        )
        and customer_scope.granted
        and exists (
          select 1
          from public.customers customer_access_row
          where customer_access_row.organization_id = current_organization_id
            and customer_access_row.id = booking_row.customer_id
            and customer_access_row.deleted_at is null
            and (
              customer_scope.organization_wide
              or exists (
                select 1
                from public.leads customer_lead_row
                join public.branches customer_branch_row
                  on customer_branch_row.id = customer_lead_row.branch_id
                 and customer_branch_row.organization_id = customer_lead_row.organization_id
                 and customer_branch_row.active
                 and customer_branch_row.deleted_at is null
                where customer_lead_row.organization_id = current_organization_id
                  and customer_lead_row.customer_id = booking_row.customer_id
                  and customer_lead_row.deleted_at is null
                  and (
                    customer_lead_row.branch_id = any(
                      customer_scope.branch_scope_ids
                    )
                    or customer_lead_row.team_id = any(
                      customer_scope.team_scope_ids
                    )
                    or (
                      customer_scope.own_records
                      and customer_lead_row.assigned_user_id = auth.uid()
                      and customer_lead_row.branch_id = any(
                        customer_scope.own_record_branch_ids
                      )
                    )
                  )
              )
            )
        )
      group by 1
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name', to_char(day_row.day_value, 'DD Mon'),
          'value', case
            when can_view_leads or can_view_calls then coalesce(
              (
                activity_result
                  -> ((day_row.row_index - 1)::integer)
                  ->> 'value'
              )::bigint,
              0
            )
            else coalesce(daily.value, 0)
          end,
          'secondary', case
            when can_view_leads or can_view_calls then coalesce(daily.value, 0)
            else 0
          end
        )
        order by day_row.day_value
      ),
      '[]'::jsonb
    )
    into activity_result
    from generate_series(
      local_today - (target_days - 1),
      local_today,
      interval '1 day'
    ) with ordinality as generated_day(day_timestamp, row_index)
    cross join lateral (
      select
        generated_day.day_timestamp::date as day_value,
        generated_day.row_index as row_index
    ) day_row
    left join daily on daily.day_value = day_row.day_value;
  end if;

  if include_live_items then
    live_result := app_private.tenant_dashboard_live_items(
      current_organization_id,
      target_timezone
    );
    lead_preview_result := coalesce(live_result->'lead_preview', '[]'::jsonb);
    attention_result := coalesce(live_result->'attention', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'organization_id', current_organization_id,
    'generated_at', now(),
    'days', target_days,
    'capabilities', jsonb_build_object(
      'leads', can_view_leads,
      'calls', can_view_calls,
      'work', can_view_work,
      'bookings', can_view_bookings,
      'inventory', can_view_inventory,
      'test_drives', can_view_test_drives,
      'operations', can_view_operations
    ),
    'kpis', jsonb_build_object(
      'open_leads', lead_open_count,
      'new_leads_today', lead_new_today_count,
      'followups_due_today', followup_due_today_count,
      'followups_overdue', followup_overdue_count,
      'appointments_today', appointment_today_count,
      'calls_today', call_today_count,
      'bookings_month', booking_month_count,
      'booking_value_month', booking_month_value,
      'test_drives_today', test_drive_today_count,
      'available_stock', available_stock_count,
      'open_cases', open_case_count,
      'overdue_cases', overdue_case_count,
      'cases_due_today', case_due_today_count,
      'cases_completed_month', case_completed_month_count
    ),
    'activity', activity_result,
    'pipeline', pipeline_result,
    'attention', attention_result,
    'lead_preview', lead_preview_result,
    'activity_primary', case
      when can_view_leads then 'New leads'
      when can_view_calls then 'Calls'
      when can_view_bookings then 'Bookings'
      else 'Activity'
    end,
    'activity_secondary', case
      when can_view_bookings and (can_view_leads or can_view_calls) then 'Bookings'
      when can_view_calls and can_view_leads then 'Calls'
      else ''
    end
  );
end;
$$;

revoke all on function app_private.tenant_performance_dashboard(integer, text, boolean)
  from public, anon, authenticated;

create or replace function public.get_tenant_performance_dashboard(
  target_days integer default 14,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.tenant_performance_dashboard(
    target_days,
    target_timezone,
    true
  );
$$;

revoke all on function public.get_tenant_performance_dashboard(integer, text)
  from public, anon;
grant execute on function public.get_tenant_performance_dashboard(integer, text)
  to authenticated;

create or replace function public.get_tenant_dashboard_summary(
  target_days integer default 14,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.tenant_performance_dashboard(
    target_days,
    target_timezone,
    false
  ) - 'lead_preview' - 'attention';
$$;

revoke all on function public.get_tenant_dashboard_summary(integer, text)
  from public, anon;
grant execute on function public.get_tenant_dashboard_summary(integer, text)
  to authenticated;

create or replace function public.get_tenant_dashboard_live_items(
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.tenant_dashboard_live_items(
    app_private.current_tenant_organization(),
    target_timezone
  );
$$;

revoke all on function public.get_tenant_dashboard_live_items(text)
  from public, anon;
grant execute on function public.get_tenant_dashboard_live_items(text)
  to authenticated;

commit;
