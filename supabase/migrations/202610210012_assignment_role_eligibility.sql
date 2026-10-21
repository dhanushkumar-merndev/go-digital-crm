begin;

-- Lead Assignment's "Assign via round robin" failed for every fresh lead in a
-- mixed team. assign_lead's round robin picked any member flagged
-- eligible_for_fresh_leads, Sales Consultants included, and the
-- enforce_sales_lead_assignment guard then rejected the insert with
-- FRESH_ASSIGNMENT_REQUIRES_TELECALLER. 20260928160000 fixed the same mismatch in
-- create_lead; this applies the guard's role rule to assign_lead and to the
-- eligible list the assignment queue shows:
--   FRESH     -> an active telecaller_bdc role
--   QUALIFIED -> an active sales_consultant role
-- claim_least_assigned_member already filters this way.

do $migration$
declare
  eligibility_anchor constant text :=
    E'      and (\n'
    || E'        (assignment_kind = ''FRESH'' and member_row.eligible_for_fresh_leads)\n'
    || E'        or (assignment_kind = ''QUALIFIED'' and member_row.eligible_for_qualified_leads)\n'
    || E'      )\n';
  role_eligibility constant text :=
    eligibility_anchor
    || E'      and exists (\n'
    || E'        select 1\n'
    || E'        from public.user_role_assignments eligible_assignment\n'
    || E'        join public.roles eligible_role on eligible_role.id = eligible_assignment.role_id\n'
    || E'        where eligible_assignment.organization_id = target_lead.organization_id\n'
    || E'          and eligible_assignment.user_id = member_row.user_id\n'
    || E'          and eligible_assignment.active\n'
    || E'          and eligible_role.role_key = case\n'
    || E'            when assignment_kind = ''FRESH'' then ''telecaller_bdc''\n'
    || E'            else ''sales_consultant''\n'
    || E'          end\n'
    || E'      )\n';
  workspace_anchor constant text :=
    E'      member_row.eligible_for_fresh_leads,\n'
    || E'      member_row.eligible_for_qualified_leads,\n';
  workspace_eligibility constant text :=
    E'      member_row.eligible_for_fresh_leads and exists (\n'
    || E'        select 1\n'
    || E'        from public.user_role_assignments eligible_assignment\n'
    || E'        join public.roles eligible_role on eligible_role.id = eligible_assignment.role_id\n'
    || E'        where eligible_assignment.organization_id = target_organization_id\n'
    || E'          and eligible_assignment.user_id = member_row.user_id\n'
    || E'          and eligible_assignment.active\n'
    || E'          and eligible_role.role_key = ''telecaller_bdc''\n'
    || E'      ) as eligible_for_fresh_leads,\n'
    || E'      member_row.eligible_for_qualified_leads and exists (\n'
    || E'        select 1\n'
    || E'        from public.user_role_assignments eligible_assignment\n'
    || E'        join public.roles eligible_role on eligible_role.id = eligible_assignment.role_id\n'
    || E'        where eligible_assignment.organization_id = target_organization_id\n'
    || E'          and eligible_assignment.user_id = member_row.user_id\n'
    || E'          and eligible_assignment.active\n'
    || E'          and eligible_role.role_key = ''sales_consultant''\n'
    || E'      ) as eligible_for_qualified_leads,\n';
  definition text;
  updated_definition text;
begin
  -- Both the round-robin pick and the final eligibility check carry the anchor.
  select pg_get_functiondef('public.assign_lead(uuid,uuid,text,text)'::regprocedure)
    into definition;
  if (length(definition) - length(replace(definition, eligibility_anchor, '')))
    / length(eligibility_anchor) <> 2
  then
    raise exception using errcode = 'P0001', message = 'ASSIGN_LEAD_ROLE_PATCH_TARGET_NOT_FOUND';
  end if;
  execute replace(definition, eligibility_anchor, role_eligibility);

  select pg_get_functiondef(
    'app_private.build_lead_assignment_workspace(uuid,uuid,uuid[],text,integer,integer)'::regprocedure
  ) into definition;
  updated_definition := replace(definition, workspace_anchor, workspace_eligibility);
  if updated_definition = definition then
    raise exception using errcode = 'P0001', message = 'ASSIGNMENT_WORKSPACE_ROLE_PATCH_TARGET_NOT_FOUND';
  end if;
  execute updated_definition;
end;
$migration$;

commit;
