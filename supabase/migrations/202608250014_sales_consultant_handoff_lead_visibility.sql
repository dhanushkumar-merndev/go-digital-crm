begin;

-- Sales Consultants start only after Telecaller/BDC hands a qualified lead to
-- Sales. For this role, New means a handoff that happened today; it never
-- means the source lead's original New lifecycle.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'  query_now timestamptz := now();\n',
    E'  query_now timestamptz := now();\n  actor_is_sales_consultant boolean := false;\n'
  );
  updated_definition := replace(
    updated_definition,
    E'  normalized_search := left(',
    E'  select exists (\n    select 1\n    from public.user_role_assignments assignment_row\n    join public.roles role_row\n      on role_row.id = assignment_row.role_id\n     and role_row.organization_id = assignment_row.organization_id\n    where assignment_row.organization_id = target_organization_id\n      and assignment_row.user_id = target_actor_id\n      and assignment_row.active\n      and role_row.role_key = ''sales_consultant''\n  ) into actor_is_sales_consultant;\n\n  normalized_search := left('
  );
  updated_definition := replace(
    updated_definition,
    E'        lead_row.next_followup_at,\n',
    E'        lead_row.next_followup_at,\n        (\n          select max(handoff_history.created_at)\n          from public.lead_stage_history handoff_history\n          where handoff_history.organization_id = lead_row.organization_id\n            and handoff_history.lead_id = lead_row.id\n            and handoff_history.to_status = ''Transferred to Sales''\n        ) as sales_handoff_at,\n'
  );
  updated_definition := replace(
    updated_definition,
    E'      where lead_row.organization_id = target_organization_id\n        and lead_row.deleted_at is null\n        and (\n          target_organization_wide',
    E'      where lead_row.organization_id = target_organization_id\n        and lead_row.deleted_at is null\n        and (\n          not actor_is_sales_consultant\n          or (\n            lead_row.lifecycle_status in (''Transferred to Sales'', ''Appointment Scheduled'', ''Lost'')\n            and exists (\n              select 1\n              from public.lead_stage_history handoff_history\n              where handoff_history.organization_id = target_organization_id\n                and handoff_history.lead_id = lead_row.id\n                and handoff_history.to_status = ''Transferred to Sales''\n            )\n          )\n        )\n        and (\n          target_organization_wide'
  );
  updated_definition := replace(
    updated_definition,
    E'        or (target_status = ''new-today'' and lead_row.work_state = ''NEW_TODAY'')',
    E'        or (\n          target_status = ''new-today''\n          and (\n            (\n              actor_is_sales_consultant\n              and lead_row.sales_handoff_at >= pg_catalog.timezone(\n                ''Asia/Kolkata'',\n                date_trunc(''day'', pg_catalog.timezone(''Asia/Kolkata'', query_now))\n              )\n              and lead_row.sales_handoff_at < pg_catalog.timezone(\n                ''Asia/Kolkata'',\n                date_trunc(''day'', pg_catalog.timezone(''Asia/Kolkata'', query_now)) + interval ''1 day''\n              )\n            )\n            or (not actor_is_sales_consultant and lead_row.work_state = ''NEW_TODAY'')\n          )\n        )'
  );
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where work_state = ''NEW_TODAY'')::bigint as new_today,',
    E'        count(*) filter (where (\n          actor_is_sales_consultant\n          and sales_handoff_at >= pg_catalog.timezone(\n            ''Asia/Kolkata'',\n            date_trunc(''day'', pg_catalog.timezone(''Asia/Kolkata'', query_now))\n          )\n          and sales_handoff_at < pg_catalog.timezone(\n            ''Asia/Kolkata'',\n            date_trunc(''day'', pg_catalog.timezone(''Asia/Kolkata'', query_now)) + interval ''1 day''\n          )\n        ) or (not actor_is_sales_consultant and work_state = ''NEW_TODAY''))::bigint as new_today,'
  );

  if updated_definition = definition
    or position('actor_is_sales_consultant' in updated_definition) = 0
    or position('sales_handoff_at' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'SALES_CONSULTANT_HANDOFF_FILTER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
