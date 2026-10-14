begin;

-- Meta-approved WhatsApp templates, synced from the WhatsApp Business Account
-- behind each Official WhatsApp connection.
--
-- Meta is the source of truth for what is approved; the CRM decides which of
-- those its agents may send. Sync copies every template the account has (any
-- status) into this catalog, and a Client Admin -- anyone with
-- integration.manage on the connection -- switches on the ones that appear in
-- the inbox. Nothing is enabled by default, and a template Meta no longer
-- approves stops appearing even if it was switched on.
--
-- Template kinds the inbox cannot fill in yet (media headers, dynamic URL or
-- code buttons, authentication and carousel templates) are synced and shown so
-- the admin sees the whole account, but cannot be switched on.
create table public.whatsapp_business_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connected_account_id uuid not null references public.connected_accounts(id),
  meta_template_id text not null,
  name text not null,
  language text not null,
  category text,
  meta_status text not null,
  parameter_format text not null default 'POSITIONAL'
    check (parameter_format in ('POSITIONAL', 'NAMED')),
  header_text text,
  body text not null default '',
  footer_text text,
  buttons jsonb not null default '[]'::jsonb,
  -- `header:<name>` and `body:<name>` keys, in the order Meta expects them.
  fields jsonb not null default '[]'::jsonb,
  supported boolean not null default true,
  unsupported_reason text,
  enabled boolean not null default false,
  enabled_by uuid references public.profiles(id),
  enabled_at timestamptz,
  removed_from_meta_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, connected_account_id, meta_template_id),
  check (not enabled or supported)
);

create index whatsapp_business_templates_inbox_idx
  on public.whatsapp_business_templates (organization_id, connected_account_id, name)
  where enabled;

-- Read and written only through the functions below.
alter table public.whatsapp_business_templates enable row level security;
revoke all on public.whatsapp_business_templates from anon, authenticated;

-- Called by the whatsapp-templates-sync Edge Function with the service role,
-- after it has checked integration.manage for the caller. Upserts the full
-- account listing and marks what Meta no longer returns as removed, in one
-- transaction so a half-finished sync is never visible.
create or replace function public.sync_whatsapp_business_templates(
  target_organization_id uuid,
  target_connection_id uuid,
  target_templates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  upserted integer;
  removed integer;
begin
  if jsonb_typeof(target_templates) is distinct from 'array'
    or jsonb_array_length(target_templates) > 5000
  then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_SYNC_PAYLOAD';
  end if;
  if not exists (
    select 1 from public.connected_accounts connection_row
    where connection_row.id = target_connection_id
      and connection_row.organization_id = target_organization_id
      and connection_row.provider_key = 'whatsapp_cloud'
      and connection_row.deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'CONNECTION_NOT_FOUND';
  end if;

  with incoming as (
    select
      btrim(item ->> 'meta_template_id') as meta_template_id,
      left(btrim(item ->> 'name'), 512) as name,
      left(btrim(item ->> 'language'), 20) as language,
      nullif(upper(btrim(item ->> 'category')), '') as category,
      upper(btrim(coalesce(item ->> 'status', 'UNKNOWN'))) as meta_status,
      case when upper(item ->> 'parameter_format') = 'NAMED' then 'NAMED' else 'POSITIONAL' end
        as parameter_format,
      nullif(item ->> 'header_text', '') as header_text,
      coalesce(item ->> 'body', '') as body,
      nullif(item ->> 'footer_text', '') as footer_text,
      coalesce(item -> 'buttons', '[]'::jsonb) as buttons,
      coalesce(item -> 'fields', '[]'::jsonb) as fields,
      coalesce((item ->> 'supported')::boolean, false) as supported,
      nullif(item ->> 'unsupported_reason', '') as unsupported_reason
    from jsonb_array_elements(target_templates) item
    where nullif(btrim(item ->> 'meta_template_id'), '') is not null
      and nullif(btrim(item ->> 'name'), '') is not null
      and nullif(btrim(item ->> 'language'), '') is not null
  )
  insert into public.whatsapp_business_templates as existing (
    organization_id, connected_account_id, meta_template_id, name, language, category,
    meta_status, parameter_format, header_text, body, footer_text, buttons, fields,
    supported, unsupported_reason, synced_at, updated_at
  )
  select
    target_organization_id, target_connection_id, meta_template_id, name, language, category,
    meta_status, parameter_format, header_text, body, footer_text, buttons, fields,
    supported, unsupported_reason, now(), now()
  from incoming
  on conflict (organization_id, connected_account_id, meta_template_id) do update set
    name = excluded.name,
    language = excluded.language,
    category = excluded.category,
    meta_status = excluded.meta_status,
    parameter_format = excluded.parameter_format,
    header_text = excluded.header_text,
    body = excluded.body,
    footer_text = excluded.footer_text,
    buttons = excluded.buttons,
    fields = excluded.fields,
    supported = excluded.supported,
    unsupported_reason = excluded.unsupported_reason,
    -- A template that became unsendable is switched off rather than left on.
    enabled = existing.enabled and excluded.supported,
    removed_from_meta_at = null,
    synced_at = now(),
    updated_at = now();
  get diagnostics upserted = row_count;

  update public.whatsapp_business_templates template_row
  set enabled = false,
    removed_from_meta_at = coalesce(template_row.removed_from_meta_at, now()),
    updated_at = now()
  where template_row.organization_id = target_organization_id
    and template_row.connected_account_id = target_connection_id
    and template_row.removed_from_meta_at is null
    and template_row.meta_template_id not in (
      select btrim(item ->> 'meta_template_id')
      from jsonb_array_elements(target_templates) item
      where nullif(btrim(item ->> 'meta_template_id'), '') is not null
    );
  get diagnostics removed = row_count;

  update public.connected_accounts
  set last_sync_at = now()
  where id = target_connection_id and organization_id = target_organization_id;

  return jsonb_build_object('synced', upserted, 'removed', removed);
end;
$$;

revoke all on function public.sync_whatsapp_business_templates(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_whatsapp_business_templates(uuid, uuid, jsonb)
  to service_role;

-- The admin catalog for one connection: every synced template, newest status.
create or replace function public.get_whatsapp_business_template_catalog(
  target_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org uuid := app_private.current_tenant_organization();
begin
  if auth.uid() is null or org is null
    or not public.authorize_integration_connection_action(org, target_connection_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  return jsonb_build_object(
    'last_synced_at', (
      select max(template_row.synced_at) from public.whatsapp_business_templates template_row
      where template_row.organization_id = org
        and template_row.connected_account_id = target_connection_id
    ),
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', template_row.id,
        'name', template_row.name,
        'language', template_row.language,
        'category', template_row.category,
        'meta_status', template_row.meta_status,
        'header_text', template_row.header_text,
        'body', template_row.body,
        'footer_text', template_row.footer_text,
        'fields', template_row.fields,
        'supported', template_row.supported,
        'unsupported_reason', template_row.unsupported_reason,
        'enabled', template_row.enabled,
        'removed_from_meta', template_row.removed_from_meta_at is not null
      ) order by
        template_row.removed_from_meta_at is not null,
        template_row.meta_status <> 'APPROVED',
        template_row.name, template_row.language)
      from public.whatsapp_business_templates template_row
      where template_row.organization_id = org
        and template_row.connected_account_id = target_connection_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_whatsapp_business_template_catalog(uuid) from public, anon;
grant execute on function public.get_whatsapp_business_template_catalog(uuid) to authenticated;

create or replace function public.set_whatsapp_business_template_enabled(
  target_template_id uuid,
  target_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid := app_private.current_tenant_organization();
  template_row public.whatsapp_business_templates;
begin
  if target_enabled is null then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_TOGGLE';
  end if;
  select * into template_row
  from public.whatsapp_business_templates candidate
  where candidate.id = target_template_id and candidate.organization_id = org
  for update;
  if auth.uid() is null or not found
    or not public.authorize_integration_connection_action(
      org, template_row.connected_account_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_enabled and (
    not template_row.supported
    or template_row.meta_status <> 'APPROVED'
    or template_row.removed_from_meta_at is not null
  ) then
    raise exception using errcode = '22023', message = 'WHATSAPP_TEMPLATE_NOT_ENABLEABLE';
  end if;
  if template_row.enabled = target_enabled then
    return jsonb_build_object('id', template_row.id, 'enabled', target_enabled, 'changed', false);
  end if;

  update public.whatsapp_business_templates
  set enabled = target_enabled,
    enabled_by = case when target_enabled then auth.uid() else enabled_by end,
    enabled_at = case when target_enabled then now() else enabled_at end,
    updated_at = now()
  where id = template_row.id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    org, auth.uid(),
    case when target_enabled then 'whatsapp_template.enabled' else 'whatsapp_template.disabled' end,
    'whatsapp_business_template', template_row.id::text,
    jsonb_build_object(
      'name', template_row.name,
      'language', template_row.language,
      'connected_account_id', template_row.connected_account_id
    )
  );
  return jsonb_build_object('id', template_row.id, 'enabled', target_enabled, 'changed', true);
end;
$$;

revoke all on function public.set_whatsapp_business_template_enabled(uuid, boolean)
  from public, anon;
grant execute on function public.set_whatsapp_business_template_enabled(uuid, boolean)
  to authenticated;

-- The inbox list now also offers the Meta templates switched on for the
-- conversation's own WhatsApp connection. Their fields carry a `header:` or
-- `body:` prefix; templates written in the CRM keep plain field names.
create or replace function public.get_whatsapp_business_reply_templates(
  target_conversation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  thread record;
  window_expires_at timestamptz;
  thread_connection_id uuid;
  suggestions jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into thread
  from app_private.accessible_inbox_threads
  where id = target_conversation_id and channel = 'WHATSAPP_BUSINESS';
  if not found
    or not app_private.has_permission(thread.organization_id, 'message.view')
    or not app_private.has_permission(thread.organization_id, 'message.send')
  then
    raise exception using errcode = '42501', message = 'CONVERSATION_NOT_FOUND';
  end if;

  select conversation_row.service_window_expires_at, conversation_row.connection_id
  into window_expires_at, thread_connection_id
  from public.conversations conversation_row
  where conversation_row.organization_id = thread.organization_id
    and conversation_row.id = thread.id;

  -- Values a template commonly asks for, so the sender only fills in the rest.
  select jsonb_strip_nulls(jsonb_build_object(
    'customer_name', coalesce(customer_row.full_name, lead_row.customer_name),
    'name', coalesce(customer_row.full_name, lead_row.customer_name),
    'first_name', nullif(split_part(btrim(coalesce(customer_row.full_name, lead_row.customer_name, '')), ' ', 1), ''),
    'vehicle_model', lead_row.interested_model,
    'interested_model', lead_row.interested_model,
    'model', lead_row.interested_model,
    'consultant_name', sender_row.full_name,
    'agent_name', sender_row.full_name,
    'dealership_name', organization_row.name,
    'company_name', organization_row.name
  ))
  into suggestions
  from (select 1) anchor
  left join public.leads lead_row
    on lead_row.organization_id = thread.organization_id and lead_row.id = thread.lead_id
  left join public.customers customer_row
    on customer_row.organization_id = thread.organization_id and customer_row.id = thread.customer_id
  left join public.profiles sender_row
    on sender_row.organization_id = thread.organization_id and sender_row.id = auth.uid()
  left join public.organizations organization_row
    on organization_row.id = thread.organization_id;

  return jsonb_build_object(
    'window_open', coalesce(window_expires_at > now(), false),
    'window_expires_at', window_expires_at,
    'suggestions', coalesce(suggestions, '{}'::jsonb),
    'templates', coalesce((
      select jsonb_agg(option order by option ->> 'name', option ->> 'id')
      from (
        select jsonb_build_object(
          'id', template_row.id,
          'name', template_row.name,
          'provider_template_id', template_row.provider_template_id,
          'body', template_row.content ->> 'body',
          'placeholders', coalesce(template_row.placeholders, '[]'::jsonb),
          'sections', null
        ) as option
        from public.templates template_row
        where template_row.organization_id = thread.organization_id
          and template_row.deleted_at is null
          and upper(template_row.status) = 'APPROVED'
          and template_row.provider_template_id is not null
          and upper(template_row.channel) in ('WHATSAPP', 'WHATSAPP_BUSINESS')
          and jsonb_typeof(template_row.content -> 'body') = 'string'
        union all
        select jsonb_build_object(
          'id', meta_row.id,
          'name', meta_row.name,
          'provider_template_id', meta_row.name || ' · ' || meta_row.language,
          'body', concat_ws(E'\n\n', meta_row.header_text, meta_row.body, meta_row.footer_text),
          'placeholders', meta_row.fields,
          -- Header and body number their fields separately ({{1}} can be in
          -- both), so the preview fills each section with its own values.
          'sections', jsonb_strip_nulls(jsonb_build_object(
            'header', meta_row.header_text,
            'body', meta_row.body,
            'footer', meta_row.footer_text
          ))
        )
        from public.whatsapp_business_templates meta_row
        where meta_row.organization_id = thread.organization_id
          and meta_row.connected_account_id = thread_connection_id
          and meta_row.enabled
          and meta_row.supported
          and meta_row.meta_status = 'APPROVED'
          and meta_row.removed_from_meta_at is null
      ) options
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_whatsapp_business_reply_templates(uuid) from public, anon;
grant execute on function public.get_whatsapp_business_reply_templates(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
