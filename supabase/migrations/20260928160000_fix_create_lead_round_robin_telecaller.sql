begin;

-- In a mixed sales team (Telecallers + Sales Consultants), round-robin intake for
-- fresh leads must only select Telecallers.
--
-- 202608310004 already added this constraint to `ingest_provider_lead`, but
-- `create_lead` was selecting any team member with `eligible_for_fresh_leads = true`.
-- When round-robin landed on a Sales Consultant, `lead_assignments` triggered
-- `FRESH_ASSIGNMENT_REQUIRES_TELECALLER` and rolled back the transaction.
--
-- This migration patches the deployed `create_lead` definition in place to ensure
-- fresh round-robin only picks eligible Telecaller members.

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
    E'        and member_row.eligible_for_fresh_leads\n        and profile_row.active\n        and profile_row.deleted_at is null\n      order by',
    E'        and member_row.eligible_for_fresh_leads\n        and profile_row.active\n        and profile_row.deleted_at is null\n        and exists (\n          select 1\n          from public.user_role_assignments intake_assignment\n          join public.roles intake_role\n            on intake_role.id = intake_assignment.role_id\n           and intake_role.organization_id = intake_assignment.organization_id\n          where intake_assignment.organization_id = target_organization_id\n            and intake_assignment.user_id = member_row.user_id\n            and intake_assignment.active\n            and intake_role.role_key = ''telecaller_bdc''\n        )\n      order by'
  );

  if updated_definition = definition then
    raise exception using errcode = 'P0001', message = 'CREATE_LEAD_ROUND_ROBIN_TELECALLER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
