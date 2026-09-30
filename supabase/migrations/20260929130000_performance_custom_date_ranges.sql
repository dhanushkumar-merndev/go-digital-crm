-- Performance dashboards accept an explicit report end date encoded with the
-- existing timezone argument.  Keeping the two-argument RPC signature avoids
-- breaking currently deployed clients while making the selected custom range
-- exact: target_days determines the inclusive start date and the suffix
-- determines the inclusive end date.
--
-- The functions are intentionally patched from their current definitions so
-- their role, permission and RLS-aware scope logic remains the single source
-- of truth.  The public contract remains (integer, text).
do $$
declare
  function_definition text;
begin
  foreach function_definition in array array[
    pg_get_functiondef('public.get_sales_consultant_performance(integer,text)'::regprocedure),
    pg_get_functiondef('public.get_telecaller_performance(integer,text)'::regprocedure),
    pg_get_functiondef('public.get_team_manager_performance(integer,text)'::regprocedure),
    pg_get_functiondef('public.get_gm_sales_analytics_workspace(integer,text)'::regprocedure),
    pg_get_functiondef('public.get_showroom_sales_team_workspace(integer,integer,integer,text)'::regprocedure)
  ]
  loop
    function_definition := regexp_replace(
      function_definition,
      'target_days( is null)? not in \([0-9, ]+\)',
      'target_days is null or target_days < 1 or target_days > 9999'
    );
    function_definition := regexp_replace(
      function_definition,
      'target_timezone( is null)? not in \(''Asia/Kolkata'',? ?''UTC''\)',
      'target_timezone is null or target_timezone !~ ''^(Asia/Kolkata|UTC)(\|[0-9]{4}-[0-9]{2}-[0-9]{2})?$'''
    );
    function_definition := replace(
      function_definition,
      'local_today := timezone(target_timezone, now())::date;',
      'local_today := coalesce(nullif(split_part(target_timezone, ''|'', 2), '''')::date, timezone(split_part(target_timezone, ''|'', 1), now())::date); target_timezone := split_part(target_timezone, ''|'', 1);'
    );
    function_definition := replace(
      function_definition,
      'today := timezone(target_timezone, now())::date;',
      'today := coalesce(nullif(split_part(target_timezone, ''|'', 2), '''')::date, timezone(split_part(target_timezone, ''|'', 1), now())::date); target_timezone := split_part(target_timezone, ''|'', 1);'
    );

    if function_definition !~ 'target_days < 1'
      or function_definition !~ 'split_part\(target_timezone, ''\|'''
    then
      raise exception 'Could not enable custom ranges for performance RPC';
    end if;

    execute function_definition;
  end loop;
end
$$;
