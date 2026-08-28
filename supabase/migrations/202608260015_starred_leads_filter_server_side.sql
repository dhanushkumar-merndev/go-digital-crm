begin;

-- The Starred tab counted globally and listed locally. `get_my_lead_preferences`
-- returns every star a user owns, so the badge was right, but the rows were
-- produced by filtering the page already on screen -- so a star on page two, or
-- one excluded by the active tab, was counted and never shown. The footer said
-- it out loud: "Showing 3 starred leads on this page" under a badge reading 6.
--
-- Starred becomes a real server-side status, so the list is drawn from the same
-- set the badge counts. The function already reads `user_lead_preferences` for
-- pin ordering, so this adds a predicate rather than a new data source.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  anchor constant text :=
    E'        or (target_status = ''hot'' and lead_row.temperature = ''HOT'')\n';
  starred_filter constant text :=
    E'        or (target_status = ''starred'' and exists (\n'
    || E'          select 1\n'
    || E'          from public.user_lead_preferences starred_row\n'
    || E'          where starred_row.organization_id = target_organization_id\n'
    || E'            and starred_row.user_id = target_actor_id\n'
    || E'            and starred_row.lead_id = lead_row.id\n'
    || E'            and starred_row.starred\n'
    || E'        ))\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := replace(definition, anchor, anchor || starred_filter);

  if updated_definition = definition
    or position('target_status = ''starred''' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'STARRED_FILTER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
