begin;

-- A Sales Consultant works in one active sales team. Team history is retained
-- as inactive membership rows, but an active consultant must never be
-- provisioned into more than one team through the user-administration flow.
do $migration$
declare
  signature regprocedure :=
    'app_private.assert_tenant_user_assignment(uuid,uuid,public.data_scope,uuid,uuid[],uuid[],text,uuid)'::regprocedure;
  definition text;
  updated_definition text;
  anchor constant text :=
    E'  if cardinality(normalized_team_ids) > 0 and target_member_type is null then\n';
  guard constant text :=
    E'  if target_role_key = ''sales_consultant'' and cardinality(normalized_team_ids) > 1 then\n'
    || E'    raise exception using errcode = ''22023'', message = ''SALES_CONSULTANT_SINGLE_TEAM_REQUIRED'';\n'
    || E'  end if;\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := replace(definition, anchor, guard || anchor);

  if updated_definition = definition
    or position('SALES_CONSULTANT_SINGLE_TEAM_REQUIRED' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'SALES_CONSULTANT_TEAM_GUARD_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

-- The workflow guard gives administrators a clear validation error. The
-- partial unique index is the final concurrency-safe invariant for any
-- server-side writer that touches team_members directly.
create unique index if not exists team_members_one_active_sales_consultant_idx
  on public.team_members (organization_id, user_id)
  where active and member_type = 'SALES_CONSULTANT';

commit;
