begin;

-- 202609090003 removed the duplicated can_access_lead/can_access_customer calls
-- and the Calls page still timed out, which ruled those out: the real cost is
-- the can_access_record() in the WHERE of `scoped_calls`. It is a chain of
-- scope lookups -- can_access_organization, actor_scope_includes_branch, the
-- support-session check and a role-assignment scan -- and the legacy query runs
-- the whole chain once per call row. At ~65ms a row over 123 calls that is the
-- entire 8s statement timeout, which is why Calls was dead for every role
-- except Sales Consultant (202608220003 resolves that actor's scope once).
--
-- Access does not vary per call; it varies per (branch, team, owner). Evaluate
-- the predicate once per distinct triple and match rows against the result.
-- Same rows, same visibility rules, a couple of dozen evaluations instead of
-- one per row. `is not distinct from` keeps null branch/team/owner matching the
-- way equality inside can_access_record did.
do $migration$
declare
  signature regprocedure :=
    'public.get_call_workspace_page_legacy(text,integer,integer,text,text,text,text)'::regprocedure;
  definition text;
  updated_definition text;
  old_cte constant text := '  with scoped_calls as materialized (
';
  new_cte constant text := '  with call_scopes as materialized (
    select distinct
      call_row.branch_id,
      call_row.team_id,
      call_row.assigned_user_id
    from public.calls call_row
    where call_row.organization_id = current_organization_id
  ), visible_scopes as materialized (
    select
      scope_row.branch_id,
      scope_row.team_id,
      scope_row.assigned_user_id
    from call_scopes scope_row
    where app_private.can_access_record(
      current_organization_id,
      scope_row.branch_id,
      scope_row.team_id,
      scope_row.assigned_user_id
    )
  ), scoped_calls as materialized (
';
  old_where constant text := '      and app_private.can_access_record(
        call_row.organization_id,
        call_row.branch_id,
        call_row.team_id,
        call_row.assigned_user_id
      )
  ), filtered_calls as materialized (
';
  new_where constant text := '      and exists (
        select 1
        from visible_scopes scope_row
        where scope_row.branch_id is not distinct from call_row.branch_id
          and scope_row.team_id is not distinct from call_row.team_id
          and scope_row.assigned_user_id is not distinct from call_row.assigned_user_id
      )
  ), filtered_calls as materialized (
';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;

  if position('visible_scopes' in definition) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'CALLS_SCOPE_HOIST_ALREADY_APPLIED';
  end if;
  if position(old_cte in definition) = 0 or position(old_where in definition) = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'CALLS_SCOPE_HOIST_TARGET_NOT_FOUND';
  end if;

  updated_definition := replace(definition, old_cte, new_cte);
  updated_definition := replace(updated_definition, old_where, new_where);

  if updated_definition = definition
    or position(new_cte in updated_definition) = 0
    or position(new_where in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'CALLS_SCOPE_HOIST_PATCH_FAILED';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
