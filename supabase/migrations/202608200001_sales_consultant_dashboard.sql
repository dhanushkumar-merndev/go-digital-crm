begin;

create index if not exists lead_assignment_history_owner_created_idx
  on public.lead_assignment_history (organization_id, new_owner_id, created_at desc, id);
create index if not exists targets_user_period_metric_idx
  on public.targets (organization_id, user_id, period_start, period_end, metric);
create index if not exists object_files_stock_image_idx
  on public.object_files (organization_id, resource_id, created_at desc, id)
  where resource_type = 'stock_unit' and deleted_at is null and mime_type like 'image/%';

create or replace function app_private.dashboard_percent_change(current_value numeric, previous_value numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(previous_value, 0) = 0 then case when coalesce(current_value, 0) > 0 then 100 else 0 end
    else round(((coalesce(current_value, 0) - previous_value) * 100 / previous_value)::numeric, 1)
  end;
$$;

create or replace function public.get_sales_consultant_dashboard(
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
  result jsonb;
begin
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_SALES_DASHBOARD_QUERY';
  end if;
  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'sales-consultant'
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'SALES_CONSULTANT_DASHBOARD_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;
  local_today := timezone(target_timezone, now())::date;

  with
  scoped_leads as materialized (
    select lead_row.*
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and app_private.can_access_record(
        lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
      )
  ),
  assigned_counts as (
    select
      count(*) filter (
        where timezone(target_timezone, history_row.created_at)::date = local_today
      )::numeric as current_value,
      count(*) filter (
        where timezone(target_timezone, history_row.created_at)::date = local_today - 1
      )::numeric as previous_value
    from public.lead_assignment_history history_row
    where history_row.organization_id = current_organization_id
      and history_row.new_owner_id = auth.uid()
      and history_row.created_at >= timezone(target_timezone, (local_today - 1)::timestamp)
  ),
  hot_counts as (
    select
      count(*) filter (where temperature = 'HOT' and lifecycle_status <> 'Lost')::numeric as current_value,
      count(*) filter (
        where temperature = 'HOT' and lifecycle_status <> 'Lost'
          and timezone(target_timezone, created_at)::date < local_today
      )::numeric as previous_value
    from scoped_leads
  ),
  followup_counts as (
    select
      count(*) filter (where timezone(target_timezone, due_at)::date = local_today)::numeric as current_value,
      count(*) filter (where timezone(target_timezone, due_at)::date = local_today - 1)::numeric as previous_value
    from public.followups followup_row
    where followup_row.organization_id = current_organization_id
      and followup_row.status in ('OPEN', 'OVERDUE')
      and app_private.can_access_record(
        followup_row.organization_id, followup_row.branch_id,
        followup_row.team_id, followup_row.assigned_user_id
      )
  ),
  call_counts as (
    select
      count(*) filter (
        where timezone(target_timezone, due_at)::date <= local_today
      )::numeric as current_value,
      count(*) filter (
        where timezone(target_timezone, due_at)::date < local_today
      )::numeric as previous_value
    from public.followups followup_row
    where followup_row.organization_id = current_organization_id
      and followup_row.status in ('OPEN', 'OVERDUE')
      and (followup_row.reason ilike '%call%' or followup_row.reason ilike '%contact%')
      and app_private.can_access_record(
        followup_row.organization_id, followup_row.branch_id,
        followup_row.team_id, followup_row.assigned_user_id
      )
  ),
  test_drive_counts as (
    select
      count(*) filter (where timezone(target_timezone, scheduled_at)::date = local_today)::numeric as current_value,
      count(*) filter (where timezone(target_timezone, scheduled_at)::date = local_today - 1)::numeric as previous_value
    from public.test_drive_appointments appointment_row
    where appointment_row.organization_id = current_organization_id
      and appointment_row.status <> 'CANCELLED'
      and app_private.can_access_record(
        appointment_row.organization_id, appointment_row.branch_id,
        appointment_row.team_id, appointment_row.assigned_user_id
      )
  ),
  quotation_counts as (
    select
      count(*) filter (where status in ('DRAFT', 'PENDING_APPROVAL', 'SENT'))::numeric as current_value,
      count(*) filter (
        where status in ('DRAFT', 'PENDING_APPROVAL', 'SENT')
          and timezone(target_timezone, created_at)::date < local_today
      )::numeric as previous_value
    from public.quotations quotation_row
    where quotation_row.organization_id = current_organization_id
      and app_private.can_access_record(
        quotation_row.organization_id, quotation_row.branch_id,
        quotation_row.team_id, quotation_row.assigned_user_id
      )
  ),
  booking_counts as (
    select
      count(*) filter (
        where date_trunc('month', timezone(target_timezone, created_at)) =
          date_trunc('month', local_today::timestamp)
      )::numeric as current_value,
      count(*) filter (
        where date_trunc('month', timezone(target_timezone, created_at)) =
          date_trunc('month', (local_today - interval '1 month')::timestamp)
      )::numeric as previous_value
    from public.bookings booking_row
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
  ),
  target_values as (
    select
      coalesce((
        select target_row.target_value
        from public.targets target_row
        where target_row.organization_id = current_organization_id
          and target_row.user_id = auth.uid()
          and upper(target_row.metric) in ('BOOKINGS', 'SALES_BOOKINGS')
          and local_today between target_row.period_start and target_row.period_end
        order by target_row.created_at desc limit 1
      ), 0)::numeric as current_target,
      coalesce((
        select target_row.target_value
        from public.targets target_row
        where target_row.organization_id = current_organization_id
          and target_row.user_id = auth.uid()
          and upper(target_row.metric) in ('BOOKINGS', 'SALES_BOOKINGS')
          and (local_today - interval '1 month')::date between target_row.period_start and target_row.period_end
        order by target_row.created_at desc limit 1
      ), 0)::numeric as previous_target
  ),
  metric_values as (
    select
      assigned_counts.current_value as assigned_current,
      assigned_counts.previous_value as assigned_previous,
      hot_counts.current_value as hot_current,
      hot_counts.previous_value as hot_previous,
      followup_counts.current_value as followup_current,
      followup_counts.previous_value as followup_previous,
      call_counts.current_value as call_current,
      call_counts.previous_value as call_previous,
      test_drive_counts.current_value as drive_current,
      test_drive_counts.previous_value as drive_previous,
      quotation_counts.current_value as quotation_current,
      quotation_counts.previous_value as quotation_previous,
      booking_counts.current_value as booking_current,
      booking_counts.previous_value as booking_previous,
      case when target_values.current_target > 0
        then round((booking_counts.current_value * 100 / target_values.current_target)::numeric, 1)
        else 0 end as target_current,
      case when target_values.previous_target > 0
        then round((booking_counts.previous_value * 100 / target_values.previous_target)::numeric, 1)
        else 0 end as target_previous
    from assigned_counts, hot_counts, followup_counts, call_counts,
      test_drive_counts, quotation_counts, booking_counts, target_values
  ),
  attention_rows as (
    select 1 as display_order, 'HOT_NOT_CALLED'::text as key,
      count(*)::bigint as value
    from scoped_leads
    where temperature = 'HOT' and first_contacted_at is null and lifecycle_status <> 'Lost'
    union all
    select 2, 'OVERDUE_FOLLOWUPS', count(*)
    from public.followups followup_row
    where followup_row.organization_id = current_organization_id
      and followup_row.status in ('OPEN', 'OVERDUE') and followup_row.due_at < now()
      and app_private.can_access_record(
        followup_row.organization_id, followup_row.branch_id,
        followup_row.team_id, followup_row.assigned_user_id
      )
    union all
    select 3, 'TEST_DRIVE_QUOTATION', count(*)
    from public.test_drives drive_row
    where drive_row.organization_id = current_organization_id
      and drive_row.status = 'COMPLETED'
      and app_private.can_access_record(
        drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
      )
      and not exists (
        select 1 from public.quotations quotation_row
        where quotation_row.organization_id = drive_row.organization_id
          and (quotation_row.lead_id = drive_row.lead_id or quotation_row.customer_id = drive_row.customer_id)
      )
    union all
    select 4, 'QUOTATION_NO_BOOKING', count(*)
    from public.quotations quotation_row
    where quotation_row.organization_id = current_organization_id
      and quotation_row.status in ('SENT', 'ACCEPTED')
      and app_private.can_access_record(
        quotation_row.organization_id, quotation_row.branch_id,
        quotation_row.team_id, quotation_row.assigned_user_id
      )
      and not exists (
        select 1 from public.bookings booking_row
        where booking_row.organization_id = quotation_row.organization_id
          and booking_row.quotation_id = quotation_row.id
          and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
      )
    union all
    select 5, 'WAITING_FOR_STOCK', count(*)
    from public.bookings booking_row
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.status = 'AWAITING_ALLOCATION'
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
  ),
  schedule_rows as (
    select followup_row.id, 'FOLLOW_UP'::text as kind, followup_row.due_at as scheduled_at,
      coalesce(customer_row.full_name, lead_row.customer_name, 'Customer') as customer_name,
      coalesce(lead_row.phone, followup_row.reason) as detail, followup_row.status
    from public.followups followup_row
    left join public.customers customer_row
      on customer_row.organization_id = followup_row.organization_id
     and customer_row.id = followup_row.customer_id and customer_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.organization_id = followup_row.organization_id
     and lead_row.id = followup_row.lead_id and lead_row.deleted_at is null
    where followup_row.organization_id = current_organization_id
      and followup_row.status in ('OPEN', 'OVERDUE', 'COMPLETED')
      and timezone(target_timezone, followup_row.due_at)::date = local_today
      and app_private.can_access_record(
        followup_row.organization_id, followup_row.branch_id,
        followup_row.team_id, followup_row.assigned_user_id
      )
    union all
    select appointment_row.id, 'SHOWROOM_VISIT', appointment_row.scheduled_at,
      customer_row.full_name, lead_row.interested_model, appointment_row.status
    from public.appointments appointment_row
    join public.customers customer_row
      on customer_row.organization_id = appointment_row.organization_id
     and customer_row.id = appointment_row.customer_id and customer_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.organization_id = appointment_row.organization_id
     and lead_row.id = appointment_row.lead_id and lead_row.deleted_at is null
    where appointment_row.organization_id = current_organization_id
      and appointment_row.appointment_type = 'Showroom Visit'
      and appointment_row.status <> 'CANCELLED'
      and timezone(target_timezone, appointment_row.scheduled_at)::date = local_today
      and app_private.can_access_record(
        appointment_row.organization_id, appointment_row.branch_id,
        appointment_row.team_id, appointment_row.assigned_user_id
      )
    union all
    select drive_row.id, 'TEST_DRIVE', drive_row.scheduled_at,
      customer_row.full_name, coalesce(model_row.name, lead_row.interested_model), drive_row.status
    from public.test_drive_appointments drive_row
    join public.customers customer_row
      on customer_row.organization_id = drive_row.organization_id
     and customer_row.id = drive_row.customer_id and customer_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.organization_id = drive_row.organization_id
     and lead_row.id = drive_row.lead_id and lead_row.deleted_at is null
    left join public.stock_units stock_row
      on stock_row.organization_id = drive_row.organization_id and stock_row.id = drive_row.stock_unit_id
    left join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id and variant_row.id = stock_row.variant_id
    left join public.vehicle_models model_row
      on model_row.organization_id = variant_row.organization_id and model_row.id = variant_row.model_id
    where drive_row.organization_id = current_organization_id
      and drive_row.status <> 'CANCELLED'
      and timezone(target_timezone, drive_row.scheduled_at)::date = local_today
      and app_private.can_access_record(
        drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
      )
    union all
    select delivery_row.id, 'DELIVERY', delivery_row.scheduled_at,
      customer_row.full_name, booking_row.booking_number, delivery_row.status
    from public.delivery_cases delivery_row
    join public.bookings booking_row
      on booking_row.organization_id = delivery_row.organization_id
     and booking_row.id = delivery_row.booking_id and booking_row.deleted_at is null
    join public.customers customer_row
      on customer_row.organization_id = delivery_row.organization_id
     and customer_row.id = delivery_row.customer_id and customer_row.deleted_at is null
    where delivery_row.organization_id = current_organization_id
      and delivery_row.status <> 'CANCELLED'
      and timezone(target_timezone, delivery_row.scheduled_at)::date = local_today
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
  ),
  pipeline_rows as (
    select 1 as display_order, 'Leads Assigned'::text as name, count(*)::bigint as value
    from public.lead_assignment_history history_row
    where history_row.organization_id = current_organization_id
      and history_row.new_owner_id = auth.uid()
      and date_trunc('month', timezone(target_timezone, history_row.created_at)) = date_trunc('month', local_today::timestamp)
    union all
    select 2, 'Follow-up', count(distinct followup_row.lead_id)
    from public.followups followup_row
    where followup_row.organization_id = current_organization_id
      and date_trunc('month', timezone(target_timezone, followup_row.created_at)) = date_trunc('month', local_today::timestamp)
      and app_private.can_access_record(
        followup_row.organization_id, followup_row.branch_id,
        followup_row.team_id, followup_row.assigned_user_id
      )
    union all
    select 3, 'Test Drive', count(*)
    from public.test_drive_appointments drive_row
    where drive_row.organization_id = current_organization_id and drive_row.status <> 'CANCELLED'
      and date_trunc('month', timezone(target_timezone, drive_row.created_at)) = date_trunc('month', local_today::timestamp)
      and app_private.can_access_record(
        drive_row.organization_id, drive_row.branch_id, drive_row.team_id, drive_row.assigned_user_id
      )
    union all
    select 4, 'Quotation', count(*)
    from public.quotations quotation_row
    where quotation_row.organization_id = current_organization_id and quotation_row.status <> 'REJECTED'
      and date_trunc('month', timezone(target_timezone, quotation_row.created_at)) = date_trunc('month', local_today::timestamp)
      and app_private.can_access_record(
        quotation_row.organization_id, quotation_row.branch_id,
        quotation_row.team_id, quotation_row.assigned_user_id
      )
    union all
    select 5, 'Booking', count(*)
    from public.bookings booking_row
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
      and date_trunc('month', timezone(target_timezone, booking_row.created_at)) = date_trunc('month', local_today::timestamp)
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
  ),
  current_model_bookings as (
    select coalesce(nullif(btrim(lead_row.interested_model), ''), 'Unspecified model') as model_name,
      count(*)::bigint as bookings
    from public.bookings booking_row
    left join public.leads lead_row
      on lead_row.organization_id = booking_row.organization_id and lead_row.id = booking_row.lead_id
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
      and date_trunc('month', timezone(target_timezone, booking_row.created_at)) = date_trunc('month', local_today::timestamp)
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
    group by 1
  ),
  previous_model_bookings as (
    select coalesce(nullif(btrim(lead_row.interested_model), ''), 'Unspecified model') as model_name,
      count(*)::bigint as bookings
    from public.bookings booking_row
    left join public.leads lead_row
      on lead_row.organization_id = booking_row.organization_id and lead_row.id = booking_row.lead_id
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
      and date_trunc('month', timezone(target_timezone, booking_row.created_at)) =
        date_trunc('month', (local_today - interval '1 month')::timestamp)
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
    group by 1
  ),
  top_model_rows as (
    select matched_model.id as model_id, current_row.model_name as name,
      current_row.bookings,
      app_private.dashboard_percent_change(current_row.bookings, coalesce(previous_row.bookings, 0)) as change,
      coalesce(stock_summary.available_stock, 0) as available_stock,
      stock_summary.image_object_file_id
    from current_model_bookings current_row
    left join previous_model_bookings previous_row on previous_row.model_name = current_row.model_name
    left join lateral (
      select model_row.id
      from public.vehicle_models model_row
      where model_row.organization_id = current_organization_id and model_row.active
        and lower(current_row.model_name) like '%' || lower(model_row.name) || '%'
      order by char_length(model_row.name) desc, model_row.id limit 1
    ) matched_model on true
    left join lateral (
      select count(*)::bigint as available_stock,
        (array_agg(image_file.id order by stock_row.received_at desc nulls last, image_file.created_at desc)
          filter (where image_file.id is not null))[1] as image_object_file_id
      from public.vehicle_variants variant_row
      join public.stock_units stock_row
        on stock_row.organization_id = variant_row.organization_id
       and stock_row.variant_id = variant_row.id
       and stock_row.deleted_at is null and stock_row.status = 'AVAILABLE'
      left join lateral (
        select file_row.id, file_row.created_at
        from public.object_files file_row
        where file_row.organization_id = stock_row.organization_id
          and file_row.resource_type = 'stock_unit' and file_row.resource_id = stock_row.id
          and file_row.deleted_at is null and file_row.mime_type like 'image/%'
        order by file_row.created_at desc, file_row.id desc limit 1
      ) image_file on true
      where variant_row.organization_id = current_organization_id
        and variant_row.model_id = matched_model.id
        and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
    ) stock_summary on matched_model.id is not null
    order by current_row.bookings desc, current_row.model_name
    limit 5
  ),
  recent_lead_rows as (
    select lead_row.id,
      'LID' || upper(substr(replace(lead_row.id::text, '-', ''), 1, 7)) as reference,
      lead_row.customer_name, lead_row.phone, lead_row.interested_model,
      lead_row.next_followup_at, lead_row.source,
      lead_row.lifecycle_status::text, lead_row.temperature::text
    from scoped_leads lead_row
    order by lead_row.updated_at desc, lead_row.id desc
    limit 5
  ),
  alert_rows as (
    select 1 as display_order, 'FOLLOWUPS_DUE'::text as key,
      (select current_value::bigint from followup_counts) as value
    union all
    select 2, 'TEST_DRIVES_SCHEDULED', (select current_value::bigint from test_drive_counts)
    union all
    select 3, 'QUOTATIONS_AWAITING', count(*)
    from public.quotations quotation_row
    where quotation_row.organization_id = current_organization_id and quotation_row.status = 'SENT'
      and app_private.can_access_record(
        quotation_row.organization_id, quotation_row.branch_id,
        quotation_row.team_id, quotation_row.assigned_user_id
      )
    union all
    select 4, 'INSURANCE_DOCUMENTS', count(*)
    from public.insurance_cases case_row
    join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id and booking_row.id = case_row.booking_id
    where case_row.organization_id = current_organization_id and case_row.status = 'QUOTE_PENDING'
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
    union all
    select 5, 'RTO_PENDING', count(*)
    from public.rto_cases case_row
    join public.bookings booking_row
      on booking_row.organization_id = case_row.organization_id and booking_row.id = case_row.booking_id
    where case_row.organization_id = current_organization_id
      and case_row.status in ('NEW', 'DOCUMENTS_PENDING', 'SUBMITTED', 'IN_PROCESS')
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
  )
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'generated_at', now(),
    'local_date', local_today,
    'timezone', target_timezone,
    'metrics', jsonb_build_object(
      'leads_assigned_today', jsonb_build_object(
        'value', assigned_current, 'change', app_private.dashboard_percent_change(assigned_current, assigned_previous), 'comparison', 'YESTERDAY'
      ),
      'hot_leads', jsonb_build_object(
        'value', hot_current, 'change', app_private.dashboard_percent_change(hot_current, hot_previous), 'comparison', 'YESTERDAY'
      ),
      'followups_today', jsonb_build_object(
        'value', followup_current, 'change', app_private.dashboard_percent_change(followup_current, followup_previous), 'comparison', 'YESTERDAY'
      ),
      'calls_pending', jsonb_build_object(
        'value', call_current, 'change', app_private.dashboard_percent_change(call_current, call_previous), 'comparison', 'YESTERDAY'
      ),
      'test_drives_today', jsonb_build_object(
        'value', drive_current, 'change', app_private.dashboard_percent_change(drive_current, drive_previous), 'comparison', 'YESTERDAY'
      ),
      'quotations_pending', jsonb_build_object(
        'value', quotation_current, 'change', app_private.dashboard_percent_change(quotation_current, quotation_previous), 'comparison', 'YESTERDAY'
      ),
      'bookings_month', jsonb_build_object(
        'value', booking_current, 'change', app_private.dashboard_percent_change(booking_current, booking_previous), 'comparison', 'LAST_MONTH'
      ),
      'target_achievement', jsonb_build_object(
        'value', target_current, 'change', target_current - target_previous, 'comparison', 'LAST_MONTH'
      )
    ),
    'attention', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value) order by display_order), '[]'::jsonb) from attention_rows),
    'schedule', (select coalesce(jsonb_agg(to_jsonb(schedule_row) order by scheduled_at, id), '[]'::jsonb) from (select * from schedule_rows order by scheduled_at, id limit 8) schedule_row),
    'pipeline', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value) order by display_order), '[]'::jsonb) from pipeline_rows),
    'top_models', (select coalesce(jsonb_agg(to_jsonb(model_row) order by bookings desc, name), '[]'::jsonb) from top_model_rows model_row),
    'recent_leads', (select coalesce(jsonb_agg(to_jsonb(lead_row)), '[]'::jsonb) from recent_lead_rows lead_row),
    'alerts', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value) order by display_order), '[]'::jsonb) from alert_rows)
  ) into result
  from metric_values;

  return result;
end;
$$;

revoke all on function public.get_sales_consultant_dashboard(text) from public, anon;
grant execute on function public.get_sales_consultant_dashboard(text) to authenticated;

commit;
