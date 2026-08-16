begin;

-- Repair the first linked deployment of 150035. Fresh installs already receive
-- the named aggregate column from 150035; recreating its function remains safe.
do $$
declare
  dashboard_definition text;
begin
  select pg_get_functiondef('public.get_tenant_performance_dashboard(integer,text)'::regprocedure)
  into dashboard_definition;

  dashboard_definition := regexp_replace(
    dashboard_definition,
    '(?is)(as day_value, count\(\*\)::bigint)(\s+from scoped_bookings)',
    '\1 as value\2'
  );
  execute dashboard_definition;
end;
$$;

revoke all on function public.get_tenant_performance_dashboard(integer, text) from public, anon;
grant execute on function public.get_tenant_performance_dashboard(integer, text) to authenticated;

commit;
