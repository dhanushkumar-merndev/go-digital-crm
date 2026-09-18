-- "New" means created today (Asia/Kolkata), not a rolling 24-hour window.
--
-- `work_state` classified an uncontacted lead as NEW_TODAY until it turned 24
-- hours old, so My Leads kept yesterday's enquiries under New until the same
-- clock time came round again: on 16 Sept at 10:57 am a lead created 15 Sept
-- at 11:42 am was still counted New. Telecallers read that tab as "came in
-- today", and the Sales Consultant New tab already scoped itself to an
-- Asia/Kolkata calendar day on `sales_handoff_at`. This aligns the intake side
-- with that reading: an uncontacted lead is NEW_TODAY while it was created on
-- the current IST day, and becomes PENDING at IST midnight. SLA_RISK still
-- takes precedence over both, and contacted leads are unaffected.
--
-- Every lead surface derives work_state from its own copy of this CASE, so all
-- of them move together -- otherwise the same lead would read New in the list
-- and Pending on its detail page.
--
-- These functions are maintained by patching the deployed definition; the
-- migration files do not hold a current copy. Each patch asserts its target is
-- present before the rewrite and gone afterwards, so a moved target fails loud
-- instead of silently no-opping.

do $migration$
declare
  target_oids oid[];
  target_oid oid;
  target_label text;
  clock_expression text;
  old_text text;
  new_text text;
  definition text;
  patched_count integer := 0;
  leftover_count integer;
begin
  select coalesce(array_agg(p.oid), '{}'::oid[])
    into target_oids
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app_private')
    and p.prokind = 'f'
    and pg_get_functiondef(p.oid) like '%NEW_TODAY%'
    and pg_get_functiondef(p.oid) like '%lead_row.created_at + interval ''24 hours''%';

  -- Nothing left to patch is the already-applied state, not a failure: the
  -- closing leftover check below is what actually proves the rule is gone.

  foreach target_oid in array target_oids loop
    definition := pg_get_functiondef(target_oid);
    target_label := target_oid::regprocedure::text;

    -- Two spellings of the same rule: the paginated workspace functions freeze
    -- the clock in a `query_now` local, everything else calls now() inline.
    if position('query_now >= lead_row.created_at + interval ''24 hours''' in definition) > 0 then
      clock_expression := 'query_now';
    else
      clock_expression := 'now()';
    end if;

    old_text := clock_expression || ' >= lead_row.created_at + interval ''24 hours''';
    new_text := 'lead_row.created_at < pg_catalog.timezone(''Asia/Kolkata'', '
      || 'date_trunc(''day'', pg_catalog.timezone(''Asia/Kolkata'', ' || clock_expression || ')))';

    if position(old_text in definition) = 0 then
      raise exception 'LEAD_WORK_STATE_PATCH_TARGET_MISSING: %', target_label;
    end if;

    execute replace(definition, old_text, new_text);

    if position(old_text in pg_get_functiondef(target_oid)) > 0 then
      raise exception 'LEAD_WORK_STATE_PATCH_NOT_APPLIED: %', target_label;
    end if;

    patched_count := patched_count + 1;
  end loop;

  select count(*)
    into leftover_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app_private')
    and p.prokind = 'f'
    and pg_get_functiondef(p.oid) like '%NEW_TODAY%'
    and pg_get_functiondef(p.oid) like '%lead_row.created_at + interval ''24 hours''%';

  -- Deliberately the same two-part filter as the loop above: other functions
  -- use a 24-hour interval for unrelated reasons (WhatsApp reply windows, call
  -- and health rollups) and must not drag this assertion down.
  if leftover_count > 0 then
    raise exception 'LEAD_WORK_STATE_PATCH_INCOMPLETE: % function(s) still on the 24-hour rule', leftover_count;
  end if;

  raise notice 'lead work_state: patched % function(s) to the IST calendar day', patched_count;
end
$migration$;

-- `public.get_lead_workspace_kpis` counts through this view, so it carries the
-- same rule and has to move with the functions above.
do $migration$
declare
  view_definition text;
  patched text;
  old_text constant text :=
    'first_contacted_at IS NULL AND now() >= (created_at + ''24:00:00''::interval)';
  new_text constant text :=
    'first_contacted_at IS NULL AND created_at < pg_catalog.timezone(''Asia/Kolkata''::text, '
    || 'date_trunc(''day''::text, pg_catalog.timezone(''Asia/Kolkata''::text, now())))';
begin
  -- pg_get_viewdef prints `from leads lead_row` unqualified, so the replacement
  -- has to be re-parsed with public on the search_path to land on the same table.
  perform set_config('search_path', 'public', true);
  view_definition := pg_get_viewdef('public.leads_with_work_state'::regclass, true);

  if position(old_text in view_definition) = 0 then
    if position('created_at + ''24:00:00''::interval' in view_definition) > 0 then
      raise exception 'LEAD_WORK_STATE_VIEW_PATCH_TARGET_MOVED';
    end if;
    return;
  end if;

  patched := regexp_replace(replace(view_definition, old_text, new_text), ';\s*$', '');

  -- security_invoker is restated because the replacement carries only the
  -- query text; dropping it would let the view read past the caller's RLS.
  execute 'create or replace view public.leads_with_work_state '
    || 'with (security_invoker = true) as ' || patched;

  if position(old_text in pg_get_viewdef('public.leads_with_work_state'::regclass, true)) > 0 then
    raise exception 'LEAD_WORK_STATE_VIEW_PATCH_NOT_APPLIED';
  end if;
end
$migration$;
