begin;

-- DORMANT was available in the enum, write RPC and row menu, but the shared
-- sales-role list RPC still rejected it before applying the filter. Keep query
-- validation aligned with the canonical temperature set.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := replace(
    definition,
    E'target_temperature not in (''all'', ''HOT'', ''WARM'', ''COLD'')',
    E'target_temperature not in (''all'', ''HOT'', ''WARM'', ''COLD'', ''DORMANT'')'
  );

  if updated_definition = definition
    or position(
      'target_temperature not in (''all'', ''HOT'', ''WARM'', ''COLD'', ''DORMANT'')'
      in updated_definition
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'DORMANT_LEAD_WORKSPACE_FILTER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
