-- Dashboard aggregates remain inside the tenant boundary. The browser receives
-- only a compact, permission-filtered summary; it never calculates metrics from
-- a full organization export.
create or replace function public.get_customer_care_dashboard_summary(
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
  result jsonb;
begin
  if target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_CARE_DASHBOARD_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.view')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_CARE_VIEW_PERMISSION_REQUIRED';
  end if;

  with authorized as materialized (
    select
      case_row.id,
      case_row.case_number,
      case_row.case_type,
      case_row.priority,
      case_row.status,
      case_row.sla_due_at,
      case_row.created_at,
      case_row.first_contacted_at,
      case_row.resolved_at,
      customer_row.full_name as customer_name,
      profile_row.full_name as assigned_user_name,
      feedback_row.rating as feedback_rating,
      exists (
        select 1
        from public.escalations escalation_row
        where escalation_row.organization_id = case_row.organization_id
          and escalation_row.customer_case_id = case_row.id
          and escalation_row.status = 'OPEN'
      ) as escalated
    from public.customer_care_cases case_row
    join public.customers customer_row
      on customer_row.organization_id = case_row.organization_id
     and customer_row.id = case_row.customer_id
     and customer_row.deleted_at is null
    left join public.profiles profile_row
      on profile_row.organization_id = case_row.organization_id
     and profile_row.id = case_row.assigned_user_id
    left join public.feedback_requests feedback_row
      on feedback_row.organization_id = case_row.organization_id
     and feedback_row.customer_case_id = case_row.id
    where case_row.organization_id = current_organization_id
      and case_row.deleted_at is null
      and app_private.can_access_record(
        case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
      )
      and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
  ),
  open_cases as materialized (
    select * from authorized where status not in ('RESOLVED', 'CLOSED')
  )
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'kpis', jsonb_build_object(
      'feedback_calls_today', (
        select count(*) from authorized
        where first_contacted_at is not null
          and timezone(target_timezone, first_contacted_at)::date
            = timezone(target_timezone, now())::date
      ),
      'feedback_pending', (
        select count(*) from open_cases where case_type = 'FEEDBACK'
      ),
      'enquiry_feedback_due', (
        select count(*) from open_cases where case_type = 'SALES_EXPERIENCE'
      ),
      'test_drive_feedback_due', (
        select count(*)
        from public.test_drives drive_row
        left join public.test_drive_feedback feedback_row
          on feedback_row.organization_id = drive_row.organization_id
         and feedback_row.test_drive_id = drive_row.id
        where drive_row.organization_id = current_organization_id
          and drive_row.status = 'COMPLETED'
          and feedback_row.id is null
          and app_private.can_access_record(
            drive_row.organization_id,
            drive_row.branch_id,
            drive_row.team_id,
            drive_row.assigned_user_id
          )
          and app_private.can_access_customer(drive_row.organization_id, drive_row.customer_id)
      ),
      'delivery_feedback_due', (
        select count(*) from open_cases where case_type = 'DELIVERY_FOLLOWUP'
      ),
      'complaints_open', (
        select count(*) from open_cases where case_type = 'COMPLAINT'
      ),
      'escalations_open', (select count(*) from open_cases where escalated),
      'review_requests_pending', (
        select count(*) from open_cases where case_type = 'REVIEW_REQUEST'
      )
    ),
    'scores', jsonb_build_object(
      'satisfaction', coalesce((
        select round(avg(feedback_rating)::numeric, 1) from authorized where feedback_rating is not null
      ), 0),
      'positive_feedback_percent', coalesce((
        select round(
          100.0 * count(*) filter (where feedback_rating >= 4)
            / nullif(count(*) filter (where feedback_rating is not null), 0),
          1
        ) from authorized
      ), 0),
      'complaint_resolution_percent', coalesce((
        select round(
          100.0 * count(*) filter (where status in ('RESOLVED', 'CLOSED'))
            / nullif(count(*), 0),
          1
        ) from authorized where case_type = 'COMPLAINT'
      ), 0),
      'review_request_conversion_percent', coalesce((
        select round(
          100.0 * count(*) filter (where status in ('RESOLVED', 'CLOSED'))
            / nullif(count(*), 0),
          1
        ) from authorized where case_type = 'REVIEW_REQUEST'
      ), 0),
      'average_response_hours', coalesce((
        select round(avg(extract(epoch from (first_contacted_at - created_at)) / 3600)::numeric, 1)
        from authorized where first_contacted_at is not null
      ), 0),
      'ratings_received', (select count(*) from authorized where feedback_rating is not null)
    ),
    'status_chart', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', initcap(replace(status, '_', ' ')), 'value', case_count
      ) order by case_count desc)
      from (
        select status, count(*) as case_count from authorized group by status
      ) status_rows
    ), '[]'::jsonb),
    'rating_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', rating_value::text || ' star',
        'value', coalesce(rating_count, 0)
      ) order by rating_value desc)
      from generate_series(5, 1, -1) rating_value
      left join (
        select feedback_rating, count(*) as rating_count
        from authorized
        where feedback_rating is not null
        group by feedback_rating
      ) rating_rows on rating_rows.feedback_rating = rating_value
    ), '[]'::jsonb),
    'issue_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', initcap(replace(case_type, '_', ' ')), 'value', case_count
      ) order by case_count desc)
      from (
        select case_type, count(*) as case_count
        from authorized
        group by case_type
        order by case_count desc
        limit 5
      ) issue_rows
    ), '[]'::jsonb),
    'attention', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'case_number', case_number,
        'customer_name', customer_name,
        'case_type', case_type,
        'priority', priority,
        'sla_due_at', sla_due_at,
        'assigned_user_name', assigned_user_name
      ) order by attention_order)
      from (
        select *, row_number() over (
          order by (sla_due_at <= now()) desc,
            case priority when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end desc,
            sla_due_at asc, id desc
        ) as attention_order
        from open_cases
        where escalated or sla_due_at <= now()
        order by (sla_due_at <= now()) desc,
          case priority when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end desc,
          sla_due_at asc, id desc
        limit 5
      ) attention_rows
    ), '[]'::jsonb),
    'consultant_performance', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', assigned_user_name,
        'value', rating_count,
        'secondary', average_rating
      ) order by rating_count desc, average_rating desc, assigned_user_name)
      from (
        select
          assigned_user_name,
          count(*) filter (where feedback_rating is not null) as rating_count,
          coalesce(round(avg(feedback_rating)::numeric, 1), 0) as average_rating
        from authorized
        where assigned_user_name is not null
        group by assigned_user_name
        having count(*) filter (where feedback_rating is not null) > 0
        order by rating_count desc, average_rating desc, assigned_user_name
        limit 5
      ) consultant_rows
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_customer_care_dashboard_summary(text) from public, anon;
grant execute on function public.get_customer_care_dashboard_summary(text) to authenticated;
