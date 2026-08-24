begin;

-- These timestamp columns were added to the originating master-data migration
-- after its first remote application. Keep the forward repair idempotent while
-- bringing already-linked databases to the same shape as a fresh chain.
alter table public.vehicle_brands
  add column if not exists created_at timestamptz not null default now();

alter table public.vehicle_models
  add column if not exists created_at timestamptz not null default now();

alter table public.lead_sources
  add column if not exists created_at timestamptz not null default now();

-- Recreate the installed functions in place so their OIDs, comments and
-- existing privileges remain intact. Each repair accepts both the originally
-- deployed body and the corrected fresh-chain body, then verifies the final
-- definition before executing it.
do $repair$
declare
  installed_definition text;
  repaired_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'app_private.tenant_performance_dashboard(integer,text,boolean)'::regprocedure
  ) into installed_definition;
  repaired_definition := replace(
    installed_definition,
    $old$(activity_result -> (day_row.row_index - 1) ->> 'value')::bigint$old$,
    $new$(activity_result -> ((day_row.row_index - 1)::integer) ->> 'value')::bigint$new$
  );
  if position(
    'activity_result -> ((day_row.row_index - 1)::integer)' in repaired_definition
  ) = 0 then
    raise exception 'TENANT_DASHBOARD_LINT_REPAIR_FAILED';
  end if;
  execute repaired_definition;

  select pg_catalog.pg_get_functiondef(
    'public.complete_followup(uuid,bigint,text,uuid)'::regprocedure
  ) into installed_definition;
  repaired_definition := replace(
    installed_definition,
    $old$  manager_override boolean;
  result jsonb;$old$,
    $new$  manager_override boolean;
  normalized_completion_note text;
  result jsonb;$new$
  );
  repaired_definition := replace(
    repaired_definition,
    $old$  if char_length(btrim(coalesce(completion_note, ''))) > 1000 then
    raise exception using errcode = '22023', message = 'COMPLETION_NOTE_TOO_LONG';
  end if;

  select * into current_row$old$,
    $new$  if char_length(btrim(coalesce(completion_note, ''))) > 1000 then
    raise exception using errcode = '22023', message = 'COMPLETION_NOTE_TOO_LONG';
  end if;
  normalized_completion_note := nullif(btrim(completion_note), '');

  select * into current_row$new$
  );
  repaired_definition := replace(
    repaired_definition,
    $old$    'completion_note', nullif(btrim(completion_note), '')$old$,
    $new$    'completion_note', normalized_completion_note$new$
  );
  repaired_definition := replace(
    repaired_definition,
    $old$      completion_note = nullif(btrim(completion_note), ''),$old$,
    $new$      completion_note = normalized_completion_note,$new$
  );
  if position('normalized_completion_note text;' in repaired_definition) = 0
    or position('completion_note = normalized_completion_note' in repaired_definition) = 0
  then
    raise exception 'COMPLETE_FOLLOWUP_LINT_REPAIR_FAILED';
  end if;
  execute repaired_definition;

  select pg_catalog.pg_get_functiondef(
    'public.get_inbox_conversation_page(text,text,integer,integer)'::regprocedure
  ) into installed_definition;
  repaired_definition := replace(
    installed_definition,
    $old$  )
  select count(*) into total_rows from filtered;

  select coalesce(jsonb_agg(jsonb_build_object($old$,
    $new$  )
  select (select count(*) from filtered), coalesce(jsonb_agg(jsonb_build_object($new$
  );
  repaired_definition := replace(
    repaired_definition,
    $old$  into rows_data
  from page_rows page_row$old$,
    $new$  into total_rows, rows_data
  from page_rows page_row$new$
  );
  if position('select (select count(*) from filtered), coalesce' in repaired_definition) = 0
    or position('into total_rows, rows_data' in repaired_definition) = 0
  then
    raise exception 'INBOX_CONVERSATION_PAGE_LINT_REPAIR_FAILED';
  end if;
  execute repaired_definition;

  select pg_catalog.pg_get_functiondef(
    'public.get_master_data_workspace(text,integer,integer,text)'::regprocedure
  ) into installed_definition;
  if position(
    $marker$'created_at', model_row.created_at$marker$ in installed_definition
  ) = 0 then
    raise exception 'MASTER_DATA_WORKSPACE_LINT_REPAIR_FAILED';
  end if;
  execute installed_definition;

  select pg_catalog.pg_get_functiondef(
    'public.get_operational_case_detail(text,uuid)'::regprocedure
  ) into installed_definition;
  repaired_definition := replace(
    installed_definition,
    'order by item_row.category, item_row.created_at, item_row.id',
    'order by item_row.category, item_row.updated_at, item_row.id'
  );
  if position(
    'order by item_row.category, item_row.updated_at, item_row.id' in repaired_definition
  ) = 0 then
    raise exception 'OPERATIONAL_CASE_DETAIL_LINT_REPAIR_FAILED';
  end if;
  execute repaired_definition;

  select pg_catalog.pg_get_functiondef(
    'public.get_call_provider_options(uuid)'::regprocedure
  ) into installed_definition;
  repaired_definition := replace(
    installed_definition,
    $old$  organization_id uuid;$old$,
    $new$  current_organization_id uuid;$new$
  );
  repaired_definition := replace(
    repaired_definition,
    'into organization_id',
    'into current_organization_id'
  );
  repaired_definition := replace(
    repaired_definition,
    'if organization_id is null',
    'if current_organization_id is null'
  );
  repaired_definition := replace(
    repaired_definition,
    $old$app_private.has_permission(organization_id, 'call.create')$old$,
    $new$app_private.has_permission(current_organization_id, 'call.create')$new$
  );
  repaired_definition := replace(
    repaired_definition,
    'app_private.can_access_branch(organization_id, target_branch_id)',
    'app_private.can_access_branch(current_organization_id, target_branch_id)'
  );
  repaired_definition := replace(
    repaired_definition,
    'connection_row.organization_id = organization_id',
    'connection_row.organization_id = current_organization_id'
  );
  repaired_definition := replace(
    repaired_definition,
    'mapping_row.organization_id = organization_id',
    'mapping_row.organization_id = current_organization_id'
  );
  if position('current_organization_id uuid;' in repaired_definition) = 0
    or position(
      'connection_row.organization_id = current_organization_id' in repaired_definition
    ) = 0
    or position(
      'mapping_row.organization_id = current_organization_id' in repaired_definition
    ) = 0
  then
    raise exception 'CALL_PROVIDER_OPTIONS_LINT_REPAIR_FAILED';
  end if;
  execute repaired_definition;

  select pg_catalog.pg_get_functiondef(
    'public.review_ai_call_fields(uuid,jsonb,uuid)'::regprocedure
  ) into installed_definition;
  repaired_definition := replace(
    installed_definition,
    $old$nullif(resolved_value #>> '', '')::public.lead_temperature$old$,
    $new$nullif(resolved_value #>> '{}', '')::public.lead_temperature$new$
  );
  if position(
    $marker$nullif(resolved_value #>> '{}', '')::public.lead_temperature$marker$
      in repaired_definition
  ) = 0 then
    raise exception 'AI_CALL_FIELD_REVIEW_LINT_REPAIR_FAILED';
  end if;
  execute repaired_definition;
end;
$repair$;

revoke all on function app_private.tenant_performance_dashboard(integer, text, boolean)
  from public, anon, authenticated;

revoke all on function public.complete_followup(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.complete_followup(uuid, bigint, text, uuid) to authenticated;

revoke all on function public.get_inbox_conversation_page(text, text, integer, integer)
  from public, anon;
grant execute on function public.get_inbox_conversation_page(text, text, integer, integer)
  to authenticated;

revoke all on function public.get_master_data_workspace(text, integer, integer, text)
  from public, anon;
grant execute on function public.get_master_data_workspace(text, integer, integer, text)
  to authenticated;

revoke all on function public.get_operational_case_detail(text, uuid) from public, anon;
grant execute on function public.get_operational_case_detail(text, uuid) to authenticated;

revoke all on function public.get_call_provider_options(uuid) from public, anon;
grant execute on function public.get_call_provider_options(uuid) to authenticated;

revoke all on function public.review_ai_call_fields(uuid, jsonb, uuid) from public, anon;
grant execute on function public.review_ai_call_fields(uuid, jsonb, uuid) to authenticated;

commit;
