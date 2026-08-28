begin;

-- 202608260015 added `starred` to the role-aware filtering predicate but not to
-- the RPC's strict query validator, so selecting the tab was rejected before it
-- reached the predicate and the workspace returned GDM-LEADS-QUERY. This is the
-- same two-place change 202608250016 had to make for the contact-state views:
-- a new status is only usable once BOTH the validator and the predicate know it.
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
    E'      ''sales-new'', ''sales-pending'', ''sales-contacted''\n',
    E'      ''sales-new'', ''sales-pending'', ''sales-contacted'',\n      ''starred''\n'
  );

  if updated_definition = definition
    or position(E'''sales-contacted'',\n      ''starred''' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'STARRED_STATUS_VALIDATOR_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
