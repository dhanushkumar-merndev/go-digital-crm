begin;

-- The Sales Consultant dashboard labels its right-hand card "Tasks & alerts",
-- but its first value previously came from followups. Keep the task value on a
-- small owner/date index path and resolve branch scope once from the same active
-- Sales Consultant assignment whose role grants task.view.
create or replace function public.get_sales_consultant_task_due_count(
  target_timezone text default 'Asia/Kolkata'
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_actor_id uuid := auth.uid();
  current_organization_id uuid;
  allowed_branch_ids uuid[] := '{}'::uuid[];
  local_today date;
  day_start timestamptz;
  day_end timestamptz;
  due_count bigint := 0;
begin
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using
      errcode = '22023',
      message = 'INVALID_SALES_TASK_ALERT_TIMEZONE';
  end if;

  current_organization_id := app_private.sales_consultant_organization();

  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.organization_id = assignment_row.organization_id
     and role_row.id = assignment_row.role_id
     and role_row.role_key = 'sales_consultant'
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = assignment_row.role_id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'task.view'
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = current_actor_id
      and assignment_row.active
  ) then
    raise exception using
      errcode = '42501',
      message = 'SALES_CONSULTANT_TASK_VIEW_REQUIRED';
  end if;

  with eligible_assignments as materialized (
    select
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.organization_id = assignment_row.organization_id
     and role_row.id = assignment_row.role_id
     and role_row.role_key = 'sales_consultant'
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = assignment_row.role_id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'task.view'
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = current_actor_id
      and assignment_row.active
  )
  select coalesce(array_agg(branch_row.id order by branch_row.id), '{}'::uuid[])
  into allowed_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and branch_row.active
    and branch_row.deleted_at is null
    and exists (
      select 1
      from eligible_assignments assignment_row
      where assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
        or (
          assignment_row.data_scope = 'ONE_BRANCH'
          and assignment_row.scope_branch_id = branch_row.id
        )
        or (
          assignment_row.data_scope = 'SELECTED_BRANCHES'
          and branch_row.id = any(
            coalesce(assignment_row.selected_branch_ids, '{}'::uuid[])
          )
        )
        or (
          assignment_row.data_scope in ('OWN_RECORDS', 'OWN_TEAM')
          and (
            exists (
              select 1
              from public.user_branch_access branch_access_row
              where branch_access_row.organization_id = current_organization_id
                and branch_access_row.user_id = current_actor_id
                and branch_access_row.branch_id = branch_row.id
                and branch_access_row.active
            )
            or exists (
              select 1
              from public.team_members member_row
              join public.teams team_row
                on team_row.organization_id = member_row.organization_id
               and team_row.id = member_row.team_id
               and team_row.active
              where member_row.organization_id = current_organization_id
                and member_row.user_id = current_actor_id
                and member_row.active
                and team_row.branch_id = branch_row.id
            )
          )
        )
    );

  local_today := timezone(target_timezone, now())::date;
  day_start := timezone(target_timezone, local_today::timestamp);
  day_end := timezone(target_timezone, (local_today + 1)::timestamp);

  select count(*)::bigint
  into due_count
  from public.tasks task_row
  where task_row.organization_id = current_organization_id
    and task_row.assigned_user_id = current_actor_id
    and task_row.deleted_at is null
    and task_row.status in ('OPEN', 'IN_PROGRESS')
    and task_row.due_at >= day_start
    and task_row.due_at < day_end
    -- Match the Sales Consultant task workspace exactly: its owner-only fast
    -- path requires an active, authorized branch and deliberately excludes
    -- legacy branchless tasks. This also fails closed when no branch is in
    -- scope instead of exposing a branchless-task count.
    and task_row.branch_id = any(allowed_branch_ids);

  return due_count;
end;
$$;

revoke all on function public.get_sales_consultant_task_due_count(text)
  from public, anon;
grant execute on function public.get_sales_consultant_task_due_count(text)
  to authenticated;

commit;
