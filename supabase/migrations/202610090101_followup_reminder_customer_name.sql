begin;

-- The 5-minute and due-now reminders for one follow-up both read "Open your
-- follow-up..." in the bell, so two rows for the same commitment could not be
-- told apart from rows for two customers. Both RPCs now carry the customer's
-- name: the reminder feed for the toast/dialog, and the notification body the
-- bell lists. The customer record wins over the enquiry's captured name.

create or replace function public.get_my_followup_reminders()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare org uuid := app_private.current_tenant_organization(); result jsonb;
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org,'followup.view') then
    raise exception using errcode='42501', message='PERMISSION_DENIED';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'due_at', f.due_at,
    'reason', f.reason, 'customer_name', f.customer_name) order by f.due_at,f.id),'[]'::jsonb) into result
  from (
    select w.id,w.due_at,w.reason,
      coalesce(c.full_name, l.customer_name) as customer_name
    from public.followups w
    left join public.customers c on c.id=w.customer_id and c.organization_id=org
    left join public.leads l on l.id=w.lead_id and l.organization_id=org
    where w.organization_id=org and w.assigned_user_id=auth.uid() and w.status='OPEN'
      and w.due_at between now()-interval '5 minutes' and now()+interval '1 hour'
      and (w.lead_id is null or (l.id is not null and l.deleted_at is null))
      and app_private.can_access_record(org,w.branch_id,w.team_id,w.assigned_user_id)
    order by w.due_at,w.id limit 100
  ) f;
  return jsonb_build_object('server_now',clock_timestamp(),'records',result);
end; $$;
revoke all on function public.get_my_followup_reminders() from public,anon;
grant execute on function public.get_my_followup_reminders() to authenticated;

create or replace function public.claim_followup_web_reminder(target_followup_id uuid, target_due_at timestamptz, target_phase text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare org uuid := app_private.current_tenant_organization(); item public.followups%rowtype;
  notification_id uuid; customer_label text;
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org,'followup.view') then
    raise exception using errcode='42501', message='PERMISSION_DENIED';
  end if;
  if target_phase is null or target_phase not in ('UPCOMING','DUE') then
    raise exception using errcode='22023',message='INVALID_REMINDER_PHASE';
  end if;
  select * into item from public.followups w where w.id=target_followup_id
    and w.organization_id=org and w.assigned_user_id=auth.uid() and w.status='OPEN'
    and w.due_at=target_due_at for share;
  if not found then return false; end if;
  if not app_private.can_access_record(org,item.branch_id,item.team_id,item.assigned_user_id)
    or (item.lead_id is not null and not exists(select 1 from public.leads l
      where l.id=item.lead_id and l.organization_id=org and l.deleted_at is null)) then return false; end if;
  if (target_phase='UPCOMING' and (now()<item.due_at-interval '5 minutes' or now()>=item.due_at))
    or (target_phase='DUE' and (now()<item.due_at or now()>item.due_at+interval '5 minutes')) then return false; end if;
  select nullif(btrim(coalesce(
      (select c.full_name from public.customers c where c.id=item.customer_id and c.organization_id=org),
      (select l.customer_name from public.leads l where l.id=item.lead_id and l.organization_id=org))),'')
    into customer_label;
  insert into public.notifications(organization_id,user_id,event_type,title,body,resource_type,resource_id,dedupe_key)
  values(org,auth.uid(),'FOLLOWUP_'||target_phase,
    case when target_phase='UPCOMING' then 'Follow-up in 5 minutes' else 'Follow-up due now' end,
    case when customer_label is null
      then 'Open your follow-up to review the details and contact the customer.'
      else customer_label||' · '||item.reason end,
    'followup',item.id,
    'followup:'||item.id::text||':'||extract(epoch from item.due_at)::text||':'||target_phase)
  on conflict (organization_id,user_id,dedupe_key) where dedupe_key is not null do nothing
  returning id into notification_id;
  return notification_id is not null;
end; $$;
revoke all on function public.claim_followup_web_reminder(uuid,timestamptz,text) from public,anon;
grant execute on function public.claim_followup_web_reminder(uuid,timestamptz,text) to authenticated;

commit;
