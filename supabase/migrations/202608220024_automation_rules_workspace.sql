-- Automation is configuration owned by administrators. The runtime/dispatch
-- layer remains provider-independent; this workspace only manages auditable
-- CRM rules and reads execution evidence already written by workers.

create index if not exists automation_rules_workspace_idx
  on public.automation_rules (organization_id, enabled, updated_at desc, id);
create index if not exists automation_runs_workspace_idx
  on public.automation_runs (organization_id, started_at desc, rule_id);

create or replace function public.get_automation_rules_workspace(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default null,
  target_status text default 'ALL'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := left(btrim(coalesce(target_search, '')), 80);
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page < 1 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_PAGE';
  end if;
  if normalized_status not in ('ALL', 'ACTIVE', 'DRAFT') then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_STATUS';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;

  with filtered_rules as materialized (
    select rule_row.*
    from public.automation_rules rule_row
    where rule_row.organization_id = current_organization_id
      and (normalized_status = 'ALL'
        or (normalized_status = 'ACTIVE' and rule_row.enabled)
        or (normalized_status = 'DRAFT' and not rule_row.enabled))
      and (normalized_search = '' or rule_row.name ilike '%' || normalized_search || '%'
        or rule_row.event_type ilike '%' || normalized_search || '%')
  ),
  paged_rules as materialized (
    select rule_row.*
    from filtered_rules rule_row
    order by rule_row.updated_at desc, rule_row.id desc
    limit target_page_size offset ((target_page - 1) * target_page_size)
  ),
  run_summary as materialized (
    select
      count(*) filter (where run_row.status = 'COMPLETED')::integer as succeeded,
      count(*) filter (where run_row.status in ('FAILED', 'ERROR'))::integer as failed,
      count(*) filter (where run_row.status in ('PENDING', 'QUEUED', 'RUNNING'))::integer as pending
    from public.automation_runs run_row
    where run_row.organization_id = current_organization_id
      and run_row.started_at >= now() - interval '30 days'
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rule_row.id,
        'name', rule_row.name,
        'event_type', rule_row.event_type,
        'condition_summary', coalesce(rule_row.conditions ->> 'summary', 'Always'),
        'action_summary', coalesce(rule_row.actions ->> 'summary', 'No action configured'),
        'enabled', rule_row.enabled,
        'created_at', rule_row.created_at,
        'updated_at', rule_row.updated_at,
        'created_by_name', coalesce(profile_row.full_name, profile_row.email, 'Unknown user'),
        'execution_count', (select count(*)::integer from public.automation_runs run_row
          where run_row.organization_id = current_organization_id and run_row.rule_id = rule_row.id),
        'success_rate', coalesce((select round(100.0 * count(*) filter (where run_row.status = 'COMPLETED')
          / nullif(count(*), 0), 1) from public.automation_runs run_row
          where run_row.organization_id = current_organization_id and run_row.rule_id = rule_row.id), 0)
      ) order by rule_row.updated_at desc, rule_row.id desc)
      from paged_rules rule_row
      left join public.profiles profile_row
        on profile_row.id = rule_row.created_by and profile_row.organization_id = rule_row.organization_id
    ), '[]'::jsonb),
    'total', (select count(*)::integer from filtered_rules),
    'kpis', jsonb_build_object(
      'total_rules', (select count(*)::integer from public.automation_rules where organization_id = current_organization_id),
      'active_rules', (select count(*)::integer from public.automation_rules where organization_id = current_organization_id and enabled),
      'draft_rules', (select count(*)::integer from public.automation_rules where organization_id = current_organization_id and not enabled),
      'failed_runs_today', (select count(*)::integer from public.automation_runs
        where organization_id = current_organization_id and status in ('FAILED', 'ERROR') and started_at >= date_trunc('day', now()))
    ),
    'execution_summary', jsonb_build_object(
      'succeeded', coalesce((select succeeded from run_summary), 0),
      'failed', coalesce((select failed from run_summary), 0),
      'pending', coalesce((select pending from run_summary), 0)
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.create_automation_rule(
  target_name text,
  target_event_type text,
  target_condition_summary text,
  target_action_type text,
  target_action_summary text,
  target_enabled boolean,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_name text := btrim(coalesce(target_name, ''));
  normalized_event text := upper(btrim(coalesce(target_event_type, '')));
  normalized_condition text := btrim(coalesce(target_condition_summary, ''));
  normalized_action_type text := upper(btrim(coalesce(target_action_type, '')));
  normalized_action_summary text := btrim(coalesce(target_action_summary, ''));
  rule_id uuid := gen_random_uuid();
  fingerprint jsonb;
  replay_fingerprint jsonb;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null
    or char_length(normalized_name) not between 2 and 120
    or normalized_event not in ('LEAD_CREATED', 'LEAD_UPDATED', 'TEST_DRIVE_COMPLETED', 'BOOKING_CONFIRMED', 'QUOTATION_SENT', 'DELIVERY_COMPLETED')
    or normalized_action_type not in ('ASSIGN_LEAD', 'CREATE_FOLLOWUP', 'CREATE_TASK', 'SEND_ALERT', 'SEND_REMINDER')
    or char_length(normalized_condition) > 500
    or char_length(normalized_action_summary) not between 2 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_RULE_INPUT';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;

  fingerprint := jsonb_build_object(
    'name', normalized_name, 'event_type', normalized_event,
    'condition', normalized_condition, 'action_type', normalized_action_type,
    'action_summary', normalized_action_summary, 'enabled', target_enabled
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  select audit_row.metadata -> 'fingerprint', audit_row.metadata -> 'result'
    into replay_fingerprint, replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'automation_rule.created'
    and audit_row.request_id = target_request_id
  order by audit_row.id desc limit 1;
  if replay_result is not null then
    if replay_fingerprint is distinct from fingerprint then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
    end if;
    return replay_result || jsonb_build_object('replayed', true);
  end if;

  insert into public.automation_rules (
    id, organization_id, name, event_type, conditions, actions, enabled, created_by
  ) values (
    rule_id, current_organization_id, normalized_name, normalized_event,
    jsonb_build_object('summary', nullif(normalized_condition, '')),
    jsonb_build_object('type', normalized_action_type, 'summary', normalized_action_summary),
    target_enabled, auth.uid()
  );
  result := jsonb_build_object('id', rule_id, 'enabled', target_enabled, 'replayed', false);
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'automation_rule.created', 'automation_rule', rule_id::text,
    target_request_id, jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.set_automation_rule_enabled(
  target_rule_id uuid,
  target_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  update public.automation_rules
    set enabled = target_enabled, updated_at = now()
    where id = target_rule_id and organization_id = current_organization_id;
  if not found then raise exception using errcode = 'P0002', message = 'AUTOMATION_RULE_NOT_FOUND'; end if;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
    values (current_organization_id, auth.uid(), 'automation_rule.enabled_changed', 'automation_rule',
      target_rule_id::text, jsonb_build_object('enabled', target_enabled));
  return true;
end;
$$;

revoke all on function public.get_automation_rules_workspace(integer, integer, text, text) from public, anon;
grant execute on function public.get_automation_rules_workspace(integer, integer, text, text) to authenticated;
revoke all on function public.create_automation_rule(text, text, text, text, text, boolean, uuid) from public, anon;
grant execute on function public.create_automation_rule(text, text, text, text, text, boolean, uuid) to authenticated;
revoke all on function public.set_automation_rule_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_automation_rule_enabled(uuid, boolean) to authenticated;
