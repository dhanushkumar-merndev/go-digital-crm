begin;

-- Two separate problems, both visible as "my leads say 18 follow-ups, the
-- Follow-ups page says 11".
--
-- 1. Scope. The Follow-up tab on My Leads counts *leads* carrying a pending
--    `next_followup_at`. The Follow-ups page counts *follow-up rows where the
--    consultant is the assignee*. `assign_lead` never moves a lead's open
--    follow-ups to the new owner, so every lead handed over from a telecaller
--    or another consultant keeps its commitment pointed at the previous owner:
--    the lead shows up under Follow-up, the task it is named after never
--    reaches the new owner's Follow-ups page.
--
--    A consultant's Follow-ups page now lists a follow-up when it is assigned
--    to them *or* when it hangs off a lead assigned to them. Nothing is
--    rewritten -- the row keeps its real assignee, the `assigned_user_name`
--    column still names them, and complete/reschedule/cancel still authorise
--    against that assignee, so a borrowed row stays read-only. This only stops
--    the page from hiding work the consultant is accountable for.
--
-- 2. Tab counts. The status tabs had no counts at all, so there was no way to
--    see from the page that the list was short. Both the consultant fast path
--    and the legacy path now return `status_counts` for the six tabs, measured
--    over the same scope + search the table is showing and *before* the status
--    filter, so the tabs sum to the unfiltered total.
--
-- The KPI block keeps its own meaning: it is the consultant's open workload
-- plus what they cleared today, and it is deliberately not search-sensitive.

create or replace function app_private.get_sales_consultant_followup_workspace_page(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_search text,
  target_status text,
  target_priority text,
  target_branch_id uuid,
  target_team_id uuid,
  target_owner_id uuid,
  target_page integer,
  target_page_size integer,
  target_sort text,
  target_timezone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  query_now timestamptz := now();
  day_start timestamptz;
  day_end timestamptz;
begin
  if auth.uid() is null
    or target_organization_id is null
    or target_user_id is distinct from auth.uid()
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_page is null
    or target_page not between 1 and 1000000
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if target_status is null
    or target_status not in ('all', 'overdue', 'today', 'upcoming', 'completed', 'cancelled')
  then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_FILTER';
  end if;
  if target_priority is null
    or target_priority not in ('all', 'LOW', 'NORMAL', 'HIGH', 'URGENT')
  then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_PRIORITY_FILTER';
  end if;
  if target_sort is null or target_sort not in (
    'scheduled:asc', 'scheduled:desc', 'updated:desc',
    'updated:asc', 'customer:asc', 'customer:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_WORK_SORT';
  end if;
  if target_timezone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
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
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';

  return (
    -- Written as a UNION rather than an OR so each arm keeps its index: the
    -- first rides followups(organization_id, assigned_user_id, due_at, id),
    -- the second walks leads(organization_id, assigned_user_id, ...) into
    -- followups(organization_id, lead_id, due_at, id). An OR across the two
    -- collapses both into a sequential scan of the tenant's follow-ups.
    with owned_followups as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.followups followup_row
      where followup_row.organization_id = target_organization_id
        and followup_row.assigned_user_id = target_user_id
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
      union
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.leads lead_row
      join public.followups followup_row
        on followup_row.lead_id = lead_row.id
       and followup_row.organization_id = target_organization_id
      where lead_row.organization_id = target_organization_id
        and lead_row.assigned_user_id = target_user_id
        and lead_row.deleted_at is null
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
    ), scoped_followups as materialized (
      select followup_row.*
      from owned_followups followup_row
      where (target_branch_id is null or followup_row.branch_id = target_branch_id)
        and (target_team_id is null or followup_row.team_id = target_team_id)
        and (target_owner_id is null or followup_row.assigned_user_id = target_owner_id)
        and (target_priority = 'all' or followup_row.priority = target_priority)
    ), searched_followups as materialized (
      select
        followup_row.*,
        case when target_customer_access then
          coalesce(
            customer_row.normalized_name,
            lower(lead_row.customer_name),
            'unlinked customer'
          )
        else null end as customer_sort
      from scoped_followups followup_row
      left join public.leads lead_row
        on target_customer_access
       and lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      where (
        normalized_search = ''
        or followup_row.id = search_uuid
        or followup_row.lead_id = search_uuid
        or (
          target_customer_access
          and (
            customer_row.normalized_name ilike '%' || normalized_search || '%'
            or lower(lead_row.customer_name) ilike '%' || normalized_search || '%'
            or (
              search_phone_digits <> ''
              and (
                customer_row.normalized_phone like search_phone_digits || '%'
                or customer_row.normalized_phone like '+' || search_phone_digits || '%'
                or lead_row.normalized_phone like search_phone_digits || '%'
                or lead_row.normalized_phone like '+' || search_phone_digits || '%'
              )
            )
          )
        )
      )
    ), searchable_followups as not materialized (
      select followup_row.*
      from searched_followups followup_row
      where case target_status
        when 'overdue' then followup_row.status = 'OPEN' and followup_row.due_at < query_now
        when 'today' then followup_row.status = 'OPEN'
          and followup_row.due_at >= day_start and followup_row.due_at < day_end
        when 'upcoming' then followup_row.status = 'OPEN' and followup_row.due_at >= day_end
        when 'completed' then followup_row.status = 'COMPLETED'
        when 'cancelled' then followup_row.status = 'CANCELLED'
        else true
      end
    ), followup_scope_stats as materialized (
      select
        count(*) filter (where status = 'OPEN' and due_at < query_now)::bigint as overdue,
        count(*) filter (
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (where status = 'OPEN' and due_at >= day_end)::bigint as upcoming,
        count(*) filter (
          where status = 'COMPLETED'
            and completed_at >= day_start and completed_at < day_end
        )::bigint as completed_today
      from scoped_followups
    ), followup_tab_stats as materialized (
      select
        count(*)::bigint as all_count,
        count(*) filter (where status = 'OPEN' and due_at < query_now)::bigint as overdue,
        count(*) filter (
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (where status = 'OPEN' and due_at >= day_end)::bigint as upcoming,
        count(*) filter (where status = 'COMPLETED')::bigint as completed,
        count(*) filter (where status = 'CANCELLED')::bigint as cancelled
      from searched_followups
    ), followup_filtered_stats as materialized (
      select count(*)::bigint as total from searchable_followups
    ), page_ids as materialized (
      select
        followup_row.id,
        followup_row.due_at,
        followup_row.updated_at,
        followup_row.customer_sort
      from searchable_followups followup_row
      order by
        case when target_sort = 'scheduled:asc' then followup_row.due_at end asc,
        case when target_sort = 'scheduled:desc' then followup_row.due_at end desc,
        case when target_sort = 'updated:desc' then followup_row.updated_at end desc,
        case when target_sort = 'updated:asc' then followup_row.updated_at end asc,
        case when target_sort = 'customer:asc' then followup_row.customer_sort end asc,
        case when target_sort = 'customer:desc' then followup_row.customer_sort end desc,
        followup_row.id asc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), page_rows as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        case when target_customer_access then
          coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer')
        else 'Restricted' end as customer_name,
        case when target_customer_access then
          coalesce(customer_row.primary_phone, lead_row.phone)
        else null end as phone,
        lead_row.interested_model,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        case
          when followup_row.status = 'OPEN' and followup_row.due_at < query_now then 'OVERDUE'
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
        followup_row.updated_at,
        page_id.customer_sort
      from page_ids page_id
      join owned_followups followup_row on followup_row.id = page_id.id
      join public.branches branch_row
        on branch_row.id = followup_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = followup_row.team_id
       and team_row.organization_id = target_organization_id
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      join public.profiles assigned_profile
        on assigned_profile.id = followup_row.assigned_user_id
       and assigned_profile.organization_id = target_organization_id
      left join public.profiles creator_profile
        on creator_profile.id = followup_row.created_by
       and creator_profile.organization_id = target_organization_id
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'version', page_row.version,
            'lead_id', page_row.lead_id,
            'customer_id', page_row.customer_id,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'interested_model', page_row.interested_model,
            'reason', page_row.reason,
            'priority', page_row.priority,
            'due_at', page_row.due_at,
            'display_status', page_row.display_status,
            'status', page_row.status,
            'assigned_user_id', page_row.assigned_user_id,
            'assigned_user_name', page_row.assigned_user_name,
            'created_by', page_row.created_by,
            'created_by_name', page_row.created_by_name,
            'branch_id', page_row.branch_id,
            'branch_name', page_row.branch_name,
            'team_id', page_row.team_id,
            'team_name', page_row.team_name,
            'completed_at', page_row.completed_at,
            'cancelled_at', page_row.cancelled_at,
            'updated_at', page_row.updated_at
          ) order by
            case when target_sort = 'scheduled:asc' then page_row.due_at end asc,
            case when target_sort = 'scheduled:desc' then page_row.due_at end desc,
            case when target_sort = 'updated:desc' then page_row.updated_at end desc,
            case when target_sort = 'updated:asc' then page_row.updated_at end asc,
            case when target_sort = 'customer:asc' then page_row.customer_sort end asc,
            case when target_sort = 'customer:desc' then page_row.customer_sort end desc,
            page_row.id asc
        )
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select total from followup_filtered_stats),
      'kpis', jsonb_build_object(
        'overdue', (select overdue from followup_scope_stats),
        'today', (select today from followup_scope_stats),
        'upcoming', (select upcoming from followup_scope_stats),
        'completed_today', (select completed_today from followup_scope_stats)
      ),
      'status_counts', jsonb_build_object(
        'all', (select all_count from followup_tab_stats),
        'overdue', (select overdue from followup_tab_stats),
        'today', (select today from followup_tab_stats),
        'upcoming', (select upcoming from followup_tab_stats),
        'completed', (select completed from followup_tab_stats),
        'cancelled', (select cancelled from followup_tab_stats)
      ),
      'filters', jsonb_build_object(
        'branches', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', branch_filter.branch_id, 'name', branch_filter.branch_name)
            order by branch_filter.branch_name
          )
          from (
            select distinct followup_row.branch_id, branch_row.name as branch_name
            from owned_followups followup_row
            join public.branches branch_row
              on branch_row.id = followup_row.branch_id
             and branch_row.organization_id = target_organization_id
          ) branch_filter
        ), '[]'::jsonb),
        'teams', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', team_filter.team_id,
              'name', team_filter.team_name,
              'branch_id', team_filter.branch_id
            ) order by team_filter.team_name
          )
          from (
            select distinct followup_row.team_id, team_row.name as team_name, followup_row.branch_id
            from owned_followups followup_row
            join public.teams team_row
              on team_row.id = followup_row.team_id
             and team_row.organization_id = target_organization_id
            where followup_row.team_id is not null
          ) team_filter
        ), '[]'::jsonb),
        'owners', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', owner_filter.assigned_user_id,
              'name', owner_filter.assigned_user_name
            ) order by owner_filter.assigned_user_name
          )
          from (
            select distinct
              followup_row.assigned_user_id,
              profile_row.full_name as assigned_user_name
            from owned_followups followup_row
            join public.profiles profile_row
              on profile_row.id = followup_row.assigned_user_id
             and profile_row.organization_id = target_organization_id
          ) owner_filter
        ), '[]'::jsonb)
      ),
      'timezone', target_timezone
    )
  );
end;
$$;

revoke all on function app_private.get_sales_consultant_followup_workspace_page(
  uuid, uuid, uuid[], boolean, text, text, text, uuid, uuid, uuid,
  integer, integer, text, text
) from public, anon, authenticated;

-- The legacy path serves every non-consultant role. Its scope rules are
-- correct already -- a manager reaches their team's follow-ups through
-- `can_access_record` -- so only the tab counts are added here, keeping the
-- response shape identical across both paths.
create or replace function public.get_followup_workspace_page_legacy(
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
  ), searched_records as materialized (
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
  ), filtered_records as materialized (
    select record_row.*
    from searched_records record_row
    where case target_status
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
    'status_counts', jsonb_build_object(
      'all', (select count(*) from searched_records),
      'overdue', (
        select count(*) from searched_records where status = 'OPEN' and due_at < now()
      ),
      'today', (
        select count(*) from searched_records
        where status = 'OPEN' and due_at >= day_start and due_at < day_end
      ),
      'upcoming', (
        select count(*) from searched_records where status = 'OPEN' and due_at >= day_end
      ),
      'completed', (select count(*) from searched_records where status = 'COMPLETED'),
      'cancelled', (select count(*) from searched_records where status = 'CANCELLED')
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

revoke all on function public.get_followup_workspace_page_legacy(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) from public, anon, authenticated;

-- Table and Calendar are two views of one page behind a toggle. Widening only
-- the table would make the same consultant's month show fewer follow-ups than
-- their list, so the calendar takes the identical scope. Patched in place
-- rather than retyped: only the `owned_followups` CTE changes, and a literal
-- match failure aborts the migration instead of silently leaving the two
-- views disagreeing.
do $calendar_patch$
declare
  signature regprocedure :=
    'app_private.get_sales_consultant_followup_calendar(uuid,uuid,uuid[],boolean,date,date,text,text,text,uuid,uuid,uuid,text)'::regprocedure;
  followup_columns constant text :=
    E'      select\n'
    || E'        followup_row.id,\n'
    || E'        followup_row.version,\n'
    || E'        followup_row.lead_id,\n'
    || E'        followup_row.customer_id,\n'
    || E'        followup_row.reason,\n'
    || E'        followup_row.priority,\n'
    || E'        followup_row.due_at,\n'
    || E'        followup_row.status,\n'
    || E'        followup_row.assigned_user_id,\n'
    || E'        followup_row.created_by,\n'
    || E'        followup_row.branch_id,\n'
    || E'        followup_row.team_id,\n'
    || E'        followup_row.completed_at,\n'
    || E'        followup_row.cancelled_at,\n'
    || E'        followup_row.updated_at\n';
  assignee_arm constant text :=
    E'      from public.followups followup_row\n'
    || E'      where followup_row.organization_id = target_organization_id\n'
    || E'        and followup_row.assigned_user_id = target_user_id\n'
    || E'        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))\n'
    || E'    ), scope_filtered as not materialized (\n';
  widened_arm constant text :=
    E'      from public.followups followup_row\n'
    || E'      where followup_row.organization_id = target_organization_id\n'
    || E'        and followup_row.assigned_user_id = target_user_id\n'
    || E'        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))\n'
    || E'      union\n'
    || followup_columns
    || E'      from public.leads lead_row\n'
    || E'      join public.followups followup_row\n'
    || E'        on followup_row.lead_id = lead_row.id\n'
    || E'       and followup_row.organization_id = target_organization_id\n'
    || E'      where lead_row.organization_id = target_organization_id\n'
    || E'        and lead_row.assigned_user_id = target_user_id\n'
    || E'        and lead_row.deleted_at is null\n'
    || E'        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))\n'
    || E'    ), scope_filtered as not materialized (\n';
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := replace(definition, assignee_arm, widened_arm);
  -- A UNION arm cannot be re-planned per reference, so the CTE stops being
  -- inlinable and is materialised once for the month.
  updated_definition := replace(
    updated_definition,
    E'    with owned_followups as not materialized (\n',
    E'    with owned_followups as materialized (\n'
  );

  if updated_definition = definition
    or position(widened_arm in updated_definition) = 0
    or position(E'    with owned_followups as materialized (\n' in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'FOLLOWUP_CALENDAR_OWNER_SCOPE_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$calendar_patch$;

commit;
