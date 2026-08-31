begin;

-- A manually added Telecaller lead is an intake lead, not a sales handoff.
-- `create_lead` previously treated every OWN_RECORDS user as a Sales
-- Consultant: it set the lead directly to Transferred to Sales, marked it
-- contacted, and wrote a fake handoff event. That bypassed the Telecaller
-- workflow (New -> Contacted -> Qualified -> actual handoff) and exposed the
-- lead to Sales before qualification.
--
-- Keep self-assignment for a Telecaller so the record remains inside their
-- OWN_RECORDS scope, but only a real Sales Consultant's self-created lead gets
-- the sales-specific handoff/contact history.
do $migration$
declare
  signature regprocedure :=
    'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'  self_assigned boolean := false;\n  resolved_team_id uuid := target_team_id;\n',
    E'  self_assigned boolean := false;\n  actor_is_sales_consultant boolean := false;\n  resolved_team_id uuid := target_team_id;\n'
  );
  updated_definition := replace(
    updated_definition,
    E'  if lead_source is null or lead_source not in (\n',
    E'  select exists (\n    select 1\n    from public.user_role_assignments assignment_row\n    join public.roles role_row\n      on role_row.id = assignment_row.role_id\n     and role_row.organization_id = assignment_row.organization_id\n    where assignment_row.organization_id = target_organization_id\n      and assignment_row.user_id = auth.uid()\n      and assignment_row.active\n      and role_row.role_key = ''sales_consultant''\n  ) into actor_is_sales_consultant;\n\n  if lead_source is null or lead_source not in (\n'
  );
  updated_definition := replace(
    updated_definition,
    E'    case when self_assigned then ''Transferred to Sales'' else ''New'' end::public.lead_lifecycle,\n    case when self_assigned then clock_timestamp() else null end\n',
    E'    case when self_assigned and actor_is_sales_consultant then ''Transferred to Sales'' else ''New'' end::public.lead_lifecycle,\n    case when self_assigned and actor_is_sales_consultant then clock_timestamp() else null end\n'
  );
  updated_definition := replace(
    updated_definition,
    E'  if self_assigned then\n    -- The handoff the consultant lead queues key off.',
    E'  if self_assigned and actor_is_sales_consultant then\n    -- The handoff the consultant lead queues key off.'
  );
  updated_definition := replace(
    updated_definition,
    E'''contacted_on_create'', self_assigned,\n',
    E'''contacted_on_create'', self_assigned and actor_is_sales_consultant,\n'
  );

  if updated_definition = definition
    or position('actor_is_sales_consultant boolean := false' in updated_definition) = 0
    or position('self_assigned and actor_is_sales_consultant then ''Transferred to Sales''' in updated_definition) = 0
    or position('if self_assigned and actor_is_sales_consultant then' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'TELECALLER_CREATE_LEAD_INTAKE_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
