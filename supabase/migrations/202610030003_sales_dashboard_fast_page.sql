-- A normal Sales Consultant dashboard visit does not need an Edge isolate:
-- the summary, live schedule and task count RPCs already enforce the user's
-- permission-bound scope. Bundle them inside PostgreSQL so the browser pays
-- one PostgREST round trip instead of an Edge gateway/cold-start path.

begin;

create or replace function public.get_sales_consultant_dashboard_page(
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  summary_result jsonb;
  live_result jsonb;
  task_due_count bigint;
  remaining_alerts jsonb;
begin
  summary_result := public.get_sales_consultant_dashboard_summary(target_timezone);
  live_result := public.get_sales_consultant_dashboard_live(target_timezone);
  task_due_count := public.get_sales_consultant_task_due_count(target_timezone);

  select coalesce(jsonb_agg(alert_row.value), '[]'::jsonb)
    into remaining_alerts
  from jsonb_array_elements(coalesce(summary_result->'alerts', '[]'::jsonb)) alert_row(value)
  where alert_row.value->>'key' <> 'FOLLOWUPS_DUE';

  return summary_result || jsonb_build_object(
    'generated_at', live_result->'generated_at',
    'local_date', live_result->'local_date',
    'timezone', live_result->'timezone',
    'schedule', coalesce(live_result->'schedule', '[]'::jsonb),
    'recent_leads', coalesce(live_result->'recent_leads', '[]'::jsonb),
    'alerts', jsonb_build_array(
      jsonb_build_object('key', 'TASKS_DUE', 'value', task_due_count)
    ) || remaining_alerts
  );
end;
$$;

revoke all on function public.get_sales_consultant_dashboard_page(text)
  from public, anon;
grant execute on function public.get_sales_consultant_dashboard_page(text)
  to authenticated;

commit;
