-- Bundle the cached tenant dashboard's authoritative summary and live rows in
-- one scoped PostgREST call for ordinary page visits. Explicit Refresh still
-- uses the Edge cache boundary and its rate limit.

begin;

create or replace function public.get_tenant_dashboard_page(
  target_days integer default 14,
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
begin
  summary_result := public.get_tenant_dashboard_summary(target_days, target_timezone);
  live_result := public.get_tenant_dashboard_live_items(target_timezone);
  return summary_result || live_result;
end;
$$;

revoke all on function public.get_tenant_dashboard_page(integer, text)
  from public, anon;
grant execute on function public.get_tenant_dashboard_page(integer, text)
  to authenticated;

commit;
