-- Keep GM analytics bounded and set-based at 100k-lead scale. Scope is
-- resolved once from active assignments that actually grant each permission;
-- a separate assignment must not be able to widen another role's permission.

begin;

create or replace function app_private.permission_bound_active_branch_ids(
  target_organization_id uuid,
  target_permission_keys text[]
)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  with permitted_assignments as materialized (
    select
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    from public.user_role_assignments assignment_row
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and assignment_row.data_scope in (
        'ONE_BRANCH',
        'SELECTED_BRANCHES',
        'ALL_BRANCHES',
        'ORGANIZATION'
      )
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
  ), resolved_branches as (
    select branch_row.id
    from public.branches branch_row
    where branch_row.organization_id = target_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and exists (
        select 1
        from permitted_assignments assignment_row
        where assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
          or (
            assignment_row.data_scope = 'ONE_BRANCH'
            and branch_row.id = assignment_row.scope_branch_id
          )
          or (
            assignment_row.data_scope = 'SELECTED_BRANCHES'
            and branch_row.id = any(
              coalesce(assignment_row.selected_branch_ids, array[]::uuid[])
            )
          )
      )
  )
  select coalesce(
    array_agg(branch_row.id order by branch_row.id),
    array[]::uuid[]
  )
  from resolved_branches branch_row;
$$;

revoke all on function app_private.permission_bound_active_branch_ids(uuid, text[])
  from public, anon, authenticated;

create or replace function public.get_gm_sales_analytics_workspace(
  target_days integer default 30,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  local_today date;
  start_day date;
  range_start timestamptz;
  range_end timestamptz;
  has_supported_lead_scope boolean;
  lead_branch_ids uuid[] := array[]::uuid[];
  call_branch_ids uuid[] := array[]::uuid[];
  test_drive_branch_ids uuid[] := array[]::uuid[];
  quotation_branch_ids uuid[] := array[]::uuid[];
  booking_branch_ids uuid[] := array[]::uuid[];
  result jsonb;
begin
  if target_days not in (7, 14, 30)
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_GM_SALES_ANALYTICS_QUERY';
  end if;

  access_context := public.get_access_context();
  if auth.uid() is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'gm-sales'
    or access_context->>'organization_id' is null
  then
    raise exception using
      errcode = '42501',
      message = 'GM_SALES_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;

  -- GM analytics intentionally supports only branch-wide scopes. OWN_TEAM and
  -- OWN_RECORDS cannot be widened into branch analytics and therefore fail
  -- closed when no permission-bearing branch scope is present.
  select exists (
    select 1
    from public.user_role_assignments assignment_row
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and assignment_row.data_scope in (
        'ONE_BRANCH',
        'SELECTED_BRANCHES',
        'ALL_BRANCHES',
        'ORGANIZATION'
      )
      and exists (
        select 1
        from public.role_permissions role_permission_row
        join public.permissions permission_row
          on permission_row.id = role_permission_row.permission_id
        where role_permission_row.role_id = assignment_row.role_id
          and permission_row.permission_key = 'lead.view'
      )
  ) into has_supported_lead_scope;

  if not has_supported_lead_scope then
    raise exception using
      errcode = '42501',
      message = 'GM_SALES_BRANCH_SCOPE_REQUIRED';
  end if;

  lead_branch_ids := app_private.permission_bound_active_branch_ids(
    current_organization_id,
    array['lead.view']::text[]
  );
  call_branch_ids := app_private.permission_bound_active_branch_ids(
    current_organization_id,
    array['call.view']::text[]
  );
  test_drive_branch_ids := app_private.permission_bound_active_branch_ids(
    current_organization_id,
    array['test_drive.view', 'test_drive.manage']::text[]
  );
  quotation_branch_ids := app_private.permission_bound_active_branch_ids(
    current_organization_id,
    array['quotation.view', 'quotation.manage']::text[]
  );
  booking_branch_ids := app_private.permission_bound_active_branch_ids(
    current_organization_id,
    array['booking.view', 'booking.manage']::text[]
  );

  local_today := timezone(target_timezone, now())::date;
  start_day := local_today - (target_days - 1);
  range_start := timezone(target_timezone, start_day::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);

  with accessible_branches as materialized (
    select branch_row.id, branch_row.name
    from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and branch_row.id = any(lead_branch_ids)
  ), scoped_leads as materialized (
    select
      lead_row.branch_id,
      lead_row.assigned_user_id,
      coalesce(nullif(btrim(lead_row.interested_model), ''), 'Not specified') as model_name,
      timezone(target_timezone, lead_row.created_at)::date as metric_day
    from public.leads lead_row
    join accessible_branches branch_row on branch_row.id = lead_row.branch_id
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.created_at >= range_start
      and lead_row.created_at < range_end
  ), lead_rollups as materialized (
    select
      lead_row.branch_id,
      lead_row.assigned_user_id,
      lead_row.model_name,
      lead_row.metric_day,
      grouping(lead_row.branch_id) as branch_group,
      grouping(lead_row.assigned_user_id) as owner_group,
      grouping(lead_row.model_name) as model_group,
      grouping(lead_row.metric_day) as day_group,
      count(*)::bigint as metric_count
    from scoped_leads lead_row
    group by grouping sets (
      (lead_row.branch_id, lead_row.assigned_user_id),
      (lead_row.model_name),
      (lead_row.metric_day)
    )
  ), lead_assignment_stats as materialized (
    select branch_id, assigned_user_id, metric_count as leads
    from lead_rollups
    where branch_group = 0
      and owner_group = 0
      and model_group = 1
      and day_group = 1
  ), lead_branch_stats as (
    select branch_id, sum(leads)::bigint as leads
    from lead_assignment_stats
    group by branch_id
  ), scoped_calls as materialized (
    select call_row.branch_id, call_row.assigned_user_id
    from public.calls call_row
    join accessible_branches branch_row on branch_row.id = call_row.branch_id
    where call_row.organization_id = current_organization_id
      and call_row.branch_id = any(call_branch_ids)
      and call_row.started_at >= range_start
      and call_row.started_at < range_end
  ), call_assignment_stats as materialized (
    select branch_id, assigned_user_id, count(*)::bigint as calls
    from scoped_calls
    group by branch_id, assigned_user_id
  ), call_branch_stats as (
    select branch_id, sum(calls)::bigint as calls
    from call_assignment_stats
    group by branch_id
  ), scoped_drives as materialized (
    select drive_row.branch_id, drive_row.assigned_user_id
    from public.test_drive_appointments drive_row
    join accessible_branches branch_row on branch_row.id = drive_row.branch_id
    where drive_row.organization_id = current_organization_id
      and drive_row.branch_id = any(test_drive_branch_ids)
      and drive_row.status <> 'CANCELLED'
      and drive_row.scheduled_at >= range_start
      and drive_row.scheduled_at < range_end
  ), drive_assignment_stats as materialized (
    select branch_id, assigned_user_id, count(*)::bigint as test_drives
    from scoped_drives
    group by branch_id, assigned_user_id
  ), drive_branch_stats as (
    select branch_id, sum(test_drives)::bigint as test_drives
    from drive_assignment_stats
    group by branch_id
  ), scoped_quotations as materialized (
    select quotation_row.branch_id, quotation_row.assigned_user_id
    from public.quotations quotation_row
    join accessible_branches branch_row on branch_row.id = quotation_row.branch_id
    where quotation_row.organization_id = current_organization_id
      and quotation_row.branch_id = any(quotation_branch_ids)
      and quotation_row.deleted_at is null
      and quotation_row.created_at >= range_start
      and quotation_row.created_at < range_end
  ), quotation_assignment_stats as materialized (
    select branch_id, assigned_user_id, count(*)::bigint as quotations
    from scoped_quotations
    group by branch_id, assigned_user_id
  ), quotation_branch_stats as (
    select branch_id, sum(quotations)::bigint as quotations
    from quotation_assignment_stats
    group by branch_id
  ), scoped_bookings as materialized (
    select
      booking_row.branch_id,
      booking_row.assigned_user_id,
      timezone(target_timezone, booking_row.created_at)::date as metric_day
    from public.bookings booking_row
    join accessible_branches branch_row on branch_row.id = booking_row.branch_id
    where booking_row.organization_id = current_organization_id
      and booking_row.branch_id = any(booking_branch_ids)
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= range_start
      and booking_row.created_at < range_end
  ), booking_rollups as materialized (
    select
      booking_row.branch_id,
      booking_row.assigned_user_id,
      booking_row.metric_day,
      grouping(booking_row.branch_id) as branch_group,
      grouping(booking_row.assigned_user_id) as owner_group,
      grouping(booking_row.metric_day) as day_group,
      count(*)::bigint as metric_count
    from scoped_bookings booking_row
    group by grouping sets (
      (booking_row.branch_id, booking_row.assigned_user_id),
      (booking_row.metric_day)
    )
  ), booking_assignment_stats as materialized (
    select branch_id, assigned_user_id, metric_count as bookings
    from booking_rollups
    where branch_group = 0
      and owner_group = 0
      and day_group = 1
  ), booking_branch_stats as (
    select branch_id, sum(bookings)::bigint as bookings
    from booking_assignment_stats
    group by branch_id
  ), branch_stats as materialized (
    select
      branch_row.id,
      branch_row.name,
      coalesce(lead_row.leads, 0)::bigint as leads,
      coalesce(call_row.calls, 0)::bigint as calls,
      coalesce(drive_row.test_drives, 0)::bigint as test_drives,
      coalesce(quotation_row.quotations, 0)::bigint as quotations,
      coalesce(booking_row.bookings, 0)::bigint as bookings
    from accessible_branches branch_row
    left join lead_branch_stats lead_row on lead_row.branch_id = branch_row.id
    left join call_branch_stats call_row on call_row.branch_id = branch_row.id
    left join drive_branch_stats drive_row on drive_row.branch_id = branch_row.id
    left join quotation_branch_stats quotation_row on quotation_row.branch_id = branch_row.id
    left join booking_branch_stats booking_row on booking_row.branch_id = branch_row.id
  ), consultants as materialized (
    select distinct
      member_row.user_id,
      team_row.branch_id,
      profile_row.full_name
    from public.team_members member_row
    join public.teams team_row
      on team_row.organization_id = member_row.organization_id
     and team_row.id = member_row.team_id
     and team_row.active
    join accessible_branches branch_row on branch_row.id = team_row.branch_id
    join public.profiles profile_row
      on profile_row.organization_id = member_row.organization_id
     and profile_row.id = member_row.user_id
     and profile_row.active
     and profile_row.deleted_at is null
    where member_row.organization_id = current_organization_id
      and member_row.active
      and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
  ), consultant_stats_unbounded as (
    select
      consultant_row.user_id,
      consultant_row.full_name,
      consultant_row.branch_id,
      branch_row.name as branch_name,
      coalesce(lead_row.leads, 0)::bigint as leads,
      coalesce(call_row.calls, 0)::bigint as calls,
      coalesce(drive_row.test_drives, 0)::bigint as test_drives,
      coalesce(quotation_row.quotations, 0)::bigint as quotations,
      coalesce(booking_row.bookings, 0)::bigint as bookings
    from consultants consultant_row
    join accessible_branches branch_row on branch_row.id = consultant_row.branch_id
    left join lead_assignment_stats lead_row
      on lead_row.branch_id = consultant_row.branch_id
     and lead_row.assigned_user_id = consultant_row.user_id
    left join call_assignment_stats call_row
      on call_row.branch_id = consultant_row.branch_id
     and call_row.assigned_user_id = consultant_row.user_id
    left join drive_assignment_stats drive_row
      on drive_row.branch_id = consultant_row.branch_id
     and drive_row.assigned_user_id = consultant_row.user_id
    left join quotation_assignment_stats quotation_row
      on quotation_row.branch_id = consultant_row.branch_id
     and quotation_row.assigned_user_id = consultant_row.user_id
    left join booking_assignment_stats booking_row
      on booking_row.branch_id = consultant_row.branch_id
     and booking_row.assigned_user_id = consultant_row.user_id
  ), consultant_stats as materialized (
    select
      user_id,
      full_name,
      branch_id,
      branch_name,
      leads,
      calls,
      test_drives,
      quotations,
      bookings
    from consultant_stats_unbounded
    order by
      bookings desc,
      quotations desc,
      calls desc,
      full_name,
      user_id,
      branch_id
    limit 100
  ), model_stats as materialized (
    select model_name as name, metric_count as leads
    from lead_rollups
    where branch_group = 1
      and owner_group = 1
      and model_group = 0
      and day_group = 1
    order by metric_count desc, model_name
    limit 100
  ), daily_stats as (
    select metric_day, metric_count as leads
    from lead_rollups
    where branch_group = 1
      and owner_group = 1
      and model_group = 1
      and day_group = 0
  ), booking_daily_stats as (
    select metric_day, metric_count as bookings
    from booking_rollups
    where branch_group = 1
      and owner_group = 1
      and day_group = 0
  ), kpi_totals as (
    select
      coalesce(sum(leads), 0)::bigint as leads,
      coalesce(sum(calls), 0)::bigint as calls,
      coalesce(sum(test_drives), 0)::bigint as test_drives,
      coalesce(sum(quotations), 0)::bigint as quotations,
      coalesce(sum(bookings), 0)::bigint as bookings
    from branch_stats
  )
  select jsonb_build_object(
    'days', target_days,
    'generated_at', now(),
    'kpis', jsonb_build_object(
      'leads', total_row.leads,
      'calls', total_row.calls,
      'test_drives', total_row.test_drives,
      'quotations', total_row.quotations,
      'bookings', total_row.bookings,
      'conversion', case
        when total_row.leads > 0
          then round(total_row.bookings::numeric * 100 / total_row.leads, 2)
        else 0
      end
    ),
    'branches', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', branch_row.id,
          'name', branch_row.name,
          'leads', branch_row.leads,
          'calls', branch_row.calls,
          'test_drives', branch_row.test_drives,
          'quotations', branch_row.quotations,
          'bookings', branch_row.bookings,
          'conversion', case
            when branch_row.leads > 0
              then round(branch_row.bookings::numeric * 100 / branch_row.leads, 2)
            else 0
          end
        ) order by
          branch_row.bookings desc,
          branch_row.leads desc,
          branch_row.name,
          branch_row.id
      )
      from branch_stats branch_row
    ), '[]'::jsonb),
    'consultants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', consultant_row.user_id,
          'full_name', consultant_row.full_name,
          'branch_name', consultant_row.branch_name,
          'leads', consultant_row.leads,
          'calls', consultant_row.calls,
          'test_drives', consultant_row.test_drives,
          'quotations', consultant_row.quotations,
          'bookings', consultant_row.bookings,
          'conversion', case
            when consultant_row.leads > 0
              then round(consultant_row.bookings::numeric * 100 / consultant_row.leads, 2)
            else 0
          end
        ) order by
          consultant_row.bookings desc,
          consultant_row.quotations desc,
          consultant_row.calls desc,
          consultant_row.full_name,
          consultant_row.user_id,
          consultant_row.branch_id
      )
      from consultant_stats consultant_row
    ), '[]'::jsonb),
    'models', coalesce((
      select jsonb_agg(
        jsonb_build_object('name', model_row.name, 'leads', model_row.leads)
        order by model_row.leads desc, model_row.name
      )
      from model_stats model_row
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', to_char(day_row.metric_day, 'DD Mon'),
          'leads', coalesce(lead_daily_row.leads, 0),
          'bookings', coalesce(booking_daily_row.bookings, 0)
        ) order by day_row.metric_day
      )
      from generate_series(
        start_day::timestamp,
        local_today::timestamp,
        interval '1 day'
      ) day_source(day_timestamp)
      cross join lateral (
        select day_source.day_timestamp::date as metric_day
      ) day_row
      left join daily_stats lead_daily_row
        on lead_daily_row.metric_day = day_row.metric_day
      left join booking_daily_stats booking_daily_row
        on booking_daily_row.metric_day = day_row.metric_day
    ), '[]'::jsonb)
  ) into result
  from kpi_totals total_row;

  return result;
end;
$$;

revoke all on function public.get_gm_sales_analytics_workspace(integer, text)
  from public, anon;
grant execute on function public.get_gm_sales_analytics_workspace(integer, text)
  to authenticated;

commit;
