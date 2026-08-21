begin;

create index if not exists leads_org_source_active_idx
  on public.leads (organization_id, source, updated_at desc, id)
  where deleted_at is null;

create index if not exists leads_org_model_active_idx
  on public.leads (organization_id, interested_model, updated_at desc, id)
  where deleted_at is null;

create index if not exists leads_org_next_followup_active_idx
  on public.leads (organization_id, next_followup_at, id)
  where deleted_at is null and next_followup_at is not null;

create or replace function public.get_lead_workspace_page_v2(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default '',
  target_status text default 'all',
  target_sort text default 'updated:desc',
  target_model text default null,
  target_source text default null,
  target_stage text default 'all',
  target_temperature text default 'all',
  target_followup_from date default null,
  target_followup_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text;
  search_lead_id uuid;
  normalized_model text;
  normalized_source text;
begin
  if target_page is null or target_page < 1
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_status is null or target_status not in (
      'all', 'hot', 'warm', 'cold', 'follow-up', 'test-drive', 'quotation', 'booking',
      'new', 'contacted', 'qualified', 'appointment-scheduled', 'transferred-to-sales',
      'lost', 'new-today', 'pending', 'sla-risk'
    )
    or target_stage is null or target_stage not in (
      'all', 'New', 'Contacted', 'Qualified', 'Appointment Scheduled',
      'Transferred to Sales', 'Lost', 'Test Drive', 'Quotation', 'Booking'
    )
    or target_temperature is null or target_temperature not in ('all', 'HOT', 'WARM', 'COLD')
    or target_sort is null or target_sort not in (
      'updated:desc', 'updated:asc', 'created:desc', 'created:asc',
      'customer:asc', 'customer:desc'
    )
    or (target_followup_from is not null and target_followup_to is not null
      and target_followup_from > target_followup_to)
  then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_WORKSPACE_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;

  normalized_search := left(
    btrim(regexp_replace(coalesce(target_search, ''), '[^[:alnum:] @+_-]+', '', 'g')),
    160
  );
  normalized_model := nullif(left(btrim(coalesce(target_model, '')), 160), '');
  normalized_source := nullif(left(btrim(coalesce(target_source, '')), 100), '');
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_lead_id := normalized_search::uuid;
  end if;

  return (
    with scoped_leads as materialized (
      select lead_row.id, lead_row.organization_id, lead_row.branch_id, lead_row.team_id,
        lead_row.customer_id, lead_row.source, lead_row.customer_name, lead_row.phone,
        lead_row.normalized_phone, lead_row.email, lead_row.interested_model,
        lead_row.lifecycle_status, lead_row.temperature, lead_row.lost_reason,
        lead_row.assigned_user_id, lead_row.first_contacted_at, lead_row.sla_due_at,
        lead_row.created_at, lead_row.updated_at, lead_row.next_followup_at,
        case
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and now() > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and now() >= lead_row.created_at + interval '24 hours' then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and app_private.can_access_record(
          lead_row.organization_id, lead_row.branch_id,
          lead_row.team_id, lead_row.assigned_user_id
        )
    ), enriched_leads as materialized (
      select lead_row.*,
        exists (
          select 1 from public.test_drive_appointments drive_row
          where drive_row.organization_id = lead_row.organization_id and drive_row.lead_id = lead_row.id
        ) as has_test_drive,
        exists (
          select 1 from public.quotations quotation_row
          where quotation_row.organization_id = lead_row.organization_id and quotation_row.lead_id = lead_row.id
        ) as has_quotation,
        exists (
          select 1 from public.bookings booking_row
          where booking_row.organization_id = lead_row.organization_id and booking_row.lead_id = lead_row.id
            and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
        ) as has_booking
      from scoped_leads lead_row
    ), staged_leads as materialized (
      select lead_row.*,
        case
          when lead_row.has_booking then 'Booking'
          when lead_row.has_quotation then 'Quotation'
          when lead_row.has_test_drive then 'Test Drive'
          else lead_row.lifecycle_status::text
        end as lead_stage
      from enriched_leads lead_row
    ), filtered_leads as materialized (
      select *
      from staged_leads lead_row
      where (
        target_status = 'all'
        or (target_status = 'hot' and lead_row.temperature = 'HOT')
        or (target_status = 'warm' and lead_row.temperature = 'WARM')
        or (target_status = 'cold' and lead_row.temperature = 'COLD')
        or (target_status = 'follow-up' and lead_row.next_followup_at is not null)
        or (target_status = 'test-drive' and lead_row.has_test_drive)
        or (target_status = 'quotation' and lead_row.has_quotation)
        or (target_status = 'booking' and lead_row.has_booking)
        or (target_status = 'new' and lead_row.lifecycle_status = 'New')
        or (target_status = 'contacted' and lead_row.lifecycle_status = 'Contacted')
        or (target_status = 'qualified' and lead_row.lifecycle_status = 'Qualified')
        or (target_status = 'appointment-scheduled' and lead_row.lifecycle_status = 'Appointment Scheduled')
        or (target_status = 'transferred-to-sales' and lead_row.lifecycle_status = 'Transferred to Sales')
        or (target_status = 'lost' and lead_row.lifecycle_status = 'Lost')
        or (target_status = 'new-today' and lead_row.work_state = 'NEW_TODAY')
        or (target_status = 'pending' and lead_row.work_state = 'PENDING')
        or (target_status = 'sla-risk' and lead_row.work_state = 'SLA_RISK')
      )
      and (normalized_model is null or lead_row.interested_model = normalized_model)
      and (normalized_source is null or lead_row.source = normalized_source)
      and (target_stage = 'all' or lead_row.lead_stage = target_stage)
      and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
      and (
        target_followup_from is null
        or (lead_row.next_followup_at at time zone 'Asia/Kolkata')::date >= target_followup_from
      )
      and (
        target_followup_to is null
        or (lead_row.next_followup_at at time zone 'Asia/Kolkata')::date <= target_followup_to
      )
      and (
        normalized_search = ''
        or lead_row.id = search_lead_id
        or lead_row.customer_name ilike '%' || normalized_search || '%'
        or lead_row.normalized_phone ilike '%' || normalized_search || '%'
      )
    ), page_rows as (
      select lead_row.*, profile_row.full_name as assigned_user_name
      from filtered_leads lead_row
      left join public.profiles profile_row
        on profile_row.id = lead_row.assigned_user_id
       and profile_row.organization_id = lead_row.organization_id
       and profile_row.active and profile_row.deleted_at is null
      order by
        case when target_sort = 'updated:asc' then lead_row.updated_at end asc nulls last,
        case when target_sort = 'updated:desc' then lead_row.updated_at end desc nulls last,
        case when target_sort = 'created:asc' then lead_row.created_at end asc nulls last,
        case when target_sort = 'created:desc' then lead_row.created_at end desc nulls last,
        case when target_sort = 'customer:asc' then lead_row.customer_name end asc nulls last,
        case when target_sort = 'customer:desc' then lead_row.customer_name end desc nulls last,
        lead_row.id desc
      limit target_page_size offset (target_page - 1) * target_page_size
    ), kpis as (
      select
        count(*)::bigint as total,
        count(*) filter (where temperature = 'HOT')::bigint as hot,
        count(*) filter (where temperature = 'WARM')::bigint as warm,
        count(*) filter (where temperature = 'COLD')::bigint as cold,
        count(*) filter (where next_followup_at is not null)::bigint as follow_up,
        count(*) filter (where has_test_drive)::bigint as test_drive,
        count(*) filter (where has_quotation)::bigint as quotation,
        count(*) filter (where has_booking)::bigint as booking,
        count(*) filter (where work_state = 'NEW_TODAY')::bigint as new_today,
        count(*) filter (where work_state = 'PENDING')::bigint as pending,
        count(*) filter (where work_state = 'SLA_RISK')::bigint as sla_risk,
        count(*) filter (where lifecycle_status = 'Qualified')::bigint as qualified,
        count(*) filter (where lifecycle_status = 'New')::bigint as new_count,
        count(*) filter (where lifecycle_status = 'Contacted')::bigint as contacted_count,
        count(*) filter (where lifecycle_status = 'Appointment Scheduled')::bigint as appointment_scheduled_count,
        count(*) filter (where lifecycle_status = 'Transferred to Sales')::bigint as transferred_to_sales_count,
        count(*) filter (where lifecycle_status = 'Lost')::bigint as lost_count
      from staged_leads
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'organization_id', organization_id, 'branch_id', branch_id,
          'team_id', team_id, 'customer_id', customer_id, 'source', source,
          'customer_name', customer_name, 'phone', phone, 'normalized_phone', normalized_phone,
          'email', email, 'interested_model', interested_model,
          'lifecycle_status', lifecycle_status, 'temperature', temperature,
          'lost_reason', lost_reason, 'work_state', work_state, 'lead_stage', lead_stage,
          'assigned_user_id', assigned_user_id, 'assigned_user_name', assigned_user_name,
          'first_contacted_at', first_contacted_at, 'sla_due_at', sla_due_at,
          'next_followup_at', next_followup_at, 'created_at', created_at, 'updated_at', updated_at
        ) order by
          case when target_sort = 'updated:asc' then updated_at end asc nulls last,
          case when target_sort = 'updated:desc' then updated_at end desc nulls last,
          case when target_sort = 'created:asc' then created_at end asc nulls last,
          case when target_sort = 'created:desc' then created_at end desc nulls last,
          case when target_sort = 'customer:asc' then customer_name end asc nulls last,
          case when target_sort = 'customer:desc' then customer_name end desc nulls last,
          id desc
        ) from page_rows
      ), '[]'::jsonb),
      'total', (select count(*) from filtered_leads),
      'kpis', (select to_jsonb(kpis) from kpis),
      'filters', jsonb_build_object(
        'models', coalesce((
          select jsonb_agg(model_name order by model_name)
          from (
            select distinct interested_model as model_name
            from scoped_leads where nullif(btrim(interested_model), '') is not null
            order by interested_model limit 100
          ) model_options
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(source_name order by source_name)
          from (
            select distinct source as source_name
            from scoped_leads where nullif(btrim(source), '') is not null
            order by source limit 100
          ) source_options
        ), '[]'::jsonb)
      )
    )
  );
end;
$$;

revoke all on function public.get_lead_workspace_page_v2(
  integer, integer, text, text, text, text, text, text, text, date, date
) from public, anon;
grant execute on function public.get_lead_workspace_page_v2(
  integer, integer, text, text, text, text, text, text, text, date, date
) to authenticated;

commit;
