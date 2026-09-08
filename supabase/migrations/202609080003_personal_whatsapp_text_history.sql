begin;
alter table public.personal_whatsapp_messages add column is_history boolean not null default false;
alter table public.personal_whatsapp_conversations add column history_requested_at timestamptz;
create or replace function public.personal_whatsapp_ingest(target_connection_id uuid,target_generation uuid,target_worker uuid,target_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.personal_whatsapp_sessions%rowtype; contact_phone text; candidates uuid[]; lid uuid; cust uuid; bid uuid;
  cid uuid; sent timestamptz; mid uuid; direction_value text; body_value text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.personal_whatsapp_gateway(target_connection_id,target_generation,target_worker,'heartbeat');
  select * into s from public.personal_whatsapp_sessions where connection_id=target_connection_id;
  contact_phone:=target_data->>'phone'; sent:=(target_data->>'sent_at')::timestamptz;
  if contact_phone is null or contact_phone!~'^[0-9]{7,15}$' or sent is null or sent < (case when target_data->>'is_history'='true' then now()-interval '30 days' else coalesce(s.linked_at,s.requested_at) end) or sent>now()+interval '1 minute'
    or length(coalesce(target_data->>'provider_message_id','')) not between 1 and 200 then return jsonb_build_object('ignored',true); end if;
  if coalesce(target_data->>'message_type','text') <> 'text' or nullif(btrim(target_data->>'body'),'') is null then return jsonb_build_object('ignored',true); end if;
  candidates:=app_private.personal_whatsapp_contact_candidates(s.owner_user_id,s.organization_id,contact_phone);
  if cardinality(candidates)=1 then
    select l.id,l.customer_id,l.branch_id into lid,cust,bid from public.leads l
      where l.organization_id=s.organization_id and l.deleted_at is null and coalesce(l.customer_id,l.id)=candidates[1]
        and app_private.personal_whatsapp_actor_record(s.owner_user_id,s.organization_id,l.id,null) order by (l.normalized_phone in(contact_phone,'+'||contact_phone)) desc,l.created_at desc,l.id limit 1;
    if bid is null then
      select c.id into cust from public.customers c where c.id=candidates[1] and c.organization_id=s.organization_id
        and app_private.personal_whatsapp_actor_record(s.owner_user_id,s.organization_id,null,c.id);
      if app_private.personal_whatsapp_actor_branch(s.owner_user_id,s.organization_id,s.branch_id) then bid:=s.branch_id; end if;
    end if;
  end if;
  if cardinality(candidates) is distinct from 1 or bid is null then
    update public.personal_whatsapp_sessions set discarded_message_count=discarded_message_count+1,
      safe_error_code=case when cardinality(candidates)>1 then 'PERSONAL_WHATSAPP_AMBIGUOUS_CONTACT' else 'PERSONAL_WHATSAPP_UNMATCHED_CONTACT' end
      where connection_id=s.connection_id;
    return jsonb_build_object('ignored',true);
  end if;
  if exists(select 1 from public.personal_whatsapp_conversations c where c.connection_id=s.connection_id and c.normalized_contact=contact_phone
    and coalesce(c.customer_id,c.lead_id) is distinct from candidates[1]) then
    update public.personal_whatsapp_sessions set discarded_message_count=discarded_message_count+1,safe_error_code='PERSONAL_WHATSAPP_CONTACT_CHANGED' where connection_id=s.connection_id;
    return jsonb_build_object('ignored',true);
  end if;
  direction_value:=case when target_data->>'from_me'='true' then 'OUTBOUND' else 'INBOUND' end;
  body_value:=left(target_data->>'body',65535);
  insert into public.personal_whatsapp_conversations(organization_id,connection_id,branch_id,owner_user_id,normalized_contact,lead_id,customer_id,last_message_at,last_inbound_at)
    values(s.organization_id,s.connection_id,bid,s.owner_user_id,contact_phone,lid,cust,sent,case when direction_value='INBOUND' then sent end)
    on conflict(connection_id,normalized_contact) do update set last_message_at=greatest(personal_whatsapp_conversations.last_message_at,excluded.last_message_at),
      last_inbound_at=greatest(personal_whatsapp_conversations.last_inbound_at,excluded.last_inbound_at)
    returning id into cid;
  insert into public.personal_whatsapp_messages(organization_id,conversation_id,connection_id,provider_message_id,direction,body,delivery_status,message_type,origin,sent_at,is_history)
    values(s.organization_id,cid,s.connection_id,target_data->>'provider_message_id',direction_value,body_value,
      case when direction_value='INBOUND' then 'RECEIVED' else 'SENT' end,left(coalesce(target_data->>'message_type','text'),64),
      case when direction_value='INBOUND' then 'CUSTOMER' else 'PHONE' end,sent,coalesce(target_data->>'is_history'='true',false))
    on conflict(connection_id,provider_message_id) do nothing returning id into mid;
  if direction_value='OUTBOUND' then
    perform public.personal_whatsapp_receipt(s.connection_id,target_data->>'provider_message_id','SENT');
  end if;
  return jsonb_build_object('conversation_id',cid,'message_id',mid);
end;
$$;
create or replace function app_private.snapshot_message_lead()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.lead_id is distinct from old.lead_id or new.conversation_id is distinct from old.conversation_id
      or new.organization_id is distinct from old.organization_id then raise exception 'MESSAGE_LEAD_IMMUTABLE'; end if;
    return new;
  end if;
  if tg_table_name='personal_whatsapp_messages' then
    if new.is_history then new.lead_id := null; return new; end if;
    select c.lead_id into new.lead_id from public.personal_whatsapp_conversations c
      where c.organization_id=new.organization_id and c.id=new.conversation_id for share;
  else
    select c.lead_id into new.lead_id from public.conversations c
      where c.organization_id=new.organization_id and c.id=new.conversation_id for share;
    if new.metadata ? 'expected_lead_id' then
      if new.lead_id is distinct from (new.metadata->>'expected_lead_id')::uuid then raise exception 'LEAD_CONTEXT_CHANGED'; end if;
      new.metadata:=new.metadata-'expected_lead_id';
    end if;
  end if;
  return new;
end;
$$;

create function public.personal_whatsapp_sync_authorize(target_conversation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.personal_whatsapp_conversations; s public.personal_whatsapp_sessions;
begin
  select * into c from public.personal_whatsapp_conversations where id=target_conversation_id and deleted_at is null for update;
  if auth.uid() is null or not found or c.owner_user_id<>auth.uid()
    or not app_private.personal_whatsapp_conversation_access(c.organization_id,c.id)
    or not app_private.has_permission(c.organization_id,'message.view') then raise exception 'PERSONAL_WHATSAPP_ACCESS_DENIED'; end if;
  select * into s from public.personal_whatsapp_sessions where connection_id=c.connection_id;
  if not s.enabled or s.status<>'CONNECTED' or s.heartbeat_at is null or s.heartbeat_at<now()-interval '45 seconds' then raise exception 'PERSONAL_WHATSAPP_DISCONNECTED'; end if;
  if c.history_requested_at>now()-interval '1 minute' then raise exception 'PERSONAL_WHATSAPP_SYNC_RATE_LIMITED'; end if;
  update public.personal_whatsapp_conversations set history_requested_at=now() where id=c.id;
  return jsonb_build_object('connection_id',s.connection_id,'generation',s.generation,'conversation_id',c.id);
end $$;
revoke all on function public.personal_whatsapp_sync_authorize(uuid) from public,anon;
grant execute on function public.personal_whatsapp_sync_authorize(uuid) to authenticated;

create function public.personal_whatsapp_sync_anchor(target_connection_id uuid,target_generation uuid,target_worker uuid,target_conversation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.personal_whatsapp_conversations; m public.personal_whatsapp_messages;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform public.personal_whatsapp_gateway(target_connection_id,target_generation,target_worker,'heartbeat');
  select * into c from public.personal_whatsapp_conversations where id=target_conversation_id and connection_id=target_connection_id and deleted_at is null;
  if not found or c.history_requested_at is null or c.history_requested_at<now()-interval '1 minute'
    or not app_private.personal_whatsapp_actor_record(c.owner_user_id,c.organization_id,c.lead_id,c.customer_id) then raise exception 'PERSONAL_WHATSAPP_ACCESS_DENIED'; end if;
  select * into m from public.personal_whatsapp_messages where conversation_id=c.id and connection_id=c.connection_id
    and deleted_at is null and provider_message_id is not null and sent_at>=now()-interval '30 days'
    order by sent_at,id limit 1;
  if not found then raise exception 'PERSONAL_WHATSAPP_SYNC_NO_ANCHOR'; end if;
  return jsonb_build_object('phone',c.normalized_contact,'provider_message_id',m.provider_message_id,
    'from_me',m.direction='OUTBOUND','timestamp_ms',floor(extract(epoch from m.sent_at)*1000));
end $$;
revoke all on function public.personal_whatsapp_sync_anchor(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.personal_whatsapp_sync_anchor(uuid,uuid,uuid,uuid) to service_role;
commit;
