begin;

-- My WhatsApp permits human-triggered messages without a recent inbound message.
-- Preserve authorization, idempotency, gateway fencing and rolling send limits.
-- The official WhatsApp Business API service window is unchanged.
-- Keep reply_window_expires_at as null for older clients during rollout.

create or replace function public.personal_whatsapp_send_prepare(target_conversation_id uuid,target_application_message_id uuid,target_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.personal_whatsapp_conversations%rowtype; s public.personal_whatsapp_sessions%rowtype; m public.personal_whatsapp_messages%rowtype; ten integer; day_count integer; recipient_count integer; last_send timestamptz;
begin
  select * into c from public.personal_whatsapp_conversations where id=target_conversation_id;
  if not found or not app_private.personal_whatsapp_conversation_access(c.organization_id,c.id)
    or not app_private.has_permission(c.organization_id,'message.send') then raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'; end if;
  if target_application_message_id is null or length(btrim(coalesce(target_body,''))) not between 1 and 1500 then raise exception 'PERSONAL_WHATSAPP_INVALID_MESSAGE'; end if;
  select * into s from public.personal_whatsapp_sessions where connection_id=c.connection_id for update;
  select * into m from public.personal_whatsapp_messages where connection_id=c.connection_id and application_message_id=target_application_message_id;
  if found then
    if m.body<>btrim(target_body) or m.conversation_id<>c.id then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return jsonb_build_object('message_id',m.id,'connection_id',s.connection_id,'generation',s.generation,'status',m.delivery_status,'duplicate',true);
  end if;
  if not s.enabled or s.status<>'CONNECTED' or s.lease_until is null or s.lease_until<=now() then raise exception 'PERSONAL_WHATSAPP_DISCONNECTED'; end if;
  if s.paused_until>now() then raise exception 'PERSONAL_WHATSAPP_PAUSED'; end if;
  select count(*) filter(where created_at>now()-interval '10 minutes'),count(*),
    count(*) filter(where conversation_id=c.id),max(created_at) into ten,day_count,recipient_count,last_send
    from public.personal_whatsapp_messages where connection_id=s.connection_id and origin='CRM' and created_at>now()-interval '24 hours';
  if last_send>now()-interval '5 seconds' or ten>=10 or day_count>=50 or recipient_count>=20 then raise exception 'PERSONAL_WHATSAPP_RATE_LIMITED'; end if;
  if exists(select 1 from public.personal_whatsapp_messages where connection_id=s.connection_id and origin='CRM' and delivery_status in ('PENDING','SENDING','UNKNOWN')) then raise exception 'PERSONAL_WHATSAPP_SEND_UNRESOLVED'; end if;
  insert into public.personal_whatsapp_messages(organization_id,conversation_id,connection_id,application_message_id,direction,body,delivery_status,origin,sent_at)
    values(c.organization_id,c.id,s.connection_id,target_application_message_id,'OUTBOUND',btrim(target_body),'PENDING','CRM',now()) returning * into m;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id)
    values(c.organization_id,auth.uid(),'personal_whatsapp.reply_requested','personal_whatsapp_message',m.id::text);
  return jsonb_build_object('message_id',m.id,'connection_id',s.connection_id,'generation',s.generation,'status',m.delivery_status,'duplicate',false);
end;
$$;

create or replace function public.personal_whatsapp_send_claim(target_connection_id uuid,target_generation uuid,target_worker uuid,target_message_id uuid,target_provider_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype; m public.personal_whatsapp_messages%rowtype; c public.personal_whatsapp_conversations%rowtype; permitted boolean;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.personal_whatsapp_gateway(target_connection_id,target_generation,target_worker,'heartbeat');
  select * into s from public.personal_whatsapp_sessions where connection_id=target_connection_id;
  select * into m from public.personal_whatsapp_messages where id=target_message_id and connection_id=s.connection_id for update;
  if not found or m.delivery_status<>'PENDING' or m.created_at<now()-interval '1 minute' then raise exception 'PERSONAL_WHATSAPP_NOT_CLAIMABLE'; end if;
  select * into c from public.personal_whatsapp_conversations where id=m.conversation_id;
  permitted:=c.deleted_at is null and c.owner_user_id=s.owner_user_id
    and app_private.personal_whatsapp_contact_candidates(s.owner_user_id,s.organization_id,c.normalized_contact)=array[coalesce(c.customer_id,c.lead_id)]
    and app_private.personal_whatsapp_actor_branch(s.owner_user_id,s.organization_id,c.branch_id)
    and (app_private.personal_whatsapp_actor_record(s.owner_user_id,s.organization_id,c.lead_id,null)
      or app_private.personal_whatsapp_actor_record(s.owner_user_id,s.organization_id,null,c.customer_id));
  if not coalesce(permitted,false) or s.status<>'CONNECTED' or s.paused_until>now() then raise exception 'PERSONAL_WHATSAPP_SEND_DENIED'; end if;
  if length(coalesce(target_provider_id,'')) not between 1 and 200 then raise exception 'INVALID_PROVIDER_ID'; end if;
  update public.personal_whatsapp_messages set delivery_status='SENDING',provider_message_id=target_provider_id where id=m.id;
  return jsonb_build_object('phone',c.normalized_contact,'body',m.body,'provider_message_id',target_provider_id);
end;
$$;

create or replace function public.get_personal_whatsapp_status(target_conversation_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype; c public.personal_whatsapp_conversations%rowtype; daily integer; recent integer; recipient integer; next_at timestamptz; reason text; qr_data jsonb;
begin
  select ps.* into s from public.personal_whatsapp_sessions ps where ps.owner_user_id=auth.uid()
    and app_private.personal_whatsapp_owner(ps.organization_id,ps.owner_user_id) limit 1;
  if not found then return null; end if;
  if target_conversation_id is not null then
    select * into c from public.personal_whatsapp_conversations where id=target_conversation_id and connection_id=s.connection_id
      and app_private.personal_whatsapp_conversation_access(organization_id,id);
    if not found then raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'; end if;
  end if;
  select count(*),count(*) filter(where created_at>now()-interval '10 minutes'),count(*) filter(where conversation_id=c.id),
    greatest(max(created_at)+interval '5 seconds',
      case when count(*)>=50 then min(created_at)+interval '24 hours' end,
      case when count(*) filter(where created_at>now()-interval '10 minutes')>=10 then min(created_at) filter(where created_at>now()-interval '10 minutes')+interval '10 minutes' end,
      case when count(*) filter(where conversation_id=c.id)>=20 then min(created_at) filter(where conversation_id=c.id)+interval '24 hours' end)
    into daily,recent,recipient,next_at from public.personal_whatsapp_messages where connection_id=s.connection_id and origin='CRM' and created_at>now()-interval '24 hours';
  reason:=case when not s.enabled or s.status<>'CONNECTED' or s.lease_until is null or s.lease_until<=now() then 'PERSONAL_WHATSAPP_DISCONNECTED'
    when s.paused_until>now() then 'PERSONAL_WHATSAPP_PAUSED'
    when exists(select 1 from public.personal_whatsapp_messages where connection_id=s.connection_id and origin='CRM' and delivery_status in ('PENDING','SENDING','UNKNOWN')) then 'PERSONAL_WHATSAPP_SEND_UNRESOLVED'
    when next_at>now() then 'PERSONAL_WHATSAPP_RATE_LIMITED' end;
  select jsonb_build_object('qr',case when expires_at>now() then qr end,'expires_at',expires_at) into qr_data
    from public.personal_whatsapp_qr_attempts where connection_id=s.connection_id and generation=s.generation;
  return jsonb_build_object('connection_id',s.connection_id,'status',case when not s.enabled then s.status when s.lease_until<now() then 'RECONNECTING' else s.status end,
    'enabled',s.enabled,'masked_phone',s.masked_phone,'heartbeat_at',s.heartbeat_at,'daily_sent',daily,'daily_limit',50,
    'paused_until',s.paused_until,'next_send_at',next_at,'reply_window_expires_at',null,
    'send_disabled_reason',reason,'qr',qr_data->'qr','qr_expires_at',qr_data->'expires_at','attempt_expires_at',s.requested_at+interval '2 minutes');
end;
$$;

commit;
