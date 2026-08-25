-- Keep the dashboard schedule useful when a consultant has many follow-ups:
-- today's scheduled work is chronological, with ID as the stable time tie-breaker.
-- The result remains bounded because this is a dashboard projection.
create or replace function public.get_sales_consultant_dashboard_live(
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
  current_user_id uuid := auth.uid();
  allowed_branch_ids uuid[];
  local_today date;
  today_start timestamptz;
  tomorrow_start timestamptz;
  permission_keys text[];
  can_view_customers boolean;
  can_view_followups boolean;
  can_view_appointments boolean;
  can_view_test_drives boolean;
  can_view_deliveries boolean;
  can_view_bookings boolean;
  schedule_item_limit constant integer := 50;
  schedule_result jsonb := '[]'::jsonb;
  recent_leads_result jsonb := '[]'::jsonb;
begin
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_SALES_DASHBOARD_QUERY';
  end if;

  current_organization_id := app_private.sales_consultant_organization();
  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  local_today := timezone(target_timezone, now())::date;
  today_start := timezone(target_timezone, local_today::timestamp);
  tomorrow_start := timezone(target_timezone, (local_today + 1)::timestamp);
  permission_keys := app_private.sales_consultant_permissions(current_organization_id);
  can_view_customers := 'customer.view' = any(permission_keys);
  can_view_followups := 'followup.view' = any(permission_keys);
  can_view_appointments := 'appointment.view' = any(permission_keys);
  can_view_test_drives :=
    'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys);
  can_view_deliveries :=
    'delivery.view' = any(permission_keys) or 'delivery.manage' = any(permission_keys);
  can_view_bookings :=
    'booking.view' = any(permission_keys) or 'booking.manage' = any(permission_keys);

  if cardinality(allowed_branch_ids) > 0 then
    select coalesce(jsonb_agg(to_jsonb(schedule_row)
      order by
        schedule_row.scheduled_at,
        schedule_row.id), '[]'::jsonb)
    into schedule_result
    from (
      select
        source_row.id,
        source_row.kind,
        source_row.scheduled_at,
        source_row.lead_id,
        source_row.customer_name,
        source_row.detail,
        source_row.status
      from (
        select
          followup_row.id,
          'FOLLOW_UP'::text as kind,
          followup_row.due_at as scheduled_at,
          followup_row.lead_id,
          coalesce(customer_row.full_name, lead_row.customer_name, 'Customer') as customer_name,
          coalesce(lead_row.phone, followup_row.reason) as detail,
          followup_row.status
        from public.followups followup_row
        left join public.customers customer_row
          on customer_row.organization_id = followup_row.organization_id
         and customer_row.id = followup_row.customer_id
         and customer_row.deleted_at is null
        left join public.leads lead_row
          on lead_row.organization_id = followup_row.organization_id
         and lead_row.id = followup_row.lead_id
         and lead_row.deleted_at is null
        where can_view_customers
          and can_view_followups
          and followup_row.organization_id = current_organization_id
          and followup_row.assigned_user_id = current_user_id
          and followup_row.branch_id = any(allowed_branch_ids)
          and followup_row.status in ('OPEN', 'OVERDUE', 'COMPLETED')
          and followup_row.due_at >= today_start
          and followup_row.due_at < tomorrow_start
        union all
        select
          appointment_row.id,
          case appointment_row.appointment_type
            when 'Test Drive' then 'APPOINTMENT_TEST_DRIVE'
            when 'Video Call' then 'APPOINTMENT_VIDEO_CALL'
            when 'Consultant Call' then 'APPOINTMENT_CONSULTANT_CALL'
            else 'SHOWROOM_VISIT'
          end::text as kind,
          appointment_row.scheduled_at,
          appointment_row.lead_id,
          customer_row.full_name,
          lead_row.interested_model,
          appointment_row.status
        from public.appointments appointment_row
        join public.customers customer_row
          on customer_row.organization_id = appointment_row.organization_id
         and customer_row.id = appointment_row.customer_id
         and customer_row.deleted_at is null
        left join public.leads lead_row
          on lead_row.organization_id = appointment_row.organization_id
         and lead_row.id = appointment_row.lead_id
         and lead_row.deleted_at is null
        where can_view_customers
          and can_view_appointments
          and appointment_row.organization_id = current_organization_id
          and appointment_row.assigned_user_id = current_user_id
          and appointment_row.branch_id = any(allowed_branch_ids)
          and appointment_row.appointment_type in (
            'Showroom Visit',
            'Video Call',
            'Test Drive',
            'Consultant Call'
          )
          and appointment_row.status <> 'CANCELLED'
          and appointment_row.scheduled_at >= today_start
          and appointment_row.scheduled_at < tomorrow_start
        union all
        select
          drive_row.id,
          'TEST_DRIVE'::text,
          drive_row.scheduled_at,
          drive_row.lead_id,
          customer_row.full_name,
          coalesce(model_row.name, lead_row.interested_model),
          drive_row.status
        from public.test_drive_appointments drive_row
        join public.customers customer_row
          on customer_row.organization_id = drive_row.organization_id
         and customer_row.id = drive_row.customer_id
         and customer_row.deleted_at is null
        left join public.leads lead_row
          on lead_row.organization_id = drive_row.organization_id
         and lead_row.id = drive_row.lead_id
         and lead_row.deleted_at is null
        left join public.stock_units stock_row
          on stock_row.organization_id = drive_row.organization_id
         and stock_row.id = drive_row.stock_unit_id
         and stock_row.deleted_at is null
        left join public.vehicle_variants variant_row
          on variant_row.organization_id = stock_row.organization_id
         and variant_row.id = stock_row.variant_id
        left join public.vehicle_models model_row
          on model_row.organization_id = variant_row.organization_id
         and model_row.id = variant_row.model_id
        where can_view_customers
          and can_view_test_drives
          and drive_row.organization_id = current_organization_id
          and drive_row.assigned_user_id = current_user_id
          and drive_row.branch_id = any(allowed_branch_ids)
          and drive_row.status <> 'CANCELLED'
          and drive_row.scheduled_at >= today_start
          and drive_row.scheduled_at < tomorrow_start
        union all
        select
          delivery_row.id,
          'DELIVERY'::text,
          delivery_row.scheduled_at,
          booking_row.lead_id,
          customer_row.full_name,
          booking_row.booking_number,
          delivery_row.status
        from public.delivery_cases delivery_row
        join public.bookings booking_row
          on booking_row.organization_id = delivery_row.organization_id
         and booking_row.id = delivery_row.booking_id
         and booking_row.deleted_at is null
        join public.customers customer_row
          on customer_row.organization_id = delivery_row.organization_id
         and customer_row.id = delivery_row.customer_id
         and customer_row.deleted_at is null
        where can_view_customers
          and can_view_deliveries
          and can_view_bookings
          and delivery_row.organization_id = current_organization_id
          and delivery_row.deleted_at is null
          and delivery_row.status <> 'CANCELLED'
          and booking_row.assigned_user_id = current_user_id
          and booking_row.branch_id = any(allowed_branch_ids)
          and delivery_row.scheduled_at >= today_start
          and delivery_row.scheduled_at < tomorrow_start
      ) source_row
      order by
        source_row.scheduled_at,
        source_row.id
      limit schedule_item_limit
    ) schedule_row;

    select coalesce(jsonb_agg(to_jsonb(lead_result) - 'updated_at'
      order by lead_result.updated_at desc, lead_result.id desc), '[]'::jsonb)
    into recent_leads_result
    from (
      select
        lead_row.id,
        'LID' || upper(substr(replace(lead_row.id::text, '-', ''), 1, 7)) as reference,
        lead_row.customer_name,
        lead_row.phone,
        lead_row.interested_model,
        lead_row.next_followup_at,
        lead_row.source,
        lead_row.lifecycle_status::text as lifecycle_status,
        lead_row.temperature::text as temperature,
        lead_row.updated_at
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = current_user_id
        and lead_row.branch_id = any(allowed_branch_ids)
        and lead_row.deleted_at is null
      order by lead_row.updated_at desc, lead_row.id desc
      limit 5
    ) lead_result;
  end if;

  return jsonb_build_object(
    'organization_id', current_organization_id,
    'generated_at', now(),
    'local_date', local_today,
    'timezone', target_timezone,
    'schedule', schedule_result,
    'recent_leads', recent_leads_result
  );
end;
$$;

revoke all on function public.get_sales_consultant_dashboard_live(text)
  from public, anon;
grant execute on function public.get_sales_consultant_dashboard_live(text)
  to authenticated;
