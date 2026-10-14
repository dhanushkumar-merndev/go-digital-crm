begin;

-- Official WhatsApp only accepts a free-form message inside the 24-hour
-- customer-service window that opens when the customer writes in. Outside it
-- the first message has to be a Meta-approved template; once the customer
-- replies, the window opens and the composer can type freely again.
--
-- The inbox needs two things for that: whether the window is open for this
-- conversation, and the approved templates it may send. Both come from here,
-- under the same access rule as reading the conversation's messages, plus
-- message.send. A template counts as approved when it is APPROVED in the CRM
-- with the Meta template name recorded (`provider_template_id`) -- the same
-- rule the drip dispatcher uses.
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

  select conversation_row.service_window_expires_at into window_expires_at
  from public.conversations conversation_row
  where conversation_row.organization_id = thread.organization_id
    and conversation_row.id = thread.id;

  -- Values a template commonly asks for, so the sender only fills in the rest.
  select jsonb_strip_nulls(jsonb_build_object(
    'customer_name', coalesce(customer_row.full_name, lead_row.customer_name),
    'first_name', split_part(btrim(coalesce(customer_row.full_name, lead_row.customer_name, '')), ' ', 1),
    'vehicle_model', lead_row.interested_model,
    'interested_model', lead_row.interested_model,
    'consultant_name', sender_row.full_name,
    'dealership_name', organization_row.name
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
      select jsonb_agg(jsonb_build_object(
        'id', template_row.id,
        'name', template_row.name,
        'provider_template_id', template_row.provider_template_id,
        'body', template_row.content ->> 'body',
        'placeholders', coalesce(template_row.placeholders, '[]'::jsonb)
      ) order by template_row.name, template_row.id)
      from public.templates template_row
      where template_row.organization_id = thread.organization_id
        and template_row.deleted_at is null
        and upper(template_row.status) = 'APPROVED'
        and template_row.provider_template_id is not null
        and upper(template_row.channel) in ('WHATSAPP', 'WHATSAPP_BUSINESS')
        and jsonb_typeof(template_row.content -> 'body') = 'string'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_whatsapp_business_reply_templates(uuid) from public, anon;
grant execute on function public.get_whatsapp_business_reply_templates(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
