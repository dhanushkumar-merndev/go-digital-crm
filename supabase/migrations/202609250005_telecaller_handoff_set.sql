-- Telecaller My Leads evaluated app_private.is_telecaller_handoff_viewer once
-- per lead in the Telecaller's branch (a re-planned SQL function with three
-- subqueries). With 75k leads that was ~1.5 s per page for every tab, versus
-- ~0.3 s for a Sales Consultant owning the same number of leads, and it grows
-- with the branch rather than with the Telecaller's own work.
--
-- The set of leads a Telecaller handed to Sales is small and depends only on
-- the actor, so it is resolved once per request and checked by array
-- membership. The rule is unchanged: previously owned by this Telecaller,
-- reassigned since, reached Transferred to Sales, and not currently theirs.
-- The workspace body is patched from its deployed definition so later changes
-- to it are preserved.

create index if not exists lead_assignment_history_previous_owner_idx
  on public.lead_assignment_history (organization_id, previous_owner_id, lead_id)
  where new_owner_id is not null;

do $patch$
declare
  definition text;
  patched text;
  call_pattern constant text :=
    'app_private\.is_telecaller_handoff_viewer\(\s*target_organization_id,\s*lead_row\.id,\s*target_actor_id\s*\)';
begin
  definition := pg_get_functiondef(
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure
  );
  if (select count(*) from regexp_matches(definition, call_pattern, 'g')) <> 2 then
    raise exception 'Expected two per-row handoff checks in get_sales_role_lead_workspace_page';
  end if;

  patched := regexp_replace(
    definition,
    call_pattern,
    '(lead_row.id = any(telecaller_handoff_lead_ids) and lead_row.assigned_user_id is distinct from target_actor_id)',
    'g'
  );
  patched := replace(
    patched,
    E'  pinned_lead_ids uuid[];\nbegin',
    E'  pinned_lead_ids uuid[];\n  -- Leads this Telecaller handed to Sales; resolved once, not per row.\n  telecaller_handoff_lead_ids uuid[] := array[]::uuid[];\nbegin'
  );
  patched := replace(
    patched,
    E'  select coalesce(array_agg(preference_row.lead_id order by preference_row.pinned_at desc), ''{}''::uuid[])\n  into pinned_lead_ids',
    E'  if actor_is_telecaller then\n'
    || E'    select coalesce(array_agg(distinct history_row.lead_id), array[]::uuid[])\n'
    || E'      into telecaller_handoff_lead_ids\n'
    || E'    from public.lead_assignment_history history_row\n'
    || E'    where history_row.organization_id = target_organization_id\n'
    || E'      and history_row.previous_owner_id = target_actor_id\n'
    || E'      and history_row.new_owner_id is not null\n'
    || E'      and exists (\n'
    || E'        select 1\n'
    || E'        from public.lead_stage_history stage_row\n'
    || E'        where stage_row.organization_id = target_organization_id\n'
    || E'          and stage_row.lead_id = history_row.lead_id\n'
    || E'          and stage_row.to_status = ''Transferred to Sales''\n'
    || E'      );\n'
    || E'  end if;\n\n'
    || E'  select coalesce(array_agg(preference_row.lead_id order by preference_row.pinned_at desc), ''{}''::uuid[])\n  into pinned_lead_ids'
  );
  if patched not like '%telecaller_handoff_lead_ids uuid[] :=%'
    or patched not like '%into telecaller_handoff_lead_ids%'
  then
    raise exception 'get_sales_role_lead_workspace_page no longer matches the expected shape';
  end if;
  execute patched;

  -- The helper is still used by policies and other RPCs; give it cached plans.
  definition := pg_get_functiondef(
    'app_private.is_telecaller_handoff_viewer(uuid,uuid,uuid)'::regprocedure
  );
  if definition like '%LANGUAGE sql%' then
    execute replace(
      replace(definition, 'LANGUAGE sql', 'LANGUAGE plpgsql'),
      '$function$' || substring(definition from '\$function\$(.*)\$function\$') || '$function$',
      '$function$ begin return ('
        || btrim(regexp_replace(substring(definition from '\$function\$(.*)\$function\$'), ';\s*$', ''))
        || '); end; $function$'
    );
  end if;
end
$patch$;
