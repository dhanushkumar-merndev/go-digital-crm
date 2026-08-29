begin;

-- The task KPIs were computed from the same CTE that had already applied the
-- status filter and the search box. Opening the Completed tab therefore drove
-- Overdue, Due today and Upcoming to zero, and typing in search moved all four
-- — the cards described the current filter rather than the workload, which is
-- the one thing a KPI must not do.
--
-- The follow-up workspace already draws the line in the right place, and tasks
-- now match it exactly:
--
--   scoped   = mine + priority          -> `kpis`          (ignores status and search)
--   searched = scoped + search          -> `status_counts` (ignores status only)
--   filtered = searched + status        -> `total` + the page
--
-- Priority stays part of the KPI scope on both pages: it narrows *which*
-- workload you are looking at, where status and search only narrow the view of
-- it.
--
-- `status_counts` feeds the tab strip. Unlike the follow-up tabs these are not
-- disjoint — an OPEN task past its due date is counted under both Open and
-- Overdue — so the tab counts describe each tab and are not expected to sum to
-- All.

create or replace function app_private.get_sales_consultant_task_workspace_page(
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
    ), scoped_tasks as materialized (
      select task_row.*
      from owned_tasks task_row
      where (target_priority = 'ALL' or task_row.priority = target_priority)
    ), searched_tasks as materialized (
      select
        task_row.*,
        case when target_customer_access then customer_row.normalized_name else null end
          as customer_sort
      from scoped_tasks task_row
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = task_row.customer_id
       and customer_row.organization_id = target_organization_id
      where (
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
    ), authorized_tasks as not materialized (
      select task_row.*
      from searched_tasks task_row
      where target_status = 'ALL'
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
    ), task_stats as materialized (
      select
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
      from scoped_tasks
    ), task_tab_stats as materialized (
      select
        count(*)::bigint as all_count,
        count(*) filter (where status = 'OPEN')::bigint as open_count,
        count(*) filter (where status = 'IN_PROGRESS')::bigint as in_progress,
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
        count(*) filter (where status = 'COMPLETED')::bigint as completed,
        count(*) filter (where status = 'CANCELLED')::bigint as cancelled
      from searched_tasks
    ), task_filtered_stats as materialized (
      select count(*)::bigint as total from authorized_tasks
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
      'total', (select total from task_filtered_stats),
      'kpis', jsonb_build_object(
        'overdue', (select overdue from task_stats),
        'today', (select today from task_stats),
        'upcoming', (select upcoming from task_stats),
        'completed_today', (select completed_today from task_stats)
      ),
      'status_counts', jsonb_build_object(
        'all', (select all_count from task_tab_stats),
        'open', (select open_count from task_tab_stats),
        'in_progress', (select in_progress from task_tab_stats),
        'overdue', (select overdue from task_tab_stats),
        'today', (select today from task_tab_stats),
        'upcoming', (select upcoming from task_tab_stats),
        'completed', (select completed from task_tab_stats),
        'cancelled', (select cancelled from task_tab_stats)
      )
    )
  );
end;
$$;

revoke all on function app_private.get_sales_consultant_task_workspace_page(
  uuid, uuid, uuid[], boolean, text, text, text, integer, integer, text, text
) from public, anon, authenticated;

create or replace function public.get_task_workspace_page_legacy(
  target_search text default '',
  target_status text default 'ALL',
  target_priority text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'due:asc',
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
  search_uuid uuid;
  day_start timestamptz;
  day_end timestamptz;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160
    or target_status not in (
      'ALL', 'OPEN', 'IN_PROGRESS', 'OVERDUE', 'TODAY', 'UPCOMING', 'COMPLETED', 'CANCELLED'
    )
    or target_priority not in ('ALL', 'LOW', 'NORMAL', 'HIGH', 'URGENT')
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
    or target_sort not in ('due:asc', 'due:desc', 'updated:desc', 'priority:desc', 'customer:asc')
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_QUERY';
  end if;
  begin
    perform now() at time zone target_timezone;
  exception when invalid_parameter_value then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end;
  day_start := date_trunc('day', now() at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'task.view')
  then
    raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
  end if;

  with accessible as materialized (
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
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model
    from public.tasks task_row
    join public.branches branch_row
      on branch_row.id = task_row.branch_id
     and branch_row.organization_id = task_row.organization_id
    left join public.teams team_row
      on team_row.id = task_row.team_id
     and team_row.organization_id = task_row.organization_id
    left join public.profiles assignee_row
      on assignee_row.id = task_row.assigned_user_id
     and assignee_row.organization_id = task_row.organization_id
    left join public.customers customer_row
      on customer_row.id = task_row.customer_id
     and customer_row.organization_id = task_row.organization_id
    left join public.leads lead_row
      on lead_row.id = task_row.lead_id
     and lead_row.organization_id = task_row.organization_id
    where task_row.organization_id = current_organization_id
      and task_row.deleted_at is null
      and app_private.can_access_record(
        task_row.organization_id, task_row.branch_id,
        task_row.team_id, task_row.assigned_user_id
      )
      and (task_row.lead_id is null or app_private.can_access_lead(task_row.lead_id))
  ), scoped as materialized (
    select accessible_row.*
    from accessible accessible_row
    where (target_priority = 'ALL' or accessible_row.priority = target_priority)
  ), searched as materialized (
    select scoped_row.*
    from scoped scoped_row
    where (
      normalized_search = ''
      or scoped_row.id = search_uuid
      or position(normalized_search in lower(scoped_row.title)) > 0
      or position(normalized_search in lower(coalesce(scoped_row.description, ''))) > 0
      or position(normalized_search in lower(coalesce(scoped_row.customer_name, ''))) > 0
      or (
        app_private.normalize_phone_digits(normalized_search) <> ''
        and app_private.normalize_phone_digits(scoped_row.phone)
          = app_private.normalize_phone_digits(normalized_search)
      )
    )
  ), authorized as materialized (
    select searched_row.*
    from searched searched_row
    where target_status = 'ALL'
      or (
        target_status in ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
        and searched_row.status = target_status
      )
      or (
        target_status = 'OVERDUE'
        and searched_row.status in ('OPEN', 'IN_PROGRESS')
        and searched_row.due_at < now()
      )
      or (
        target_status = 'TODAY'
        and searched_row.status in ('OPEN', 'IN_PROGRESS')
        and searched_row.due_at >= day_start and searched_row.due_at < day_end
      )
      or (
        target_status = 'UPCOMING'
        and searched_row.status in ('OPEN', 'IN_PROGRESS')
        and searched_row.due_at >= day_end
      )
  ), page_rows as (
    select authorized_row.*
    from authorized authorized_row
    order by
      case when target_sort = 'due:asc' then authorized_row.due_at end asc nulls last,
      case when target_sort = 'due:desc' then authorized_row.due_at end desc nulls last,
      case when target_sort = 'updated:desc' then authorized_row.updated_at end desc,
      case when target_sort = 'priority:desc' then case authorized_row.priority
        when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end
      end desc,
      case when target_sort = 'customer:asc' then lower(authorized_row.customer_name) end asc,
      authorized_row.id asc
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((select jsonb_agg(to_jsonb(page_row) order by
      case when target_sort = 'due:asc' then page_row.due_at end asc nulls last,
      case when target_sort = 'due:desc' then page_row.due_at end desc nulls last,
      case when target_sort = 'updated:desc' then page_row.updated_at end desc,
      case when target_sort = 'priority:desc' then case page_row.priority
        when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end
      end desc,
      case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
      page_row.id asc
    ) from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from authorized),
    'kpis', jsonb_build_object(
      'overdue', (
        select count(*) from scoped
        where status in ('OPEN', 'IN_PROGRESS') and due_at < now()
      ),
      'today', (
        select count(*) from scoped
        where status in ('OPEN', 'IN_PROGRESS') and due_at >= day_start and due_at < day_end
      ),
      'upcoming', (
        select count(*) from scoped
        where status in ('OPEN', 'IN_PROGRESS') and due_at >= day_end
      ),
      'completed_today', (
        select count(*) from scoped
        where status = 'COMPLETED' and completed_at >= day_start and completed_at < day_end
      )
    ),
    'status_counts', jsonb_build_object(
      'all', (select count(*) from searched),
      'open', (select count(*) from searched where status = 'OPEN'),
      'in_progress', (select count(*) from searched where status = 'IN_PROGRESS'),
      'overdue', (
        select count(*) from searched
        where status in ('OPEN', 'IN_PROGRESS') and due_at < now()
      ),
      'today', (
        select count(*) from searched
        where status in ('OPEN', 'IN_PROGRESS') and due_at >= day_start and due_at < day_end
      ),
      'upcoming', (
        select count(*) from searched
        where status in ('OPEN', 'IN_PROGRESS') and due_at >= day_end
      ),
      'completed', (select count(*) from searched where status = 'COMPLETED'),
      'cancelled', (select count(*) from searched where status = 'CANCELLED')
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_task_workspace_page_legacy(
  text, text, text, integer, integer, text, text
) from public, anon, authenticated;

commit;
