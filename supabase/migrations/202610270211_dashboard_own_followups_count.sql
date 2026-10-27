-- The Telecaller home read 150 overdue follow-ups on its tile and 151 on the
-- follow-up list. The list shows every follow-up assigned to the caller; the
-- dashboard count also required the follow-up's lead and customer to be visible
-- through the caller's lead and customer scope, so a follow-up the telecaller
-- created after a call, on a customer they hold no lead for, was listed but not
-- counted. A follow-up assigned to the caller is now counted like the list
-- shows it; the scope checks still apply to everyone else's follow-ups.

CREATE OR REPLACE FUNCTION app_private.tenant_performance_dashboard(target_days integer, target_timezone text, include_live_items boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  operational_counts record;
  operational_department text;
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
        followup_row.assigned_user_id = auth.uid()
        or followup_row.lead_id is null
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
        followup_row.assigned_user_id = auth.uid()
        or followup_row.customer_id is null
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
$function$;
