begin;

-- A sales consultant could see an appointment, task, call or test drive for a
-- customer whose lead My Leads refused to list. The two used different rules.
--
-- Every work module scopes on `app_private.can_access_record`, which asks only
-- who the record is assigned to. The consultant lead list additionally required
-- a `lead_stage_history` row recording a transition to 'Transferred to Sales'.
-- Any lead that reached Sales without that audit row written — imported,
-- seeded, assigned directly, or moved by a path that set the column without
-- recording the transition — became invisible in My Leads while its
-- appointments kept showing up on the consultant's day. The consultant saw the
-- work and could not open the customer behind it.
--
-- History is an audit trail, not an access rule. A lead that is in a sales
-- lifecycle state AND assigned to this consultant is theirs to see, whether or
-- not the transition was recorded. The handoff check is kept as an alternative
-- so leads handed over but assigned elsewhere still appear as before; this
-- widens visibility only to leads the consultant already owns.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  handoff_requirement constant text :=
    E'            and exists (\n'
    || E'              select 1\n'
    || E'              from public.lead_stage_history handoff_history\n'
    || E'              where handoff_history.organization_id = target_organization_id\n'
    || E'                and handoff_history.lead_id = lead_row.id\n'
    || E'                and handoff_history.to_status = ''Transferred to Sales''\n'
    || E'            )\n';
  handoff_or_owned constant text :=
    E'            and (\n'
    || E'              lead_row.assigned_user_id = target_actor_id\n'
    || E'              or exists (\n'
    || E'                select 1\n'
    || E'                from public.lead_stage_history handoff_history\n'
    || E'                where handoff_history.organization_id = target_organization_id\n'
    || E'                  and handoff_history.lead_id = lead_row.id\n'
    || E'                  and handoff_history.to_status = ''Transferred to Sales''\n'
    || E'              )\n'
    || E'            )\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;

  -- Already applied: re-running must not fail.
  if position(handoff_or_owned in definition) > 0 then
    return;
  end if;

  updated_definition := replace(definition, handoff_requirement, handoff_or_owned);
  if updated_definition = definition then
    raise exception using
      errcode = 'P0001',
      message = 'SALES_CONSULTANT_LEAD_VISIBILITY_PATCH_TARGET_NOT_FOUND';
  end if;
  execute updated_definition;
end;
$migration$;

commit;
