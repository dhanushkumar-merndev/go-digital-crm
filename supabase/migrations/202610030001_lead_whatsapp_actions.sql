begin;

-- Open (or reuse) a WhatsApp thread directly from a lead row. The browser never
-- chooses a provider connection: the database resolves the authenticated
-- employee's personal session or the branch-mapped official account.
create or replace function public.open_lead_whatsapp_conversation(
  target_lead_id uuid,
  target_channel text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization uuid;
  lead_row public.leads%rowtype;
  normalized_channel text := upper(btrim(coalesce(target_channel, '')));
  contact_phone text;
  personal_session public.personal_whatsapp_sessions%rowtype;
  official_connection_id uuid;
  conversation_id uuid;
begin
  organization := app_private.current_tenant_organization();
  if auth.uid() is null or organization is null
    or not app_private.has_permission(organization, 'message.view')
    or not app_private.has_permission(organization, 'message.send')
  then
    raise exception using errcode = '42501', message = 'MESSAGE_SEND_PERMISSION_REQUIRED';
  end if;
  if normalized_channel not in ('WHATSAPP_PERSONAL', 'WHATSAPP_BUSINESS') then
    raise exception using errcode = '22023', message = 'WHATSAPP_CHANNEL_INVALID';
  end if;

  select * into lead_row
  from public.leads
  where organization_id = organization
    and id = target_lead_id
    and deleted_at is null;
  if not found or not app_private.can_access_lead(target_lead_id)
    or not app_private.can_access_branch(organization, lead_row.branch_id)
    or not app_private.can_access_record(
      organization,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'LEAD_NOT_FOUND';
  end if;

  contact_phone := regexp_replace(coalesce(lead_row.normalized_phone, lead_row.phone, ''), '[^0-9]', '', 'g');
  -- Match the web dialler's India-default normalization so opening a lead row
  -- reuses an inbound 91XXXXXXXXXX thread instead of creating a duplicate for
  -- the same locally stored ten-digit mobile.
  if length(contact_phone) = 10 then
    contact_phone := '91' || contact_phone;
  elsif length(contact_phone) = 11 and left(contact_phone, 1) = '0' then
    contact_phone := '91' || right(contact_phone, 10);
  end if;
  if contact_phone !~ '^[0-9]{7,15}$' then
    raise exception using errcode = '22023', message = 'LEAD_PHONE_INVALID';
  end if;

  if normalized_channel = 'WHATSAPP_PERSONAL' then
    if not app_private.personal_whatsapp_actor_record(auth.uid(), organization, lead_row.id, null) then
      raise exception using errcode = '42501', message = 'PERSONAL_WHATSAPP_LEAD_DENIED';
    end if;
    select session_row.* into personal_session
    from public.personal_whatsapp_sessions session_row
    where session_row.organization_id = organization
      and session_row.owner_user_id = auth.uid()
      and session_row.enabled
      and session_row.status in ('CONNECTED', 'RECONNECTING')
    order by session_row.requested_at desc
    limit 1;
    if not found then
      raise exception using errcode = '55000', message = 'PERSONAL_WHATSAPP_NOT_CONNECTED';
    end if;

    insert into public.personal_whatsapp_conversations as existing_thread (
      organization_id,
      connection_id,
      branch_id,
      owner_user_id,
      normalized_contact,
      lead_id,
      customer_id
    ) values (
      organization,
      personal_session.connection_id,
      lead_row.branch_id,
      auth.uid(),
      contact_phone,
      lead_row.id,
      lead_row.customer_id
    )
    on conflict (connection_id, normalized_contact)
    do update set
      branch_id = excluded.branch_id,
      lead_id = excluded.lead_id,
      customer_id = coalesce(excluded.customer_id, existing_thread.customer_id),
      deleted_at = null
    returning id into conversation_id;
  else
    select account_row.id into official_connection_id
    from public.connected_accounts account_row
    where account_row.organization_id = organization
      and account_row.provider_key = 'whatsapp_cloud'
      and account_row.status = 'CONNECTED'
      and account_row.deleted_at is null
      and (
        exists (
          select 1
          from public.integration_branch_mappings mapping_row
          where mapping_row.organization_id = organization
            and mapping_row.connected_account_id = account_row.id
            and mapping_row.branch_id = lead_row.branch_id
            and mapping_row.deleted_at is null
        )
        or account_row.scope_mode = 'ALL_BRANCHES'
      )
    order by (
      exists (
        select 1
        from public.integration_branch_mappings preferred_mapping
        where preferred_mapping.organization_id = organization
          and preferred_mapping.connected_account_id = account_row.id
          and preferred_mapping.branch_id = lead_row.branch_id
          and preferred_mapping.external_resource_type = 'WHATSAPP_PHONE_NUMBER'
          and preferred_mapping.deleted_at is null
      )
    ) desc,
    account_row.connected_at desc nulls last,
    account_row.id
    limit 1;
    if official_connection_id is null then
      raise exception using errcode = '55000', message = 'WHATSAPP_CONNECTION_UNAVAILABLE';
    end if;

    insert into public.conversations as existing_thread (
      organization_id,
      branch_id,
      lead_id,
      customer_id,
      channel,
      connection_id,
      external_thread_id,
      external_contact,
      normalized_contact,
      assigned_user_id,
      status
    ) values (
      organization,
      lead_row.branch_id,
      lead_row.id,
      lead_row.customer_id,
      'WHATSAPP_BUSINESS',
      official_connection_id,
      contact_phone,
      contact_phone,
      contact_phone,
      lead_row.assigned_user_id,
      'OPEN'
    )
    on conflict (organization_id, connection_id, external_thread_id)
    do update set
      branch_id = excluded.branch_id,
      lead_id = excluded.lead_id,
      customer_id = coalesce(excluded.customer_id, existing_thread.customer_id),
      assigned_user_id = coalesce(excluded.assigned_user_id, existing_thread.assigned_user_id),
      status = 'OPEN'
    returning id into conversation_id;
  end if;

  insert into public.audit_logs (
    organization_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    branch_id,
    metadata
  ) values (
    organization,
    auth.uid(),
    'conversation.opened_from_lead',
    'conversation',
    conversation_id::text,
    lead_row.branch_id,
    jsonb_build_object('lead_id', lead_row.id, 'channel', normalized_channel)
  );

  return jsonb_build_object(
    'conversation_id', conversation_id,
    'channel', normalized_channel
  );
end;
$$;

revoke all on function public.open_lead_whatsapp_conversation(uuid, text) from public, anon;
grant execute on function public.open_lead_whatsapp_conversation(uuid, text) to authenticated;

commit;
