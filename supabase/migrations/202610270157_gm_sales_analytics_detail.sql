-- GM Sales Analytics (PRD 54.5 §3-7).
--
-- Sales Consultant Ranking listed telecallers at 0% conversion; it now ranks
-- consultants only. Model performance had lead interest alone; each model now
-- carries the period's test drives, quotations and bookings (credited to the
-- model the enquiry asked for), lost leads, and available / incoming stock when
-- the caller may check stock. Branches gain lost leads for Showroom comparison,
-- and the KPIs gain contacted and qualified so the funnel follows the PRD's
-- stages.
-- GM Targets took 1.2-1.4 s: can_access_record ran once per booking and test
-- drive. Branches fully visible to the caller are now resolved once and rows
-- there skip the per-record check; results are identical (same md5 for the
-- demo GM, current and previous month), 53 ms warm.
-- Bodies are the deployed definitions with anchored edits.

begin;

CREATE OR REPLACE FUNCTION public.get_gm_sales_analytics_workspace(target_days integer DEFAULT 30, target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  stock_branch_ids uuid[] := array[]::uuid[];
  result jsonb;
begin
  if target_days is null or target_days < 1 or target_days > 9999
    or target_timezone is null or target_timezone !~ '^(Asia/Kolkata|UTC)(\|[0-9]{4}-[0-9]{2}-[0-9]{2})?$'
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
  -- Stock beside model demand is read-only and only for callers who may check stock.
  stock_branch_ids := app_private.permission_bound_active_branch_ids(
    current_organization_id,
    array['inventory.view', 'inventory.stock_check']::text[]
  );

  local_today := coalesce(nullif(split_part(target_timezone, '|', 2), '')::date, timezone(split_part(target_timezone, '|', 1), now())::date); target_timezone := split_part(target_timezone, '|', 1);
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
      lead_row.id,
      lead_row.branch_id,
      lead_row.assigned_user_id,
      coalesce(nullif(btrim(lead_row.interested_model), ''), 'Not specified') as model_name,
      timezone(target_timezone, lead_row.created_at)::date as metric_day,
      lead_row.first_contacted_at is not null as contacted,
      lead_row.lifecycle_status = 'Lost' as lost,
      -- Reached qualification: there now, or history says so (a later loss keeps it).
      (lead_row.lifecycle_status in ('Qualified', 'Appointment Scheduled', 'Transferred to Sales')
        or exists (
          select 1 from public.lead_stage_history history_row
          where history_row.organization_id = current_organization_id
            and history_row.lead_id = lead_row.id
            and history_row.to_status in ('Qualified', 'Transferred to Sales')
        )) as qualified
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
  ), lead_funnel as (
    select
      count(*) filter (where contacted)::bigint as contacted,
      count(*) filter (where qualified)::bigint as qualified
    from scoped_leads
  ), lead_branch_lost as (
    select branch_id, count(*) filter (where lost)::bigint as lost
    from scoped_leads
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
    select drive_row.branch_id, drive_row.assigned_user_id, drive_row.lead_id
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
    select quotation_row.branch_id, quotation_row.assigned_user_id, quotation_row.lead_id
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
      booking_row.lead_id,
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
      coalesce(booking_row.bookings, 0)::bigint as bookings,
      coalesce(lost_row.lost, 0)::bigint as lost
    from accessible_branches branch_row
    left join lead_branch_stats lead_row on lead_row.branch_id = branch_row.id
    left join lead_branch_lost lost_row on lost_row.branch_id = branch_row.id
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
      -- Sales Consultant Ranking: telecallers hand leads on and are compared elsewhere.
      and member_row.member_type = 'SALES_CONSULTANT'
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
  ), model_activity as (
    -- Drives, quotations and bookings in the period, credited to the model their
    -- enquiry asked for (the lead may predate the period).
    select coalesce(nullif(btrim(lead_row.interested_model), ''), 'Not specified') as model_name,
      activity_row.kind
    from (
      select lead_id, 'drive'::text as kind from scoped_drives
      union all select lead_id, 'quotation' from scoped_quotations
      union all select lead_id, 'booking' from scoped_bookings
    ) activity_row
    join public.leads lead_row
      on lead_row.id = activity_row.lead_id
     and lead_row.organization_id = current_organization_id
  ), model_activity_stats as (
    select model_name,
      count(*) filter (where kind = 'drive')::bigint as test_drives,
      count(*) filter (where kind = 'quotation')::bigint as quotations,
      count(*) filter (where kind = 'booking')::bigint as bookings
    from model_activity
    group by model_name
  ), model_lost_stats as (
    select model_name, count(*) filter (where lost)::bigint as lost
    from scoped_leads
    group by model_name
  ), model_stock_stats as (
    select lower(model_row.name) as model_key,
      count(*) filter (where stock_row.status = 'AVAILABLE')::bigint as available,
      count(*) filter (where stock_row.status in ('INCOMING', 'IN_TRANSIT'))::bigint as incoming
    from public.stock_units stock_row
    join public.vehicle_variants variant_row on variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row on model_row.id = variant_row.model_id
    where stock_row.organization_id = current_organization_id
      and stock_row.deleted_at is null
      and stock_row.branch_id = any(stock_branch_ids)
    group by lower(model_row.name)
  ), model_stats as materialized (
    select lead_model_row.model_name as name, lead_model_row.metric_count as leads,
      coalesce(activity_row.test_drives, 0)::bigint as test_drives,
      coalesce(activity_row.quotations, 0)::bigint as quotations,
      coalesce(activity_row.bookings, 0)::bigint as bookings,
      coalesce(lost_row.lost, 0)::bigint as lost,
      stock_row.available,
      stock_row.incoming
    from lead_rollups lead_model_row
    left join model_activity_stats activity_row on activity_row.model_name = lead_model_row.model_name
    left join model_lost_stats lost_row on lost_row.model_name = lead_model_row.model_name
    left join model_stock_stats stock_row on stock_row.model_key = lower(lead_model_row.model_name)
    where lead_model_row.branch_group = 1
      and lead_model_row.owner_group = 1
      and lead_model_row.model_group = 0
      and lead_model_row.day_group = 1
    order by lead_model_row.metric_count desc, lead_model_row.model_name
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
    'stock_visible', cardinality(stock_branch_ids) > 0,
    'kpis', jsonb_build_object(
      'leads', total_row.leads,
      'contacted', (select contacted from lead_funnel),
      'qualified', (select qualified from lead_funnel),
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
          'lost', branch_row.lost,
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
        jsonb_build_object(
          'name', model_row.name,
          'leads', model_row.leads,
          'test_drives', model_row.test_drives,
          'quotations', model_row.quotations,
          'bookings', model_row.bookings,
          'lost', model_row.lost,
          'available', model_row.available,
          'incoming', model_row.incoming
        )
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
$function$;

CREATE OR REPLACE FUNCTION public.get_gm_target_workspace(target_month date DEFAULT (date_trunc('month'::text, timezone('Asia/Kolkata'::text, now())))::date, target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  access_context jsonb;
  current_organization_id uuid;
  local_today date;
  month_start date;
  month_end date;
  range_start timestamptz;
  range_end timestamptz;
  branch_wide_ids uuid[];
begin
  if target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_GM_TARGET_TIMEZONE';
  end if;

  access_context := public.get_access_context();
  if auth.uid() is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'gm-sales'
    or access_context->>'organization_id' is null
    or not app_private.has_permission((access_context->>'organization_id')::uuid, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'GM_TARGET_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  local_today := timezone(target_timezone, now())::date;
  month_start := date_trunc('month', target_month)::date;
  month_end := (month_start + interval '1 month')::date;
  if target_month <> month_start
    or month_start < date_trunc('month', local_today - interval '12 months')::date
    or month_start > date_trunc('month', local_today + interval '12 months')::date
  then
    raise exception using errcode = '22023', message = 'INVALID_GM_TARGET_MONTH';
  end if;

  range_start := timezone(target_timezone, month_start::timestamp);
  range_end := timezone(target_timezone, month_end::timestamp);
  -- Branches where every record is visible: can_access_record with no team and
  -- no owner passes only through branch-wide scope (or a support session), and
  -- then passes for any team or owner in that branch. Rows elsewhere still go
  -- through the per-record check, so own-team / own-record scopes are unchanged.
  select coalesce(array_agg(branch_row.id), array[]::uuid[])
    into branch_wide_ids
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and app_private.can_access_record(current_organization_id, branch_row.id, null, null);

  return (
    with accessible_branches as materialized (
      select branch_row.id, branch_row.name
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
        and app_private.can_access_branch(current_organization_id, branch_row.id)
    ), branch_targets as materialized (
      select target_row.branch_id,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('SALES_VALUE', 'SALES_AMOUNT', 'REVENUE')), 0)::numeric as sales_target,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('BOOKINGS', 'SALES_BOOKINGS')), 0)::numeric as booking_target,
        coalesce(sum(target_row.target_value) filter (where upper(target_row.metric) in ('TEST_DRIVES', 'TEST_DRIVE')), 0)::numeric as drive_target
      from public.targets target_row
      join accessible_branches branch_row on branch_row.id = target_row.branch_id
      where target_row.organization_id = current_organization_id
        and target_row.team_id is null
        and target_row.user_id is null
        and target_row.period_start <= month_start
        and target_row.period_end >= month_end - 1
      group by target_row.branch_id
    ), branch_bookings as materialized (
      select booking_row.branch_id,
        coalesce(sum(coalesce(booking_row.total_value, booking_row.booking_amount)), 0)::numeric as sales_value,
        count(*)::bigint as bookings
      from public.bookings booking_row
      join accessible_branches branch_row on branch_row.id = booking_row.branch_id
      where booking_row.organization_id = current_organization_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start
        and booking_row.created_at < range_end
        and case when booking_row.branch_id = any(branch_wide_ids) then true
          else app_private.can_access_record(
            booking_row.organization_id, booking_row.branch_id, booking_row.team_id, booking_row.assigned_user_id
          ) end
      group by booking_row.branch_id
    ), branch_drives as materialized (
      select drive_row.branch_id, count(*)::bigint as test_drives
      from public.test_drive_appointments drive_row
      join accessible_branches branch_row on branch_row.id = drive_row.branch_id
      where drive_row.organization_id = current_organization_id
        and drive_row.status <> 'CANCELLED'
        and drive_row.scheduled_at >= range_start
        and drive_row.scheduled_at < range_end
        and case when drive_row.branch_id = any(branch_wide_ids) then true
          else app_private.can_access_record(
            drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
          ) end
      group by drive_row.branch_id
    ), branch_rows as (
      select branch_row.id, branch_row.name,
        coalesce(target_row.sales_target, 0)::numeric as sales_target,
        coalesce(booking_row.sales_value, 0)::numeric as sales_value,
        coalesce(target_row.booking_target, 0)::numeric as booking_target,
        coalesce(booking_row.bookings, 0)::bigint as bookings,
        coalesce(target_row.drive_target, 0)::numeric as drive_target,
        coalesce(drive_row.test_drives, 0)::bigint as test_drives
      from accessible_branches branch_row
      left join branch_targets target_row on target_row.branch_id = branch_row.id
      left join branch_bookings booking_row on booking_row.branch_id = branch_row.id
      left join branch_drives drive_row on drive_row.branch_id = branch_row.id
    )
    select jsonb_build_object(
      'month', month_start,
      'kpis', jsonb_build_object(
        'sales_target', coalesce((select sum(sales_target) from branch_rows), 0),
        'sales_value', coalesce((select sum(sales_value) from branch_rows), 0),
        'booking_target', coalesce((select sum(booking_target) from branch_rows), 0),
        'bookings', coalesce((select sum(bookings) from branch_rows), 0),
        'drive_target', coalesce((select sum(drive_target) from branch_rows), 0),
        'test_drives', coalesce((select sum(test_drives) from branch_rows), 0)
      ),
      'branches', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'sales_target', sales_target, 'sales_value', sales_value,
        'booking_target', booking_target, 'bookings', bookings,
        'drive_target', drive_target, 'test_drives', test_drives
      ) order by sales_value desc, bookings desc, name) from branch_rows), '[]'::jsonb)
    )
  );
end;
$function$;

commit;
