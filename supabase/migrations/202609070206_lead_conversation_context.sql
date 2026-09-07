begin;

-- A conversation has a current working lead; each message keeps the lead that
-- was selected when it arrived/was composed. Existing history keeps its link.
alter table public.personal_whatsapp_messages add column lead_id uuid;
alter table public.conversation_messages add column lead_id uuid;
alter table public.personal_whatsapp_messages add constraint personal_message_lead_fk
  foreign key (organization_id, lead_id) references public.leads(organization_id,id);
alter table public.conversation_messages add constraint conversation_message_lead_fk
  foreign key (organization_id, lead_id) references public.leads(organization_id,id);
update public.personal_whatsapp_messages m set lead_id=c.lead_id
  from public.personal_whatsapp_conversations c where c.id=m.conversation_id and c.organization_id=m.organization_id;
update public.conversation_messages m set lead_id=c.lead_id
  from public.conversations c where c.id=m.conversation_id and c.organization_id=m.organization_id;
create index personal_messages_lead_page_idx on public.personal_whatsapp_messages(organization_id,lead_id,sent_at desc,id desc) where deleted_at is null;
create index conversation_messages_lead_page_idx on public.conversation_messages(organization_id,lead_id,sent_at desc,id desc);

create function app_private.snapshot_message_lead()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.lead_id is distinct from old.lead_id or new.conversation_id is distinct from old.conversation_id
      or new.organization_id is distinct from old.organization_id then raise exception 'MESSAGE_LEAD_IMMUTABLE'; end if;
    return new;
  end if;
  if tg_table_name='personal_whatsapp_messages' then
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
create trigger personal_message_lead_snapshot before insert or update of lead_id,conversation_id,organization_id on public.personal_whatsapp_messages
  for each row execute function app_private.snapshot_message_lead();
create trigger conversation_message_lead_snapshot before insert or update of lead_id,conversation_id,organization_id on public.conversation_messages
  for each row execute function app_private.snapshot_message_lead();

-- These views are private read models, never granted to browser roles.
create view app_private.accessible_inbox_threads as
select c.id,c.organization_id,c.branch_id,c.lead_id,c.customer_id,c.channel::text,c.status::text,
  c.assigned_user_id,c.external_contact,c.last_message_at,c.created_at
from public.conversations c where app_private.can_access_conversation(c.organization_id,c.id)
union all
select c.id,c.organization_id,c.branch_id,c.lead_id,c.customer_id,'WHATSAPP_PERSONAL','OPEN',
  c.owner_user_id,c.normalized_contact,c.last_message_at,c.created_at
from public.personal_whatsapp_conversations c where app_private.personal_whatsapp_conversation_access(c.organization_id,c.id);
create view app_private.accessible_inbox_messages as
select m.id,m.organization_id,m.conversation_id,m.lead_id,m.direction::text,m.body,m.delivery_status::text,m.sent_at,
  coalesce(m.metadata,'{}'::jsonb) || jsonb_build_object('lead_id',m.lead_id) as metadata
from public.conversation_messages m where app_private.can_access_conversation(m.organization_id,m.conversation_id)
union all
select m.id,m.organization_id,m.conversation_id,m.lead_id,m.direction,m.body,m.delivery_status,m.sent_at,
  jsonb_build_object('lead_id',m.lead_id,'message_type',m.message_type,'origin',m.origin)
from public.personal_whatsapp_messages m where m.deleted_at is null
  and app_private.personal_whatsapp_conversation_access(m.organization_id,m.conversation_id);

create function public.get_context_inbox_page(
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
        or c.customer_id=(select l.customer_id from public.leads l where l.organization_id=org and l.id=target_lead_id)
        or exists(
        select 1 from app_private.accessible_inbox_messages m where m.organization_id=org and m.conversation_id=c.id and m.lead_id=target_lead_id))
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
    from page p left join lateral (select m.sent_at,m.body,m.direction from app_private.accessible_inbox_messages m
      where m.organization_id=org and m.conversation_id=p.id and (target_lead_id is null or m.lead_id=target_lead_id)
      order by m.sent_at desc,m.id desc limit 1) latest on true),'[]'::jsonb)) into result;
  return result;
end;
$$;

create function public.get_context_inbox_messages(target_conversation_id uuid,target_lead_id uuid default null,
  target_before_at timestamptz default null,target_before_id uuid default null,target_page_size integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare org uuid; result jsonb;
begin
  select organization_id into org from app_private.accessible_inbox_threads where id=target_conversation_id;
  if org is null or not app_private.has_permission(org,'message.view') then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if target_lead_id is not null and not app_private.can_access_lead(target_lead_id) then raise exception 'LEAD_NOT_FOUND'; end if;
  if target_page_size not in(25,50,100) or (target_before_at is null)<>(target_before_id is null) then raise exception 'INVALID_INBOX_MESSAGE_PAGE'; end if;
  with rows as materialized (
    select m.id,m.direction,m.body,m.delivery_status,m.sent_at,m.metadata from app_private.accessible_inbox_messages m
    where m.organization_id=org and m.conversation_id=target_conversation_id and (target_lead_id is null or m.lead_id=target_lead_id)
      and (target_before_at is null or (m.sent_at,m.id)<(target_before_at,target_before_id))
    order by m.sent_at desc,m.id desc limit target_page_size+1
  ), visible as (select * from rows order by sent_at desc,id desc limit target_page_size)
  select jsonb_build_object('records',coalesce((select jsonb_agg(to_jsonb(v) order by sent_at,id) from visible v),'[]'::jsonb),
    'has_more',(select count(*)>target_page_size from rows),
    'next_before_at',(select sent_at from visible order by sent_at,id limit 1),
    'next_before_id',(select id from visible order by sent_at,id limit 1)) into result;
  return result;
end;
$$;

create function public.get_inbox_lead_options(target_conversation_id uuid,target_search text default '')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c record; result jsonb;
begin
  select * into c from app_private.accessible_inbox_threads where id=target_conversation_id;
  if not found or not app_private.has_permission(c.organization_id,'message.view') then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) into result from (
    select l.id,l.customer_id,l.branch_id,l.team_id,l.assigned_user_id,l.customer_name,l.phone,l.interested_model,
      l.lifecycle_status::text,l.created_at
    from public.leads l where l.organization_id=c.organization_id and l.deleted_at is null
      and ((c.customer_id is not null and l.customer_id=c.customer_id) or l.id=c.lead_id)
      and app_private.can_access_lead(l.id) and app_private.can_access_branch(l.organization_id,l.branch_id)
      and (c.channel='WHATSAPP_PERSONAL' or l.branch_id=c.branch_id)
      and (c.channel<>'WHATSAPP_PERSONAL' or app_private.personal_whatsapp_actor_record(auth.uid(),c.organization_id,l.id,null))
      and (coalesce(target_search,'')='' or position(lower(left(target_search,160)) in lower(concat_ws(' ',l.id::text,l.interested_model,l.source::text,l.customer_name)))>0)
    order by (l.id=c.lead_id) desc,l.created_at desc,l.id desc limit 25
  ) l;
  return result;
end;
$$;

create function public.set_inbox_working_lead(target_conversation_id uuid,target_lead_id uuid,expected_lead_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c record; l public.leads%rowtype; previous uuid;
begin
  select * into c from app_private.accessible_inbox_threads where id=target_conversation_id;
  if not found or not app_private.has_permission(c.organization_id,'message.send') then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  select * into l from public.leads where organization_id=c.organization_id and id=target_lead_id and deleted_at is null;
  if not found or not app_private.can_access_lead(l.id) or not app_private.can_access_branch(l.organization_id,l.branch_id)
    or not app_private.can_access_record(l.organization_id,l.branch_id,l.team_id,l.assigned_user_id)
    or ((c.customer_id is not null and l.customer_id=c.customer_id) or l.id=c.lead_id) is not true then raise exception 'LEAD_CONTEXT_DENIED'; end if;
  if c.channel='WHATSAPP_PERSONAL' then
    if not app_private.personal_whatsapp_actor_record(auth.uid(),c.organization_id,l.id,null) then raise exception 'LEAD_CONTEXT_DENIED'; end if;
    select lead_id into previous from public.personal_whatsapp_conversations where id=c.id for update;
    if previous is distinct from expected_lead_id then raise exception 'LEAD_CONTEXT_CHANGED'; end if;
    update public.personal_whatsapp_conversations set lead_id=l.id where id=c.id;
  else
    -- Official provider connections remain bound to their mapped branch.
    if l.branch_id<>c.branch_id then raise exception 'LEAD_CONTEXT_DENIED'; end if;
    select lead_id into previous from public.conversations where id=c.id for update;
    if previous is distinct from expected_lead_id then raise exception 'LEAD_CONTEXT_CHANGED'; end if;
    update public.conversations set lead_id=l.id where id=c.id;
  end if;
  if previous is distinct from l.id then
    insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
    values(c.organization_id,auth.uid(),'conversation.working_lead_changed','conversation',c.id::text,
      jsonb_build_object('previous_lead_id',previous,'lead_id',l.id));
  end if;
end;
$$;
create trigger personal_thread_context_invalidation after update of lead_id on public.personal_whatsapp_conversations
  for each row execute function app_private.broadcast_tenant_invalidation('communications');

create function public.personal_whatsapp_send_for_lead(target_conversation_id uuid,target_application_message_id uuid,target_body text,expected_lead_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_lead uuid;
begin
  if not exists(select 1 from app_private.accessible_inbox_threads where id=target_conversation_id) then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  select lead_id into current_lead from public.personal_whatsapp_conversations where id=target_conversation_id for update;
  if current_lead is distinct from expected_lead_id then raise exception 'LEAD_CONTEXT_CHANGED'; end if;
  return public.personal_whatsapp_send_prepare(target_conversation_id,target_application_message_id,target_body);
end;
$$;

create function public.get_lead_activity_page(target_lead_id uuid,target_kind text,target_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare org uuid; result jsonb; permission text;
begin
  if not app_private.can_access_lead(target_lead_id) then raise exception 'LEAD_NOT_FOUND'; end if;
  select organization_id into org from public.leads where id=target_lead_id and deleted_at is null;
  permission:=case target_kind when 'calls' then 'call.view' when 'followups' then 'followup.view' when 'appointments' then 'appointment.view' end;
  if permission is null or not app_private.has_permission(org,permission) then raise exception 'ACTIVITY_ACCESS_DENIED'; end if;
  if target_page not between 1 and 1000000 then raise exception 'INVALID_PAGE'; end if;
  with rows as materialized (
    select id,direction::text||' call' label,status::text,started_at occurred_at,coalesce(outcome,'') detail from public.calls
    where target_kind='calls' and organization_id=org and lead_id=target_lead_id and app_private.can_access_call(org,id)
    union all
    select id,reason,status::text,due_at,priority::text from public.followups
    where target_kind='followups' and organization_id=org and lead_id=target_lead_id
      and app_private.can_access_record(organization_id,branch_id,team_id,assigned_user_id)
    union all
    select id,appointment_type,status::text,scheduled_at,coalesce(notes,'') from public.appointments
    where target_kind='appointments' and organization_id=org and lead_id=target_lead_id
      and app_private.can_access_record(organization_id,branch_id,team_id,assigned_user_id)
  ), page as (select * from rows order by occurred_at desc,id desc limit 25 offset (target_page-1)::bigint*25)
  select jsonb_build_object('total',(select count(*) from rows),'records',coalesce((select jsonb_agg(to_jsonb(p) order by occurred_at desc,id desc) from page p),'[]'::jsonb)) into result;
  return result;
end;
$$;

create or replace function public.get_lead_telecmi_call_options(target_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  lead_row record;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.create')
    or not app_private.can_access_lead(target_lead_id)
  then
    raise exception using errcode = '42501', message = 'TELECMI_CALL_PERMISSION_REQUIRED';
  end if;

  select lead_source.id, lead_source.branch_id, branch_row.name as branch_name
  into lead_row
  from public.leads lead_source
  join public.branches branch_row
    on branch_row.organization_id = lead_source.organization_id
   and branch_row.id = lead_source.branch_id
  where lead_source.organization_id = current_organization_id
    and lead_source.id = target_lead_id
    and lead_source.deleted_at is null
    and app_private.can_access_record(
      lead_source.organization_id,
      lead_source.branch_id,
      lead_source.team_id,
      lead_source.assigned_user_id
    )
  order by lead_source.updated_at desc, lead_source.id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'lead_id', null,
      'branch_name', null,
      'connections', '[]'::jsonb
    );
  end if;

  select jsonb_build_object(
    'lead_id', lead_row.id,
    'branch_name', lead_row.branch_name,
    'connections', coalesce(jsonb_agg(jsonb_build_object(
      'id', connection_row.id,
      'display_name', connection_row.display_name,
      'caller_id_label', nullif(connection_row.connection_config->>'caller_id_label', ''),
      'scope_mode', connection_row.scope_mode
    ) order by connection_row.display_name, connection_row.id), '[]'::jsonb)
  )
  into result
  from public.connected_accounts connection_row
  where connection_row.organization_id = current_organization_id
    and connection_row.provider_key = 'telecmi'
    and connection_row.status = 'CONNECTED'
    and connection_row.deleted_at is null
    and connection_row.connection_config @> '{"capabilities":["IVR_CALLING"]}'::jsonb
    and (
      connection_row.scope_mode = 'ALL_BRANCHES'
      or exists (
        select 1
        from public.integration_branch_mappings mapping_row
        where mapping_row.organization_id = current_organization_id
          and mapping_row.connected_account_id = connection_row.id
          and mapping_row.external_resource_type = 'CONNECTION_SCOPE'
          and mapping_row.branch_id = lead_row.branch_id
          and mapping_row.deleted_at is null
      )
    )
    and exists (
      select 1
      from public.profiles actor_profile,
        jsonb_array_elements(
          case when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
            then connection_row.connection_config -> 'parallel_agents' else '[]'::jsonb end
        ) agent_data
      where actor_profile.id = auth.uid()
        and actor_profile.organization_id = current_organization_id
        and actor_profile.active
        and actor_profile.deleted_at is null
        and actor_profile.normalized_phone is not null
        and app_private.normalize_phone_digits(agent_data ->> 'phone')
          = app_private.normalize_phone_digits(actor_profile.normalized_phone)
        and nullif(btrim(agent_data ->> 'user_id'), '') is not null
    );

  return result;
end;
$$;

revoke all on function public.get_lead_telecmi_call_options(uuid) from public, anon;
grant execute on function public.get_lead_telecmi_call_options(uuid) to authenticated;

revoke all on app_private.accessible_inbox_threads,app_private.accessible_inbox_messages from public,anon,authenticated;
revoke all on function app_private.snapshot_message_lead() from public,anon,authenticated;
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('get_context_inbox_page','get_context_inbox_messages','get_inbox_lead_options','set_inbox_working_lead','personal_whatsapp_send_for_lead','get_lead_activity_page') loop
    execute format('revoke all on function %s from public,anon',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;
commit;
