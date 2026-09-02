begin;

-- 202609020014 patched every `lead_row.next_followup_at` projection. That
-- correctly added the flag to scoped_leads, but also added a second copy to
-- page_rows, where stage_row.is_handoff_read_only was already selected. Remove
-- only the page_rows copy so the JSON projection has one unambiguous column.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  duplicate_projection text :=
    E'        lead_row.sla_due_at,\n'
      || E'        lead_row.next_followup_at,\n'
      || E'        actor_is_telecaller and app_private.is_telecaller_handoff_viewer(\n'
      || E'          target_organization_id, lead_row.id, target_actor_id\n'
      || E'        ) as is_handoff_read_only,\n'
      || E'        (\n'
      || E'          select max(handoff_history.created_at)';
  single_projection text :=
    E'        lead_row.sla_due_at,\n'
      || E'        lead_row.next_followup_at,\n'
      || E'        (\n'
      || E'          select max(handoff_history.created_at)';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := replace(definition, duplicate_projection, single_projection);

  if updated_definition = definition
    or position('stage_row.is_handoff_read_only' in updated_definition) = 0
    or position('''read_only'', is_handoff_read_only' in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'HANDOFF_READ_ONLY_PROJECTION_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
