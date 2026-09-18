-- Saved replies are tenant-owned text, never provider-approved templates.
begin;
alter table public.templates add constraint personal_reply_template_content check (
  channel <> 'WHATSAPP_PERSONAL' or coalesce((
    status in ('ACTIVE', 'ARCHIVED') and provider_template_id is null
    and jsonb_typeof(content->'body') = 'string'
    and char_length(content->>'body') between 1 and 1500
  ), false)
);

-- Extend the existing paginated admin workspace without duplicating its query.
do $$ declare definition text; begin
  select pg_get_functiondef('public.get_template_workspace(integer,integer,text,text,text)'::regprocedure) into definition;
  definition := replace(definition, '''WHATSAPP_BUSINESS'')', '''WHATSAPP_BUSINESS'', ''WHATSAPP_PERSONAL'')');
  definition := replace(definition, '''ARCHIVED'')', '''ARCHIVED'', ''ACTIVE'')');
  execute definition;
end $$;

create function public.save_personal_whatsapp_template(
  target_name text, target_body text, target_template_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare org uuid := app_private.current_tenant_organization(); tid uuid; result jsonb;
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org, 'integration.manage') then
    raise exception 'TEMPLATE_MANAGE_PERMISSION_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_name,''))) not between 2 and 120
    or char_length(btrim(coalesce(target_body,''))) not between 1 and 1500 then
    raise exception 'INVALID_TEMPLATE_INPUT';
  end if;
  if target_template_id is null then
    insert into public.templates(organization_id,channel,name,content,status,created_by)
    values(org,'WHATSAPP_PERSONAL',btrim(target_name),jsonb_build_object('body',btrim(target_body),'format','TEXT'),'ACTIVE',auth.uid())
    returning id into tid;
  else
    update public.templates set name=btrim(target_name),content=jsonb_build_object('body',btrim(target_body),'format','TEXT'),updated_at=now()
    where id=target_template_id and organization_id=org and channel='WHATSAPP_PERSONAL' and status='ACTIVE' and deleted_at is null
    returning id into tid;
    if tid is null then raise exception 'TEMPLATE_NOT_FOUND'; end if;
  end if;
  result := jsonb_build_object('id',tid,'status','ACTIVE');
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
  values(org,auth.uid(),case when target_template_id is null then 'template.reply_created' else 'template.reply_updated' end,'template',tid::text,jsonb_build_object('channel','WHATSAPP_PERSONAL'));
  return result;
end $$;

create function public.get_personal_whatsapp_templates(target_conversation_id uuid, target_search text default null, target_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid; result jsonb;
begin
  select organization_id into org from public.personal_whatsapp_conversations c
  where c.id=target_conversation_id and c.deleted_at is null
    and app_private.personal_whatsapp_conversation_access(c.organization_id,c.id);
  if auth.uid() is null or org is null or not app_private.has_permission(org,'message.send') then
    raise exception 'PERSONAL_WHATSAPP_ACCESS_DENIED';
  end if;
  if target_page is null or target_page not between 1 and 100000 then raise exception 'INVALID_TEMPLATE_PAGE'; end if;
  select jsonb_build_object('records',coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'body',content->>'body') order by name,id),'[]'::jsonb)) into result
  from (select id,name,content from public.templates
    where organization_id=org and channel='WHATSAPP_PERSONAL' and status='ACTIVE' and deleted_at is null
      and (nullif(btrim(target_search),'') is null or name ilike '%'||left(btrim(target_search),100)||'%')
    order by name,id limit 25 offset (target_page-1)*25) t;
  return result;
end $$;
create index templates_personal_reply_idx on public.templates(organization_id,name,id)
where channel='WHATSAPP_PERSONAL' and status='ACTIVE' and deleted_at is null;
revoke all on function public.save_personal_whatsapp_template(text,text,uuid) from public,anon;
revoke all on function public.get_personal_whatsapp_templates(uuid,text,integer) from public,anon;
grant execute on function public.save_personal_whatsapp_template(text,text,uuid) to authenticated;
grant execute on function public.get_personal_whatsapp_templates(uuid,text,integer) to authenticated;
commit;
