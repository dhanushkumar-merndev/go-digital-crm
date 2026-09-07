begin;

alter table public.custom_field_definitions add column annual_reminder boolean not null default false;
update public.custom_field_definitions set annual_reminder=true
  where module='CUSTOMERS' and field_type='DATE' and field_key in ('date_of_birth','wedding_anniversary');
create function app_private.default_customer_date_reminder() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.module='CUSTOMERS' and new.field_type='DATE' and new.field_key in ('date_of_birth','wedding_anniversary') then
    new.annual_reminder := true;
  end if;
  return new;
end; $$;
revoke all on function app_private.default_customer_date_reminder() from public,anon,authenticated;
create trigger default_customer_date_reminder before insert on public.custom_field_definitions
  for each row execute function app_private.default_customer_date_reminder();
alter table public.notifications add column dedupe_key text;
create unique index notifications_dedupe_idx on public.notifications(organization_id,user_id,dedupe_key)
  where dedupe_key is not null;
create index customer_dates_anniversary_idx on public.custom_field_values
  ((substring(value #>> '{}' from 6 for 5)),organization_id,definition_id,resource_id)
  where resource_type='CUSTOMER' and jsonb_typeof(value)='string';
create index leads_uncontacted_alert_idx on public.leads(created_at,id)
  where deleted_at is null and first_contacted_at is null and lifecycle_status='New';

-- Add the new property without copying the administration query and its scope
-- checks. Fail migration on a changed source instead of silently omitting it.
do $$ declare definition text; changed text;
begin
  definition := pg_get_functiondef('public.get_custom_field_administration_page(text,text,integer,integer)'::regprocedure);
  changed := replace(definition, '''version'', row.version', '''version'', row.version, ''annual_reminder'', row.annual_reminder');
  if changed=definition then raise exception 'CUSTOM_FIELD_PAGE_PATCH_ANCHOR_MISSING'; end if;
  execute changed;
end; $$;

create function public.set_customer_date_reminder(target_definition_id uuid,target_enabled boolean,expected_version bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare org uuid := app_private.current_tenant_organization(); field public.custom_field_definitions%rowtype;
begin
  if auth.uid() is null or org is null or not app_private.has_organization_wide_scope(org)
    or not app_private.has_permission(org,'role.manage') then
    raise exception using errcode='42501',message='CUSTOM_FIELD_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_enabled is null or expected_version is null then raise exception using errcode='22023',message='INVALID_DATE_REMINDER'; end if;
  select * into field from public.custom_field_definitions where id=target_definition_id and organization_id=org for update;
  if not found then raise exception using errcode='P0002',message='CUSTOM_FIELD_NOT_FOUND'; end if;
  if field.module<>'CUSTOMERS' or field.field_type<>'DATE' then raise exception using errcode='22023',message='CUSTOMER_DATE_FIELD_REQUIRED'; end if;
  if field.version<>expected_version then raise exception using errcode='40001',message='CUSTOM_FIELD_VERSION_CONFLICT'; end if;
  update public.custom_field_definitions set annual_reminder=target_enabled,version=version+1 where id=field.id;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
    values(org,auth.uid(),'custom_field.date_reminder_changed','custom_field_definition',field.id::text,
      jsonb_build_object('old',field.annual_reminder,'new',target_enabled));
  return true;
end; $$;
revoke all on function public.set_customer_date_reminder(uuid,boolean,bigint) from public,anon;
grant execute on function public.set_customer_date_reminder(uuid,boolean,bigint) to authenticated;

-- A scheduled worker has no end-user JWT. Check the recipient's active role,
-- permission and branch/team ceiling before placing customer data in their bell.
create function app_private.alert_recipient_allowed(org uuid,branch uuid,team uuid,owner_id uuid,recipient uuid,permission_key text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from public.profiles p join public.organizations o on o.id=p.organization_id
    join public.user_role_assignments a on a.user_id=p.id and a.organization_id=p.organization_id and a.active
    join public.roles r on r.id=a.role_id and r.organization_id=a.organization_id
    join public.role_permissions rp on rp.role_id=r.id
    join public.permissions permission on permission.id=rp.permission_id
    join public.branches b on b.id=branch and b.organization_id=org and b.active and b.deleted_at is null
    where p.id=recipient and p.organization_id=org and p.active and p.deleted_at is null
      and o.status='ACTIVE' and o.deleted_at is null and permission.permission_key=$6
      and (
        a.data_scope in ('ORGANIZATION','ALL_BRANCHES')
        or (a.data_scope='ONE_BRANCH' and a.scope_branch_id=branch)
        or (a.data_scope='SELECTED_BRANCHES' and branch=any(a.selected_branch_ids))
        or (a.data_scope in ('OWN_RECORDS','OWN_TEAM') and (a.data_scope='OWN_TEAM' or recipient=owner_id)
          and exists(select 1 from public.team_members m join public.teams t on t.id=m.team_id and t.organization_id=org
            where m.organization_id=org and m.user_id=recipient and m.team_id=team and m.active and t.active and t.branch_id=branch))
      )
  );
$$;
revoke all on function app_private.alert_recipient_allowed(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;

create function app_private.valid_customer_date(value jsonb) returns date
language plpgsql immutable set search_path='' as $$
declare text_value text := value #>> '{}'; result date;
begin
  if jsonb_typeof(value)<>'string' or text_value !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  result := text_value::date;
  return result;
exception when datetime_field_overflow or invalid_datetime_format then return null;
end; $$;
revoke all on function app_private.valid_customer_date(jsonb) from public,anon,authenticated;

create function public.dispatch_crm_alerts(target_batch_size integer default 200,target_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path='' as $$
declare sla_count integer; date_count integer; local_day date := timezone('Asia/Kolkata',target_now)::date;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='SERVICE_ROLE_REQUIRED'; end if;
  if target_batch_size is null or target_batch_size not between 1 and 500 or target_now is null then
    raise exception using errcode='22023',message='INVALID_ALERT_BATCH';
  end if;
  with candidates as materialized (
    select l.organization_id,l.id,recipient.user_id,'lead-five-minute:'||l.id::text as key
    from public.leads l
    cross join lateral (
      select l.assigned_user_id as user_id
      union select m.user_id from public.team_members m where m.organization_id=l.organization_id
        and m.team_id=l.team_id and m.member_type='TEAM_MANAGER' and m.active
      union select t.manager_id from public.teams t where t.organization_id=l.organization_id and t.id=l.team_id and t.active
    ) recipient
    where l.deleted_at is null and l.first_contacted_at is null and l.lifecycle_status='New'
      and l.created_at<=target_now-interval '5 minutes'
      and app_private.alert_recipient_allowed(l.organization_id,l.branch_id,l.team_id,l.assigned_user_id,recipient.user_id,'lead.view')
      and not exists(select 1 from public.calls c where c.organization_id=l.organization_id and c.lead_id=l.id and c.deleted_at is null and c.started_at>=l.created_at and c.started_at<=target_now)
      and not exists(select 1 from public.notifications n where n.organization_id=l.organization_id and n.user_id=recipient.user_id and n.dedupe_key='lead-five-minute:'||l.id::text)
    order by l.created_at,l.id,recipient.user_id limit target_batch_size
  )
  insert into public.notifications(organization_id,user_id,event_type,title,body,resource_type,resource_id,dedupe_key)
    select organization_id,user_id,'LEAD_FIVE_MINUTE_SLA','Fresh lead needs a call',
      'This lead has had no call recorded within five minutes. Open the lead to follow up.','lead',id,key from candidates
    on conflict (organization_id,user_id,dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics sla_count=row_count;

  with due as materialized (
    select distinct v.organization_id,v.resource_id as customer_id,d.id as definition_id,d.label,l.assigned_user_id as user_id,
      'customer-date:'||v.resource_id::text||':'||d.id::text||':'||local_day::text as key
    from public.custom_field_values v
    join public.custom_field_definitions d on d.id=v.definition_id and d.organization_id=v.organization_id
      and d.module='CUSTOMERS' and d.field_type='DATE' and d.active and d.annual_reminder
    join public.customers c on c.id=v.resource_id and c.organization_id=v.organization_id and c.deleted_at is null
    join public.leads l on l.organization_id=v.organization_id and l.customer_id=c.id and l.deleted_at is null
    where v.resource_type='CUSTOMER' and jsonb_typeof(v.value)='string'
      and substring(v.value #>> '{}' from 6 for 5)=to_char(local_day,'MM-DD')
      and app_private.valid_customer_date(v.value)<=local_day
      and app_private.alert_recipient_allowed(l.organization_id,l.branch_id,l.team_id,l.assigned_user_id,l.assigned_user_id,'customer.view')
      and not exists(select 1 from public.notifications n where n.organization_id=v.organization_id and n.user_id=l.assigned_user_id
        and n.dedupe_key='customer-date:'||v.resource_id::text||':'||d.id::text||':'||local_day::text)
    order by v.organization_id,v.resource_id,d.id,d.label,l.assigned_user_id,key limit target_batch_size
  )
  insert into public.notifications(organization_id,user_id,event_type,title,body,resource_type,resource_id,dedupe_key)
    select organization_id,user_id,'CUSTOMER_DATE_REMINDER',label||' reminder',
      'A customer date falls today. Open the customer profile to review it.','customer',customer_id,key from due
    on conflict (organization_id,user_id,dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics date_count=row_count;
  return jsonb_build_object('lead_sla',sla_count,'customer_dates',date_count);
end; $$;
revoke all on function public.dispatch_crm_alerts(integer,timestamptz) from public,anon,authenticated;
grant execute on function public.dispatch_crm_alerts(integer,timestamptz) to service_role;
commit;
