-- Loaded after public-feedback-base.sql, 202609070202, branch-feedback-branding-base.sql
-- and 202610142271: the tables and helpers 202610182000 reads, reduced to the
-- columns it touches.
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','anon')
$$;
alter table customers add column primary_phone text, add column whatsapp_phone text;
create table leads(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  branch_id uuid not null references branches(id), team_id uuid, customer_id uuid references customers(id),
  customer_name text not null default 'Lead', phone text, normalized_phone text,
  interested_model text, assigned_user_id uuid, deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table connected_accounts(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  provider_key text not null, scope_mode text not null, status text not null,
  connection_config jsonb not null default '{}'::jsonb, deleted_at timestamptz
);
create table credit_ledger(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  ledger_kind text not null, transaction_type text not null, amount integer not null check (amount <> 0),
  feature text, reference_id text not null, reason text, user_id uuid,
  unique (organization_id, ledger_kind, reference_id)
);
-- Record scope stand-in: a lead is visible to its assignee only.
create function app_private.can_access_lead(target_lead_id uuid) returns boolean language sql stable as $$
  select exists(select 1 from leads where id=target_lead_id and deleted_at is null and assigned_user_id=auth.uid())
$$;
-- Same contract as production: service role only, idempotent per reference.
create function public.consume_platform_ai_credits(
  target_organization_id uuid, target_amount integer, target_feature text, target_reference_id text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare current_balance bigint; ledger_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  select id into ledger_id from public.credit_ledger
  where organization_id = target_organization_id and ledger_kind = 'AI' and reference_id = target_reference_id;
  if found then return ledger_id; end if;
  select coalesce(sum(amount), 0) into current_balance from public.credit_ledger
  where organization_id = target_organization_id and ledger_kind = 'AI';
  if current_balance < target_amount then raise exception using errcode = 'P0001', message = 'INSUFFICIENT_CREDITS'; end if;
  insert into public.credit_ledger(organization_id, ledger_kind, transaction_type, amount, feature, reference_id, reason)
  values (target_organization_id, 'AI', 'CONSUMPTION', -target_amount, target_feature, target_reference_id, 'test');
  return ledger_id;
end $$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' and p.proname='can_access_lead' loop
    execute format('alter function %s set search_path=public,pg_catalog', f.signature);
  end loop;
end $$;

-- The deployed completion trigger (before 202610171757), so 202610182000's guarded
-- patch runs against the real body. Its case/complaint path is not exercised here.
CREATE OR REPLACE FUNCTION app_private.route_completed_customer_feedback()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end; $function$

;
create trigger route_completed_customer_feedback after update of status, rating on feedback_requests
  for each row execute function app_private.route_completed_customer_feedback();
