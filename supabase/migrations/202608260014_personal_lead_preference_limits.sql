begin;

-- Pins and stars are a personal shortlist, not a second inbox. Unbounded, they
-- stop meaning anything: a hundred pinned leads sort to the top and the pin
-- ordering that 202608250005 introduced degrades into the ordinary list.
--
-- Caps are enforced here rather than in the dialog because the RPC is the only
-- thing both the web and mobile clients share, and a client-side guard is a
-- suggestion rather than a limit.
--
-- Only a NEW pin or star is counted against the cap. Re-saving a lead that is
-- already pinned -- which happens whenever the star is toggled on a pinned row,
-- since both flags are written together -- must not fail once the cap is full,
-- and unpinning must always be possible.
do $migration$
declare
  signature regprocedure :=
    'public.set_my_lead_preference(uuid,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  guard constant text :=
    E'  if target_pinned and not exists (\n'
    || E'    select 1 from public.user_lead_preferences limit_row\n'
    || E'    where limit_row.organization_id = current_organization_id\n'
    || E'      and limit_row.user_id = auth.uid()\n'
    || E'      and limit_row.lead_id = target_lead_id\n'
    || E'      and limit_row.pinned\n'
    || E'  ) and (\n'
    || E'    select count(*) from public.user_lead_preferences limit_row\n'
    || E'    where limit_row.organization_id = current_organization_id\n'
    || E'      and limit_row.user_id = auth.uid()\n'
    || E'      and limit_row.pinned\n'
    || E'  ) >= 5 then\n'
    || E'    raise exception using errcode = ''23514'', message = ''LEAD_PIN_LIMIT_REACHED'';\n'
    || E'  end if;\n'
    || E'  if target_starred and not exists (\n'
    || E'    select 1 from public.user_lead_preferences limit_row\n'
    || E'    where limit_row.organization_id = current_organization_id\n'
    || E'      and limit_row.user_id = auth.uid()\n'
    || E'      and limit_row.lead_id = target_lead_id\n'
    || E'      and limit_row.starred\n'
    || E'  ) and (\n'
    || E'    select count(*) from public.user_lead_preferences limit_row\n'
    || E'    where limit_row.organization_id = current_organization_id\n'
    || E'      and limit_row.user_id = auth.uid()\n'
    || E'      and limit_row.starred\n'
    || E'  ) >= 10 then\n'
    || E'    raise exception using errcode = ''23514'', message = ''LEAD_STAR_LIMIT_REACHED'';\n'
    || E'  end if;\n';
  anchor constant text :=
    E'  insert into public.user_lead_preferences (\n    organization_id, user_id, lead_id, pinned, starred, pinned_at, updated_at\n  )\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := replace(definition, anchor, guard || anchor);

  if updated_definition = definition
    or position('LEAD_PIN_LIMIT_REACHED' in updated_definition) = 0
    or position('LEAD_STAR_LIMIT_REACHED' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'LEAD_PREFERENCE_LIMIT_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
