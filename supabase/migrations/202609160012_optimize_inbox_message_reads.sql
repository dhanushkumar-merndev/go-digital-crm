begin;

-- Thread access is established once before reading its messages. Reapplying the
-- complete conversation-access policy to every message made a 33-row pilot inbox
-- take several seconds because each predicate resolves role, branch and record
-- scope again. Direct message reads remain bound to an already-authorized thread.
create or replace function public.get_context_inbox_page(
  target_lead_id uuid default null,target_customer_id uuid default null,
  target_search text default '',target_channel text default 'all',target_page integer default 1,target_page_size integer default 25
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare org uuid; result jsonb;
begin
  org:=(public.get_access_context()->>'organization_id')::uuid;
  if auth.uid() is null or not app_private.has_permission(org,'message.view') then raise exception 'MESSAGE_VIEW_PERMISSION_REQUIRED'; end if;
  if target_lead_id is not null and not app_private.can_access_lead(target_lead_id) then raise exception 'LEAD_NOT_FOUND'; end if;
  if target_customer_id is not null and not app_private.can_access_customer(org,target_customer_id) then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if target_page not between 1 and 1000000 or target_page_size not in(25,50,100) then raise exception 'INVALID_INBOX_PAGINATION'; end if;
  with filtered as materialized (
    select c.*,coalesce(cu.full_name,l.customer_name,c.external_contact,'Unknown contact') customer_name,
      coalesce(cu.primary_phone,l.phone,c.external_contact) phone,l.interested_model,p.full_name assigned_user_name
    from app_private.accessible_inbox_threads c
    left join public.customers cu on cu.organization_id=c.organization_id and cu.id=c.customer_id
    left join public.leads l on l.organization_id=c.organization_id and l.id=c.lead_id
    left join public.profiles p on p.organization_id=c.organization_id and p.id=c.assigned_user_id
    where c.organization_id=org and (upper(target_channel)='ALL' or c.channel=upper(target_channel))
      and (target_customer_id is null or c.customer_id=target_customer_id)
      and (target_lead_id is null or c.lead_id=target_lead_id
        or c.customer_id=(select target.customer_id from public.leads target where target.organization_id=org and target.id=target_lead_id)
        or (c.channel='WHATSAPP_PERSONAL' and exists(select 1 from public.personal_whatsapp_messages m
          where m.organization_id=org and m.conversation_id=c.id and m.lead_id=target_lead_id and m.deleted_at is null))
        or (c.channel<>'WHATSAPP_PERSONAL' and exists(select 1 from public.conversation_messages m
          where m.organization_id=org and m.conversation_id=c.id and m.lead_id=target_lead_id)))
      and (btrim(coalesce(target_search,''))='' or position(lower(left(btrim(target_search),160)) in
        lower(concat_ws(' ',cu.full_name,l.customer_name,cu.primary_phone,l.phone,c.external_contact)))>0)
  ), page as (select * from filtered order by coalesce(last_message_at,created_at) desc,id desc
    limit target_page_size offset (target_page-1)::bigint*target_page_size)
  select jsonb_build_object('total',(select count(*) from filtered),'records',coalesce((
    select jsonb_agg(jsonb_build_object('id',p.id,'lead_id',p.lead_id,'customer_id',p.customer_id,
      'channel',p.channel,'status',p.status,'customer_name',p.customer_name,'phone',p.phone,
      'interested_model',p.interested_model,'assigned_user_name',p.assigned_user_name,
      'last_message_at',latest.sent_at,'last_message_body',latest.body,'last_message_direction',latest.direction)
      order by coalesce(p.last_message_at,p.created_at) desc,p.id desc)
    from page p left join lateral (
      select message.sent_at,message.body,message.direction from (
        select m.sent_at,m.body,m.direction::text,m.id from public.conversation_messages m
          where p.channel<>'WHATSAPP_PERSONAL' and m.organization_id=org and m.conversation_id=p.id
            and (target_lead_id is null or m.lead_id=target_lead_id)
        union all
        select m.sent_at,m.body,m.direction,m.id from public.personal_whatsapp_messages m
          where p.channel='WHATSAPP_PERSONAL' and m.organization_id=org and m.conversation_id=p.id
            and m.deleted_at is null and (target_lead_id is null or m.lead_id=target_lead_id)
      ) message order by message.sent_at desc,message.id desc limit 1
    ) latest on true),'[]'::jsonb)) into result;
  return result;
end;
$$;

create or replace function public.get_context_inbox_messages(target_conversation_id uuid,target_lead_id uuid default null,
  target_before_at timestamptz default null,target_before_id uuid default null,target_page_size integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare thread record; result jsonb;
begin
  select * into thread from app_private.accessible_inbox_threads where id=target_conversation_id;
  if not found or not app_private.has_permission(thread.organization_id,'message.view') then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if target_lead_id is not null and not app_private.can_access_lead(target_lead_id) then raise exception 'LEAD_NOT_FOUND'; end if;
  if target_page_size not in(25,50,100) or (target_before_at is null)<>(target_before_id is null) then raise exception 'INVALID_INBOX_MESSAGE_PAGE'; end if;
  with rows as materialized (
    select message.* from (
      select m.id,m.direction::text,m.body,m.delivery_status::text,m.sent_at,
        coalesce(m.metadata,'{}'::jsonb)||jsonb_build_object('lead_id',m.lead_id) metadata
      from public.conversation_messages m
      where thread.channel<>'WHATSAPP_PERSONAL' and m.organization_id=thread.organization_id and m.conversation_id=thread.id
        and (target_lead_id is null or m.lead_id=target_lead_id)
      union all
      select m.id,m.direction,m.body,m.delivery_status,m.sent_at,
        jsonb_build_object('lead_id',m.lead_id,'message_type',m.message_type,'origin',m.origin) metadata
      from public.personal_whatsapp_messages m
      where thread.channel='WHATSAPP_PERSONAL' and m.organization_id=thread.organization_id and m.conversation_id=thread.id
        and m.deleted_at is null and (target_lead_id is null or m.lead_id=target_lead_id)
    ) message
    where target_before_at is null or (message.sent_at,message.id)<(target_before_at,target_before_id)
    order by message.sent_at desc,message.id desc limit target_page_size+1
  ), visible as (select * from rows order by sent_at desc,id desc limit target_page_size)
  select jsonb_build_object('records',coalesce((select jsonb_agg(to_jsonb(v) order by sent_at,id) from visible v),'[]'::jsonb),
    'has_more',(select count(*)>target_page_size from rows),
    'next_before_at',(select sent_at from visible order by sent_at,id limit 1),
    'next_before_id',(select id from visible order by sent_at,id limit 1)) into result;
  return result;
end;
$$;

revoke all on function public.get_context_inbox_page(uuid,uuid,text,text,integer,integer) from public,anon;
revoke all on function public.get_context_inbox_messages(uuid,uuid,timestamptz,uuid,integer) from public,anon;
grant execute on function public.get_context_inbox_page(uuid,uuid,text,text,integer,integer) to authenticated;
grant execute on function public.get_context_inbox_messages(uuid,uuid,timestamptz,uuid,integer) to authenticated;
commit;
