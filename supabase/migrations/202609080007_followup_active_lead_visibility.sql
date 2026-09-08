begin;

-- An owned follow-up survived its lead's soft deletion in the worklist, even
-- though validate_work_tenant_integrity correctly refused to reschedule it.
-- Filter before aggregation/pagination so rows, KPIs, tabs and calendars agree.
-- Customer-only work is still valid. Preserve existing role/scope fast paths,
-- function privileges and all historical business records.
do $migration$
declare
  target record;
  definition text;
  patched text;
  patched_count integer := 0;
begin
  for target in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'app_private' and p.proname in (
      'get_telecaller_followup_workspace_filtered_page',
      'get_sales_consultant_followup_workspace_filtered_page',
      'get_sales_consultant_followup_workspace_page',
      'get_sales_consultant_followup_calendar'
    )) or (n.nspname = 'public' and p.proname in (
      'get_followup_workspace_filtered_page',
      'get_followup_workspace_page_legacy',
      'get_followup_calendar_legacy'
    ))
  loop
    definition := pg_catalog.pg_get_functiondef(target.signature);
    patched := regexp_replace(
      definition,
      '(where followup_row.organization_id = (target|current)_organization_id)',
      E'\\1\n        and (followup_row.lead_id is null or exists (\n'
        || E'          select 1 from public.leads active_work_lead\n'
        || E'          where active_work_lead.id = followup_row.lead_id\n'
        || E'            and active_work_lead.organization_id = followup_row.organization_id\n'
        || E'            and active_work_lead.deleted_at is null\n'
        || E'        ))',
      'g'
    );
    if patched = definition then
      raise exception 'FOLLOWUP_VISIBILITY_PATCH_TARGET_NOT_FOUND: %', target.signature;
    end if;
    execute patched;
    patched_count := patched_count + 1;
  end loop;
  if patched_count <> 7 then
    raise exception 'FOLLOWUP_VISIBILITY_FUNCTION_COUNT: %', patched_count;
  end if;
end;
$migration$;

commit;
