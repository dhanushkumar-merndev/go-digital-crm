begin;

-- The contact-state views were added to the role-aware filtering predicate in
-- the previous migration. They must also be accepted by the RPC's strict
-- query validator before a Sales Consultant can select those tabs.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_get_functiondef(signature) into definition;
  updated_definition := replace(
    definition,
    E'      ''lost'', ''new-today'', ''pending'', ''sla-risk''\n',
    E'      ''lost'', ''new-today'', ''pending'', ''sla-risk'',\n      ''sales-new'', ''sales-pending'', ''sales-contacted''\n'
  );

  if updated_definition = definition
    or position('sales-contacted' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'SALES_CONTACT_STATUS_QUERY_PATCH_TARGET_NOT_FOUND';
  end if;
  execute updated_definition;
end;
$migration$;

commit;
