begin;

-- A sales handoff changes leads.assigned_user_id to the consultant. Keep that
-- active ownership invariant, while allowing the outgoing Telecaller to retain
-- a historical read-only view of the lead they handed off.
create or replace function app_private.is_telecaller_handoff_viewer(
  target_organization_id uuid,
  target_lead_id uuid,
  target_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.leads lead_row
    where lead_row.organization_id = target_organization_id
      and lead_row.id = target_lead_id
      and lead_row.deleted_at is null
      and lead_row.assigned_user_id is distinct from target_actor_id
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.organization_id = assignment_row.organization_id
         and role_row.id = assignment_row.role_id
        join public.profiles profile_row
          on profile_row.organization_id = assignment_row.organization_id
         and profile_row.id = assignment_row.user_id
        where assignment_row.organization_id = target_organization_id
          and assignment_row.user_id = target_actor_id
          and assignment_row.active
          and role_row.role_key = 'telecaller_bdc'
          and profile_row.active
          and profile_row.deleted_at is null
      )
      and exists (
        select 1
        from public.lead_assignment_history history_row
        where history_row.organization_id = target_organization_id
          and history_row.lead_id = target_lead_id
          and history_row.previous_owner_id = target_actor_id
          and history_row.new_owner_id is not null
      )
      and exists (
        select 1
        from public.lead_stage_history stage_row
        where stage_row.organization_id = target_organization_id
          and stage_row.lead_id = target_lead_id
          and stage_row.to_status = 'Transferred to Sales'
      )
  );
$$;

revoke all on function app_private.is_telecaller_handoff_viewer(uuid, uuid, uuid)
  from public, anon, authenticated;

-- Admit past Telecaller handoffs to the list scope, label them for the client,
-- and keep them out of active-work tabs. They remain in All, Transferred to
-- Sales, and the Telecaller's personal Starred view.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'  actor_is_sales_consultant boolean := false;\n',
    E'  actor_is_sales_consultant boolean := false;\n'
      || E'  actor_is_telecaller boolean := false;\n'
  );
  updated_definition := replace(
    updated_definition,
    E'  ) into actor_is_sales_consultant;\n\n  normalized_search :=',
    E'  ) into actor_is_sales_consultant;\n\n'
      || E'  select exists (\n'
      || E'    select 1\n'
      || E'    from public.user_role_assignments assignment_row\n'
      || E'    join public.roles role_row\n'
      || E'      on role_row.id = assignment_row.role_id\n'
      || E'     and role_row.organization_id = assignment_row.organization_id\n'
      || E'    where assignment_row.organization_id = target_organization_id\n'
      || E'      and assignment_row.user_id = target_actor_id\n'
      || E'      and assignment_row.active\n'
      || E'      and role_row.role_key = ''telecaller_bdc''\n'
      || E'  ) into actor_is_telecaller;\n\n'
      || E'  normalized_search :='
  );
  updated_definition := replace(
    updated_definition,
    E'        lead_row.next_followup_at,\n        (\n          select max(handoff_history.created_at)',
    E'        lead_row.next_followup_at,\n'
      || E'        actor_is_telecaller and app_private.is_telecaller_handoff_viewer(\n'
      || E'          target_organization_id, lead_row.id, target_actor_id\n'
      || E'        ) as is_handoff_read_only,\n'
      || E'        (\n          select max(handoff_history.created_at)'
  );
  updated_definition := replace(
    updated_definition,
    E'          or (\n            target_owner_scope\n            and lead_row.assigned_user_id = target_actor_id\n            and lead_row.branch_id = any(target_owner_branch_ids)\n          )',
    E'          or (\n'
      || E'            target_owner_scope\n'
      || E'            and lead_row.branch_id = any(target_owner_branch_ids)\n'
      || E'            and (\n'
      || E'              lead_row.assigned_user_id = target_actor_id\n'
      || E'              or (\n'
      || E'                actor_is_telecaller\n'
      || E'                and app_private.is_telecaller_handoff_viewer(\n'
      || E'                  target_organization_id, lead_row.id, target_actor_id\n'
      || E'                )\n'
      || E'              )\n'
      || E'            )\n'
      || E'          )'
  );
  updated_definition := replace(
    updated_definition,
    E'      from staged_leads lead_row\n      where (\n        target_status = ''all''',
    E'      from staged_leads lead_row\n'
      || E'      where (\n'
      || E'        not lead_row.is_handoff_read_only\n'
      || E'        or target_status in (''all'', ''transferred-to-sales'', ''starred'')\n'
      || E'      )\n'
      || E'      and (\n        target_status = ''all'''
  );
  updated_definition := replace(
    updated_definition,
    E'        lead_row.assigned_user_id,\n        stage_row.work_state,',
    E'        lead_row.assigned_user_id,\n'
      || E'        stage_row.is_handoff_read_only,\n'
      || E'        stage_row.work_state,'
  );
  updated_definition := replace(
    updated_definition,
    E'          ''assigned_user_name'', assigned_user_name,\n          ''phone_lead_count'', phone_lead_count,',
    E'          ''assigned_user_name'', assigned_user_name,\n'
      || E'          ''read_only'', is_handoff_read_only,\n'
      || E'          ''phone_lead_count'', phone_lead_count,'
  );

  if updated_definition = definition
    or position('actor_is_telecaller boolean' in updated_definition) = 0
    or position('as is_handoff_read_only' in updated_definition) = 0
    or position('''read_only'', is_handoff_read_only' in updated_definition) = 0
    or position('target_status in (''all'', ''transferred-to-sales'', ''starred'')' in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'TELECALLER_HANDOFF_LIST_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

-- The accordion has its own scoped RPC. Apply the same past-owner admission so
-- a visible handoff group can still show all scoped lifetime enquiries.
do $migration$
declare
  signature regprocedure := 'public.get_lead_phone_history(uuid)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'  actor_is_sales_consultant boolean := false;\n',
    E'  actor_is_sales_consultant boolean := false;\n'
      || E'  actor_is_telecaller boolean := false;\n'
  );
  updated_definition := replace(
    updated_definition,
    E'  actor_is_sales_consultant := access_context->>''role_key'' = ''sales-consultant'';\n',
    E'  actor_is_sales_consultant := access_context->>''role_key'' = ''sales-consultant'';\n'
      || E'  actor_is_telecaller := access_context->>''role_key'' = ''telecaller'';\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        workspace_scope.owner_scope\n        and lead_row.assigned_user_id = auth.uid()\n        and lead_row.branch_id = any(workspace_scope.owner_branch_ids)\n',
    E'        workspace_scope.owner_scope\n'
      || E'        and lead_row.branch_id = any(workspace_scope.owner_branch_ids)\n'
      || E'        and (\n'
      || E'          lead_row.assigned_user_id = auth.uid()\n'
      || E'          or (\n'
      || E'            actor_is_telecaller\n'
      || E'            and app_private.is_telecaller_handoff_viewer(\n'
      || E'              current_organization_id, lead_row.id, auth.uid()\n'
      || E'            )\n'
      || E'          )\n'
      || E'        )\n'
  );
  updated_definition := replace(
    updated_definition,
    E'            workspace_scope.owner_scope\n            and lead_row.assigned_user_id = auth.uid()\n            and lead_row.branch_id = any(workspace_scope.owner_branch_ids)\n',
    E'            workspace_scope.owner_scope\n'
      || E'            and lead_row.branch_id = any(workspace_scope.owner_branch_ids)\n'
      || E'            and (\n'
      || E'              lead_row.assigned_user_id = auth.uid()\n'
      || E'              or (\n'
      || E'                actor_is_telecaller\n'
      || E'                and app_private.is_telecaller_handoff_viewer(\n'
      || E'                  current_organization_id, lead_row.id, auth.uid()\n'
      || E'                )\n'
      || E'              )\n'
      || E'            )\n'
  );

  if updated_definition = definition
    or position('actor_is_telecaller boolean' in updated_definition) = 0
    or (length(updated_definition) - length(replace(
      updated_definition,
      'app_private.is_telecaller_handoff_viewer(',
      ''
    ))) / length('app_private.is_telecaller_handoff_viewer(') < 2
  then
    raise exception using
      errcode = 'P0001',
      message = 'TELECALLER_HANDOFF_PHONE_HISTORY_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

-- Lead Details is a separate read RPC. Admit the same historical viewer and
-- explicitly mark the response read-only so the UI removes every mutation and
-- contact action while preserving navigation to Customer 360.
do $migration$
declare
  signature regprocedure := 'public.get_lead_detail_workspace(uuid)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'  can_update boolean := false;\n',
    E'  can_update boolean := false;\n  handoff_read_only boolean := false;\n'
  );
  updated_definition := replace(
    updated_definition,
    E'  if auth.uid() is null or target_lead_id is null\n    or not app_private.can_access_lead(target_lead_id) then',
    E'  if auth.uid() is null or target_lead_id is null\n'
      || E'    or not (\n'
      || E'      app_private.can_access_lead(target_lead_id)\n'
      || E'      or exists (\n'
      || E'        select 1\n'
      || E'        from public.leads access_lead_row\n'
      || E'        where access_lead_row.id = target_lead_id\n'
      || E'          and access_lead_row.deleted_at is null\n'
      || E'          and app_private.is_telecaller_handoff_viewer(\n'
      || E'            access_lead_row.organization_id, access_lead_row.id, auth.uid()\n'
      || E'          )\n'
      || E'      )\n'
      || E'    ) then'
  );
  updated_definition := replace(
    updated_definition,
    E'  if not found then\n    raise exception using errcode = ''P0002'', message = ''LEAD_NOT_FOUND'';\n  end if;\n\n  can_followups :=',
    E'  if not found then\n'
      || E'    raise exception using errcode = ''P0002'', message = ''LEAD_NOT_FOUND'';\n'
      || E'  end if;\n\n'
      || E'  handoff_read_only := app_private.is_telecaller_handoff_viewer(\n'
      || E'    lead_row.organization_id, lead_row.id, auth.uid()\n'
      || E'  );\n\n'
      || E'  can_followups :='
  );
  updated_definition := replace(
    updated_definition,
    E'  can_update := app_private.has_permission(lead_row.organization_id, ''lead.update'');\n',
    E'  can_update := not handoff_read_only\n'
      || E'    and app_private.has_permission(lead_row.organization_id, ''lead.update'');\n'
  );
  updated_definition := replace(
    updated_definition,
    E'      ''can_update'', can_update,\n      ''can_followups'', can_followups,',
    E'      ''can_update'', can_update,\n'
      || E'      ''read_only'', handoff_read_only,\n'
      || E'      ''can_followups'', can_followups,'
  );

  if updated_definition = definition
    or position('handoff_read_only boolean' in updated_definition) = 0
    or position('''read_only'', handoff_read_only' in updated_definition) = 0
    or position('can_update := not handoff_read_only' in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'TELECALLER_HANDOFF_DETAIL_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
