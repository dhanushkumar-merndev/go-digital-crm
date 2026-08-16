begin;

-- 150035 was already applied to the linked project before its first signed-in
-- smoke test exposed an unqualified PL/pgSQL identifier in the aggregate.
-- Recreate the installed definition with the qualified day source. On a fresh
-- database 150035 already has the corrected source, so this is intentionally
-- idempotent.
do $$
declare
  dashboard_definition text;
begin
  select pg_get_functiondef('public.get_tenant_performance_dashboard(integer,text)'::regprocedure)
  into dashboard_definition;

  dashboard_definition := replace(
    dashboard_definition,
    'to_char(day_value, ''DD Mon'')',
    'to_char(day_row.day_value, ''DD Mon'')'
  );
  dashboard_definition := replace(
    dashboard_definition,
    ') order by day_value), ''[]''::jsonb)',
    ') order by day_row.day_value), ''[]''::jsonb)'
  );
  execute dashboard_definition;
end;
$$;

revoke all on function public.get_tenant_performance_dashboard(integer, text) from public, anon;
grant execute on function public.get_tenant_performance_dashboard(integer, text) to authenticated;

commit;
