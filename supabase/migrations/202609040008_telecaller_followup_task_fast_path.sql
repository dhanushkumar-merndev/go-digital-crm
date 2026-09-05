-- Telecaller's Follow-ups and Tasks pages were still going through the
-- generic, non-fast-pathed branch of get_followup_workspace_filtered_page /
-- get_task_workspace_page: it scans every followup/task in the ORGANIZATION
-- and runs app_private.can_access_record() + can_access_lead() (both
-- SECURITY DEFINER, so non-inlinable -- a real function call, with its own
-- nested EXISTS checks, per candidate row) before narrowing to "my own
-- records" at all. Sales Consultant got a narrow-first fast path for exactly
-- this in 202608310001 (followups) and 202608220004 (tasks); Telecaller never
-- did. This is the same class of bug diagnosed in CONTINUE.md for the
-- tenant/Sales Consultant dashboards -- see [[gdm-crm-scale-work]].
--
-- Fix: give Telecaller the identical fast path, reusing the exact same
-- (already role-agnostic) query bodies under new names, then dispatch to them
-- from the two existing public routers via a guarded, live-fetched patch --
-- see [[patch-deployed-plpgsql-never-re-emit]] -- so this never risks
-- reverting whatever those two dispatcher functions currently look like live.

begin;

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. Telecaller fast path for Follow-ups -- identical body to
--    app_private.get_sales_consultant_followup_workspace_filtered_page, which
--    was already written with no role-specific logic inside it.
-- ──────────────────────────────────────────────────────────────────────────────

create or replace function app_private.get_telecaller_followup_workspace_filtered_page(
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
  target_timezone text,
  target_model text default '',
  target_source text default '',
  target_temperature text default 'all',
  target_followup_from date default null,
  target_followup_to date default null
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
  followup_from_at timestamptz;
  followup_to_exclusive_at timestamptz;
  has_lead_filters boolean;
begin
  -- Validation is performed by the public router; this function trusts its
  -- caller to have validated all inputs.

  normalized_search := lower(btrim(coalesce(target_search, '')));
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  if target_followup_from is not null then
    followup_from_at := target_followup_from::timestamp at time zone target_timezone;
  end if;
  if target_followup_to is not null then
    followup_to_exclusive_at := (target_followup_to + 1)::timestamp at time zone target_timezone;
  end if;

  has_lead_filters :=
       nullif(btrim(coalesce(target_model, '')), '') is not null
    or nullif(btrim(coalesce(target_source, '')), '') is not null
    or target_temperature is distinct from 'all';

  return (
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
      select
        followup_row.*,
        lead_row.interested_model as lead_interested_model,
        lead_row.source::text as lead_source,
        lead_row.temperature::text as lead_temperature
      from owned_followups followup_row
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      where (target_branch_id is null or followup_row.branch_id = target_branch_id)
        and (target_team_id is null or followup_row.team_id = target_team_id)
        and (target_owner_id is null or followup_row.assigned_user_id = target_owner_id)
        and (target_priority = 'all' or followup_row.priority = target_priority)
        and (nullif(btrim(coalesce(target_model, '')), '') is null
          or lead_row.interested_model = btrim(target_model))
        and (nullif(btrim(coalesce(target_source, '')), '') is null
          or lead_row.source::text = btrim(target_source))
        and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
        and (followup_from_at is null or followup_row.due_at >= followup_from_at)
        and (followup_to_exclusive_at is null or followup_row.due_at < followup_to_exclusive_at)

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
            jsonb_build_object('id', bf.branch_id, 'name', bf.branch_name)
            order by bf.branch_name
          )
          from (
            select distinct f.branch_id, b.name as branch_name
            from owned_followups f
            join public.branches b
              on b.id = f.branch_id
             and b.organization_id = target_organization_id
          ) bf
        ), '[]'::jsonb),
        'teams', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', tf.team_id, 'name', tf.team_name, 'branch_id', tf.branch_id)
            order by tf.team_name
          )
          from (
            select distinct f.team_id, t.name as team_name, f.branch_id
            from owned_followups f
            join public.teams t
              on t.id = f.team_id
             and t.organization_id = target_organization_id
            where f.team_id is not null
          ) tf
        ), '[]'::jsonb),
        'owners', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', of_row.assigned_user_id, 'name', of_row.assigned_user_name)
            order by of_row.assigned_user_name
          )
          from (
            select distinct f.assigned_user_id, p.full_name as assigned_user_name
            from owned_followups f
            join public.profiles p
              on p.id = f.assigned_user_id
             and p.organization_id = target_organization_id
          ) of_row
        ), '[]'::jsonb),
        'models', coalesce((
          select jsonb_agg(mv.model order by mv.model)
          from (
            select distinct l.interested_model as model
            from owned_followups f
            join public.leads l
              on l.id = f.lead_id
             and l.organization_id = target_organization_id
             and l.deleted_at is null
            where l.interested_model is not null
          ) mv
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(sv.source order by sv.source)
          from (
            select distinct l.source::text as source
            from owned_followups f
            join public.leads l
              on l.id = f.lead_id
             and l.organization_id = target_organization_id
             and l.deleted_at is null
            where l.source is not null
          ) sv
        ), '[]'::jsonb)
      ),
      'timezone', target_timezone
    )
  );
end;
$$;

revoke all on function app_private.get_telecaller_followup_workspace_filtered_page(
  uuid, uuid, uuid[], boolean, text, text, text, uuid, uuid, uuid,
  integer, integer, text, text, text, text, text, date, date
) from public, anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. Telecaller fast path for Tasks -- identical body to
--    app_private.get_sales_consultant_task_workspace_page.
-- ──────────────────────────────────────────────────────────────────────────────

create or replace function app_private.get_telecaller_task_workspace_page(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_search text,
  target_status text,
  target_priority text,
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
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
    raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160
    or target_status is null
    or target_status not in (
      'ALL', 'OPEN', 'IN_PROGRESS', 'OVERDUE', 'TODAY', 'UPCOMING', 'COMPLETED', 'CANCELLED'
    )
    or target_priority is null
    or target_priority not in ('ALL', 'LOW', 'NORMAL', 'HIGH', 'URGENT')
    or target_page is null
    or target_page not between 1 and 1000000
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
    or target_sort is null
    or target_sort not in ('due:asc', 'due:desc', 'updated:desc', 'priority:desc', 'customer:asc')
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_QUERY';
  end if;
  begin
    perform query_now at time zone target_timezone;
  exception when invalid_parameter_value then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end;
  if target_timezone is null then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  return (
    with owned_tasks as not materialized (
      select
        task_row.id,
        task_row.organization_id,
        task_row.branch_id,
        task_row.team_id,
        task_row.lead_id,
        task_row.customer_id,
        task_row.assigned_user_id,
        task_row.title,
        task_row.description,
        task_row.priority,
        task_row.status,
        task_row.due_at,
        task_row.completed_at,
        task_row.completion_note,
        task_row.version,
        task_row.created_at,
        task_row.updated_at
      from public.tasks task_row
      where task_row.organization_id = target_organization_id
        and task_row.assigned_user_id = target_user_id
        and task_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
        and task_row.deleted_at is null
    ), authorized_tasks as not materialized (
      select
        task_row.*,
        case when target_customer_access then customer_row.normalized_name else null end
          as customer_sort
      from owned_tasks task_row
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = task_row.customer_id
       and customer_row.organization_id = target_organization_id
      where (target_priority = 'ALL' or task_row.priority = target_priority)
        and (
          target_status = 'ALL'
          or (
            target_status in ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
            and task_row.status = target_status
          )
          or (
            target_status = 'OVERDUE'
            and task_row.status in ('OPEN', 'IN_PROGRESS')
            and task_row.due_at < query_now
          )
          or (
            target_status = 'TODAY'
            and task_row.status in ('OPEN', 'IN_PROGRESS')
            and task_row.due_at >= day_start
            and task_row.due_at < day_end
          )
          or (
            target_status = 'UPCOMING'
            and task_row.status in ('OPEN', 'IN_PROGRESS')
            and task_row.due_at >= day_end
          )
        )
        and (
          normalized_search = ''
          or task_row.id = search_uuid
          or position(normalized_search in lower(task_row.title)) > 0
          or position(normalized_search in lower(coalesce(task_row.description, ''))) > 0
          or (
            target_customer_access
            and (
              customer_row.normalized_name ilike '%' || normalized_search || '%'
              or (
                search_phone_digits <> ''
                and customer_row.normalized_phone in (
                  search_phone_digits,
                  '+' || search_phone_digits
                )
              )
            )
          )
        )
    ), task_stats as materialized (
      select
        count(*)::bigint as total,
        count(*) filter (
          where status in ('OPEN', 'IN_PROGRESS') and due_at < query_now
        )::bigint as overdue,
        count(*) filter (
          where status in ('OPEN', 'IN_PROGRESS')
            and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (
          where status in ('OPEN', 'IN_PROGRESS') and due_at >= day_end
        )::bigint as upcoming,
        count(*) filter (
          where status = 'COMPLETED'
            and completed_at >= day_start and completed_at < day_end
        )::bigint as completed_today
      from authorized_tasks
    ), page_ids as materialized (
      select
        task_row.id,
        task_row.due_at,
        task_row.updated_at,
        task_row.priority,
        task_row.customer_sort
      from authorized_tasks task_row
      order by
        case when target_sort = 'due:asc' then task_row.due_at end asc nulls last,
        case when target_sort = 'due:desc' then task_row.due_at end desc nulls last,
        case when target_sort = 'updated:desc' then task_row.updated_at end desc,
        case when target_sort = 'priority:desc' then case task_row.priority
          when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end
        end desc,
        case when target_sort = 'customer:asc' then task_row.customer_sort end asc,
        task_row.id asc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), page_rows as materialized (
      select
        task_row.id,
        task_row.organization_id,
        task_row.branch_id,
        task_row.team_id,
        task_row.lead_id,
        task_row.customer_id,
        task_row.assigned_user_id,
        task_row.title,
        task_row.description,
        task_row.priority,
        task_row.status,
        task_row.due_at,
        task_row.completed_at,
        task_row.completion_note,
        task_row.version,
        task_row.created_at,
        task_row.updated_at,
        branch_row.name as branch_name,
        team_row.name as team_name,
        assignee_row.full_name as assigned_user_name,
        case when target_customer_access then customer_row.full_name else null end
          as customer_name,
        case when target_customer_access then customer_row.primary_phone else null end
          as phone,
        lead_row.interested_model,
        page_id.customer_sort
      from page_ids page_id
      join owned_tasks task_row on task_row.id = page_id.id
      join public.branches branch_row
        on branch_row.id = task_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = task_row.team_id
       and team_row.organization_id = target_organization_id
      left join public.profiles assignee_row
        on assignee_row.id = task_row.assigned_user_id
       and assignee_row.organization_id = target_organization_id
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = task_row.customer_id
       and customer_row.organization_id = target_organization_id
      left join public.leads lead_row
        on lead_row.id = task_row.lead_id
       and lead_row.organization_id = target_organization_id
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'organization_id', page_row.organization_id,
            'branch_id', page_row.branch_id,
            'team_id', page_row.team_id,
            'lead_id', page_row.lead_id,
            'customer_id', page_row.customer_id,
            'assigned_user_id', page_row.assigned_user_id,
            'title', page_row.title,
            'description', page_row.description,
            'priority', page_row.priority,
            'status', page_row.status,
            'due_at', page_row.due_at,
            'completed_at', page_row.completed_at,
            'completion_note', page_row.completion_note,
            'version', page_row.version,
            'created_at', page_row.created_at,
            'updated_at', page_row.updated_at,
            'branch_name', page_row.branch_name,
            'team_name', page_row.team_name,
            'assigned_user_name', page_row.assigned_user_name,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'interested_model', page_row.interested_model
          ) order by
            case when target_sort = 'due:asc' then page_row.due_at end asc nulls last,
            case when target_sort = 'due:desc' then page_row.due_at end desc nulls last,
            case when target_sort = 'updated:desc' then page_row.updated_at end desc,
            case when target_sort = 'priority:desc' then case page_row.priority
              when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end
            end desc,
            case when target_sort = 'customer:asc' then page_row.customer_sort end asc,
            page_row.id asc
        )
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select total from task_stats),
      'kpis', jsonb_build_object(
        'overdue', (select overdue from task_stats),
        'today', (select today from task_stats),
        'upcoming', (select upcoming from task_stats),
        'completed_today', (select completed_today from task_stats)
      )
    )
  );
end;
$$;

revoke all on function app_private.get_telecaller_task_workspace_page(
  uuid, uuid, uuid[], boolean, text, text, text, integer, integer, text, text
) from public, anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. Patch the two live dispatchers to route Telecaller to the fast paths
--    above. Guarded, live-body patch (per [[patch-deployed-plpgsql-never-
--    re-emit]]): fetches whatever is actually deployed right now via
--    pg_get_functiondef, confirms the anchor text appears exactly once, and
--    only then does the targeted replace. Aborts loudly instead of silently
--    reverting unrelated later work if the live body doesn't look as
--    expected.
-- ──────────────────────────────────────────────────────────────────────────────

do $migration$
declare
  function_definition text;
  -- Anchored on this plain-ASCII comment line rather than the box-drawing
  -- "── Generic path ──" banner above it, so the match can't silently fail on
  -- a byte-for-byte mismatch in hand-typed Unicode dashes.
  broken_fragment constant text := E'  -- (unchanged logic from 202608290009)';
  fixed_fragment constant text :=
    $body$  -- ── Telecaller fast path ──
  if access_context->>'role_key' = 'telecaller' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('followup.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    if target_branch_id is not null
      and not (target_branch_id = any(allowed_branch_ids))
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if target_team_id is not null
      and not app_private.can_access_team(current_organization_id, target_team_id)
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;

    return app_private.get_telecaller_followup_workspace_filtered_page(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      customer_access,
      target_search,
      target_status,
      target_priority,
      target_branch_id,
      target_team_id,
      target_owner_id,
      target_page,
      target_page_size,
      target_sort,
      target_timezone,
      target_model,
      target_source,
      target_temperature,
      target_followup_from,
      target_followup_to
    );
  end if;

  -- (unchanged logic from 202608290009)$body$;
begin
  select pg_get_functiondef(
    'public.get_followup_workspace_filtered_page(text,text,text,uuid,uuid,uuid,integer,integer,text,text,text,text,text,date,date)'::regprocedure
  ) into function_definition;
  if function_definition is null
    or position(broken_fragment in function_definition) = 0
    or (
      char_length(function_definition)
      - char_length(replace(function_definition, broken_fragment, ''))
    ) / char_length(broken_fragment) <> 1
  then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_DISPATCH_PATCH_MISMATCH';
  end if;
  execute replace(function_definition, broken_fragment, fixed_fragment);
end;
$migration$;

do $migration$
declare
  function_definition text;
  broken_fragment constant text := E'  return public.get_task_workspace_page_legacy(';
  fixed_fragment constant text :=
    $body$  if access_context->>'role_key' = 'telecaller' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('task.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );

    return app_private.get_telecaller_task_workspace_page(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      customer_access,
      target_search,
      target_status,
      target_priority,
      target_page,
      target_page_size,
      target_sort,
      target_timezone
    );
  end if;

  return public.get_task_workspace_page_legacy($body$;
begin
  select pg_get_functiondef(
    'public.get_task_workspace_page(text,text,text,integer,integer,text,text)'::regprocedure
  ) into function_definition;
  if function_definition is null
    or position(broken_fragment in function_definition) = 0
    or (
      char_length(function_definition)
      - char_length(replace(function_definition, broken_fragment, ''))
    ) / char_length(broken_fragment) <> 1
  then
    raise exception using errcode = 'P0001', message = 'TASK_DISPATCH_PATCH_MISMATCH';
  end if;
  -- access_context/current_organization_id/current_user_id/allowed_branch_ids/
  -- permission_keys/customer_access are all already declared up front in this
  -- function (the sales-consultant branch already uses every one of them), so
  -- the injected telecaller branch below needs no new declarations.
  execute replace(function_definition, broken_fragment, fixed_fragment);
end;
$migration$;

commit;
