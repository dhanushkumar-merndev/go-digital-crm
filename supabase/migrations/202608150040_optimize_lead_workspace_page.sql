begin;

-- A single, bounded workspace RPC prevents the browser from separately
-- evaluating the same RLS-scoped lead set for the page and its KPI cards.
create or replace function public.get_lead_workspace_page(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default '',
  target_status text default 'all',
  target_sort text default 'updated:desc'
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
begin
  if target_page is null or target_page < 1
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_status is null or target_status not in (
      'all', 'new', 'contacted', 'qualified', 'appointment-scheduled',
      'transferred-to-sales', 'lost', 'new-today', 'pending', 'sla-risk'
    )
    or target_sort is null or target_sort not in (
      'updated:desc', 'updated:asc', 'created:desc', 'created:asc',
      'customer:asc', 'customer:desc'
    )
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
    ), filtered_leads as materialized (
      select *
      from scoped_leads lead_row
      where (
        target_status = 'all'
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
       and profile_row.active
       and profile_row.deleted_at is null
      order by
        case when target_sort = 'updated:asc' then lead_row.updated_at end asc nulls last,
        case when target_sort = 'updated:desc' then lead_row.updated_at end desc nulls last,
        case when target_sort = 'created:asc' then lead_row.created_at end asc nulls last,
        case when target_sort = 'created:desc' then lead_row.created_at end desc nulls last,
        case when target_sort = 'customer:asc' then lead_row.customer_name end asc nulls last,
        case when target_sort = 'customer:desc' then lead_row.customer_name end desc nulls last,
        lead_row.id desc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    ), kpis as (
      select
        count(*) filter (where work_state = 'NEW_TODAY')::bigint as new_today,
        count(*) filter (where work_state = 'PENDING')::bigint as pending,
        count(*) filter (where work_state = 'SLA_RISK')::bigint as sla_risk,
        count(*) filter (where lifecycle_status = 'Qualified')::bigint as qualified,
        count(*) filter (where lifecycle_status = 'New')::bigint as new_count,
        count(*) filter (where lifecycle_status = 'Contacted')::bigint as contacted_count,
        count(*) filter (where lifecycle_status = 'Appointment Scheduled')::bigint as appointment_scheduled_count,
        count(*) filter (where lifecycle_status = 'Transferred to Sales')::bigint as transferred_to_sales_count,
        count(*) filter (where lifecycle_status = 'Lost')::bigint as lost_count
      from scoped_leads
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'organization_id', organization_id, 'branch_id', branch_id,
          'team_id', team_id, 'customer_id', customer_id, 'source', source,
          'customer_name', customer_name, 'phone', phone, 'normalized_phone', normalized_phone,
          'email', email, 'interested_model', interested_model,
          'lifecycle_status', lifecycle_status, 'temperature', temperature,
          'lost_reason', lost_reason, 'work_state', work_state,
          'assigned_user_id', assigned_user_id, 'assigned_user_name', assigned_user_name,
          'first_contacted_at', first_contacted_at, 'sla_due_at', sla_due_at,
          'created_at', created_at, 'updated_at', updated_at
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
      'kpis', (select to_jsonb(kpis) from kpis)
    )
  );
end;
$$;

revoke all on function public.get_lead_workspace_page(integer, integer, text, text, text) from public, anon;
grant execute on function public.get_lead_workspace_page(integer, integer, text, text, text) to authenticated;

commit;
