begin;

-- 202608290006 removed the Team picker and resolved the consultant's team from
-- their membership. The lookup was too narrow and could return null, and a null
-- team on an assigned lead trips `ASSIGNED_LEAD_REQUIRES_TEAM` in
-- `validate_lead_tenant_integrity` -- surfacing as a bare "could not be created"
-- with nothing to act on.
--
-- Two changes:
--
-- 1. The lookup no longer insists on `member_type = 'SALES_CONSULTANT'`. The
--    trigger's own rule is only that the assignee is an *active member of the
--    lead's team*, so requiring a particular member_type here was stricter than
--    the constraint being satisfied and excluded anyone seeded or migrated with
--    a different label. Teams in the lead's branch are still the only
--    candidates, because the trigger also requires team.branch_id to match.
--
-- 2. When there is genuinely no such membership the function now raises
--    SALES_CONSULTANT_TEAM_REQUIRED instead of falling through to the generic
--    trigger error, so the dialog can say what is actually wrong: this user is
--    not in a team in this branch, and an administrator has to add them.
--
-- Note this failure predates the picker's removal. Leaving the dropdown on "No
-- team yet" sent a null team too, and produced the same unexplained error. The
-- picker was never a fix -- it was a workaround that only worked if the
-- consultant happened to choose a team they were a member of.

create or replace function app_private.resolve_self_assigned_lead_team(
  target_organization_id uuid,
  target_branch_id uuid,
  target_user_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select member_row.team_id
  from public.team_members member_row
  join public.teams team_row
    on team_row.id = member_row.team_id
   and team_row.organization_id = member_row.organization_id
  where member_row.organization_id = target_organization_id
    and member_row.user_id = target_user_id
    and member_row.active
    and team_row.active
    and team_row.branch_id = target_branch_id
  order by
    -- A sales membership wins when someone holds more than one, so the lead
    -- lands on the team they actually sell for.
    case when member_row.member_type = 'SALES_CONSULTANT' then 0 else 1 end,
    member_row.joined_at,
    member_row.team_id
  limit 1;
$$;

revoke all on function app_private.resolve_self_assigned_lead_team(uuid, uuid, uuid)
  from public, anon, authenticated;

do $migration$
declare
  definition text;
  updated_definition text;
  old_lookup constant text :=
    E'  if self_assigned and resolved_team_id is null then\n'
    || E'    select member_row.team_id into resolved_team_id\n'
    || E'    from public.team_members member_row\n'
    || E'    join public.teams team_row\n'
    || E'      on team_row.id = member_row.team_id\n'
    || E'     and team_row.organization_id = member_row.organization_id\n'
    || E'    where member_row.organization_id = target_organization_id\n'
    || E'      and member_row.user_id = auth.uid()\n'
    || E'      and member_row.active\n'
    || E'      and member_row.member_type = ''SALES_CONSULTANT''\n'
    || E'      and team_row.active\n'
    || E'      and team_row.branch_id = target_branch_id\n'
    || E'    order by member_row.joined_at, member_row.team_id\n'
    || E'    limit 1;\n'
    || E'  end if;\n';
  new_lookup constant text :=
    E'  if self_assigned and resolved_team_id is null then\n'
    || E'    resolved_team_id := app_private.resolve_self_assigned_lead_team(\n'
    || E'      target_organization_id, target_branch_id, auth.uid()\n'
    || E'    );\n'
    || E'    if resolved_team_id is null then\n'
    || E'      raise exception using errcode = ''23514'',\n'
    || E'        message = ''SALES_CONSULTANT_TEAM_REQUIRED'';\n'
    || E'    end if;\n'
    || E'  end if;\n';
begin
  select pg_catalog.pg_get_functiondef(
    'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure
  ) into definition;
  updated_definition := replace(definition, old_lookup, new_lookup);

  if updated_definition = definition
    or position('SALES_CONSULTANT_TEAM_REQUIRED' in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'CONSULTANT_LEAD_TEAM_LOOKUP_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
