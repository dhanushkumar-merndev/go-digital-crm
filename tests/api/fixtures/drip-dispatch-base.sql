create type public.lead_lifecycle as enum ('New','Contacted','Qualified','Appointment Scheduled','Transferred to Sales','Lost');
create type public.lead_temperature as enum ('COLD','WARM','HOT','DORMANT');
-- Minimal pre-drip CRM schema for executable PostgreSQL tests. The tables below
-- mirror the production shape the drip migrations alter; the migrations under
-- test are then loaded unchanged so their DDL and RPCs run for real.
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
create table customers(id uuid primary key,organization_id uuid,full_name text,primary_phone text,primary_email text,deleted_at timestamptz,unique(organization_id,id));
create table leads(id uuid primary key,organization_id uuid,branch_id uuid,team_id uuid,customer_id uuid,assigned_user_id uuid,source text default 'Manual',lifecycle_status public.lead_lifecycle not null default 'New',temperature public.lead_temperature,created_at timestamptz default now(),updated_at timestamptz default now(),deleted_at timestamptz,unique(organization_id,id));
create table activities(id uuid primary key default gen_random_uuid(),organization_id uuid,customer_id uuid,lead_id uuid,activity_type text,actor_id uuid,metadata jsonb,created_at timestamptz default now());
create table audit_logs(id bigserial primary key,organization_id uuid,actor_id uuid,action text,resource_type text,resource_id text,branch_id uuid,request_id uuid,metadata jsonb,created_at timestamptz default now());
create table connected_accounts(id uuid primary key default gen_random_uuid(),organization_id uuid,provider_key text,display_name text,scope_mode text,status text,created_at timestamptz default now(),deleted_at timestamptz,unique(organization_id,id));
create table integration_branch_mappings(organization_id uuid,connected_account_id uuid,branch_id uuid);
create table marketing_drip_campaigns(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,name text,audience_filter jsonb not null default '{}'::jsonb,default_channel text default 'EMAIL',status text not null default 'DRAFT',created_by uuid,updated_at timestamptz default now(),deleted_at timestamptz,unique(organization_id,id));

-- Production shape from 202608140002 plus the deleted_at added by 202608220028.
create table templates(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  channel text not null, name text not null, content jsonb not null, provider_template_id text,
  status text not null default 'DRAFT', created_by uuid references profiles(id), deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- Production shape from 202608220035.
create table marketing_drip_steps(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  campaign_id uuid not null references marketing_drip_campaigns(id), step_order smallint not null,
  delay_hours integer not null default 0, channel text not null, message_body text not null,
  active boolean not null default true, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), unique(campaign_id,step_order), unique(organization_id,id),
  check (channel in ('WHATSAPP','SMS','EMAIL'))
);

-- Production shape from 202608260005, including the status check and the due
-- index the dispatch migration replaces.
create table customer_drip_enrollments(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  branch_id uuid not null references branches(id), customer_id uuid not null references customers(id),
  lead_id uuid references leads(id), source_campaign_id uuid references marketing_drip_campaigns(id),
  source_name text not null, status text not null default 'ACTIVE', enrolled_by uuid not null references profiles(id),
  cancelled_at timestamptz, cancellation_reason text, completed_at timestamptz, version bigint not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(organization_id,id), check (status in ('ACTIVE','COMPLETED','CANCELLED'))
);
create table customer_drip_messages(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  enrollment_id uuid not null references customer_drip_enrollments(id), step_order smallint not null,
  channel text not null, message_body text not null, scheduled_for timestamptz not null,
  status text not null default 'QUEUED', sent_at timestamptz, failure_reason text, provider_message_id text,
  attempts integer not null default 0, version bigint not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(enrollment_id,step_order), unique(organization_id,id),
  check (step_order between 1 and 12), check (channel in ('WHATSAPP','SMS','EMAIL')),
  check (status in ('QUEUED','SENT','FAILED','CANCELLED')), check (attempts between 0 and 10)
);
create index customer_drip_messages_due_idx on customer_drip_messages(status,scheduled_for,id) where status='QUEUED';


create table object_files(id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id),branch_id uuid,resource_type text not null,resource_id uuid not null,bucket text not null,object_key text not null,mime_type text not null,size_bytes bigint not null,checksum text not null,uploaded_by uuid,deleted_at timestamptz,created_at timestamptz default now(),unique(bucket,object_key));
create table ai_image_generations(id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id),branch_id uuid references branches(id),status text not null default 'QUEUED',created_at timestamptz default now());
create table ai_image_generation_outputs(id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id),generation_id uuid not null references ai_image_generations(id),object_file_id uuid not null references object_files(id),ordinal smallint not null,created_at timestamptz default now(),unique(generation_id,ordinal),unique(object_file_id));
create function app_private.can_access_branch(org uuid,branch uuid) returns boolean language sql stable as $$select true$$;

create function app_private.current_tenant_organization() returns uuid language sql stable as $$
  select organization_id from profiles where id=auth.uid() and active and deleted_at is null limit 1
$$;
create function app_private.has_permission(org uuid,permission text) returns boolean language sql stable as $$
  select exists(select 1 from profiles p join organizations o on o.id=p.organization_id
    where p.id=auth.uid() and p.organization_id=org and p.active and p.deleted_at is null and o.status='ACTIVE')
$$;
create function app_private.can_access_record(org uuid,branch uuid,team uuid,assigned uuid) returns boolean language sql stable as $$
  select assigned=auth.uid()
$$;
create function app_private.can_access_customer(org uuid,customer uuid) returns boolean language sql stable as $$
  select exists(select 1 from leads where organization_id=org and customer_id=customer and assigned_user_id=auth.uid() and deleted_at is null)
$$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' loop
    execute format('alter function %s set search_path=public,pg_catalog', f.signature);
  end loop;
end $$;

create table app_private.retention_table_allowlist(table_name name primary key,disposition text,delete_order integer unique);

create table marketing_campaigns(id uuid primary key default gen_random_uuid(),organization_id uuid,unique(organization_id,id));
create table social_posts(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  branch_id uuid references branches(id), connected_account_id uuid references connected_accounts(id),
  campaign_id uuid references marketing_campaigns(id), platform text not null, content text not null,
  media_object_file_ids jsonb not null default '[]'::jsonb, status text not null default 'DRAFT',
  scheduled_for timestamptz, published_at timestamptz, provider_post_id text, safe_error_code text,
  version bigint not null default 1, created_by uuid not null references profiles(id), deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (platform in ('FACEBOOK','INSTAGRAM','GOOGLE_BUSINESS_PROFILE','OTHER')),
  check (status in ('DRAFT','SCHEDULED','PUBLISH_REQUESTED','PUBLISHED','FAILED','CANCELLED')),
  check (published_at is null or status = 'PUBLISHED')
);

create table integration_field_mappings(id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id),connected_account_id uuid not null references connected_accounts(id),external_field text not null,canonical_field text not null,transform_config jsonb not null default '{}'::jsonb,unique(connected_account_id,external_field));
