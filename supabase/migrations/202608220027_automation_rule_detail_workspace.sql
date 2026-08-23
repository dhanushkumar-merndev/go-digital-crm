create or replace function public.get_automation_rule_detail(target_rule_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  rule_record public.automation_rules%rowtype;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage') then
    raise exception using errcode = '42501', message = 'AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into rule_record from public.automation_rules
    where id = target_rule_id and organization_id = current_organization_id;
  if not found then raise exception using errcode = 'P0002', message = 'AUTOMATION_RULE_NOT_FOUND'; end if;
  return jsonb_build_object(
    'rule', jsonb_build_object(
      'id', rule_record.id, 'name', rule_record.name, 'event_type', rule_record.event_type,
      'conditions', rule_record.conditions, 'actions', rule_record.actions, 'enabled', rule_record.enabled,
      'created_at', rule_record.created_at, 'updated_at', rule_record.updated_at,
      'created_by_name', coalesce((select profile_row.full_name from public.profiles profile_row where profile_row.id = rule_record.created_by), 'System')
    ),
    'statistics', jsonb_build_object(
      'total', (select count(*)::integer from public.automation_runs where rule_id = rule_record.id),
      'succeeded', (select count(*)::integer from public.automation_runs where rule_id = rule_record.id and upper(status) in ('SUCCESS', 'SUCCEEDED', 'COMPLETED')),
      'failed', (select count(*)::integer from public.automation_runs where rule_id = rule_record.id and upper(status) in ('FAILED', 'ERROR')),
      'pending', (select count(*)::integer from public.automation_runs where rule_id = rule_record.id and upper(status) in ('PENDING', 'RUNNING', 'QUEUED')),
      'last_execution_at', (select max(started_at) from public.automation_runs where rule_id = rule_record.id)
    ),
    'runs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', run_row.id, 'status', run_row.status, 'result', run_row.result,
        'started_at', run_row.started_at, 'completed_at', run_row.completed_at
      ) order by run_row.started_at desc, run_row.id desc)
      from (select * from public.automation_runs where rule_id = rule_record.id order by started_at desc, id desc limit 25) run_row
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_automation_rule_detail(uuid) from public, anon;
grant execute on function public.get_automation_rule_detail(uuid) to authenticated;
