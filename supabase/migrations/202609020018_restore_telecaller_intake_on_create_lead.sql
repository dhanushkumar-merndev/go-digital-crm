begin;

-- Regression repair. 202609020006 rebuilt create_lead by copying the whole
-- function body out of 202608290008 and recreating it, which silently discarded
-- everything applied to that function afterwards. The casualty was
-- 202608310003: the rule that only a *Sales Consultant's* self-created lead
-- becomes a sales handoff.
--
-- Without it, create_lead was back to treating every OWN_RECORDS user as a Sales
-- Consultant. Telecaller has that scope too, so a manually added Telecaller lead
-- was written straight to Transferred to Sales, stamped as contacted, and given
-- a fabricated handoff history -- skipping New -> Contacted -> Qualified and
-- exposing the lead to Sales before anyone had qualified it. A lead typed in by
-- a Telecaller has to start exactly where a Facebook or Google Ads lead starts.
--
-- This re-applies 202608310003 verbatim onto the current definition, so the
-- explicit-customer-resolution change from 202609020013 is preserved rather
-- than copied over in turn.
--
-- The lesson, for whoever edits this function next: patch the deployed
-- definition, never re-emit an old copy of it. A wholesale CREATE OR REPLACE
-- from an older migration's text reverts every later change without failing.
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

  -- The stage and the contacted stamp are the visible half of the bug.
  updated_definition := replace(
    updated_definition,
    E'    case when self_assigned then ''Transferred to Sales'' else ''New'' end::public.lead_lifecycle,\n    case when self_assigned then clock_timestamp() else null end\n',
    E'    case when self_assigned and actor_is_sales_consultant then ''Transferred to Sales'' else ''New'' end::public.lead_lifecycle,\n    case when self_assigned and actor_is_sales_consultant then clock_timestamp() else null end\n'
  );

  -- The fabricated handoff history is the half that would have kept the lead
  -- looking handed-off to every downstream consumer.
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
    or position(E'''contacted_on_create'', self_assigned and actor_is_sales_consultant' in updated_definition) = 0
    -- Self-assignment itself must survive: a Telecaller only sees leads where
    -- assigned_user_id is itself, so dropping it would hide the lead they just
    -- typed in.
    or position('self_assigned := true;' in updated_definition) = 0
    -- No unguarded branch may remain, or a Telecaller lead still becomes a
    -- handoff down whichever path was missed.
    or position(E'case when self_assigned then ''Transferred to Sales''' in updated_definition) > 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'TELECALLER_CREATE_LEAD_INTAKE_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
