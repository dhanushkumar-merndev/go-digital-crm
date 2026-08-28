begin;

-- The Starred badge counted `get_my_lead_preferences`, which returns every star
-- a user owns unconditionally, while the list ran through the workspace's scope
-- rules. A star on a lead that later moved out of the caller's visible scope was
-- therefore counted and never listed: badge 6, "Showing 1 to 5 of 5".
--
-- Counting inside the same aggregate the list is drawn from makes the two
-- structurally incapable of disagreeing. `to_jsonb(kpis)` serialises the CTE
-- wholesale, so adding the column is enough to publish it.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  anchor constant text := E' as sales_contacted\n      from staged_leads\n';
  replacement constant text :=
    E' as sales_contacted,\n'
    || E'        count(*) filter (where exists (\n'
    || E'          select 1\n'
    || E'          from public.user_lead_preferences starred_kpi_row\n'
    || E'          where starred_kpi_row.organization_id = target_organization_id\n'
    || E'            and starred_kpi_row.user_id = target_actor_id\n'
    || E'            and starred_kpi_row.lead_id = staged_leads.id\n'
    || E'            and starred_kpi_row.starred\n'
    || E'        ))::bigint as starred_count\n'
    || E'      from staged_leads\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := replace(definition, anchor, replacement);

  if updated_definition = definition
    or position('as starred_count' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'STARRED_COUNT_KPI_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
