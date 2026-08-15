begin;

-- One RLS-invoker aggregate call supplies the lead workspace KPI bundle. The
-- underlying security-invoker view keeps data scope and tenant isolation in the
-- database; callers never submit an organization id.
create or replace function public.get_lead_workspace_kpis()
returns table (
  new_today bigint,
  pending bigint,
  sla_risk bigint,
  qualified bigint,
  new_count bigint,
  contacted_count bigint,
  appointment_scheduled_count bigint,
  transferred_to_sales_count bigint,
  lost_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
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
  from public.leads_with_work_state;
$$;

revoke all on function public.get_lead_workspace_kpis() from public, anon;
grant execute on function public.get_lead_workspace_kpis() to authenticated;

commit;
