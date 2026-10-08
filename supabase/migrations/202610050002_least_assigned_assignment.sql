begin;

-- Teams choose one of three assignment modes for fresh and qualified leads:
--
--   ROUND_ROBIN       next member in rotation (whoever has waited longest)
--   LEAST_ASSIGNED    member carrying the fewest open leads in the team
--   MANUAL_ASSIGNMENT a person picks the assignee
--
-- Before this migration the qualified-lead handoff labelled a fewest-open-leads
-- pick as ROUND_ROBIN. It now honours the team's qualified mode: ROUND_ROBIN
-- rotates, LEAST_ASSIGNED balances the open book. An automatic handoff in a
-- MANUAL_ASSIGNMENT team keeps its existing fewest-open-leads pick and is
-- recorded as LEAST_ASSIGNED, so the history says which rule actually chose.
--
-- create_lead, ingest_provider_lead, assign_lead and transfer_lead_to_sales are
-- patched against their deployed definitions (see 202609020018 for why they are
-- never re-emitted from an older migration body).

-- ---------------------------------------------------------------------------
-- The one place that decides who carries the lightest book.
--
-- Open leads are the member's non-Lost, non-deleted leads in this team -- the
-- same book the Sales handoff dialog shows. Ties go to whoever has waited
-- longest for an assignment of this kind, then to the longest-standing member,
-- so an empty team still distributes in rotation. The team row is locked so two
-- leads arriving together cannot both read the same lightest book.
-- ---------------------------------------------------------------------------
create or replace function app_private.claim_least_assigned_member(
  target_organization_id uuid,
  target_team_id uuid,
  assignment_kind text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_user_id uuid;
begin
  if assignment_kind is null or assignment_kind not in ('FRESH', 'QUALIFIED') then
    raise exception using errcode = '22023', message = 'INVALID_ASSIGNMENT_KIND';
  end if;

  perform 1
  from public.teams team_row
  where team_row.id = target_team_id
    and team_row.organization_id = target_organization_id
  for update;

  select candidate.user_id into selected_user_id
  from (
    select member_row.user_id,
      member_row.joined_at,
      case
        when assignment_kind = 'FRESH' then member_row.last_fresh_assigned_at
        else member_row.last_qualified_assigned_at
      end as last_assigned_at,
      (
        select count(*)
        from public.leads lead_row
        where lead_row.organization_id = target_organization_id
          and lead_row.assigned_user_id = member_row.user_id
          and lead_row.team_id = target_team_id
          and lead_row.deleted_at is null
          and lead_row.lifecycle_status <> 'Lost'
      ) as open_leads
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_organization_id
      and member_row.team_id = target_team_id
      and member_row.active
      and profile_row.active
      and profile_row.deleted_at is null
      and case
        when assignment_kind = 'FRESH' then member_row.eligible_for_fresh_leads
        else member_row.eligible_for_qualified_leads
      end
      -- Fresh intake goes to Telecallers and qualified leads to Sales
      -- Consultants; enforce_sales_lead_assignment rejects anything else.
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.organization_id = target_organization_id
          and assignment_row.user_id = member_row.user_id
          and assignment_row.active
          and role_row.role_key = case
            when assignment_kind = 'FRESH' then 'telecaller_bdc'
            else 'sales_consultant'
          end
      )
  ) candidate
  order by candidate.open_leads asc,
    candidate.last_assigned_at asc nulls first,
    candidate.joined_at asc,
    candidate.user_id
  limit 1;

  if selected_user_id is not null then
    update public.team_members member_row
    set last_fresh_assigned_at = case
          when assignment_kind = 'FRESH' then clock_timestamp()
          else member_row.last_fresh_assigned_at
        end,
        last_qualified_assigned_at = case
          when assignment_kind = 'QUALIFIED' then clock_timestamp()
          else member_row.last_qualified_assigned_at
        end
    where member_row.organization_id = target_organization_id
      and member_row.team_id = target_team_id
      and member_row.user_id = selected_user_id;
  end if;

  return selected_user_id;
end;
$$;

revoke all on function app_private.claim_least_assigned_member(uuid, uuid, text)
  from public, anon, authenticated;

-- Replaces exactly `expected` occurrences of `anchor`, or fails the migration.
-- A moved anchor must stop the deploy rather than leave a half-patched function.
create function pg_temp.replace_exactly(
  source text,
  anchor text,
  replacement text,
  expected integer,
  label text
)
returns text
language plpgsql
as $$
declare
  occurrences integer;
begin
  occurrences := (char_length(source) - char_length(replace(source, anchor, '')))
    / char_length(anchor);
  if occurrences <> expected then
    raise exception using
      errcode = 'P0001',
      message = label || '_PATCH_TARGET_NOT_FOUND',
      detail = format('expected %s occurrence(s), found %s', expected, occurrences);
  end if;
  return replace(source, anchor, replacement);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Hand-entered leads (create_lead).
-- ---------------------------------------------------------------------------
do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure
  );
  patched text;
begin
  if position('LEAST_ASSIGNED' in definition) > 0 then
    return;
  end if;

  patched := pg_temp.replace_exactly(
    definition,
    E'    if team_mode = ''ROUND_ROBIN'' then\n      select member_row.user_id into selected_user_id\n',
    E'    if team_mode = ''LEAST_ASSIGNED'' then\n'
      || E'      selected_user_id := app_private.claim_least_assigned_member(\n'
      || E'        target_organization_id, target_team_id, ''FRESH''\n'
      || E'      );\n'
      || E'      if selected_user_id is null then\n'
      || E'        raise exception using errcode = ''23514'', message = ''NO_ELIGIBLE_FRESH_ASSIGNEE'';\n'
      || E'      end if;\n'
      || E'    elsif team_mode = ''ROUND_ROBIN'' then\n      select member_row.user_id into selected_user_id\n',
    1,
    'CREATE_LEAD_LEAST_ASSIGNED_PICK'
  );
  -- The assignment row and its history carry the rule that actually chose.
  patched := pg_temp.replace_exactly(
    patched,
    E'      case when self_assigned then ''MANUAL_ASSIGNMENT'' else ''ROUND_ROBIN'' end::public.assignment_mode,\n',
    E'      case when self_assigned then ''MANUAL_ASSIGNMENT'' else coalesce(team_mode, ''ROUND_ROBIN'') end::public.assignment_mode,\n',
    2,
    'CREATE_LEAD_LEAST_ASSIGNED_METHOD'
  );

  execute patched;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 2. Provider intake (ingest_provider_lead). No eligible member leaves the lead
--    in the unassigned queue, exactly as round robin already does.
-- ---------------------------------------------------------------------------
do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.ingest_provider_lead(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid)'::regprocedure
  );
  patched text;
begin
  if position('LEAST_ASSIGNED' in definition) > 0 then
    return;
  end if;

  patched := pg_temp.replace_exactly(
    definition,
    E'    if team_row.fresh_assignment_mode = ''ROUND_ROBIN'' then\n      select tm.user_id into selected_user_id\n',
    E'    if team_row.fresh_assignment_mode = ''LEAST_ASSIGNED'' then\n'
      || E'      selected_user_id := app_private.claim_least_assigned_member(\n'
      || E'        target_organization_id, resolved_team_id, ''FRESH''\n'
      || E'      );\n'
      || E'    elsif team_row.fresh_assignment_mode = ''ROUND_ROBIN'' then\n      select tm.user_id into selected_user_id\n',
    1,
    'PROVIDER_INTAKE_LEAST_ASSIGNED_PICK'
  );
  patched := pg_temp.replace_exactly(
    patched,
    E'selected_user_id, ''FRESH'', ''ROUND_ROBIN'', ''Provider lead ingestion''',
    E'selected_user_id, ''FRESH'', team_row.fresh_assignment_mode, ''Provider lead ingestion''',
    1,
    'PROVIDER_INTAKE_LEAST_ASSIGNED_ASSIGNMENT_METHOD'
  );
  patched := pg_temp.replace_exactly(
    patched,
    E'null, selected_user_id, ''ROUND_ROBIN'', ''Provider lead ingestion''',
    E'null, selected_user_id, team_row.fresh_assignment_mode, ''Provider lead ingestion''',
    1,
    'PROVIDER_INTAKE_LEAST_ASSIGNED_HISTORY_METHOD'
  );
  patched := pg_temp.replace_exactly(
    patched,
    E'case when selected_user_id is null then ''MANUAL_QUEUE'' else ''ROUND_ROBIN'' end',
    E'case when selected_user_id is null then ''MANUAL_QUEUE'' else team_row.fresh_assignment_mode::text end',
    1,
    'PROVIDER_INTAKE_LEAST_ASSIGNED_AUDIT'
  );

  execute patched;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 3. Manager assignment (assign_lead). An automatic team mode chooses the
--    assignee; only MANUAL_ASSIGNMENT honours the requested user.
-- ---------------------------------------------------------------------------
do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.assign_lead(uuid,uuid,text,text)'::regprocedure
  );
  patched text;
begin
  if position('LEAST_ASSIGNED' in definition) > 0 then
    return;
  end if;

  patched := pg_temp.replace_exactly(
    definition,
    E'  if team_mode = ''ROUND_ROBIN'' then\n    select member_row.user_id into selected_user_id\n',
    E'  if team_mode = ''LEAST_ASSIGNED'' then\n'
      || E'    selected_user_id := app_private.claim_least_assigned_member(\n'
      || E'      target_lead.organization_id, target_lead.team_id, assignment_kind\n'
      || E'    );\n'
      || E'  elsif team_mode = ''ROUND_ROBIN'' then\n    select member_row.user_id into selected_user_id\n',
    1,
    'ASSIGN_LEAD_LEAST_ASSIGNED_PICK'
  );

  execute patched;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 4. Telecaller -> Sales handoff (transfer_lead_to_sales). The automatic pick
--    now follows the team's qualified mode instead of always balancing load.
--    Reading the mode locks the team row, which also stops two simultaneous
--    handoffs from landing on the same consultant.
-- ---------------------------------------------------------------------------
do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.transfer_lead_to_sales(uuid,uuid,text)'::regprocedure
  );
  patched text;
begin
  if position('LEAST_ASSIGNED' in definition) > 0 then
    return;
  end if;

  patched := pg_temp.replace_exactly(
    definition,
    E'  selected_open_leads bigint;\n',
    E'  selected_open_leads bigint;\n  qualified_mode public.assignment_mode;\n',
    1,
    'SALES_HANDOFF_MODE_DECLARATION'
  );
  patched := pg_temp.replace_exactly(
    patched,
    E'  if target_lead.team_id is null then\n'
      || E'    raise exception using errcode = ''23514'', message = ''LEAD_TEAM_REQUIRED'';\n'
      || E'  end if;\n',
    E'  if target_lead.team_id is null then\n'
      || E'    raise exception using errcode = ''23514'', message = ''LEAD_TEAM_REQUIRED'';\n'
      || E'  end if;\n'
      || E'  select team_row.qualified_assignment_mode into qualified_mode\n'
      || E'  from public.teams team_row\n'
      || E'  where team_row.id = target_lead.team_id\n'
      || E'    and team_row.organization_id = current_organization_id\n'
      || E'  for update;\n',
    1,
    'SALES_HANDOFF_MODE_READ'
  );
  patched := pg_temp.replace_exactly(
    patched,
    E'    order by candidate.open_leads asc,\n',
    E'    order by case when qualified_mode = ''ROUND_ROBIN'' then 0 else candidate.open_leads end asc,\n',
    1,
    'SALES_HANDOFF_MODE_ORDER'
  );
  patched := pg_temp.replace_exactly(
    patched,
    E'    selected_method := ''ROUND_ROBIN'';\n',
    E'    selected_method := case\n'
      || E'      when qualified_mode = ''ROUND_ROBIN'' then ''ROUND_ROBIN''\n'
      || E'      else ''LEAST_ASSIGNED''\n'
      || E'    end::public.assignment_mode;\n',
    1,
    'SALES_HANDOFF_MODE_METHOD'
  );
  patched := pg_temp.replace_exactly(
    patched,
    E'        when selected_method = ''ROUND_ROBIN''\n'
      || E'          then ''Auto-assigned to the Sales Consultant with the fewest open leads.''\n',
    E'        when selected_method = ''ROUND_ROBIN''\n'
      || E'          then ''Auto-assigned to the next Sales Consultant in rotation.''\n'
      || E'        when selected_method = ''LEAST_ASSIGNED''\n'
      || E'          then ''Auto-assigned to the Sales Consultant with the fewest open leads.''\n',
    1,
    'SALES_HANDOFF_MODE_REASON'
  );

  execute patched;
end;
$migration$;

revoke all on function public.transfer_lead_to_sales(uuid, uuid, text) from public, anon;
grant execute on function public.transfer_lead_to_sales(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The handoff dialog's recommendation and label follow the same rule as the
--    automatic pick, so "Auto-assign (Name)" names who will actually get it.
--    The return type gains assignment_mode, so the function is recreated.
-- ---------------------------------------------------------------------------
drop function public.get_sales_handoff_candidates(uuid, text);

create function public.get_sales_handoff_candidates(
  target_lead_id uuid,
  target_search text default ''
)
returns table (
  user_id uuid,
  full_name text,
  open_leads bigint,
  hot_leads bigint,
  recommended boolean,
  assignment_mode text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_lead public.leads%rowtype;
  normalized_search text;
  qualified_mode public.assignment_mode;
begin
  if target_lead_id is null then
    raise exception using errcode = '22023', message = 'LEAD_ID_REQUIRED';
  end if;
  normalized_search := left(btrim(coalesce(target_search, '')), 160);

  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.id = target_lead_id
    and lead_row.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.can_access_record(
      target_lead.organization_id,
      target_lead.branch_id,
      target_lead.team_id,
      target_lead.assigned_user_id
    )
    or not (
      app_private.has_permission(target_lead.organization_id, 'lead.assign')
      or (
        coalesce(target_lead.assigned_user_id = auth.uid(), false)
        and app_private.has_permission(target_lead.organization_id, 'lead.update')
      )
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_lead.team_id is null then
    raise exception using errcode = '23514', message = 'LEAD_TEAM_REQUIRED';
  end if;

  select team_row.qualified_assignment_mode into qualified_mode
  from public.teams team_row
  where team_row.id = target_lead.team_id
    and team_row.organization_id = target_lead.organization_id;

  return query
  with eligible as (
    select member_row.user_id,
      profile_row.full_name,
      member_row.last_qualified_assigned_at,
      member_row.joined_at
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_lead.organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.active
      and member_row.eligible_for_qualified_leads
      and profile_row.active
      and profile_row.deleted_at is null
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.organization_id = target_lead.organization_id
          and assignment_row.user_id = member_row.user_id
          and assignment_row.active
          and role_row.role_key = 'sales_consultant'
      )
  ), loaded as (
    select eligible_row.*,
      coalesce(book.open_leads, 0)::bigint as open_leads,
      coalesce(book.hot_leads, 0)::bigint as hot_leads
    from eligible eligible_row
    left join lateral (
      select count(*)::bigint as open_leads,
        count(*) filter (where lead_row.temperature = 'HOT')::bigint as hot_leads
      from public.leads lead_row
      where lead_row.organization_id = target_lead.organization_id
        and lead_row.team_id = target_lead.team_id
        and lead_row.assigned_user_id = eligible_row.user_id
        and lead_row.deleted_at is null
        and lead_row.lifecycle_status <> 'Lost'
    ) book on true
  ), ranked as (
    -- The recommendation is a property of the team, not of the search box, so
    -- it is decided before any name filter is applied. It mirrors the order
    -- transfer_lead_to_sales uses for an automatic pick.
    select loaded_row.*,
      row_number() over (
        order by case when qualified_mode = 'ROUND_ROBIN' then 0 else loaded_row.open_leads end asc,
          loaded_row.last_qualified_assigned_at asc nulls first,
          loaded_row.joined_at asc,
          loaded_row.user_id
      ) = 1 as recommended
    from loaded loaded_row
  )
  select ranked_row.user_id,
    ranked_row.full_name,
    ranked_row.open_leads,
    ranked_row.hot_leads,
    ranked_row.recommended,
    coalesce(qualified_mode::text, 'MANUAL_ASSIGNMENT')
  from ranked ranked_row
  where normalized_search = ''
    or ranked_row.full_name ilike '%' || normalized_search || '%'
  order by ranked_row.open_leads asc, ranked_row.full_name, ranked_row.user_id
  limit 50;
end;
$$;

revoke all on function public.get_sales_handoff_candidates(uuid, text) from public, anon;
grant execute on function public.get_sales_handoff_candidates(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. AI voice escalation covers every automatic fresh assignment. A lead the
--    rule handed to a Telecaller who then never called is the same situation
--    whichever automatic rule chose them.
-- ---------------------------------------------------------------------------
do $migration$
declare
  signature regprocedure;
  definition text;
begin
  foreach signature in array array[
    'app_private.enqueue_ai_voice_after_assignment()'::regprocedure,
    'public.prepare_ai_voice_escalation(uuid,uuid)'::regprocedure,
    'public.authorize_ai_voice_escalation(uuid,uuid)'::regprocedure
  ] loop
    definition := pg_catalog.pg_get_functiondef(signature);
    if position('LEAST_ASSIGNED' in definition) > 0 then
      continue;
    end if;
    execute pg_temp.replace_exactly(
      definition,
      E'method = ''ROUND_ROBIN'' and ',
      E'method in (''ROUND_ROBIN'', ''LEAST_ASSIGNED'') and ',
      1,
      'AI_VOICE_LEAST_ASSIGNED_' || upper(split_part(signature::text, '(', 1))
    );
  end loop;
end;
$migration$;

commit;
