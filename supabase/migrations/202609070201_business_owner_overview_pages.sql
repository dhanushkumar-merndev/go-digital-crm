-- Business Owner had four navigation entries -- Dashboard, Sales Overview,
-- Showroom Performance and Operations Overview -- and all four rendered the same
-- tenant dashboard component. The pages were never built; only the links were.
--
-- The three RPCs below give each page something of its own. Every aggregate is
-- one grouped pass over the rows that match, never a per-branch or per-stage
-- subquery repeated inside a series, so cost tracks matched rows rather than the
-- number of branches or stages being reported on.

-- Branch scope is resolved identically by all three. The existing dashboard
-- inlines this as a CTE; extracting it here avoids a third and fourth copy
-- drifting out of step, and deliberately does not touch that function.
create or replace function app_private.actor_branch_scope(target_organization_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct branch_row.id), array[]::uuid[])
  from public.branches branch_row
  where branch_row.organization_id = target_organization_id
    and branch_row.active
    and branch_row.deleted_at is null
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      where assignment_row.organization_id = target_organization_id
        and assignment_row.user_id = auth.uid()
        and assignment_row.active
        and (
          assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
          or (assignment_row.data_scope = 'ONE_BRANCH'
            and assignment_row.scope_branch_id = branch_row.id)
          or (assignment_row.data_scope = 'SELECTED_BRANCHES'
            and branch_row.id = any(
              coalesce(assignment_row.selected_branch_ids, array[]::uuid[])))
          or exists (
            select 1 from public.user_branch_access access_row
            where access_row.organization_id = target_organization_id
              and access_row.user_id = auth.uid()
              and access_row.branch_id = branch_row.id
          )
        )
    )
$$;

create or replace function app_private.assert_owner_overview_access()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'OWNER_OVERVIEW_ACCESS_REQUIRED';
  end if;
  return current_organization_id;
end;
$$;

-- Sales Overview: where the pipeline actually stands, by stage, by source and
-- by the people working it.
create or replace function public.get_business_sales_overview(target_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  scope uuid[];
  window_start timestamptz;
begin
  current_organization_id := app_private.assert_owner_overview_access();
  if target_days not between 1 and 365 then
    raise exception using errcode = '22023', message = 'INVALID_OVERVIEW_WINDOW';
  end if;
  scope := app_private.actor_branch_scope(current_organization_id);
  window_start := now() - make_interval(days => target_days);

  return jsonb_build_object(
    'window_days', target_days,
    -- One grouped pass per shape, not one query per stage.
    'pipeline', coalesce((
      select jsonb_agg(jsonb_build_object('stage', stage, 'leads', total) order by total desc)
      from (
        select lead_row.lifecycle_status::text as stage, count(*)::integer as total
        from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.deleted_at is null
          and lead_row.branch_id = any(scope)
          and lead_row.created_at >= window_start
        group by lead_row.lifecycle_status
      ) stage_rows
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('source', source, 'leads', total) order by total desc)
      from (
        select lead_row.source, count(*)::integer as total
        from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.deleted_at is null
          and lead_row.branch_id = any(scope)
          and lead_row.created_at >= window_start
        group by lead_row.source
      ) source_rows
    ), '[]'::jsonb),
    'consultants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', coalesce(profile_row.full_name, 'Unassigned'),
        'leads', consultant_rows.total,
        'won', consultant_rows.won
      ) order by consultant_rows.total desc)
      from (
        select lead_row.assigned_user_id,
          count(*)::integer as total,
          count(*) filter (
            where lead_row.lifecycle_status = 'Transferred to Sales'
          )::integer as won
        from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.deleted_at is null
          and lead_row.branch_id = any(scope)
          and lead_row.created_at >= window_start
        group by lead_row.assigned_user_id
        order by count(*) desc
        limit 10
      ) consultant_rows
      left join public.profiles profile_row on profile_row.id = consultant_rows.assigned_user_id
    ), '[]'::jsonb),
    'totals', (
      select jsonb_build_object(
        'leads', count(*)::integer,
        'lost', count(*) filter (where lead_row.lifecycle_status = 'Lost')::integer,
        'transferred',
          count(*) filter (where lead_row.lifecycle_status = 'Transferred to Sales')::integer
      )
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and lead_row.branch_id = any(scope)
        and lead_row.created_at >= window_start
    )
  );
end;
$$;

-- Showroom Performance: the same measures side by side per branch, which is the
-- comparison the tenant dashboard cannot show because it reports one total.
create or replace function public.get_business_showroom_performance(
  target_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  scope uuid[];
  window_start timestamptz;
begin
  current_organization_id := app_private.assert_owner_overview_access();
  if target_days not between 1 and 365 then
    raise exception using errcode = '22023', message = 'INVALID_OVERVIEW_WINDOW';
  end if;
  scope := app_private.actor_branch_scope(current_organization_id);
  window_start := now() - make_interval(days => target_days);

  -- Each measure is aggregated once and joined onto the branch list. The
  -- alternative -- a count per branch inside the select list -- would re-scan
  -- every table once per branch.
  return jsonb_build_object(
    'window_days', target_days,
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'branch_id', branch_row.id,
        'branch', branch_row.name,
        'leads', coalesce(lead_totals.total, 0),
        'transferred', coalesce(lead_totals.transferred, 0),
        'test_drives', coalesce(test_drive_totals.total, 0),
        'bookings', coalesce(booking_totals.total, 0)
      ) order by coalesce(lead_totals.total, 0) desc, branch_row.name)
      from public.branches branch_row
      left join (
        select lead_row.branch_id, count(*)::integer as total,
          count(*) filter (
            where lead_row.lifecycle_status = 'Transferred to Sales'
          )::integer as transferred
        from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.deleted_at is null
          and lead_row.created_at >= window_start
        group by lead_row.branch_id
      ) lead_totals on lead_totals.branch_id = branch_row.id
      left join (
        select drive_row.branch_id, count(*)::integer as total
        from public.test_drives drive_row
        where drive_row.organization_id = current_organization_id
          and drive_row.created_at >= window_start
        group by drive_row.branch_id
      ) test_drive_totals on test_drive_totals.branch_id = branch_row.id
      left join (
        select booking_row.branch_id, count(*)::integer as total
        from public.bookings booking_row
        where booking_row.organization_id = current_organization_id
          and booking_row.created_at >= window_start
        group by booking_row.branch_id
      ) booking_totals on booking_totals.branch_id = branch_row.id
      where branch_row.organization_id = current_organization_id
        and branch_row.id = any(scope)
        and branch_row.deleted_at is null
    ), '[]'::jsonb)
  );
end;
$$;

-- Operations Overview: the five departmental queues in one place. The tenant
-- dashboard reports a single "open cases" number; an owner needs to see which
-- desk the backlog is actually on.
--
-- Counted by the status values actually present rather than against a hardcoded
-- list of terminal states. These tables carry no status CHECK constraint, so a
-- guessed terminal value would miscount silently instead of failing; grouping
-- keeps the report honest if a new status is ever introduced.
create or replace function public.get_business_operations_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  scope uuid[];
begin
  current_organization_id := app_private.assert_owner_overview_access();
  scope := app_private.actor_branch_scope(current_organization_id);

  return jsonb_build_object(
    'closed_statuses', to_jsonb(array['DISBURSED', 'POLICY_ISSUED', 'REGISTERED',
      'COMPLETED', 'DELIVERED', 'CANCELLED', 'REJECTED']),
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'department', department_rows.department,
        'total', department_rows.total,
        'open', department_rows.open,
        'statuses', department_rows.statuses
      ) order by department_rows.open desc, department_rows.department)
      from (
        select
          case_rows.department,
          count(*)::integer as total,
          count(*) filter (
            where case_rows.status not in ('DISBURSED', 'POLICY_ISSUED', 'REGISTERED',
              'COMPLETED', 'DELIVERED', 'CANCELLED', 'REJECTED')
          )::integer as open,
          -- Grouped once per department/status pair.
          (
            select jsonb_agg(jsonb_build_object('status', inner_rows.status,
              'count', inner_rows.total) order by inner_rows.total desc)
            from (
              select status, count(*)::integer as total
              from unnest(array_agg(case_rows.status)) as status
              group by status
            ) inner_rows
          ) as statuses
        from (
          select 'Finance' as department, row_data.status, row_data.branch_id
            from public.finance_cases row_data
            where row_data.organization_id = current_organization_id
          union all
          select 'Insurance', row_data.status, row_data.branch_id
            from public.insurance_cases row_data
            where row_data.organization_id = current_organization_id
          union all
          select 'RTO', row_data.status, row_data.branch_id
            from public.rto_cases row_data
            where row_data.organization_id = current_organization_id
          union all
          select 'Exchange', row_data.status, row_data.branch_id
            from public.exchange_cases row_data
            where row_data.organization_id = current_organization_id
          union all
          select 'Delivery', row_data.status, row_data.branch_id
            from public.delivery_cases row_data
            where row_data.organization_id = current_organization_id
        ) case_rows
        where case_rows.branch_id = any(scope)
        group by case_rows.department
      ) department_rows
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function app_private.actor_branch_scope(uuid) from public, anon, authenticated;
revoke all on function app_private.assert_owner_overview_access() from public, anon, authenticated;
revoke all on function public.get_business_sales_overview(integer) from public, anon;
grant execute on function public.get_business_sales_overview(integer) to authenticated;
revoke all on function public.get_business_showroom_performance(integer) from public, anon;
grant execute on function public.get_business_showroom_performance(integer) to authenticated;
revoke all on function public.get_business_operations_overview() from public, anon;
grant execute on function public.get_business_operations_overview() to authenticated;
