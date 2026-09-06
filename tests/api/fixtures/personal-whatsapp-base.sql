-- Minimal pre-pilot CRM schema for executable PostgreSQL migration/RLS tests.
-- Access predicates below model own-record and manager scope; the migration itself
-- is loaded unchanged, along with the production inbox RPC definitions.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema app_private;
grant usage on schema public,auth,app_private to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'$$;
create table organizations(id uuid primary key,status text default 'ACTIVE',deleted_at timestamptz);
create table profiles(id uuid primary key,organization_id uuid not null,full_name text default 'Employee',active boolean default true,deleted_at timestamptz,unique(organization_id,id));
create table branches(id uuid primary key,organization_id uuid not null,active boolean default true,deleted_at timestamptz,unique(organization_id,id));
create table roles(id uuid primary key,organization_id uuid,role_key text,authority_level integer default 10);
create table permissions(id uuid primary key default gen_random_uuid(),permission_key text);
create table role_permissions(role_id uuid,permission_id uuid);
insert into permissions(permission_key) values('lead.view'),('customer.view');
create table user_role_assignments(id uuid default gen_random_uuid(),organization_id uuid,user_id uuid,role_id uuid,active boolean default true,data_scope text default 'OWN_RECORDS',scope_branch_id uuid,selected_branch_ids uuid[] default '{}');
create table user_branch_access(organization_id uuid,user_id uuid,branch_id uuid,active boolean default true);
create table teams(id uuid primary key,branch_id uuid,organization_id uuid,active boolean default true);
create table team_members(user_id uuid,team_id uuid,organization_id uuid,active boolean default true);
create table lead_assignments(organization_id uuid,lead_id uuid,assigned_user_id uuid);
create table lead_assignment_history(organization_id uuid,lead_id uuid,previous_owner_id uuid,new_owner_id uuid);
create table customers(id uuid primary key,organization_id uuid,full_name text,primary_phone text,normalized_phone text,deleted_at timestamptz,unique(organization_id,id));
create table leads(id uuid primary key,organization_id uuid,branch_id uuid,team_id uuid,customer_id uuid,assigned_user_id uuid,customer_name text,phone text,normalized_phone text,interested_model text,created_at timestamptz default now(),deleted_at timestamptz,unique(organization_id,id));
create table connected_accounts(id uuid primary key default gen_random_uuid(),organization_id uuid,provider_key text,display_name text,scope_mode text,status text,external_account_id text,created_by uuid,created_at timestamptz default now(),deleted_at timestamptz,connected_at timestamptz,auth_type text constraint connected_accounts_auth_type_check check(auth_type in ('OAUTH2','API_KEY','WEBHOOK_SECRET','BASIC_AUTH')),unique(organization_id,id));
create function app_private.validate_connected_account_actor() returns trigger language plpgsql as $$begin return new; end$$;
create trigger enforce_connected_account_actor before insert or update on connected_accounts for each row execute function app_private.validate_connected_account_actor();
create table integration_branch_mappings(organization_id uuid,connected_account_id uuid,branch_id uuid,external_resource_type text,external_resource_id text);
create table audit_logs(organization_id uuid,actor_id uuid,action text,resource_type text,resource_id text,metadata jsonb);
create table conversations(id uuid primary key,organization_id uuid,branch_id uuid,lead_id uuid,customer_id uuid,channel text,status text,assigned_user_id uuid,external_contact text,last_message_at timestamptz,created_at timestamptz default now());
create table conversation_messages(id uuid primary key,organization_id uuid,conversation_id uuid,body text,direction text,sent_at timestamptz,delivery_status text,metadata jsonb);
create function app_private.actor_has_tenant_operation_context(actor uuid,org uuid,permission text) returns boolean language sql stable as $$
 select exists(select 1 from profiles p join organizations o on o.id=p.organization_id where p.id=actor and p.organization_id=org and p.active and p.deleted_at is null and o.status='ACTIVE')
$$;
create function app_private.has_permission(org uuid,permission text) returns boolean language sql stable as $$select app_private.actor_has_tenant_operation_context(auth.uid(),org,permission)$$;
create function app_private.can_access_branch(org uuid,branch uuid) returns boolean language sql stable as $$select exists(select 1 from user_branch_access where organization_id=org and user_id=auth.uid() and branch_id=branch)$$;
create function app_private.can_access_lead(lead uuid) returns boolean language sql stable as $$select exists(select 1 from leads where id=lead and assigned_user_id=auth.uid() and deleted_at is null)$$;
create function app_private.can_access_customer(org uuid,customer uuid) returns boolean language sql stable as $$select exists(select 1 from leads where organization_id=org and customer_id=customer and assigned_user_id=auth.uid() and deleted_at is null)$$;
create function app_private.can_access_conversation(org uuid,conversation uuid) returns boolean language sql stable as $$select exists(select 1 from conversations where id=conversation and organization_id=org and assigned_user_id=auth.uid())$$;
create function app_private.broadcast_tenant_invalidation() returns trigger language plpgsql as $$begin return null; end$$;
create function public.get_access_context() returns jsonb language sql stable as $$
 select jsonb_build_object('organization_id',p.organization_id,'destination',case when p.active then 'CRM' else 'LOCKED' end,'role_key',case when r.role_key='telecaller_bdc' then 'telecaller' else replace(r.role_key,'_','-') end)
 from profiles p join user_role_assignments a on a.user_id=p.id and a.active join roles r on r.id=a.role_id where p.id=auth.uid() limit 1
$$;
grant select on all tables in schema public to authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' or (n.nspname='public' and p.proname='get_access_context') loop
    execute format('alter function %s set search_path=public,pg_catalog', f.signature);
  end loop;
end $$;
create table app_private.retention_table_allowlist(table_name name primary key,disposition text,delete_order integer unique);
