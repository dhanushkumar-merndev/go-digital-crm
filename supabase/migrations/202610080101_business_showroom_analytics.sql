begin;

-- Showroom Performance for the Business Owner: every per-showroom analytic on
-- one page, and the current-month unit-target attainment that used to sit on
-- its own Targets & Performance page.
--
-- One call returns the whole page. Each scoped set (leads, calls, test drives,
-- quotations, bookings, deliveries) is read once into a materialized CTE and
-- grouped by branch once; the branch list then joins those groups. A count per
-- branch inside the select list would re-scan every table once per branch.
create or replace function public.get_business_showroom_analytics(
  target_days integer default 30,
  target_timezone text default 'Asia/Kolkata',
  target_branch_id uuid default null
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
  focus_scope uuid[];
  local_today date;
  start_day date;
  range_start timestamptz;
  range_end timestamptz;
  month_start date;
  month_end date;
  month_range_start timestamptz;
  month_range_end timestamptz;
begin
  current_organization_id := app_private.assert_owner_overview_access();
  if target_days not in (7, 30, 90) or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_OVERVIEW_WINDOW';
  end if;
  scope := app_private.actor_branch_scope(current_organization_id);
  if target_branch_id is not null and not (target_branch_id = any(scope)) then
    raise exception using errcode = '42501', message = 'SHOWROOM_OUT_OF_SCOPE';
  end if;
  focus_scope := case when target_branch_id is null then scope else array[target_branch_id] end;

  local_today := timezone(target_timezone, now())::date;
  start_day := local_today - (target_days - 1);
  range_start := timezone(target_timezone, start_day::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);
  month_start := date_trunc('month', local_today)::date;
  month_end := (month_start + interval '1 month')::date;
  month_range_start := timezone(target_timezone, month_start::timestamp);
  month_range_end := timezone(target_timezone, month_end::timestamp);

  return (
    with branch_list as materialized (
      select branch_row.id, branch_row.name
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.id = any(scope)
        and branch_row.deleted_at is null
    ), scoped_leads as materialized (
      select lead_row.id, lead_row.branch_id, lead_row.created_at, lead_row.first_contacted_at,
        lead_row.lifecycle_status::text as lifecycle_status,
        coalesce(lead_row.temperature::text, 'UNRATED') as temperature,
        coalesce(nullif(btrim(lead_row.source), ''), 'Other') as source,
        coalesce(nullif(btrim(lead_row.interested_model), ''), 'Not specified') as model,
        coalesce(nullif(btrim(lead_row.lost_reason), ''), 'Not recorded') as lost_reason
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.branch_id = any(scope)
        and lead_row.deleted_at is null
        and lead_row.created_at >= range_start
        and lead_row.created_at < range_end
    ), scoped_calls as materialized (
      select call_row.branch_id, upper(coalesce(call_row.outcome, '')) = 'CONNECTED' as connected
      from public.calls call_row
      where call_row.organization_id = current_organization_id
        and call_row.branch_id = any(scope)
        and call_row.started_at >= range_start
        and call_row.started_at < range_end
    ), scoped_drives as materialized (
      select drive_row.branch_id, drive_row.status
      from public.test_drive_appointments drive_row
      where drive_row.organization_id = current_organization_id
        and drive_row.branch_id = any(scope)
        and drive_row.status <> 'CANCELLED'
        and drive_row.scheduled_at >= range_start
        and drive_row.scheduled_at < range_end
    ), scoped_quotations as materialized (
      select quotation_row.branch_id
      from public.quotations quotation_row
      where quotation_row.organization_id = current_organization_id
        and quotation_row.branch_id = any(scope)
        and quotation_row.deleted_at is null
        and quotation_row.created_at >= range_start
        and quotation_row.created_at < range_end
    ), scoped_bookings as materialized (
      select booking_row.branch_id, booking_row.lead_id, booking_row.created_at,
        coalesce(booking_row.total_value, booking_row.booking_amount, 0)::numeric as value
      from public.bookings booking_row
      where booking_row.organization_id = current_organization_id
        and booking_row.branch_id = any(scope)
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= range_start
        and booking_row.created_at < range_end
    ), open_deliveries as materialized (
      -- Pending delivery is a current snapshot, not windowed: a car still
      -- waiting is waiting regardless of when its case was opened.
      select delivery_row.branch_id,
        delivery_row.status = 'DELIVERED'
          and delivery_row.delivered_at >= range_start
          and delivery_row.delivered_at < range_end as delivered_in_window,
        delivery_row.status <> 'DELIVERED' as pending
      from public.delivery_cases delivery_row
      where delivery_row.organization_id = current_organization_id
        and delivery_row.branch_id = any(scope)
        and delivery_row.deleted_at is null
        and (
          delivery_row.status <> 'DELIVERED'
          or (delivery_row.delivered_at >= range_start and delivery_row.delivered_at < range_end)
        )
    ), lead_totals as (
      select branch_id,
        count(*)::bigint as leads,
        count(*) filter (where first_contacted_at is not null)::bigint as contacted,
        count(*) filter (where lifecycle_status = 'Transferred to Sales')::bigint as moved_to_sales,
        count(*) filter (where lifecycle_status = 'Lost')::bigint as lost,
        round(avg(extract(epoch from (first_contacted_at - created_at)) / 60)
          filter (where first_contacted_at >= created_at))::bigint as response_minutes,
        count(*) filter (where temperature = 'HOT')::bigint as hot,
        count(*) filter (where temperature = 'WARM')::bigint as warm,
        count(*) filter (where temperature = 'COLD')::bigint as cold,
        count(*) filter (where temperature = 'DORMANT')::bigint as dormant,
        count(*) filter (where temperature = 'UNRATED')::bigint as unrated
      from scoped_leads group by branch_id
    ), source_totals as (
      select branch_id, jsonb_object_agg(source, leads) as sources
      from (select branch_id, source, count(*)::bigint as leads from scoped_leads group by 1, 2) source_row
      group by branch_id
    ), call_totals as (
      select branch_id, count(*)::bigint as calls, count(*) filter (where connected)::bigint as connected
      from scoped_calls group by branch_id
    ), drive_totals as (
      select branch_id, count(*)::bigint as test_drives,
        count(*) filter (where status = 'COMPLETED')::bigint as completed_drives
      from scoped_drives group by branch_id
    ), quotation_totals as (
      select branch_id, count(*)::bigint as quotations from scoped_quotations group by branch_id
    ), booking_totals as (
      select branch_id, count(*)::bigint as bookings, sum(value)::numeric as booking_value
      from scoped_bookings group by branch_id
    ), delivery_totals as (
      select branch_id,
        count(*) filter (where delivered_in_window)::bigint as delivered,
        count(*) filter (where pending)::bigint as pending_delivery
      from open_deliveries group by branch_id
    ), target_totals as (
      -- Unit targets per model are what a Client Admin configures for each
      -- showroom and month; a showroom's target is the sum across its models.
      select target_row.branch_id, sum(target_row.target_units)::bigint as unit_target
      from public.branch_model_targets target_row
      where target_row.organization_id = current_organization_id
        and target_row.branch_id = any(scope)
        and target_row.month = month_start
      group by target_row.branch_id
    ), month_bookings as (
      select booking_row.branch_id, count(*)::bigint as bookings,
        sum(coalesce(booking_row.total_value, booking_row.booking_amount, 0))::numeric as booking_value
      from public.bookings booking_row
      where booking_row.organization_id = current_organization_id
        and booking_row.branch_id = any(scope)
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= month_range_start
        and booking_row.created_at < month_range_end
      group by booking_row.branch_id
    ), branch_rows as (
      select branch_row.id, branch_row.name,
        coalesce(lead_row.leads, 0) as leads,
        coalesce(lead_row.contacted, 0) as contacted,
        coalesce(lead_row.moved_to_sales, 0) as moved_to_sales,
        coalesce(lead_row.lost, 0) as lost,
        lead_row.response_minutes,
        coalesce(drive_row.test_drives, 0) as test_drives,
        coalesce(drive_row.completed_drives, 0) as completed_drives,
        coalesce(quotation_row.quotations, 0) as quotations,
        coalesce(booking_row.bookings, 0) as bookings,
        coalesce(booking_row.booking_value, 0) as booking_value,
        coalesce(delivery_row.delivered, 0) as delivered,
        coalesce(delivery_row.pending_delivery, 0) as pending_delivery,
        coalesce(call_row.calls, 0) as calls,
        coalesce(call_row.connected, 0) as connected_calls,
        jsonb_build_object(
          'HOT', coalesce(lead_row.hot, 0), 'WARM', coalesce(lead_row.warm, 0),
          'COLD', coalesce(lead_row.cold, 0), 'DORMANT', coalesce(lead_row.dormant, 0),
          'UNRATED', coalesce(lead_row.unrated, 0)
        ) as temperatures,
        coalesce(source_row.sources, '{}'::jsonb) as sources,
        coalesce(target_row.unit_target, 0) as unit_target,
        coalesce(month_booking_row.bookings, 0) as month_bookings,
        coalesce(month_booking_row.booking_value, 0) as month_booking_value
      from branch_list branch_row
      left join lead_totals lead_row on lead_row.branch_id = branch_row.id
      left join source_totals source_row on source_row.branch_id = branch_row.id
      left join call_totals call_row on call_row.branch_id = branch_row.id
      left join drive_totals drive_row on drive_row.branch_id = branch_row.id
      left join quotation_totals quotation_row on quotation_row.branch_id = branch_row.id
      left join booking_totals booking_row on booking_row.branch_id = branch_row.id
      left join delivery_totals delivery_row on delivery_row.branch_id = branch_row.id
      left join target_totals target_row on target_row.branch_id = branch_row.id
      left join month_bookings month_booking_row on month_booking_row.branch_id = branch_row.id
    ), focus_rows as (
      select * from branch_rows where id = any(focus_scope)
    ), focus_leads as materialized (
      select * from scoped_leads where branch_id = any(focus_scope)
    ), focus_bookings as materialized (
      select * from scoped_bookings where branch_id = any(focus_scope)
    ), days as (
      select generate_series(start_day, local_today, interval '1 day')::date as metric_day
    ), daily_leads as (
      select timezone(target_timezone, created_at)::date as metric_day, count(*)::bigint as leads
      from focus_leads group by 1
    ), daily_bookings as (
      select timezone(target_timezone, created_at)::date as metric_day, count(*)::bigint as bookings
      from focus_bookings group by 1
    ), daily as (
      select day_row.metric_day, coalesce(lead_row.leads, 0) as leads,
        coalesce(booking_row.bookings, 0) as bookings
      from days day_row
      left join daily_leads lead_row on lead_row.metric_day = day_row.metric_day
      left join daily_bookings booking_row on booking_row.metric_day = day_row.metric_day
    ), booking_sources as (
      select coalesce(nullif(btrim(lead_row.source), ''), 'Other') as source, count(*)::bigint as bookings
      from focus_bookings booking_row
      left join public.leads lead_row
        on lead_row.organization_id = current_organization_id
       and lead_row.id = booking_row.lead_id
      group by 1
    )
    select jsonb_build_object(
      'window_days', target_days,
      'month', month_start,
      'branch_id', target_branch_id,
      'per_branch', coalesce((
        select jsonb_agg(jsonb_build_object(
          'branch_id', id, 'branch', name, 'leads', leads, 'contacted', contacted,
          'moved_to_sales', moved_to_sales, 'lost', lost, 'response_minutes', response_minutes,
          'test_drives', test_drives, 'completed_drives', completed_drives,
          'quotations', quotations, 'bookings', bookings, 'booking_value', booking_value,
          'delivered', delivered, 'pending_delivery', pending_delivery,
          'calls', calls, 'connected_calls', connected_calls,
          'temperatures', temperatures, 'sources', sources
        ) order by leads desc, name)
        from branch_rows
      ), '[]'::jsonb),
      'focus', jsonb_build_object(
        'totals', (
          select jsonb_build_object(
            'leads', coalesce(sum(leads), 0), 'contacted', coalesce(sum(contacted), 0),
            'moved_to_sales', coalesce(sum(moved_to_sales), 0), 'lost', coalesce(sum(lost), 0),
            'test_drives', coalesce(sum(test_drives), 0),
            'completed_drives', coalesce(sum(completed_drives), 0),
            'quotations', coalesce(sum(quotations), 0), 'bookings', coalesce(sum(bookings), 0),
            'booking_value', coalesce(sum(booking_value), 0),
            'delivered', coalesce(sum(delivered), 0),
            'pending_delivery', coalesce(sum(pending_delivery), 0),
            'calls', coalesce(sum(calls), 0), 'connected_calls', coalesce(sum(connected_calls), 0),
            'response_minutes', (
              select round(avg(extract(epoch from (first_contacted_at - created_at)) / 60))
              from focus_leads where first_contacted_at >= created_at
            )
          )
          from focus_rows
        ),
        'daily', coalesce((
          select jsonb_agg(jsonb_build_object('day', metric_day, 'leads', leads, 'bookings', bookings)
            order by metric_day)
          from daily
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(jsonb_build_object('name', source, 'leads', leads) order by leads desc, source)
          from (select source, count(*)::bigint as leads from focus_leads group by 1) source_row
        ), '[]'::jsonb),
        'booking_sources', coalesce((
          select jsonb_agg(jsonb_build_object('name', source, 'bookings', bookings)
            order by bookings desc, source)
          from booking_sources
        ), '[]'::jsonb),
        'models', coalesce((
          select jsonb_agg(jsonb_build_object('name', model, 'leads', leads) order by leads desc, model)
          from (
            select model, count(*)::bigint as leads from focus_leads
            group by 1 order by 2 desc, 1 limit 8
          ) model_row
        ), '[]'::jsonb),
        'lost_reasons', coalesce((
          select jsonb_agg(jsonb_build_object('name', lost_reason, 'leads', leads)
            order by leads desc, lost_reason)
          from (
            select lost_reason, count(*)::bigint as leads from focus_leads
            where lifecycle_status = 'Lost' group by 1
          ) reason_row
        ), '[]'::jsonb)
      ),
      'targets', coalesce((
        select jsonb_agg(jsonb_build_object(
          'branch_id', id, 'branch', name,
          'unit_target', unit_target, 'bookings', month_bookings,
          'booking_value', month_booking_value
        ) order by month_bookings desc, name)
        from branch_rows
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.get_business_showroom_analytics(integer, text, uuid) from public, anon;
grant execute on function public.get_business_showroom_analytics(integer, text, uuid) to authenticated;

commit;
