-- Shared inbox hot path: one server-paged conversation list plus a bounded
-- per-thread message history. Access is inherited from the conversation's
-- branch/team/lead scope; no browser query reads another user's full tenant inbox.

create index if not exists conversation_messages_inbox_page_idx
  on public.conversation_messages (organization_id, conversation_id, sent_at desc, id desc);

create or replace function public.get_inbox_conversation_page(
  target_search text default '',
  target_channel text default 'all',
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  normalized_search text := left(btrim(coalesce(target_search, '')), 160);
  normalized_channel text := upper(btrim(coalesce(target_channel, 'ALL')));
  offset_rows bigint;
  total_rows bigint := 0;
  rows_data jsonb := '[]'::jsonb;
begin
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_INBOX_PAGINATION';
  end if;
  if normalized_channel not in ('ALL', 'WHATSAPP_BUSINESS', 'INSTAGRAM_MESSAGING', 'FACEBOOK_MESSENGER', 'SMS', 'EMAIL') then
    raise exception using errcode = '22023', message = 'INVALID_INBOX_CHANNEL';
  end if;
  access_context := public.get_access_context();
  if auth.uid() is null or access_context->>'destination' <> 'CRM'
    or access_context->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'INBOX_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;
  if not app_private.has_permission(current_organization_id, 'message.view') then
    raise exception using errcode = '42501', message = 'MESSAGE_VIEW_PERMISSION_REQUIRED';
  end if;
  offset_rows := (target_page - 1)::bigint * target_page_size;

  with scoped as materialized (
    select conversation_row.id, conversation_row.organization_id, conversation_row.branch_id,
      conversation_row.lead_id, conversation_row.customer_id, conversation_row.channel,
      conversation_row.status, conversation_row.assigned_user_id,
      conversation_row.external_contact, conversation_row.last_message_at, conversation_row.created_at
    from public.conversations conversation_row
    where conversation_row.organization_id = current_organization_id
      and app_private.can_access_conversation(current_organization_id, conversation_row.id)
      and (normalized_channel = 'ALL' or conversation_row.channel = normalized_channel)
  ), filtered as materialized (
    select scoped_row.*
    from scoped scoped_row
    left join public.customers customer_row
      on customer_row.organization_id = scoped_row.organization_id and customer_row.id = scoped_row.customer_id
    left join public.leads lead_row
      on lead_row.organization_id = scoped_row.organization_id and lead_row.id = scoped_row.lead_id
    where normalized_search = ''
      or coalesce(customer_row.full_name, lead_row.customer_name, scoped_row.external_contact, '')
        ilike '%' || replace(replace(replace(normalized_search, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' escape E'\\'
      or coalesce(customer_row.primary_phone, lead_row.phone, scoped_row.external_contact, '')
        ilike '%' || replace(replace(replace(normalized_search, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' escape E'\\'
  ), page_rows as materialized (
    select * from filtered
    order by coalesce(last_message_at, created_at) desc, id desc
    limit target_page_size offset offset_rows
  )
  select count(*) into total_rows from filtered;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page_row.id,
    'lead_id', page_row.lead_id,
    'customer_id', page_row.customer_id,
    'channel', page_row.channel,
    'status', page_row.status,
    'customer_name', coalesce(customer_row.full_name, lead_row.customer_name, page_row.external_contact, 'Unknown contact'),
    'phone', coalesce(customer_row.primary_phone, lead_row.phone, page_row.external_contact),
    'interested_model', lead_row.interested_model,
    'assigned_user_name', profile_row.full_name,
    'last_message_at', page_row.last_message_at,
    'last_message_body', latest_message.body,
    'last_message_direction', latest_message.direction
  ) order by coalesce(page_row.last_message_at, page_row.created_at) desc, page_row.id desc), '[]'::jsonb)
  into rows_data
  from page_rows page_row
  left join public.customers customer_row
    on customer_row.organization_id = page_row.organization_id and customer_row.id = page_row.customer_id
  left join public.leads lead_row
    on lead_row.organization_id = page_row.organization_id and lead_row.id = page_row.lead_id
  left join public.profiles profile_row
    on profile_row.organization_id = page_row.organization_id and profile_row.id = page_row.assigned_user_id
  left join lateral (
    select message_row.body, message_row.direction
    from public.conversation_messages message_row
    where message_row.organization_id = page_row.organization_id and message_row.conversation_id = page_row.id
    order by message_row.sent_at desc, message_row.id desc limit 1
  ) latest_message on true;

  return jsonb_build_object('records', rows_data, 'total', total_rows);
end;
$$;

create or replace function public.get_inbox_message_page(
  target_conversation_id uuid,
  target_before_at timestamptz default null,
  target_before_id uuid default null,
  target_page_size integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  records_data jsonb := '[]'::jsonb;
  has_more boolean := false;
  next_at timestamptz;
  next_id uuid;
begin
  if target_page_size not in (25, 50, 100) or (target_before_at is null) <> (target_before_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_INBOX_MESSAGE_PAGE';
  end if;
  select organization_id into current_organization_id
  from public.conversations where id = target_conversation_id;
  if current_organization_id is null or not app_private.can_access_conversation(current_organization_id, target_conversation_id) then
    raise exception using errcode = 'P0002', message = 'CONVERSATION_NOT_FOUND';
  end if;

  with page_rows as materialized (
    select message_row.id, message_row.direction, message_row.body, message_row.delivery_status,
      message_row.sent_at, message_row.metadata
    from public.conversation_messages message_row
    where message_row.organization_id = current_organization_id
      and message_row.conversation_id = target_conversation_id
      and (target_before_at is null or (message_row.sent_at, message_row.id) < (target_before_at, target_before_id))
    order by message_row.sent_at desc, message_row.id desc
    limit target_page_size + 1
  ), visible_rows as materialized (
    select * from page_rows order by sent_at desc, id desc limit target_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', row_data.id, 'direction', row_data.direction, 'body', row_data.body,
    'delivery_status', row_data.delivery_status, 'sent_at', row_data.sent_at, 'metadata', row_data.metadata
  ) order by row_data.sent_at asc, row_data.id asc), '[]'::jsonb),
    (select count(*) > target_page_size from page_rows),
    (select row_data.sent_at from visible_rows row_data order by row_data.sent_at asc, row_data.id asc limit 1),
    (select row_data.id from visible_rows row_data order by row_data.sent_at asc, row_data.id asc limit 1)
  into records_data, has_more, next_at, next_id
  from visible_rows row_data;

  return jsonb_build_object(
    'records', records_data, 'has_more', has_more,
    'next_before_at', case when has_more then next_at else null end,
    'next_before_id', case when has_more then next_id else null end
  );
end;
$$;

revoke all on function public.get_inbox_conversation_page(text, text, integer, integer) from public, anon;
grant execute on function public.get_inbox_conversation_page(text, text, integer, integer) to authenticated;
revoke all on function public.get_inbox_message_page(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.get_inbox_message_page(uuid, timestamptz, uuid, integer) to authenticated;
