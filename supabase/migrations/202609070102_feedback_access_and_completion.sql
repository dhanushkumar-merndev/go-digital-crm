begin;

-- Feedback UUIDs are record identifiers, not public authorization tokens.
-- This compatibility RPC records a response on behalf of an authenticated user.
create or replace function public.submit_customer_feedback(
  target_feedback_id uuid, target_rating smallint, target_comments text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  org uuid := app_private.current_tenant_organization();
  feedback public.feedback_requests%rowtype;
  complaint_id uuid;
  review_url text;
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org,'customer.view')
    or not (app_private.has_permission(org,'customer_care.manage') or app_private.has_permission(org,'delivery.manage')) then
    raise exception using errcode='42501',message='FEEDBACK_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_rating is null or target_rating not between 1 and 5 or length(coalesce(target_comments,''))>4000 then
    raise exception using errcode='22023',message='INVALID_RATING_VALUE';
  end if;
  select * into feedback from public.feedback_requests where id=target_feedback_id and organization_id=org for update;
  if not found then raise exception using errcode='P0002',message='FEEDBACK_REQUEST_NOT_FOUND'; end if;
  if not app_private.can_access_branch(org,feedback.branch_id)
    or not app_private.can_access_customer(org,feedback.customer_id) then
    raise exception using errcode='42501',message='FEEDBACK_SCOPE_DENIED';
  end if;
  if feedback.delivery_case_id is not null and not exists (
    select 1 from public.delivery_cases d where d.id=feedback.delivery_case_id and d.organization_id=org
      and d.deleted_at is null and app_private.can_access_record(org,d.branch_id,null,d.assigned_user_id)
  ) then raise exception using errcode='42501',message='FEEDBACK_SCOPE_DENIED'; end if;
  if feedback.customer_case_id is not null and not exists (
    select 1 from public.customer_care_cases c where c.id=feedback.customer_case_id and c.organization_id=org
      and c.deleted_at is null and app_private.can_access_record(org,c.branch_id,null,c.assigned_user_id)
  ) then raise exception using errcode='42501',message='FEEDBACK_SCOPE_DENIED'; end if;
  if feedback.status='COMPLETED' then
    if feedback.rating is distinct from target_rating or feedback.comments is distinct from nullif(trim(target_comments),'') then
      raise exception using errcode='23514',message='FEEDBACK_ALREADY_COMPLETED';
    end if;
  else
    if feedback.status not in ('PENDING','SENT','DELIVERED') then
      raise exception using errcode='23514',message='FEEDBACK_NOT_PENDING';
    end if;
    update public.feedback_requests set rating=target_rating,comments=nullif(trim(target_comments),''),
      status='COMPLETED',completed_at=now(),updated_at=now(),version=version+1 where id=feedback.id;
  end if;
  select google_review_url into review_url from public.organizations where id=org;
  select id into complaint_id from public.complaints where organization_id=org and source_feedback_id=feedback.id;
  return jsonb_build_object('feedback_id',feedback.id,'rating',target_rating,'status','COMPLETED',
    'outcome',case when target_rating>=4 then 'POSITIVE_REVIEW' else 'DETRACTOR_ESCALATED' end,
    'redirect_review_url',case when target_rating>=4 then review_url end,'complaint_id',complaint_id);
end; $$;

-- Make the real Delivery/Customer Care capture flows run the same routing too.
-- The previous implementation only routed an otherwise unused standalone RPC.
alter table public.complaints add column source_feedback_id uuid;
create unique index complaints_feedback_unique_idx on public.complaints(organization_id,source_feedback_id)
  where source_feedback_id is not null;

create function app_private.route_completed_customer_feedback() returns trigger
language plpgsql security definer set search_path = '' as $$
declare case_id uuid := gen_random_uuid(); complaint_id uuid; review_url text; description text;
begin
  if new.status <> 'COMPLETED' or new.rating is null or (old.status='COMPLETED' and old.rating is not null) then return new; end if;
  if new.rating>=4 then
    select google_review_url into review_url from public.organizations where id=new.organization_id;
    insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
      values(new.organization_id,auth.uid(),'feedback.promoter_recorded','customer',new.customer_id::text,
        jsonb_build_object('rating',new.rating,'feedback_id',new.id,'google_review_url',review_url));
  else
    -- Serialize by the feedback row (the caller holds its write lock). A source
    -- identity makes a retried submission incapable of creating two complaints.
    if exists(select 1 from public.complaints where organization_id=new.organization_id and source_feedback_id=new.id) then return new; end if;
    description := 'Customer feedback ' || new.rating || '/5. ' || coalesce(new.comments,'Follow up with the customer.');
    insert into public.customer_care_cases(id,organization_id,branch_id,customer_id,booking_id,
      case_number,case_type,priority,status,subject,description,sla_due_at,created_by)
      values(case_id,new.organization_id,new.branch_id,new.customer_id,new.booking_id,
        'CC-FB-'||replace(new.id::text,'-',''),'COMPLAINT','HIGH','NEW',
        'Customer feedback requires follow-up',left(description,4000),now()+interval '8 hours',auth.uid());
    insert into public.complaints(organization_id,branch_id,customer_id,booking_id,category,description,
      priority,status,customer_case_id,source_feedback_id)
      values(new.organization_id,new.branch_id,new.customer_id,new.booking_id,'DELIVERY_FEEDBACK',
        left(description,4000),'HIGH','OPEN',case_id,new.id) returning id into complaint_id;
    insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
      values(new.organization_id,auth.uid(),'feedback.detractor_escalated','complaint',complaint_id::text,
        jsonb_build_object('rating',new.rating,'feedback_id',new.id,'complaint_id',complaint_id,'case_id',case_id));
    insert into public.activities(organization_id,customer_id,activity_type,actor_id,metadata)
      values(new.organization_id,new.customer_id,'FEEDBACK_COMPLAINT_CREATED',auth.uid(),
        jsonb_build_object('feedback_id',new.id,'complaint_id',complaint_id,'case_id',case_id));
  end if;
  return new;
end; $$;
revoke all on function app_private.route_completed_customer_feedback() from public,anon,authenticated;
create trigger route_completed_customer_feedback after update of status,rating on public.feedback_requests
  for each row execute function app_private.route_completed_customer_feedback();

create or replace function public.trigger_delivery_feedback_request(target_delivery_id uuid,target_channel text default 'WHATSAPP')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare org uuid := app_private.current_tenant_organization(); delivery public.delivery_cases%rowtype; feedback public.feedback_requests%rowtype;
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org,'delivery.manage')
    or not app_private.has_permission(org,'customer.view') then
    raise exception using errcode='42501',message='FEEDBACK_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_channel is null or upper(trim(target_channel)) not in ('WHATSAPP','SMS','EMAIL','MANUAL') then
    raise exception using errcode='22023',message='INVALID_FEEDBACK_CHANNEL';
  end if;
  select * into delivery from public.delivery_cases where id=target_delivery_id and organization_id=org and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='DELIVERY_CASE_NOT_FOUND'; end if;
  if delivery.status<>'DELIVERED' or not app_private.can_access_record(org,delivery.branch_id,null,delivery.assigned_user_id)
    or not app_private.can_access_customer(org,delivery.customer_id) then
    raise exception using errcode='42501',message='FEEDBACK_SCOPE_DENIED';
  end if;
  select * into feedback from public.feedback_requests where delivery_case_id=delivery.id and organization_id=org;
  if not found then
    insert into public.feedback_requests(organization_id,branch_id,customer_id,booking_id,delivery_case_id,channel,status)
      values(org,delivery.branch_id,delivery.customer_id,delivery.booking_id,delivery.id,upper(trim(target_channel)),'PENDING') returning * into feedback;
    insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,metadata)
      values(org,auth.uid(),'feedback.request_created','feedback_request',feedback.id::text,jsonb_build_object('delivery_case_id',delivery.id,'channel',target_channel));
  end if;
  return jsonb_build_object('feedback_id',feedback.id,'booking_id',feedback.booking_id,'customer_id',feedback.customer_id,'channel',feedback.channel,'status',feedback.status);
end; $$;

revoke all on function public.submit_customer_feedback(uuid,smallint,text) from public,anon;
revoke all on function public.trigger_delivery_feedback_request(uuid,text) from public,anon;
revoke all on function public.set_organization_google_review_url(text) from public,anon;
grant execute on function public.submit_customer_feedback(uuid,smallint,text) to authenticated;
grant execute on function public.trigger_delivery_feedback_request(uuid,text) to authenticated;
commit;
