-- Minimal CRM schema for executable Business Owner overview tests.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema app_private;
grant usage on schema public,auth,app_private to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;

create type public.lead_lifecycle as enum ('New','Contacted','Qualified','Appointment Scheduled','Transferred to Sales','Lost');
create table organizations(id uuid primary key,status text default 'ACTIVE',deleted_at timestamptz);
create table profiles(id uuid primary key,organization_id uuid not null,full_name text default 'Employee',active boolean default true,deleted_at timestamptz);
create table branches(id uuid primary key,organization_id uuid not null,name text not null,active boolean default true,deleted_at timestamptz);
create table user_role_assignments(id uuid default gen_random_uuid(),organization_id uuid,user_id uuid,role_id uuid,active boolean default true,data_scope text default 'ORGANIZATION',scope_branch_id uuid,selected_branch_ids uuid[] default '{}');
create table user_branch_access(organization_id uuid,user_id uuid,branch_id uuid,active boolean default true);
create table customers(id uuid primary key,organization_id uuid,deleted_at timestamptz);
create table leads(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,customer_id uuid,assigned_user_id uuid,source text default 'Manual',lifecycle_status public.lead_lifecycle not null default 'New',created_at timestamptz default now(),deleted_at timestamptz);
create table bookings(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,created_at timestamptz default now());
create table test_drives(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,created_at timestamptz default now());
create table finance_cases(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,status text default 'DOCUMENTS_PENDING');
create table insurance_cases(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,status text default 'QUOTE_PENDING');
create table rto_cases(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,status text default 'NEW');
create table exchange_cases(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,status text default 'REQUESTED');
create table delivery_cases(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,status text default 'PLANNING');

create function app_private.current_tenant_organization() returns uuid language sql stable as $$
  select organization_id from profiles where id=auth.uid() and active and deleted_at is null limit 1
$$;
create function app_private.has_permission(org uuid,permission text) returns boolean language sql stable as $$
  select permission is distinct from current_setting('test.denied_permission',true)
    and exists(select 1 from profiles where id=auth.uid() and organization_id=org and active)
$$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' loop
    execute format('alter function %s set search_path=public,pg_catalog', f.signature);
  end loop;
end $$;

alter table leads add column team_id uuid, add column campaign text;
alter table bookings add column lead_id uuid, add column deleted_at timestamptz;
alter table test_drives add column lead_id uuid;
create table quotations(organization_id uuid,lead_id uuid,deleted_at timestamptz);
create table marketing_campaigns(organization_id uuid,branch_id uuid,status text,deleted_at timestamptz);
create table social_posts(organization_id uuid,branch_id uuid,status text,deleted_at timestamptz);
create table customer_care_cases(organization_id uuid,branch_id uuid,assigned_user_id uuid,customer_id uuid,case_type text,deleted_at timestamptz);
create function app_private.can_access_record(org uuid, branch uuid, team uuid, owner uuid) returns boolean language sql stable as $$
 select org=app_private.current_tenant_organization() and exists (
 select 1 from user_role_assignments a where a.user_id=auth.uid() and a.organization_id=org and a.active
 and (a.data_scope='ORGANIZATION' or (a.data_scope='ONE_BRANCH' and a.scope_branch_id=branch)
 or (a.data_scope='OWN_RECORDS' and owner=auth.uid()) or (a.data_scope='OWN_TEAM' and team=a.role_id)))
$$;
create function app_private.can_access_lead(lead uuid) returns boolean language sql stable as $$
 select exists(select 1 from leads l where l.id=lead and l.deleted_at is null
 and app_private.has_permission(l.organization_id,'lead.view') and app_private.can_access_record(l.organization_id,l.branch_id,l.team_id,l.assigned_user_id))
$$;
create function app_private.has_organization_wide_scope(org uuid) returns boolean language sql stable as $$ select exists(select 1 from user_role_assignments where user_id=auth.uid() and organization_id=org and data_scope='ORGANIZATION' and active) $$;
create function app_private.can_access_branch(org uuid,branch uuid) returns boolean language sql stable as $$ select app_private.can_access_record(org,branch,null,null) $$;
create function app_private.can_access_customer(org uuid,customer uuid) returns boolean language sql stable as $$ select org=app_private.current_tenant_organization() $$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' loop
    execute format('alter function %s set search_path=public,pg_catalog', f.signature);
  end loop;
end $$;
