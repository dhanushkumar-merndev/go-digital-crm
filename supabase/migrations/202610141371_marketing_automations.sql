begin;

-- Marketing automations: "when this happens, do that" rules a Digital Marketing
-- user switches on and off.
--
-- A rule watches one event -- a new lead, a lead moving to a stage, a lead's
-- temperature changing, a completed test drive, a booking, a delivery -- narrowed
-- by lead source, interested model and temperature, and runs one or both actions:
--   * START_DRIP: start a drip campaign whose trigger is AUTOMATION (a drip that
--     only automations start). The drip pass enrolls it with every rule a drip
--     already has: DORMANT suppression, opt-outs, reachable channel, priority.
--   * NOTIFY_OWNER: an in-app notification to the lead owner, and optionally the
--     team manager, through the existing notification centre.
--
-- Rules share automation_rules / automation_runs with the System Administrator
-- page, told apart by `module`. The administrator RPCs only read ADMIN rules, so
-- neither page can rewrite the other's rule shape.
--
-- run_marketing_automations is set-based and idempotent per (rule, occurrence):
-- a unique occurrence key per run means an event is acted on once however many
-- passes see it. It runs at the start of the existing per-minute drip event
-- pass, so a drip it requests is enrolled in that same pass and no worker
-- redeploy is needed. Only events after the rule was switched on, and at most
-- three days old, are considered, so switching a rule on never replays history.
--
-- Existing bodies are text-patched from the deployed pg_get_functiondef.

-- Rules -------------------------------------------------------------------------
alter table public.automation_rules
  add column if not exists module text not null default 'ADMIN',
  add column if not exists branch_id uuid references public.branches(id),
  add column if not exists description text,
  add column if not exists activated_at timestamptz,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_by uuid references public.profiles(id),
  add column if not exists deleted_at timestamptz;

alter table public.automation_rules
  drop constraint if exists automation_rules_module_check,
  add constraint automation_rules_module_check check (module in ('ADMIN', 'MARKETING')),
  drop constraint if exists automation_rules_marketing_event_check,
  add constraint automation_rules_marketing_event_check check (
    module <> 'MARKETING' or event_type in (
      'LEAD_CREATED', 'LEAD_STAGE_CHANGED', 'LEAD_TEMPERATURE_CHANGED',
      'TEST_DRIVE_COMPLETED', 'BOOKING_CONFIRMED', 'VEHICLE_DELIVERED'
    )
  ),
  drop constraint if exists automation_rules_version_check,
  add constraint automation_rules_version_check check (version > 0);

create index if not exists automation_rules_marketing_enabled_idx
  on public.automation_rules (organization_id, event_type)
  where module = 'MARKETING' and enabled and deleted_at is null;

-- Runs: one per rule and occurrence -------------------------------------------
alter table public.automation_runs
  add column if not exists occurrence_key text,
  add column if not exists lead_id uuid references public.leads(id),
  add column if not exists customer_id uuid references public.customers(id),
  add column if not exists branch_id uuid references public.branches(id),
  add column if not exists drip_campaign_id uuid references public.marketing_drip_campaigns(id);

alter table public.automation_runs
  drop constraint if exists automation_runs_occurrence_key_check,
  add constraint automation_runs_occurrence_key_check
    check (occurrence_key is null or char_length(occurrence_key) between 3 and 160);

create unique index if not exists automation_runs_occurrence_idx
  on public.automation_runs (rule_id, occurrence_key)
  where occurrence_key is not null;
create index if not exists automation_runs_drip_request_idx
  on public.automation_runs (drip_campaign_id, started_at)
  where drip_campaign_id is not null;

-- The runner reads each source by tenant and time.
create index if not exists lead_stage_history_org_created_idx
  on public.lead_stage_history (organization_id, created_at);
create index if not exists lead_temperature_history_org_created_idx
  on public.lead_temperature_history (organization_id, created_at);
create index if not exists test_drives_org_completed_idx
  on public.test_drives (organization_id, completed_at)
  where status = 'COMPLETED';
create index if not exists delivery_cases_org_delivered_idx
  on public.delivery_cases (organization_id, delivered_at)
  where status = 'DELIVERED' and deleted_at is null;

-- The marketing page refreshes when a rule changes. Runs are not broadcast: a
-- busy tenant writes several a minute.
drop trigger if exists realtime_automation_rules_invalidate on public.automation_rules;
create trigger realtime_automation_rules_invalidate
  after insert or update on public.automation_rules
  for each row execute function app_private.broadcast_tenant_invalidation('marketing');

-- Drips that only an automation starts -----------------------------------------
alter table public.marketing_drip_campaigns
  drop constraint if exists marketing_drip_campaigns_trigger_type_check,
  add constraint marketing_drip_campaigns_trigger_type_check check (trigger_type in (
    'AUDIENCE', 'LEAD_CREATED', 'BIRTHDAY', 'ANNIVERSARY', 'BOOKING_CONFIRMED',
    'VEHICLE_DELIVERED', 'DELIVERY_ANNIVERSARY', 'AUTOMATION'
  ));

-- Validates and normalizes one rule payload; raises on anything invalid.
create or replace function app_private.normalize_marketing_automation_payload(
  target_organization_id uuid, target_branch_id uuid, target_payload jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  payload jsonb := coalesce(target_payload, '{}'::jsonb);
  event_value text := upper(btrim(coalesce(payload ->> 'event_type', '')));
  conditions jsonb := coalesce(payload -> 'conditions', '{}'::jsonb);
  action_items jsonb := coalesce(payload -> 'actions', '[]'::jsonb);
  action_value jsonb;
  action_type text;
  seen_actions text[] := '{}'::text[];
  normalized_actions jsonb := '[]'::jsonb;
  drip_row public.marketing_drip_campaigns%rowtype;
  stages jsonb;
  temperatures jsonb;
  event_label text;
  action_labels text[] := '{}'::text[];
  condition_labels text[] := '{}'::text[];
begin
  if char_length(btrim(coalesce(payload ->> 'name', ''))) not between 3 and 180
    or char_length(coalesce(payload ->> 'description', '')) > 2000 then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_NAME';
  end if;
  event_label := case event_value
    when 'LEAD_CREATED' then 'New lead'
    when 'LEAD_STAGE_CHANGED' then 'Lead stage changes'
    when 'LEAD_TEMPERATURE_CHANGED' then 'Lead temperature changes'
    when 'TEST_DRIVE_COMPLETED' then 'Test drive completed'
    when 'BOOKING_CONFIRMED' then 'Booking confirmed'
    when 'VEHICLE_DELIVERED' then 'Vehicle delivered'
  end;
  if event_label is null then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_EVENT';
  end if;
  if jsonb_typeof(conditions) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(conditions) condition_key
      where condition_key not in ('sources', 'models', 'temperatures', 'stages')
    )
    or exists (
      select 1 from (values ('sources'), ('models'), ('temperatures'), ('stages')) list(name)
      where conditions ? list.name and (
        jsonb_typeof(conditions -> list.name) <> 'array'
        or jsonb_array_length(conditions -> list.name) > 50
        or exists (
          select 1 from jsonb_array_elements(conditions -> list.name) item
          where jsonb_typeof(item) <> 'string' or char_length(btrim(item #>> '{}')) not between 1 and 120
        )
      )
    )
    or exists (
      select 1 from jsonb_array_elements_text(coalesce(conditions -> 'sources', '[]'::jsonb)) source_name
      where source_name <> all(app_private.drip_lead_sources())
    )
    or exists (
      select 1 from jsonb_array_elements_text(coalesce(conditions -> 'temperatures', '[]'::jsonb)) temperature_name
      where temperature_name not in ('HOT', 'WARM', 'COLD', 'DORMANT')
    )
    or exists (
      select 1 from jsonb_array_elements_text(coalesce(conditions -> 'stages', '[]'::jsonb)) stage_name
      where stage_name not in ('New', 'Contacted', 'Qualified', 'Appointment Scheduled',
        'Transferred to Sales', 'Lost')
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_CONDITIONS';
  end if;
  stages := coalesce((select jsonb_agg(distinct item) from jsonb_array_elements_text(
    coalesce(conditions -> 'stages', '[]'::jsonb)) item), '[]'::jsonb);
  temperatures := coalesce((select jsonb_agg(distinct item) from jsonb_array_elements_text(
    coalesce(conditions -> 'temperatures', '[]'::jsonb)) item), '[]'::jsonb);
  -- A stage or temperature change with nothing to change to would fire on every
  -- change, which is never what the rule meant.
  if (event_value = 'LEAD_STAGE_CHANGED' and jsonb_array_length(stages) = 0)
    or (event_value = 'LEAD_TEMPERATURE_CHANGED' and jsonb_array_length(temperatures) = 0)
    or (event_value <> 'LEAD_STAGE_CHANGED' and jsonb_array_length(stages) > 0) then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_CONDITIONS';
  end if;

  if jsonb_typeof(action_items) <> 'array' or jsonb_array_length(action_items) not between 1 and 2 then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_ACTIONS';
  end if;
  for action_value in select value from jsonb_array_elements(action_items) loop
    action_type := upper(btrim(coalesce(action_value ->> 'type', '')));
    if jsonb_typeof(action_value) <> 'object' or action_type = any(seen_actions) then
      raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_ACTIONS';
    end if;
    seen_actions := seen_actions || action_type;
    if action_type = 'START_DRIP' then
      select * into drip_row
      from public.marketing_drip_campaigns
      where id = nullif(action_value ->> 'campaign_id', '')::uuid
        and organization_id = target_organization_id
        and deleted_at is null
        and status <> 'ARCHIVED';
      if not found or drip_row.trigger_type <> 'AUTOMATION' then
        raise exception using errcode = '22023', message = 'AUTOMATION_DRIP_NOT_FOUND';
      end if;
      -- A branch rule cannot start a drip scoped to a different branch.
      if drip_row.branch_id is not null and drip_row.branch_id is distinct from target_branch_id then
        raise exception using errcode = '22023', message = 'AUTOMATION_DRIP_SCOPE_MISMATCH';
      end if;
      normalized_actions := normalized_actions || jsonb_build_object(
        'type', 'START_DRIP', 'campaign_id', drip_row.id);
      action_labels := action_labels || ('start drip "' || drip_row.name || '"');
    elsif action_type = 'NOTIFY_OWNER' then
      if char_length(btrim(coalesce(action_value ->> 'title', ''))) not between 3 and 120
        or char_length(btrim(coalesce(action_value ->> 'message', ''))) not between 1 and 500
        or jsonb_typeof(coalesce(action_value -> 'include_team_manager', 'false'::jsonb)) <> 'boolean' then
        raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_ACTIONS';
      end if;
      normalized_actions := normalized_actions || jsonb_build_object(
        'type', 'NOTIFY_OWNER',
        'title', btrim(action_value ->> 'title'),
        'message', btrim(action_value ->> 'message'),
        'include_team_manager', coalesce((action_value ->> 'include_team_manager')::boolean, false));
      action_labels := action_labels || case
        when coalesce((action_value ->> 'include_team_manager')::boolean, false)
          then 'notify the lead owner and team manager'
        else 'notify the lead owner' end;
    else
      raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_ACTIONS';
    end if;
  end loop;

  if jsonb_array_length(stages) > 0 then
    condition_labels := condition_labels || ('stage ' || (select string_agg(value, ' or ') from jsonb_array_elements_text(stages)));
  end if;
  if jsonb_array_length(temperatures) > 0 then
    condition_labels := condition_labels || ('temperature ' || (select string_agg(value, ' or ') from jsonb_array_elements_text(temperatures)));
  end if;
  if jsonb_array_length(coalesce(conditions -> 'sources', '[]'::jsonb)) > 0 then
    condition_labels := condition_labels || ('source ' || (select string_agg(value, ' or ') from jsonb_array_elements_text(conditions -> 'sources')));
  end if;
  if jsonb_array_length(coalesce(conditions -> 'models', '[]'::jsonb)) > 0 then
    condition_labels := condition_labels || ('model ' || (select string_agg(btrim(value), ' or ') from jsonb_array_elements_text(conditions -> 'models')));
  end if;

  return jsonb_build_object(
    'name', btrim(payload ->> 'name'),
    'description', nullif(btrim(coalesce(payload ->> 'description', '')), ''),
    'event_type', event_value,
    'conditions', jsonb_build_object(
      'sources', coalesce((select jsonb_agg(distinct item) from jsonb_array_elements_text(
        coalesce(conditions -> 'sources', '[]'::jsonb)) item), '[]'::jsonb),
      'models', coalesce((select jsonb_agg(distinct btrim(item)) from jsonb_array_elements_text(
        coalesce(conditions -> 'models', '[]'::jsonb)) item), '[]'::jsonb),
      'temperatures', temperatures,
      'stages', stages,
      -- Read by the System Administrator list, which shows summaries only.
      'summary', left(event_label || coalesce(': ' || nullif(array_to_string(condition_labels, ', '), ''), ''), 500)
    ),
    'actions', jsonb_build_object(
      'items', normalized_actions,
      'summary', left(initcap(left(array_to_string(action_labels, ' and '), 1))
        || substr(array_to_string(action_labels, ' and '), 2), 500)
    )
  );
end;
$function$;
revoke all on function app_private.normalize_marketing_automation_payload(uuid, uuid, jsonb)
  from public, anon, authenticated;

-- Can the caller see or change a rule with this scope?
create or replace function app_private.marketing_automation_scope_allowed(
  target_organization_id uuid, target_branch_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when target_branch_id is null then app_private.has_organization_wide_scope(target_organization_id)
    else app_private.can_access_branch(target_organization_id, target_branch_id)
  end;
$function$;
revoke all on function app_private.marketing_automation_scope_allowed(uuid, uuid)
  from public, anon, authenticated;

-- Everything the Automations page renders in one read.
create or replace function public.get_marketing_automations_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
begin
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.view') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_VIEW_PERMISSION_REQUIRED';
  end if;

  return (
    with visible_rule as materialized (
      select rule_row.*
      from public.automation_rules rule_row
      where rule_row.organization_id = current_organization_id
        and rule_row.module = 'MARKETING'
        and rule_row.deleted_at is null
        and app_private.marketing_automation_scope_allowed(current_organization_id, rule_row.branch_id)
      order by rule_row.updated_at desc, rule_row.id desc
      -- Rules are configuration, not records: a dealership has a handful.
      limit 200
    ), run_stats as materialized (
      select run_row.rule_id,
        count(*) filter (where run_row.started_at >= now() - interval '30 days')::integer as runs_30d,
        max(run_row.started_at) as last_run_at
      from public.automation_runs run_row
      where run_row.organization_id = current_organization_id
        and run_row.rule_id in (select id from visible_rule)
      group by run_row.rule_id
    )
    select jsonb_build_object(
      'organization_id', current_organization_id,
      'can_manage', app_private.has_permission(current_organization_id, 'marketing.automation.manage'),
      'kpis', jsonb_build_object(
        'total', (select count(*) from visible_rule)::integer,
        'enabled', (select count(*) from visible_rule where enabled)::integer,
        'runs_today', (select count(*) from public.automation_runs run_row
          where run_row.organization_id = current_organization_id
            and run_row.rule_id in (select id from visible_rule)
            and run_row.started_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')::integer,
        'drips_started_7d', (select count(*) from public.automation_runs run_row
          where run_row.organization_id = current_organization_id
            and run_row.rule_id in (select id from visible_rule)
            and run_row.drip_campaign_id is not null
            and run_row.started_at >= now() - interval '7 days')::integer
      ),
      'rules', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', rule_row.id,
          'name', rule_row.name,
          'description', rule_row.description,
          'branch_id', rule_row.branch_id,
          'branch_name', branch_row.name,
          'event_type', rule_row.event_type,
          'conditions', rule_row.conditions - 'summary',
          'condition_summary', rule_row.conditions ->> 'summary',
          'actions', coalesce(rule_row.actions -> 'items', '[]'::jsonb),
          'action_summary', rule_row.actions ->> 'summary',
          'enabled', rule_row.enabled,
          'activated_at', rule_row.activated_at,
          'version', rule_row.version,
          'updated_at', rule_row.updated_at,
          'runs_30d', coalesce(run_stats.runs_30d, 0),
          'last_run_at', run_stats.last_run_at
        ) order by rule_row.updated_at desc, rule_row.id desc)
        from visible_rule rule_row
        left join public.branches branch_row on branch_row.id = rule_row.branch_id
        left join run_stats on run_stats.rule_id = rule_row.id
      ), '[]'::jsonb),
      'drip_options', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', campaign_row.id, 'name', campaign_row.name, 'status', campaign_row.status,
          'branch_id', campaign_row.branch_id
        ) order by campaign_row.name, campaign_row.id)
        from public.marketing_drip_campaigns campaign_row
        where campaign_row.organization_id = current_organization_id
          and campaign_row.trigger_type = 'AUTOMATION'
          and campaign_row.deleted_at is null
          and campaign_row.status <> 'ARCHIVED'
          and app_private.marketing_automation_scope_allowed(current_organization_id, campaign_row.branch_id)
      ), '[]'::jsonb),
      'recent_runs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', run_row.id,
          'rule_id', run_row.rule_id,
          'rule_name', rule_row.name,
          'status', run_row.status,
          'event_type', run_row.result ->> 'event_type',
          'customer_name', run_row.result ->> 'customer_name',
          'drip_state', run_row.result ->> 'drip_state',
          'notified', coalesce((run_row.result ->> 'notify')::boolean, false),
          'lead_id', run_row.lead_id,
          'started_at', run_row.started_at
        ) order by run_row.started_at desc, run_row.id desc)
        from (
          select * from public.automation_runs run_source
          where run_source.organization_id = current_organization_id
            and run_source.rule_id in (select id from visible_rule)
          order by run_source.started_at desc, run_source.id desc
          limit 25
        ) run_row
        join visible_rule rule_row on rule_row.id = run_row.rule_id
      ), '[]'::jsonb)
    )
  );
end;
$function$;
revoke all on function public.get_marketing_automations_workspace() from public, anon;
grant execute on function public.get_marketing_automations_workspace() to authenticated;

-- Create or edit a rule. Editing an enabled rule restarts its clock, so changed
-- conditions only apply to events from now on.
create or replace function public.save_marketing_automation(
  target_rule_id uuid,
  target_expected_version bigint,
  target_branch_id uuid,
  target_payload jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  normalized jsonb;
  rule_row public.automation_rules%rowtype;
  saved_id uuid := coalesce(target_rule_id, gen_random_uuid());
  result jsonb;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_AUTOMATION';
  end if;
  if not app_private.marketing_automation_scope_allowed(current_organization_id, target_branch_id)
    or (target_branch_id is not null and not exists (
      select 1 from public.branches
      where id = target_branch_id and organization_id = current_organization_id
        and active and deleted_at is null
    )) then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_SCOPE_DENIED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0));
  select (audit_row.metadata -> 'result') || jsonb_build_object('replayed', true) into result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action in ('marketing_automation.rule_created', 'marketing_automation.rule_updated')
    and audit_row.request_id = target_request_id
  order by audit_row.id desc
  limit 1;
  if result is not null then return result; end if;

  normalized := app_private.normalize_marketing_automation_payload(
    current_organization_id, target_branch_id, target_payload);

  if target_rule_id is not null then
    select * into rule_row
    from public.automation_rules
    where id = target_rule_id and organization_id = current_organization_id
      and module = 'MARKETING' and deleted_at is null
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'MARKETING_AUTOMATION_NOT_FOUND';
    end if;
    if not app_private.marketing_automation_scope_allowed(current_organization_id, rule_row.branch_id) then
      raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_SCOPE_DENIED';
    end if;
    if target_expected_version is distinct from rule_row.version then
      raise exception using errcode = 'PT409', message = 'MARKETING_AUTOMATION_VERSION_CONFLICT';
    end if;
    -- An enabled rule must keep pointing at a drip that is running.
    if rule_row.enabled and exists (
      select 1 from jsonb_array_elements(normalized #> '{actions,items}') item
      join public.marketing_drip_campaigns campaign_row
        on campaign_row.id = (item ->> 'campaign_id')::uuid
      where item ->> 'type' = 'START_DRIP' and campaign_row.status <> 'ACTIVE'
    ) then
      raise exception using errcode = '22023', message = 'AUTOMATION_DRIP_NOT_ACTIVE';
    end if;
    update public.automation_rules
    set name = normalized ->> 'name',
      description = normalized ->> 'description',
      branch_id = target_branch_id,
      event_type = normalized ->> 'event_type',
      conditions = normalized -> 'conditions',
      actions = normalized -> 'actions',
      activated_at = case when enabled then now() else activated_at end,
      version = version + 1,
      updated_by = auth.uid(),
      updated_at = now()
    where id = target_rule_id
    returning jsonb_build_object('id', id, 'enabled', enabled, 'version', version, 'replayed', false)
    into result;
  else
    insert into public.automation_rules (
      id, organization_id, module, branch_id, name, description, event_type, conditions,
      actions, enabled, created_by, updated_by
    ) values (
      saved_id, current_organization_id, 'MARKETING', target_branch_id, normalized ->> 'name',
      normalized ->> 'description', normalized ->> 'event_type', normalized -> 'conditions',
      normalized -> 'actions', false, auth.uid(), auth.uid()
    )
    returning jsonb_build_object('id', id, 'enabled', enabled, 'version', version, 'replayed', false)
    into result;
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(),
    case when target_rule_id is null then 'marketing_automation.rule_created'
      else 'marketing_automation.rule_updated' end,
    'automation_rule', saved_id::text, target_branch_id, target_request_id,
    jsonb_build_object('event_type', normalized ->> 'event_type',
      'conditions', normalized -> 'conditions', 'actions', normalized -> 'actions', 'result', result)
  );
  return result;
end;
$function$;
revoke all on function public.save_marketing_automation(uuid, bigint, uuid, jsonb, uuid) from public, anon;
grant execute on function public.save_marketing_automation(uuid, bigint, uuid, jsonb, uuid) to authenticated;

-- Switch a rule on or off, or archive it.
create or replace function public.set_marketing_automation_state(
  target_rule_id uuid, target_state text, target_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  normalized_state text := upper(btrim(coalesce(target_state, '')));
  rule_row public.automation_rules%rowtype;
  result jsonb;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if normalized_state not in ('ENABLED', 'DISABLED', 'ARCHIVED') then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_AUTOMATION_STATE';
  end if;
  select * into rule_row
  from public.automation_rules
  where id = target_rule_id and organization_id = current_organization_id
    and module = 'MARKETING' and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'MARKETING_AUTOMATION_NOT_FOUND';
  end if;
  if not app_private.marketing_automation_scope_allowed(current_organization_id, rule_row.branch_id) then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_SCOPE_DENIED';
  end if;
  if target_expected_version is distinct from rule_row.version then
    raise exception using errcode = 'PT409', message = 'MARKETING_AUTOMATION_VERSION_CONFLICT';
  end if;
  if (normalized_state = 'ENABLED' and rule_row.enabled)
    or (normalized_state = 'DISABLED' and not rule_row.enabled) then
    return jsonb_build_object('id', rule_row.id, 'enabled', rule_row.enabled,
      'version', rule_row.version, 'replayed', true);
  end if;

  if normalized_state = 'ENABLED' then
    -- Switching on a rule whose drip is not running would act on events and
    -- send nothing; refuse it now instead.
    if exists (
      select 1 from jsonb_array_elements(coalesce(rule_row.actions -> 'items', '[]'::jsonb)) item
      left join public.marketing_drip_campaigns campaign_row
        on campaign_row.id = (item ->> 'campaign_id')::uuid
       and campaign_row.organization_id = current_organization_id
       and campaign_row.deleted_at is null
      where item ->> 'type' = 'START_DRIP'
        and (campaign_row.id is null or campaign_row.status <> 'ACTIVE')
    ) then
      raise exception using errcode = '22023', message = 'AUTOMATION_DRIP_NOT_ACTIVE';
    end if;
    if jsonb_array_length(coalesce(rule_row.actions -> 'items', '[]'::jsonb)) = 0 then
      raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_ACTIONS';
    end if;
  end if;

  update public.automation_rules
  set enabled = normalized_state = 'ENABLED',
    -- Only events after switching on count, so a rule switched back on does
    -- not act on everything that happened while it was off.
    activated_at = case when normalized_state = 'ENABLED' then now() else activated_at end,
    deleted_at = case when normalized_state = 'ARCHIVED' then now() else deleted_at end,
    version = version + 1,
    updated_by = auth.uid(),
    updated_at = now()
  where id = rule_row.id
  returning jsonb_build_object('id', id, 'enabled', enabled, 'version', version, 'replayed', false)
  into result;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'marketing_automation.rule_state_changed', 'automation_rule',
    rule_row.id::text, rule_row.branch_id,
    jsonb_build_object('from', case when rule_row.enabled then 'ENABLED' else 'DISABLED' end,
      'to', normalized_state)
  );
  return result;
end;
$function$;
revoke all on function public.set_marketing_automation_state(uuid, text, bigint) from public, anon;
grant execute on function public.set_marketing_automation_state(uuid, text, bigint) to authenticated;

-- The runner -------------------------------------------------------------------
create or replace function public.run_marketing_automations(target_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  pass_at timestamptz := now();
  run_count integer := 0;
  notified integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'INVALID_AUTOMATION_LIMIT';
  end if;

  with rule as materialized (
    select rule_row.id, rule_row.organization_id, rule_row.branch_id, rule_row.event_type,
      rule_row.conditions,
      greatest(rule_row.activated_at, pass_at - interval '3 days') as since,
      (select (item ->> 'campaign_id')::uuid
       from jsonb_array_elements(coalesce(rule_row.actions -> 'items', '[]'::jsonb)) item
       where item ->> 'type' = 'START_DRIP' limit 1) as drip_campaign_id,
      (select item
       from jsonb_array_elements(coalesce(rule_row.actions -> 'items', '[]'::jsonb)) item
       where item ->> 'type' = 'NOTIFY_OWNER' limit 1) as notify
    from public.automation_rules rule_row
    where rule_row.module = 'MARKETING'
      and rule_row.enabled
      and rule_row.deleted_at is null
      and rule_row.activated_at is not null
  ), event as (
    select rule.id as rule_id, lead_row.organization_id, lead_row.id as lead_id,
      lead_row.customer_id, lead_row.branch_id, 'lead:' || lead_row.id as occurrence_key,
      lead_row.created_at as occurred_at
    from rule
    join public.leads lead_row
      on lead_row.organization_id = rule.organization_id
     and lead_row.created_at >= rule.since
     and lead_row.deleted_at is null
    where rule.event_type = 'LEAD_CREATED'

    union all
    select rule.id, history_row.organization_id, history_row.lead_id, lead_row.customer_id,
      lead_row.branch_id, 'stage:' || history_row.id, history_row.created_at
    from rule
    join public.lead_stage_history history_row
      on history_row.organization_id = rule.organization_id
     and history_row.created_at >= rule.since
    join public.leads lead_row
      on lead_row.id = history_row.lead_id
     and lead_row.organization_id = history_row.organization_id
     and lead_row.deleted_at is null
    where rule.event_type = 'LEAD_STAGE_CHANGED'
      and history_row.to_status::text in (select jsonb_array_elements_text(rule.conditions -> 'stages'))

    union all
    select rule.id, history_row.organization_id, history_row.lead_id, lead_row.customer_id,
      lead_row.branch_id, 'temperature:' || history_row.id, history_row.created_at
    from rule
    join public.lead_temperature_history history_row
      on history_row.organization_id = rule.organization_id
     and history_row.created_at >= rule.since
    join public.leads lead_row
      on lead_row.id = history_row.lead_id
     and lead_row.organization_id = history_row.organization_id
     and lead_row.deleted_at is null
    where rule.event_type = 'LEAD_TEMPERATURE_CHANGED'
      and history_row.to_temperature::text in (
        select jsonb_array_elements_text(rule.conditions -> 'temperatures'))

    union all
    select rule.id, drive_row.organization_id, drive_row.lead_id, drive_row.customer_id,
      drive_row.branch_id, 'test-drive:' || drive_row.id, drive_row.completed_at
    from rule
    join public.test_drives drive_row
      on drive_row.organization_id = rule.organization_id
     and drive_row.status = 'COMPLETED'
     and drive_row.completed_at >= rule.since
    where rule.event_type = 'TEST_DRIVE_COMPLETED'

    union all
    select rule.id, booking_row.organization_id, booking_row.lead_id, booking_row.customer_id,
      booking_row.branch_id, 'booking:' || booking_row.id, booking_row.created_at
    from rule
    join public.bookings booking_row
      on booking_row.organization_id = rule.organization_id
     and booking_row.created_at >= rule.since
     and booking_row.deleted_at is null
     and booking_row.status <> 'CANCELLED'
    where rule.event_type = 'BOOKING_CONFIRMED'

    union all
    select rule.id, delivery_row.organization_id, booking_row.lead_id, delivery_row.customer_id,
      delivery_row.branch_id, 'delivery:' || delivery_row.id, delivery_row.delivered_at
    from rule
    join public.delivery_cases delivery_row
      on delivery_row.organization_id = rule.organization_id
     and delivery_row.status = 'DELIVERED'
     and delivery_row.deleted_at is null
     and delivery_row.delivered_at >= rule.since
    left join public.bookings booking_row
      on booking_row.organization_id = delivery_row.organization_id
     and booking_row.id = delivery_row.booking_id
    where rule.event_type = 'VEHICLE_DELIVERED'
  ), matched as materialized (
    select event.*, rule.event_type, rule.drip_campaign_id, rule.notify,
      lead_row.assigned_user_id, lead_row.team_id,
      coalesce(customer_row.full_name, lead_row.customer_name) as customer_name,
      coalesce(drip_row.status = 'ACTIVE' and drip_row.deleted_at is null, false) as drip_active
    from event
    join rule on rule.id = event.rule_id
    left join public.leads lead_row
      on lead_row.id = event.lead_id and lead_row.organization_id = event.organization_id
    left join public.customers customer_row
      on customer_row.id = event.customer_id and customer_row.organization_id = event.organization_id
    left join public.marketing_drip_campaigns drip_row
      on drip_row.id = rule.drip_campaign_id and drip_row.organization_id = rule.organization_id
    where event.branch_id is not null
      and (rule.branch_id is null or event.branch_id = rule.branch_id)
      and (
        coalesce(jsonb_array_length(rule.conditions -> 'sources'), 0) = 0
        or lead_row.source in (select jsonb_array_elements_text(rule.conditions -> 'sources'))
      )
      and (
        coalesce(jsonb_array_length(rule.conditions -> 'models'), 0) = 0
        or lower(btrim(lead_row.interested_model)) in (
          select lower(btrim(model_name))
          from jsonb_array_elements_text(rule.conditions -> 'models') model_name
        )
      )
      -- For a temperature change the event itself is the filter.
      and (
        rule.event_type = 'LEAD_TEMPERATURE_CHANGED'
        or coalesce(jsonb_array_length(rule.conditions -> 'temperatures'), 0) = 0
        or lead_row.temperature::text in (
          select jsonb_array_elements_text(rule.conditions -> 'temperatures'))
      )
      and not exists (
        select 1 from public.automation_runs run_row
        where run_row.rule_id = event.rule_id
          and run_row.occurrence_key = event.occurrence_key
      )
    order by event.occurred_at, event.rule_id, event.occurrence_key
    limit target_limit
  ), new_runs as (
    insert into public.automation_runs (
      organization_id, rule_id, status, result, started_at, completed_at,
      occurrence_key, lead_id, customer_id, branch_id, drip_campaign_id
    )
    select matched.organization_id, matched.rule_id,
      -- A run whose only action is a drip that has since stopped did nothing.
      case when matched.notify is null and not matched.drip_active then 'SKIPPED' else 'COMPLETED' end,
      jsonb_build_object(
        'event_type', matched.event_type,
        'occurred_at', matched.occurred_at,
        'customer_name', matched.customer_name,
        'drip_state', case
          when matched.drip_campaign_id is null then null
          when matched.drip_active then 'REQUESTED'
          else 'CAMPAIGN_NOT_ACTIVE'
        end,
        'notify', matched.notify is not null
      ),
      pass_at, pass_at, matched.occurrence_key, matched.lead_id, matched.customer_id,
      matched.branch_id,
      case when matched.drip_active then matched.drip_campaign_id end
    from matched
    on conflict (rule_id, occurrence_key) where occurrence_key is not null do nothing
    returning rule_id, occurrence_key
  ), recipient as (
    select matched.*, recipient_row.user_id
    from new_runs
    join matched
      on matched.rule_id = new_runs.rule_id and matched.occurrence_key = new_runs.occurrence_key
    cross join lateral (
      select matched.assigned_user_id as user_id
      union
      select member_row.user_id
      from public.team_members member_row
      where coalesce((matched.notify ->> 'include_team_manager')::boolean, false)
        and member_row.organization_id = matched.organization_id
        and member_row.team_id = matched.team_id
        and member_row.member_type = 'TEAM_MANAGER'
        and member_row.active
      union
      select team_row.manager_id
      from public.teams team_row
      where coalesce((matched.notify ->> 'include_team_manager')::boolean, false)
        and team_row.organization_id = matched.organization_id
        and team_row.id = matched.team_id
        and team_row.active
    ) recipient_row
    where matched.notify is not null
      and recipient_row.user_id is not null
      and app_private.alert_recipient_allowed(matched.organization_id, matched.branch_id,
        matched.team_id, matched.assigned_user_id, recipient_row.user_id, 'lead.view')
  ), notified_rows as (
    insert into public.notifications (
      organization_id, user_id, event_type, title, body, resource_type, resource_id, dedupe_key
    )
    select recipient.organization_id, recipient.user_id, 'MARKETING_AUTOMATION',
      left(recipient.notify ->> 'title', 120),
      left(concat_ws(' — ', recipient.notify ->> 'message', recipient.customer_name), 1000),
      case when recipient.lead_id is not null then 'lead' else 'customer' end,
      coalesce(recipient.lead_id, recipient.customer_id),
      left('automation:' || recipient.rule_id || ':' || recipient.occurrence_key, 200)
    from recipient
    where coalesce(recipient.lead_id, recipient.customer_id) is not null
    on conflict (organization_id, user_id, dedupe_key) where dedupe_key is not null do nothing
    returning 1
  )
  select (select count(*) from new_runs)::integer, (select count(*) from notified_rows)::integer
  into run_count, notified;

  return jsonb_build_object('runs', run_count, 'notified', notified);
end;
$function$;
revoke all on function public.run_marketing_automations(integer) from public, anon, authenticated;
grant execute on function public.run_marketing_automations(integer) to service_role;

do $patch$
declare
  body text;
  anchor text;
begin
  -- The drip builder accepts the new trigger, with no conditions of its own.
  body := pg_get_functiondef('app_private.normalize_drip_campaign_payload(uuid,jsonb)'::regprocedure);
  anchor := '''VEHICLE_DELIVERED'', ''DELIVERY_ANNIVERSARY'') then';
  if position(anchor in body) = 0 then raise exception 'DRIP_TRIGGER_LIST_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, '''VEHICLE_DELIVERED'', ''DELIVERY_ANNIVERSARY'', ''AUTOMATION'') then');
  execute body;

  -- The per-minute drip pass runs automations first, then enrolls what they
  -- requested alongside the other events.
  body := pg_get_functiondef('public.run_event_drip_matches(integer)'::regprocedure);
  anchor := '  cancelled integer := 0;';
  if position(anchor in body) = 0 then raise exception 'DRIP_MATCH_DECLARE_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || '
  automation_outcome jsonb;');
  anchor := '    raise exception using errcode = ''22023'', message = ''INVALID_EVENT_MATCH_LIMIT'';
  end if;';
  if position(anchor in body) = 0 then raise exception 'DRIP_MATCH_LIMIT_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || '

  -- A failing automation must not stop the drips: its error is reported, and
  -- its events are retried on the next pass because no run row was written.
  begin
    automation_outcome := public.run_marketing_automations(target_limit);
  exception when others then
    automation_outcome := jsonb_build_object(''failed'', left(sqlerrm, 200));
  end;');
  anchor := '  ), all_match as (';
  if position(anchor in body) = 0 then raise exception 'DRIP_MATCH_CTE_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, '  ), automation_match as (
    select campaign.id as campaign_id, run_row.organization_id, run_row.customer_id,
      run_row.lead_id, run_row.branch_id, run_row.id as resource_id,
      left(''automation:'' || run_row.rule_id || '':'' || run_row.occurrence_key, 200) as occurrence_key
    from campaign
    join public.automation_runs run_row
      on run_row.drip_campaign_id = campaign.id
     and run_row.organization_id = campaign.organization_id
     and run_row.started_at >= campaign.activated_at
     and run_row.started_at >= pass_at - interval ''3 days''
    where campaign.trigger_type = ''AUTOMATION''
      and (campaign.branch_id is null or run_row.branch_id = campaign.branch_id)
' || anchor);
  anchor := '    union all select * from delivery_match';
  if position(anchor in body) = 0 then raise exception 'DRIP_MATCH_UNION_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || '
    union all select * from automation_match');
  if (length(body) - length(replace(body, 'return jsonb_build_object(', ''))) / length('return jsonb_build_object(') <> 2 then
    raise exception 'DRIP_MATCH_RETURN_ANCHOR_COUNT';
  end if;
  body := replace(body, 'return jsonb_build_object(',
    'return jsonb_build_object(''automations'', automation_outcome) || jsonb_build_object(');
  execute body;

  -- The System Administrator page keeps to its own rules.
  body := pg_get_functiondef('public.get_automation_rules_workspace(integer,integer,text,text)'::regprocedure);
  anchor := '    where rule_row.organization_id = current_organization_id';
  if position(anchor in body) = 0 then raise exception 'ADMIN_RULES_FILTER_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || ' and rule_row.module = ''ADMIN''');
  anchor := 'from public.automation_rules where organization_id = current_organization_id';
  if position(anchor in body) = 0 then raise exception 'ADMIN_RULES_KPI_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || ' and module = ''ADMIN''');
  anchor := '      and run_row.started_at >= now() - interval ''30 days''';
  if position(anchor in body) = 0 then raise exception 'ADMIN_RULES_RUN_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || '
      and exists (select 1 from public.automation_rules admin_rule
        where admin_rule.id = run_row.rule_id and admin_rule.module = ''ADMIN'')');
  execute body;

  body := pg_get_functiondef('public.set_automation_rule_enabled(uuid,boolean)'::regprocedure);
  anchor := 'where id = target_rule_id and organization_id = current_organization_id;';
  if position(anchor in body) = 0 then raise exception 'ADMIN_RULE_TOGGLE_ANCHOR_MISSING'; end if;
  body := replace(body, anchor,
    'where id = target_rule_id and organization_id = current_organization_id and module = ''ADMIN'';');
  execute body;

  body := pg_get_functiondef('public.get_automation_rule_detail(uuid)'::regprocedure);
  anchor := 'where id = target_rule_id and organization_id = current_organization_id;';
  if position(anchor in body) = 0 then raise exception 'ADMIN_RULE_DETAIL_ANCHOR_MISSING'; end if;
  body := replace(body, anchor,
    'where id = target_rule_id and organization_id = current_organization_id and module = ''ADMIN'';');
  execute body;
end;
$patch$;

commit;
