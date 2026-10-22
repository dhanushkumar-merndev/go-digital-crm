-- The WhatsApp template an agent's "Send review link" uses outside the 24-hour
-- reply window, chosen per WhatsApp connection by whoever manages that
-- integration (Client Admin, or a System Administrator granted it).
--
-- Inside the window, or on personal WhatsApp, the inbox sends the review link as
-- text and this setting is not used. Outside it Meta only accepts an approved
-- template, so the template's fields are filled here: each value may mix text
-- with {{customer_first_name}}-style fields, including {{review_link}}, the
-- signed single-use link create_lead_review_request just issued.

begin;

create table if not exists public.whatsapp_review_templates (
  connected_account_id uuid primary key references public.connected_accounts(id),
  organization_id uuid not null references public.organizations(id),
  template_id uuid not null references public.whatsapp_business_templates(id),
  variable_map jsonb not null default '{}'::jsonb check (jsonb_typeof(variable_map) = 'object'),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version > 0)
);
alter table public.whatsapp_review_templates enable row level security;
alter table public.whatsapp_review_templates force row level security;
revoke all on public.whatsapp_review_templates from anon, authenticated;

create or replace function app_private.review_template_tokens()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['customer_name', 'customer_first_name', 'consultant_name', 'branch_name',
    'dealership_name', 'review_link'];
$$;

create or replace function public.get_whatsapp_review_template(target_connection_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org uuid := app_private.current_tenant_organization();
  setting public.whatsapp_review_templates%rowtype;
begin
  if auth.uid() is null or org is null
    or not public.authorize_integration_connection_action(org, target_connection_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select * into setting from public.whatsapp_review_templates source_row
  where source_row.connected_account_id = target_connection_id and source_row.organization_id = org;
  return jsonb_build_object(
    'tokens', to_jsonb(app_private.review_template_tokens()),
    'template_id', setting.template_id,
    'variable_map', coalesce(setting.variable_map, '{}'::jsonb),
    'version', setting.version
  );
end;
$$;

create or replace function public.set_whatsapp_review_template(
  target_connection_id uuid, target_template_id uuid, target_variable_map jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid := app_private.current_tenant_organization();
  template_row public.whatsapp_business_templates%rowtype;
  clean_map jsonb := '{}'::jsonb;
  field_name text;
  field_value text;
begin
  if auth.uid() is null or org is null
    or not public.authorize_integration_connection_action(org, target_connection_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_template_id is null then
    delete from public.whatsapp_review_templates
    where connected_account_id = target_connection_id and organization_id = org;
    insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
    values (org, auth.uid(), 'whatsapp_review_template.cleared', 'connected_account',
      target_connection_id::text, '{}'::jsonb);
    return jsonb_build_object('template_id', null);
  end if;
  if jsonb_typeof(coalesce(target_variable_map, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_TEMPLATE_FIELDS';
  end if;
  select * into template_row from public.whatsapp_business_templates candidate
  where candidate.id = target_template_id and candidate.organization_id = org
    and candidate.connected_account_id = target_connection_id
    and candidate.enabled and candidate.supported and candidate.meta_status = 'APPROVED'
    and candidate.removed_from_meta_at is null;
  if not found then
    raise exception using errcode = '22023', message = 'WHATSAPP_TEMPLATE_NOT_ENABLED';
  end if;
  for field_name in select jsonb_array_elements_text(coalesce(template_row.fields, '[]'::jsonb)) loop
    field_value := btrim(coalesce(target_variable_map ->> field_name, ''));
    if char_length(field_value) not between 1 and 500 then
      raise exception using errcode = '22023', message = 'REVIEW_TEMPLATE_FIELD_REQUIRED',
        detail = field_name;
    end if;
    clean_map := clean_map || jsonb_build_object(field_name, field_value);
  end loop;
  insert into public.whatsapp_review_templates as setting (
    connected_account_id, organization_id, template_id, variable_map, updated_by)
  values (target_connection_id, org, template_row.id, clean_map, auth.uid())
  on conflict (connected_account_id) do update
  set template_id = excluded.template_id, variable_map = excluded.variable_map,
    updated_by = excluded.updated_by, updated_at = now(), version = setting.version + 1;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
  values (org, auth.uid(), 'whatsapp_review_template.set', 'connected_account',
    target_connection_id::text,
    jsonb_build_object('template_id', template_row.id, 'name', template_row.name));
  return jsonb_build_object('template_id', template_row.id);
end;
$$;

-- For the agent in the inbox: the configured template with every field filled
-- for this conversation, ready for send-message's crm_template path. Returns
-- configured=false (not an error) when the admin has not chosen one yet.
create or replace function public.resolve_inbox_review_template(
  target_conversation_id uuid, target_review_link text
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  thread record;
  setting public.whatsapp_review_templates%rowtype;
  template_row public.whatsapp_business_templates%rowtype;
  context jsonb;
  resolved jsonb := '{}'::jsonb;
  entry record;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_review_link is null or char_length(target_review_link) > 500
    or target_review_link !~ '^https://[^\s]+/feedback/[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_LINK';
  end if;
  select * into thread from app_private.accessible_inbox_threads
  where id = target_conversation_id and channel = 'WHATSAPP_BUSINESS';
  if not found
    or not app_private.has_permission(thread.organization_id, 'message.view')
    or not app_private.has_permission(thread.organization_id, 'message.send')
  then
    raise exception using errcode = '42501', message = 'CONVERSATION_NOT_FOUND';
  end if;
  select setting_row.* into setting
  from public.conversations conversation_row
  join public.whatsapp_review_templates setting_row
    on setting_row.connected_account_id = conversation_row.connection_id
   and setting_row.organization_id = conversation_row.organization_id
  where conversation_row.organization_id = thread.organization_id and conversation_row.id = thread.id;
  if not found then return jsonb_build_object('configured', false); end if;
  select * into template_row from public.whatsapp_business_templates candidate
  where candidate.id = setting.template_id and candidate.organization_id = thread.organization_id
    and candidate.enabled and candidate.supported and candidate.meta_status = 'APPROVED'
    and candidate.removed_from_meta_at is null;
  if not found then return jsonb_build_object('configured', false); end if;

  select jsonb_build_object(
    'customer_name', coalesce(customer_row.full_name, lead_row.customer_name, ''),
    'customer_first_name', split_part(btrim(coalesce(customer_row.full_name, lead_row.customer_name, '')), ' ', 1),
    'consultant_name', coalesce(sender_row.full_name, ''),
    'branch_name', coalesce(branch_row.name, ''),
    'dealership_name', coalesce(organization_row.name, ''),
    'review_link', target_review_link
  ) into context
  from (select 1) anchor
  left join public.leads lead_row
    on lead_row.organization_id = thread.organization_id and lead_row.id = thread.lead_id
  left join public.customers customer_row
    on customer_row.organization_id = thread.organization_id and customer_row.id = thread.customer_id
  left join public.conversations conversation_row
    on conversation_row.organization_id = thread.organization_id and conversation_row.id = thread.id
  left join public.branches branch_row
    on branch_row.organization_id = thread.organization_id and branch_row.id = conversation_row.branch_id
  left join public.profiles sender_row
    on sender_row.organization_id = thread.organization_id and sender_row.id = auth.uid()
  left join public.organizations organization_row on organization_row.id = thread.organization_id;

  for entry in select key, value from jsonb_each_text(setting.variable_map) loop
    resolved := resolved || jsonb_build_object(entry.key, app_private.render_review_value(entry.value, context));
  end loop;
  return jsonb_build_object(
    'configured', true,
    'template_id', template_row.id,
    'template_name', template_row.name,
    'variables', resolved
  );
end;
$$;

revoke all on function public.get_whatsapp_review_template(uuid),
  public.set_whatsapp_review_template(uuid, uuid, jsonb),
  public.resolve_inbox_review_template(uuid, text) from public, anon;
grant execute on function public.get_whatsapp_review_template(uuid),
  public.set_whatsapp_review_template(uuid, uuid, jsonb),
  public.resolve_inbox_review_template(uuid, text) to authenticated;
revoke all on function app_private.review_template_tokens() from public, anon, authenticated;

commit;
