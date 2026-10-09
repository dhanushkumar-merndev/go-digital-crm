begin;

-- Drip builder for Digital Marketing (Manager and Executive, who hold
-- marketing.automation.manage):
--   * create_marketing_template drafts a MARKETING template with its
--     placeholders; approve_template / archive_template now accept marketing
--     for MARKETING templates (and validate an MSG91 SMS template id);
--   * save_marketing_drip_campaign / get_marketing_drip_campaign build an
--     event-triggered campaign whose steps send on one or more channels, each
--     with a placeholder -> token map;
--   * set_marketing_drip_campaign_status activates (approved templates and a
--     connected provider per channel required), pauses or archives;
--   * preview_marketing_drip_audience estimates reach;
--   * get/set_customer_marketing_opt_out(s) manage per-channel opt-outs;
--   * get_marketing_automation_workspace returns trigger, channels and stats.
--
-- Existing bodies are text-patched from the deployed pg_get_functiondef.

-- Sources a lead trigger can filter on (AGENTS.md 9.2).
create or replace function app_private.drip_lead_sources()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select array['Facebook', 'Instagram', 'Google Ads', 'Website', 'WhatsApp Business', 'CarWale',
    'CarDekho', 'Justdial', 'IndiaMART', 'Manual', 'Other']::text[];
$function$;
revoke all on function app_private.drip_lead_sources() from public, anon;
grant execute on function app_private.drip_lead_sources() to authenticated;

-- Is a channel's provider connected for this campaign's scope? Email goes
-- through the platform Brevo account, so it is always available.
create or replace function app_private.drip_channel_connected(
  target_organization_id uuid, target_branch_id uuid, target_channel text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when target_channel = 'EMAIL' then true
    else exists (
      select 1
      from public.connected_accounts account_row
      where account_row.organization_id = target_organization_id
        and account_row.provider_key = case target_channel
          when 'WHATSAPP' then 'whatsapp_cloud' when 'SMS' then 'msg91' end
        and account_row.status = 'CONNECTED'
        and account_row.deleted_at is null
        and (
          target_branch_id is null
          or account_row.scope_mode = 'ALL_BRANCHES'
          or exists (
            select 1 from public.integration_branch_mappings mapping_row
            where mapping_row.connected_account_id = account_row.id
              and mapping_row.branch_id = target_branch_id
              and mapping_row.deleted_at is null
          )
        )
    )
  end;
$function$;
revoke all on function app_private.drip_channel_connected(uuid, uuid, text) from public, anon, authenticated;

-- Everything the drip builder needs to render: tokens, sources, channel
-- availability and the tenant's marketing templates.
create or replace function public.get_marketing_drip_builder_options()
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
  return jsonb_build_object(
    'can_manage', app_private.has_permission(current_organization_id, 'marketing.automation.manage'),
    'tokens', to_jsonb(app_private.drip_variable_tokens()),
    'sources', to_jsonb(app_private.drip_lead_sources()),
    'channels', jsonb_build_object(
      'WHATSAPP', app_private.drip_channel_connected(current_organization_id, null, 'WHATSAPP'),
      'SMS', app_private.drip_channel_connected(current_organization_id, null, 'SMS'),
      'EMAIL', true
    ),
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', template_row.id,
        'name', template_row.name,
        'channel', case when template_row.channel = 'WHATSAPP_BUSINESS' then 'WHATSAPP' else template_row.channel end,
        'status', upper(template_row.status),
        'category', template_row.category,
        'provider_template_id', template_row.provider_template_id,
        'body', template_row.content ->> 'body',
        'placeholders', template_row.placeholders,
        'updated_at', template_row.updated_at
      ) order by template_row.updated_at desc, template_row.id)
      from public.templates template_row
      where template_row.organization_id = current_organization_id
        and template_row.deleted_at is null
        and template_row.channel in ('WHATSAPP', 'WHATSAPP_BUSINESS', 'SMS', 'EMAIL')
        and (template_row.category = 'MARKETING' or upper(template_row.status) = 'APPROVED')
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_marketing_drip_builder_options() from public, anon;
grant execute on function public.get_marketing_drip_builder_options() to authenticated;

-- Marketing drafts its own templates. Approval still records the provider's
-- id (Meta template name, MSG91 template id, Brevo template id) through
-- approve_template.
create or replace function public.create_marketing_template(
  target_name text, target_channel text, target_body text, target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  normalized_name text := left(btrim(coalesce(target_name, '')), 120);
  normalized_channel text := upper(btrim(coalesce(target_channel, '')));
  normalized_body text := btrim(coalesce(target_body, ''));
  new_template_id uuid := gen_random_uuid();
  result jsonb;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null or char_length(normalized_name) not between 2 and 120
    or normalized_channel not in ('WHATSAPP', 'SMS', 'EMAIL')
    or char_length(normalized_body) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_INPUT';
  end if;
  if jsonb_array_length(app_private.template_placeholders(normalized_body)) > 20 then
    raise exception using errcode = '22023', message = 'TOO_MANY_TEMPLATE_PLACEHOLDERS';
  end if;

  select jsonb_build_object('id', audit_row.resource_id::uuid, 'status', 'DRAFT', 'replayed', true)
  into result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'template.marketing_draft_created'
    and audit_row.request_id = target_request_id
  limit 1;
  if result is not null then return result; end if;

  insert into public.templates (
    id, organization_id, channel, name, content, status, created_by, category, placeholders
  ) values (
    new_template_id, current_organization_id, normalized_channel, normalized_name,
    jsonb_build_object('body', normalized_body, 'format', 'TEXT'), 'DRAFT', auth.uid(),
    'MARKETING', app_private.template_placeholders(normalized_body)
  );
  result := jsonb_build_object('id', new_template_id, 'status', 'DRAFT', 'replayed', false);
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'template.marketing_draft_created', 'template',
    new_template_id::text, target_request_id,
    jsonb_build_object('channel', normalized_channel, 'name', normalized_name)
  );
  return result;
end;
$function$;
revoke all on function public.create_marketing_template(text, text, text, uuid) from public, anon;
grant execute on function public.create_marketing_template(text, text, text, uuid) to authenticated;

-- Validates and normalizes one campaign payload; raises on anything invalid.
create or replace function app_private.normalize_drip_campaign_payload(
  target_organization_id uuid, target_payload jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  payload jsonb := coalesce(target_payload, '{}'::jsonb);
  trigger_value text := upper(btrim(coalesce(payload ->> 'trigger_type', '')));
  conditions jsonb := coalesce(payload -> 'trigger_conditions', '{}'::jsonb);
  normalized_conditions jsonb;
  step_value jsonb;
  channel_value jsonb;
  template_row public.templates%rowtype;
  normalized_steps jsonb := '[]'::jsonb;
  normalized_channels jsonb;
  step_number integer := 0;
  channel_name text;
  seen_channels text[];
  days_before integer;
  send_hour integer;
begin
  if char_length(btrim(coalesce(payload ->> 'name', ''))) not between 3 and 180
    or char_length(coalesce(payload ->> 'description', '')) > 2000 then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_CAMPAIGN_NAME';
  end if;
  if trigger_value not in ('LEAD_CREATED', 'BIRTHDAY', 'ANNIVERSARY', 'BOOKING_CONFIRMED',
    'VEHICLE_DELIVERED', 'DELIVERY_ANNIVERSARY') then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_TRIGGER';
  end if;
  if jsonb_typeof(conditions) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_CONDITIONS';
  end if;

  if trigger_value = 'LEAD_CREATED' then
    if jsonb_typeof(coalesce(conditions -> 'sources', '[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(conditions -> 'models', '[]'::jsonb)) <> 'array'
      or jsonb_array_length(coalesce(conditions -> 'models', '[]'::jsonb)) > 50
      or exists (
        select 1 from jsonb_array_elements_text(coalesce(conditions -> 'sources', '[]'::jsonb)) source_name
        where source_name <> all(app_private.drip_lead_sources())
      )
      or exists (
        select 1 from jsonb_array_elements(coalesce(conditions -> 'models', '[]'::jsonb)) model_value
        where jsonb_typeof(model_value) <> 'string'
          or char_length(btrim(model_value #>> '{}')) not between 1 and 120
      ) then
      raise exception using errcode = '22023', message = 'INVALID_DRIP_CONDITIONS';
    end if;
    normalized_conditions := jsonb_build_object(
      'sources', coalesce((select jsonb_agg(distinct source_name)
        from jsonb_array_elements_text(coalesce(conditions -> 'sources', '[]'::jsonb)) source_name), '[]'::jsonb),
      'models', coalesce((select jsonb_agg(distinct btrim(model_name))
        from jsonb_array_elements_text(coalesce(conditions -> 'models', '[]'::jsonb)) model_name), '[]'::jsonb)
    );
  elsif trigger_value in ('BIRTHDAY', 'ANNIVERSARY', 'DELIVERY_ANNIVERSARY') then
    begin
      days_before := coalesce((conditions ->> 'days_before')::integer, 0);
      send_hour := coalesce((conditions ->> 'send_hour')::integer, 10);
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_DRIP_CONDITIONS';
    end;
    if days_before not between 0 and 30 or send_hour not between 0 and 23 then
      raise exception using errcode = '22023', message = 'INVALID_DRIP_CONDITIONS';
    end if;
    normalized_conditions := jsonb_build_object('days_before', days_before, 'send_hour', send_hour);
  else
    normalized_conditions := '{}'::jsonb;
  end if;

  if jsonb_typeof(payload -> 'steps') <> 'array'
    or jsonb_array_length(payload -> 'steps') not between 1 and 24 then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_STEPS';
  end if;

  for step_value in select value from jsonb_array_elements(payload -> 'steps') loop
    step_number := step_number + 1;
    if jsonb_typeof(step_value) <> 'object'
      or jsonb_typeof(step_value -> 'delay_hours') <> 'number'
      or (step_value ->> 'delay_hours')::numeric <> trunc((step_value ->> 'delay_hours')::numeric)
      or (step_value ->> 'delay_hours')::numeric not between 0 and 8760
      or jsonb_typeof(step_value -> 'channels') <> 'array'
      or jsonb_array_length(step_value -> 'channels') not between 1 and 3 then
      raise exception using errcode = '22023', message = 'INVALID_DRIP_STEPS';
    end if;
    normalized_channels := '[]'::jsonb;
    seen_channels := '{}'::text[];
    for channel_value in select value from jsonb_array_elements(step_value -> 'channels') loop
      channel_name := upper(btrim(coalesce(channel_value ->> 'channel', '')));
      if channel_name not in ('WHATSAPP', 'SMS', 'EMAIL') or channel_name = any(seen_channels)
        or jsonb_typeof(coalesce(channel_value -> 'variable_map', '{}'::jsonb)) <> 'object' then
        raise exception using errcode = '22023', message = 'INVALID_DRIP_STEP_CHANNEL';
      end if;
      seen_channels := seen_channels || channel_name;
      select * into template_row
      from public.templates
      where id = nullif(channel_value ->> 'template_id', '')::uuid
        and organization_id = target_organization_id
        and deleted_at is null;
      if not found
        or (case when template_row.channel = 'WHATSAPP_BUSINESS' then 'WHATSAPP' else template_row.channel end) <> channel_name then
        raise exception using errcode = '22023', message = 'DRIP_TEMPLATE_CHANNEL_MISMATCH';
      end if;
      -- Every placeholder mapped, nothing extra, each to a known token.
      if exists (
          select 1 from jsonb_array_elements_text(template_row.placeholders) placeholder
          where not (coalesce(channel_value -> 'variable_map', '{}'::jsonb) ? placeholder)
        )
        or exists (
          select 1 from jsonb_each(coalesce(channel_value -> 'variable_map', '{}'::jsonb)) entry
          where not (template_row.placeholders ? entry.key)
            or jsonb_typeof(entry.value) <> 'string'
            or (entry.value #>> '{}') <> all(app_private.drip_variable_tokens())
        ) then
        raise exception using errcode = '22023', message = 'DRIP_TEMPLATE_VARIABLES_UNMAPPED';
      end if;
      normalized_channels := normalized_channels || jsonb_build_object(
        'channel', channel_name,
        'template_id', template_row.id,
        'variable_map', coalesce(channel_value -> 'variable_map', '{}'::jsonb),
        'body', left(coalesce(template_row.content ->> 'body', template_row.name), 4000)
      );
    end loop;
    normalized_steps := normalized_steps || jsonb_build_object(
      'step_order', step_number,
      'delay_hours', (step_value ->> 'delay_hours')::integer,
      'channels', normalized_channels
    );
  end loop;

  return jsonb_build_object(
    'name', btrim(payload ->> 'name'),
    'description', nullif(btrim(coalesce(payload ->> 'description', '')), ''),
    'trigger_type', trigger_value,
    'trigger_conditions', normalized_conditions,
    'steps', normalized_steps
  );
end;
$function$;
revoke all on function app_private.normalize_drip_campaign_payload(uuid, jsonb) from public, anon, authenticated;

-- Create or edit a conditional campaign. Only DRAFT or PAUSED campaigns can be
-- edited; edits apply to enrollments made after they are saved.
create or replace function public.save_marketing_drip_campaign(
  target_campaign_id uuid,
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
  campaign_row public.marketing_drip_campaigns%rowtype;
  saved_id uuid := coalesce(target_campaign_id, gen_random_uuid());
  saved_version bigint;
  step_value jsonb;
  channel_value jsonb;
  new_step_id uuid;
  result jsonb;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_DRIP_CAMPAIGN';
  end if;
  if target_branch_id is not null and not app_private.can_access_branch(current_organization_id, target_branch_id) then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_SCOPE_DENIED';
  end if;
  if target_branch_id is null and not app_private.has_organization_wide_scope(current_organization_id) then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_ORGANIZATION_SCOPE_REQUIRED';
  end if;

  normalized := app_private.normalize_drip_campaign_payload(current_organization_id, target_payload);

  if target_campaign_id is not null then
    select * into campaign_row
    from public.marketing_drip_campaigns
    where id = target_campaign_id and organization_id = current_organization_id and deleted_at is null
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'MARKETING_DRIP_CAMPAIGN_NOT_FOUND';
    end if;
    if campaign_row.trigger_type = 'AUDIENCE' then
      raise exception using errcode = '22023', message = 'MARKETING_DRIP_CAMPAIGN_NOT_EDITABLE';
    end if;
    if campaign_row.status not in ('DRAFT', 'PAUSED') then
      raise exception using errcode = '22023', message = 'MARKETING_DRIP_CAMPAIGN_ACTIVE';
    end if;
    if (campaign_row.branch_id is null and not app_private.has_organization_wide_scope(current_organization_id))
      or (campaign_row.branch_id is not null and not app_private.can_access_branch(current_organization_id, campaign_row.branch_id)) then
      raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_SCOPE_DENIED';
    end if;
    if target_expected_version is distinct from campaign_row.version then
      raise exception using errcode = 'PT409', message = 'MARKETING_DRIP_CAMPAIGN_VERSION_CONFLICT';
    end if;
    update public.marketing_drip_campaigns
    set name = normalized ->> 'name',
      description = normalized ->> 'description',
      branch_id = target_branch_id,
      trigger_type = normalized ->> 'trigger_type',
      trigger_conditions = normalized -> 'trigger_conditions',
      default_channel = normalized #>> '{steps,0,channels,0,channel}',
      version = version + 1,
      updated_at = now()
    where id = target_campaign_id
    returning version into saved_version;
    delete from public.marketing_drip_steps where campaign_id = target_campaign_id;
  else
    insert into public.marketing_drip_campaigns (
      id, organization_id, branch_id, name, description, audience_filter, default_channel,
      status, created_by, trigger_type, trigger_conditions
    ) values (
      saved_id, current_organization_id, target_branch_id, normalized ->> 'name',
      normalized ->> 'description', '{}'::jsonb, normalized #>> '{steps,0,channels,0,channel}',
      'DRAFT', auth.uid(), normalized ->> 'trigger_type', normalized -> 'trigger_conditions'
    )
    returning version into saved_version;
  end if;

  for step_value in select value from jsonb_array_elements(normalized -> 'steps') loop
    -- The legacy single-channel columns carry the first channel, so older
    -- readers still see a valid step.
    insert into public.marketing_drip_steps (
      organization_id, campaign_id, step_order, delay_hours, channel, message_body,
      template_id, template_variables
    ) values (
      current_organization_id, saved_id, (step_value ->> 'step_order')::smallint,
      (step_value ->> 'delay_hours')::integer, step_value #>> '{channels,0,channel}',
      step_value #>> '{channels,0,body}', (step_value #>> '{channels,0,template_id}')::uuid, '{}'::jsonb
    ) returning id into new_step_id;
    for channel_value in select value from jsonb_array_elements(step_value -> 'channels') loop
      insert into public.marketing_drip_step_channels (
        organization_id, step_id, channel, template_id, variable_map
      ) values (
        current_organization_id, new_step_id, channel_value ->> 'channel',
        (channel_value ->> 'template_id')::uuid, channel_value -> 'variable_map'
      );
    end loop;
  end loop;

  result := jsonb_build_object(
    'id', saved_id, 'status', coalesce(campaign_row.status, 'DRAFT'), 'version', saved_version,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(),
    case when target_campaign_id is null then 'marketing_automation.drip_created'
      else 'marketing_automation.drip_updated' end,
    'marketing_drip_campaign', saved_id::text, target_branch_id, target_request_id,
    jsonb_build_object('trigger_type', normalized ->> 'trigger_type',
      'trigger_conditions', normalized -> 'trigger_conditions',
      'steps', jsonb_array_length(normalized -> 'steps'), 'result', result)
  );
  return result;
end;
$function$;
revoke all on function public.save_marketing_drip_campaign(uuid, bigint, uuid, jsonb, uuid) from public, anon;
grant execute on function public.save_marketing_drip_campaign(uuid, bigint, uuid, jsonb, uuid) to authenticated;

-- One campaign with its steps and channels, for the builder.
create or replace function public.get_marketing_drip_campaign(target_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  campaign_row public.marketing_drip_campaigns%rowtype;
begin
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.view') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_VIEW_PERMISSION_REQUIRED';
  end if;
  select * into campaign_row
  from public.marketing_drip_campaigns
  where id = target_campaign_id and organization_id = current_organization_id and deleted_at is null
    and ((branch_id is null and app_private.has_organization_wide_scope(current_organization_id))
      or (branch_id is not null and app_private.can_access_branch(current_organization_id, branch_id)));
  if not found then
    raise exception using errcode = 'P0002', message = 'MARKETING_DRIP_CAMPAIGN_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'id', campaign_row.id, 'name', campaign_row.name, 'description', campaign_row.description,
    'branch_id', campaign_row.branch_id, 'status', campaign_row.status,
    'trigger_type', campaign_row.trigger_type, 'trigger_conditions', campaign_row.trigger_conditions,
    'activated_at', campaign_row.activated_at, 'version', campaign_row.version,
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'step_order', step_row.step_order,
        'delay_hours', step_row.delay_hours,
        'channels', coalesce((
          select jsonb_agg(jsonb_build_object(
            'channel', channel_row.channel, 'template_id', channel_row.template_id,
            'variable_map', channel_row.variable_map
          ) order by array_position(array['WHATSAPP', 'SMS', 'EMAIL'], channel_row.channel))
          from public.marketing_drip_step_channels channel_row
          where channel_row.step_id = step_row.id
        ), '[]'::jsonb)
      ) order by step_row.step_order)
      from public.marketing_drip_steps step_row
      where step_row.campaign_id = campaign_row.id and step_row.active
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_marketing_drip_campaign(uuid) from public, anon;
grant execute on function public.get_marketing_drip_campaign(uuid) to authenticated;

-- Activate, pause or archive. Activation needs every step channel on an
-- approved template and a connected provider for that channel.
create or replace function public.set_marketing_drip_campaign_status(
  target_campaign_id uuid, target_status text, target_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  campaign_row public.marketing_drip_campaigns%rowtype;
  normalized_status text := upper(btrim(coalesce(target_status, '')));
  missing_channel text;
  result jsonb;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if normalized_status not in ('ACTIVE', 'PAUSED', 'ARCHIVED') then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_CAMPAIGN_STATUS';
  end if;
  select * into campaign_row
  from public.marketing_drip_campaigns
  where id = target_campaign_id and organization_id = current_organization_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'MARKETING_DRIP_CAMPAIGN_NOT_FOUND';
  end if;
  if (campaign_row.branch_id is null and not app_private.has_organization_wide_scope(current_organization_id))
    or (campaign_row.branch_id is not null and not app_private.can_access_branch(current_organization_id, campaign_row.branch_id)) then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_SCOPE_DENIED';
  end if;
  if target_expected_version is distinct from campaign_row.version then
    raise exception using errcode = 'PT409', message = 'MARKETING_DRIP_CAMPAIGN_VERSION_CONFLICT';
  end if;
  if campaign_row.status = normalized_status then
    return jsonb_build_object('id', campaign_row.id, 'status', campaign_row.status,
      'version', campaign_row.version, 'replayed', true);
  end if;
  if campaign_row.status = 'ARCHIVED'
    or (normalized_status = 'PAUSED' and campaign_row.status <> 'ACTIVE') then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_CAMPAIGN_TRANSITION';
  end if;

  if normalized_status = 'ACTIVE' then
    if campaign_row.trigger_type = 'AUDIENCE' then
      raise exception using errcode = '22023', message = 'MARKETING_DRIP_CAMPAIGN_NOT_EDITABLE';
    end if;
    if not exists (
      select 1 from public.marketing_drip_steps step_row
      join public.marketing_drip_step_channels channel_row on channel_row.step_id = step_row.id
      where step_row.campaign_id = campaign_row.id and step_row.active
    ) then
      raise exception using errcode = '22023', message = 'DRIP_CAMPAIGN_HAS_NO_STEPS';
    end if;
    if exists (
      select 1
      from public.marketing_drip_steps step_row
      join public.marketing_drip_step_channels channel_row on channel_row.step_id = step_row.id
      left join public.templates template_row
        on template_row.id = channel_row.template_id and template_row.deleted_at is null
      where step_row.campaign_id = campaign_row.id and step_row.active
        and (
          template_row.id is null
          or upper(template_row.status) <> 'APPROVED'
          or template_row.provider_template_id is null
          or exists (
            select 1 from jsonb_array_elements_text(template_row.placeholders) placeholder
            where not (channel_row.variable_map ? placeholder)
          )
        )
    ) then
      raise exception using errcode = '22023', message = 'DRIP_CAMPAIGN_TEMPLATE_NOT_APPROVED';
    end if;
    select channel_row.channel into missing_channel
    from public.marketing_drip_steps step_row
    join public.marketing_drip_step_channels channel_row on channel_row.step_id = step_row.id
    where step_row.campaign_id = campaign_row.id and step_row.active
      and not app_private.drip_channel_connected(current_organization_id, campaign_row.branch_id, channel_row.channel)
    limit 1;
    if missing_channel is not null then
      raise exception using errcode = '22023',
        message = 'DRIP_CHANNEL_NOT_CONNECTED', detail = missing_channel;
    end if;
  end if;

  update public.marketing_drip_campaigns
  set status = normalized_status,
    -- Only events after (re)activation fire, so a resume does not replay the
    -- leads that arrived while it was paused.
    activated_at = case when normalized_status = 'ACTIVE' then now() else activated_at end,
    starts_at = case when normalized_status = 'ACTIVE' then coalesce(starts_at, now()) else starts_at end,
    paused_at = case when normalized_status = 'PAUSED' then now() when normalized_status = 'ACTIVE' then null else paused_at end,
    version = version + 1,
    updated_at = now()
  where id = campaign_row.id
  returning jsonb_build_object('id', id, 'status', status, 'version', version, 'replayed', false)
  into result;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'marketing_automation.drip_status_changed',
    'marketing_drip_campaign', campaign_row.id::text, campaign_row.branch_id,
    jsonb_build_object('from', campaign_row.status, 'to', normalized_status)
  );
  return result;
end;
$function$;
revoke all on function public.set_marketing_drip_campaign_status(uuid, text, bigint) from public, anon;
grant execute on function public.set_marketing_drip_campaign_status(uuid, text, bigint) to authenticated;

-- Roughly how many would this trigger have reached: the last 30 days for
-- events, the next 30 days for dates.
create or replace function public.preview_marketing_drip_audience(
  target_trigger_type text, target_conditions jsonb, target_branch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  trigger_value text := upper(btrim(coalesce(target_trigger_type, '')));
  conditions jsonb := coalesce(target_conditions, '{}'::jsonb);
  today_ist date := (now() at time zone 'Asia/Kolkata')::date;
  match_count bigint := 0;
begin
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.view') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_VIEW_PERMISSION_REQUIRED';
  end if;
  if target_branch_id is not null and not app_private.can_access_branch(current_organization_id, target_branch_id) then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_SCOPE_DENIED';
  end if;

  if trigger_value = 'LEAD_CREATED' then
    select count(*) into match_count
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.created_at >= now() - interval '30 days'
      and (target_branch_id is null or lead_row.branch_id = target_branch_id)
      and (
        coalesce(jsonb_array_length(conditions -> 'sources'), 0) = 0
        or lead_row.source in (select jsonb_array_elements_text(conditions -> 'sources'))
      )
      and (
        coalesce(jsonb_array_length(conditions -> 'models'), 0) = 0
        or lower(btrim(lead_row.interested_model)) in (
          select lower(btrim(model_name)) from jsonb_array_elements_text(conditions -> 'models') model_name
        )
      );
  elsif trigger_value in ('BIRTHDAY', 'ANNIVERSARY') then
    select count(distinct value_row.resource_id) into match_count
    from public.custom_field_definitions definition_row
    join public.custom_field_values value_row
      on value_row.organization_id = definition_row.organization_id
     and value_row.definition_id = definition_row.id
     and value_row.resource_type = 'CUSTOMER'
     and jsonb_typeof(value_row.value) = 'string'
    where definition_row.organization_id = current_organization_id
      and definition_row.module = 'CUSTOMERS'
      and definition_row.field_type = 'DATE'
      and definition_row.field_key = case trigger_value when 'BIRTHDAY' then 'date_of_birth' else 'wedding_anniversary' end
      and substring(value_row.value #>> '{}' from 6 for 5) in (
        select to_char(today_ist + offset_day, 'MM-DD') from generate_series(0, 29) offset_day
      )
      and (target_branch_id is null or exists (
        select 1 from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.customer_id = value_row.resource_id
          and lead_row.branch_id = target_branch_id
          and lead_row.deleted_at is null
      ));
  elsif trigger_value = 'BOOKING_CONFIRMED' then
    select count(*) into match_count
    from public.bookings booking_row
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= now() - interval '30 days'
      and (target_branch_id is null or booking_row.branch_id = target_branch_id);
  elsif trigger_value = 'VEHICLE_DELIVERED' then
    select count(*) into match_count
    from public.delivery_cases delivery_row
    where delivery_row.organization_id = current_organization_id
      and delivery_row.deleted_at is null and delivery_row.status = 'DELIVERED'
      and delivery_row.delivered_at >= now() - interval '30 days'
      and (target_branch_id is null or delivery_row.branch_id = target_branch_id);
  elsif trigger_value = 'DELIVERY_ANNIVERSARY' then
    select count(*) into match_count
    from public.delivery_cases delivery_row
    where delivery_row.organization_id = current_organization_id
      and delivery_row.deleted_at is null and delivery_row.status = 'DELIVERED'
      and delivery_row.delivered_at < date_trunc('year', now())
      and to_char(timezone('Asia/Kolkata', delivery_row.delivered_at), 'MM-DD') in (
        select to_char(today_ist + offset_day, 'MM-DD') from generate_series(0, 29) offset_day
      )
      and (target_branch_id is null or delivery_row.branch_id = target_branch_id);
  else
    raise exception using errcode = '22023', message = 'INVALID_DRIP_TRIGGER';
  end if;

  return jsonb_build_object(
    'count', match_count,
    'window', case when trigger_value in ('BIRTHDAY', 'ANNIVERSARY', 'DELIVERY_ANNIVERSARY')
      then 'NEXT_30_DAYS' else 'LAST_30_DAYS' end
  );
end;
$function$;
revoke all on function public.preview_marketing_drip_audience(text, jsonb, uuid) from public, anon;
grant execute on function public.preview_marketing_drip_audience(text, jsonb, uuid) to authenticated;

-- Per-channel marketing opt-out for one customer.
create or replace function public.get_customer_marketing_opt_outs(target_customer_id uuid)
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
    or not app_private.can_access_customer(current_organization_id, target_customer_id) then
    raise exception using errcode = '42501', message = 'CUSTOMER_ACCESS_DENIED';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'channel', opt_out_row.channel, 'reason', opt_out_row.reason,
      'source', opt_out_row.source, 'created_at', opt_out_row.created_at,
      'created_by_name', profile_row.full_name
    ) order by opt_out_row.channel)
    from public.customer_marketing_opt_outs opt_out_row
    left join public.profiles profile_row on profile_row.id = opt_out_row.created_by
    where opt_out_row.organization_id = current_organization_id
      and opt_out_row.customer_id = target_customer_id
      and opt_out_row.revoked_at is null
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.get_customer_marketing_opt_outs(uuid) from public, anon;
grant execute on function public.get_customer_marketing_opt_outs(uuid) to authenticated;

create or replace function public.set_customer_marketing_opt_out(
  target_customer_id uuid, target_channel text, target_opted_out boolean, target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  normalized_channel text := upper(btrim(coalesce(target_channel, '')));
  normalized_reason text := nullif(btrim(coalesce(target_reason, '')), '');
  changed integer := 0;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.can_access_customer(current_organization_id, target_customer_id)
    or not (
      app_private.has_permission(current_organization_id, 'customer.drip.manage')
      or app_private.has_permission(current_organization_id, 'marketing.automation.manage')
      or app_private.has_permission(current_organization_id, 'lead.update')
    ) then
    raise exception using errcode = '42501', message = 'CUSTOMER_ACCESS_DENIED';
  end if;
  if normalized_channel not in ('WHATSAPP', 'SMS', 'EMAIL') or target_opted_out is null
    or char_length(coalesce(normalized_reason, '')) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_OPT_OUT';
  end if;

  if target_opted_out then
    insert into public.customer_marketing_opt_outs (
      organization_id, customer_id, channel, reason, source, created_by
    ) values (
      current_organization_id, target_customer_id, normalized_channel, normalized_reason, 'MANUAL', auth.uid()
    )
    on conflict (organization_id, customer_id, channel) where revoked_at is null do nothing;
    get diagnostics changed = row_count;
  else
    update public.customer_marketing_opt_outs
    set revoked_at = now(), revoked_by = auth.uid()
    where organization_id = current_organization_id
      and customer_id = target_customer_id
      and channel = normalized_channel
      and revoked_at is null;
    get diagnostics changed = row_count;
  end if;

  if changed > 0 then
    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, metadata
    ) values (
      current_organization_id, auth.uid(),
      case when target_opted_out then 'customer.marketing_opted_out' else 'customer.marketing_opted_in' end,
      'customer', target_customer_id::text,
      jsonb_build_object('channel', normalized_channel, 'reason', normalized_reason)
    );
    insert into public.activities (organization_id, customer_id, activity_type, actor_id, metadata)
    values (
      current_organization_id, target_customer_id,
      case when target_opted_out then 'MARKETING_OPTED_OUT' else 'MARKETING_OPTED_IN' end,
      auth.uid(), jsonb_build_object('channel', normalized_channel, 'reason', normalized_reason)
    );
  end if;
  return jsonb_build_object('channel', normalized_channel, 'opted_out', target_opted_out, 'changed', changed > 0);
end;
$function$;
revoke all on function public.set_customer_marketing_opt_out(uuid, text, boolean, text) from public, anon;
grant execute on function public.set_customer_marketing_opt_out(uuid, text, boolean, text) to authenticated;

CREATE OR REPLACE FUNCTION public.approve_template(target_template_id uuid, target_provider_template_id text, target_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  template_row public.templates%rowtype;
  normalized_provider_id text := btrim(coalesce(target_provider_template_id, ''));
  normalized_channel text;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not (
      app_private.has_permission(current_organization_id, 'integration.manage')
      -- Marketing manages its own MARKETING templates.
      or (
        app_private.has_permission(current_organization_id, 'marketing.automation.manage')
        and exists (
          select 1 from public.templates marketing_template
          where marketing_template.id = target_template_id
            and marketing_template.organization_id = current_organization_id
            and marketing_template.category = 'MARKETING'
        )
      )
    ) then
    raise exception using errcode = '42501', message = 'TEMPLATE_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_template_id is null or target_request_id is null
    or char_length(normalized_provider_id) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_APPROVAL_INPUT';
  end if;

  select * into template_row
  from public.templates
  where id = target_template_id
    and organization_id = current_organization_id
    and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'TEMPLATE_NOT_FOUND';
  end if;

  normalized_channel := upper(btrim(coalesce(template_row.channel, '')));

  -- send-email casts the provider id back through `z.int().positive()`, so a
  -- non-numeric Brevo id would be stored here and then never match at send time.
  -- Rejecting it now turns a silent dead template into an immediate error.
  if normalized_channel = 'EMAIL' and normalized_provider_id !~ '^[0-9]{1,18}$' then
    raise exception using errcode = '22023', message = 'INVALID_BREVO_TEMPLATE_ID';
  end if;
  -- Meta names approved WhatsApp templates in lowercase snake case. Length is
  -- already bounded above; POSIX regex caps a repetition count at 255, so the
  -- quantifier here stays unbounded rather than restating the 512 limit.
  -- MSG91 template ids are alphanumeric.
  if normalized_channel = 'SMS' and normalized_provider_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception using errcode = '22023', message = 'INVALID_SMS_TEMPLATE_ID';
  end if;
  if normalized_channel in ('WHATSAPP', 'WHATSAPP_BUSINESS')
    and normalized_provider_id !~ '^[a-z0-9_]+$' then
    raise exception using errcode = '22023', message = 'INVALID_WHATSAPP_TEMPLATE_NAME';
  end if;

  -- Approving twice with the same provider id is the natural retry and must not
  -- fail; approving twice with a different id is a conflicting decision.
  if upper(template_row.status) = 'APPROVED' then
    if template_row.provider_template_id is distinct from normalized_provider_id then
      raise exception using errcode = '22023', message = 'TEMPLATE_ALREADY_APPROVED';
    end if;
    return jsonb_build_object(
      'id', template_row.id, 'status', 'APPROVED',
      'provider_template_id', normalized_provider_id, 'replayed', true
    );
  end if;
  if upper(template_row.status) not in ('DRAFT', 'REJECTED') then
    raise exception using errcode = '22023', message = 'TEMPLATE_NOT_APPROVABLE';
  end if;

  update public.templates
  set status = 'APPROVED', provider_template_id = normalized_provider_id, updated_at = now()
  where id = template_row.id and organization_id = current_organization_id;

  result := jsonb_build_object(
    'id', template_row.id, 'status', 'APPROVED',
    'provider_template_id', normalized_provider_id, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'template.approved', 'template',
    template_row.id::text, target_request_id,
    jsonb_build_object('channel', normalized_channel, 'result', result)
  );
  return result;
exception
  when unique_violation then
    raise exception using errcode = '22023', message = 'TEMPLATE_PROVIDER_ID_IN_USE';
end;
$function$;

CREATE OR REPLACE FUNCTION public.archive_template(target_template_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not (
      app_private.has_permission(current_organization_id, 'integration.manage')
      -- Marketing manages its own MARKETING templates.
      or (
        app_private.has_permission(current_organization_id, 'marketing.automation.manage')
        and exists (
          select 1 from public.templates marketing_template
          where marketing_template.id = target_template_id
            and marketing_template.organization_id = current_organization_id
            and marketing_template.category = 'MARKETING'
        )
      )
    ) then
    raise exception using errcode = '42501', message = 'TEMPLATE_MANAGE_PERMISSION_REQUIRED';
  end if;
  update public.templates set status = 'ARCHIVED', deleted_at = now(), updated_at = now()
    where id = target_template_id and organization_id = current_organization_id and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'TEMPLATE_NOT_FOUND'; end if;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
    values (current_organization_id, auth.uid(), 'template.archived', 'template', target_template_id::text, '{}'::jsonb);
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_marketing_automation_workspace(target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_organization_id uuid; result jsonb;
begin
  if target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_AUTOMATION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.view') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_VIEW_PERMISSION_REQUIRED';
  end if;
  with campaigns as materialized (
    select campaign_row.*,
      coalesce((select count(*) from public.marketing_drip_steps step_row
        where step_row.organization_id = campaign_row.organization_id and step_row.campaign_id = campaign_row.id and step_row.active), 0) as step_count
    from public.marketing_drip_campaigns campaign_row
    where campaign_row.organization_id = current_organization_id and campaign_row.deleted_at is null
      and ((campaign_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id))
        or (campaign_row.branch_id is not null and app_private.can_access_branch(current_organization_id, campaign_row.branch_id)))
  ), reviews as materialized (
    select request_row.*, customer_row.full_name as customer_name, customer_row.primary_phone as customer_phone,
      booking_row.booking_number
    from public.customer_review_requests request_row
    join public.customers customer_row on customer_row.organization_id = request_row.organization_id
      and customer_row.id = request_row.customer_id and customer_row.deleted_at is null
    left join public.bookings booking_row on booking_row.organization_id = request_row.organization_id
      and booking_row.id = request_row.booking_id and booking_row.deleted_at is null
    where request_row.organization_id = current_organization_id and request_row.deleted_at is null
      and app_private.can_access_branch(current_organization_id, request_row.branch_id)
      and app_private.can_access_customer(current_organization_id, request_row.customer_id)
  )
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'drip_kpis', jsonb_build_object(
      'total', (select count(*) from campaigns),
      'active', (select count(*) from campaigns where status = 'ACTIVE'),
      'paused', (select count(*) from campaigns where status = 'PAUSED'),
      'steps', (select coalesce(sum(step_count), 0) from campaigns)
    ),
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'description', description, 'branch_id', branch_id,
      'default_channel', default_channel, 'status', status, 'starts_at', starts_at,
      'step_count', step_count, 'version', version, 'updated_at', updated_at,
      'trigger_type', trigger_type, 'trigger_conditions', trigger_conditions,
      'activated_at', activated_at,
      'channels', coalesce((
        select jsonb_agg(distinct channel_row.channel)
        from public.marketing_drip_steps step_row
        join public.marketing_drip_step_channels channel_row on channel_row.step_id = step_row.id
        where step_row.campaign_id = page_row.id and step_row.active
      ), jsonb_build_array(default_channel)),
      'stats', (
        select jsonb_build_object(
          'enrolled', count(distinct enrollment_row.id),
          'sent', count(message_row.id) filter (where message_row.status = 'SENT'),
          'queued', count(message_row.id) filter (where message_row.status in ('QUEUED', 'SENDING')),
          'failed', count(message_row.id) filter (where message_row.status = 'FAILED'),
          'skipped', count(message_row.id) filter (where message_row.status = 'CANCELLED' and message_row.skip_reason is not null)
        )
        from public.customer_drip_enrollments enrollment_row
        left join public.customer_drip_messages message_row on message_row.enrollment_id = enrollment_row.id
        where enrollment_row.organization_id = page_row.organization_id
          and enrollment_row.source_campaign_id = page_row.id
      )
    ) order by updated_at desc, id desc) from (select * from campaigns order by updated_at desc, id desc limit 25) page_row), '[]'::jsonb),
    'review_kpis', jsonb_build_object(
      'queued', (select count(*) from reviews where status = 'QUEUED'),
      'sent_today', (select count(*) from reviews where sent_at is not null
        and timezone(target_timezone, sent_at)::date = timezone(target_timezone, now())::date),
      'delivered', (select count(*) from reviews where status in ('DELIVERED', 'COMPLETED')),
      'completed', (select count(*) from reviews where status = 'COMPLETED')
    ),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'customer_id', customer_id, 'customer_name', customer_name,
      'customer_phone', customer_phone, 'booking_id', booking_id, 'booking_number', booking_number,
      'channel', channel, 'status', status, 'scheduled_for', scheduled_for,
      'sent_at', sent_at, 'created_at', created_at, 'updated_at', updated_at, 'version', version
    ) order by updated_at desc, id desc) from (select * from reviews order by updated_at desc, id desc limit 25) page_row), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

commit;
