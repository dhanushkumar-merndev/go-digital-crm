begin;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create type public.data_scope as enum ('OWN_RECORDS', 'OWN_TEAM', 'ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES', 'ORGANIZATION', 'PLATFORM');
create type public.tenant_status as enum ('ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED', 'ACTIVE', 'SUPPORT_MAINTENANCE', 'SUSPENDED', 'REJECTED', 'SOFT_DELETED');
create type public.assignment_mode as enum ('ROUND_ROBIN', 'MANUAL_ASSIGNMENT');
create type public.lead_lifecycle as enum ('New', 'Contacted', 'Qualified', 'Appointment Scheduled', 'Transferred to Sales', 'Lost');
create type public.lead_temperature as enum ('COLD', 'WARM', 'HOT');
create type public.branch_scope_mode as enum ('ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES');
create type public.credit_ledger_kind as enum ('AI', 'TRACKING');
create type public.credit_transaction_type as enum ('ALLOCATION', 'CONSUMPTION', 'ADJUSTMENT', 'REVERSAL');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  legal_name text,
  gst_number text,
  status public.tenant_status not null default 'ONBOARDING',
  primary_owner_id uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  deletion_reason text,
  purge_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  code text not null,
  name text not null,
  address jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  organization_id uuid references public.organizations(id),
  full_name text not null,
  email text not null,
  normalized_email text generated always as (lower(trim(email))) stored,
  phone text,
  normalized_phone text,
  employee_id text,
  active boolean not null default true,
  mfa_required boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, normalized_email),
  unique nulls not distinct (organization_id, employee_id)
);

alter table public.organizations add constraint organizations_primary_owner_fk foreign key (primary_owner_id) references public.profiles(id) deferrable initially deferred;

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id),
  name text not null,
  role_key text not null,
  authority_level integer not null check (authority_level between 0 and 1000),
  system_role boolean not null default false,
  mfa_required boolean not null default false,
  created_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, role_key),
  constraint roles_no_team_leader check (lower(name) not like '%team leader%' and lower(role_key) not like '%team_leader%')
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  permission_key text not null unique,
  module text not null,
  description text not null
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id),
  user_id uuid not null references public.profiles(id),
  role_id uuid not null references public.roles(id),
  data_scope public.data_scope not null,
  scope_branch_id uuid references public.branches(id),
  selected_branch_ids uuid[] not null default '{}',
  active boolean not null default true,
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint valid_branch_scope check (
    (data_scope = 'ONE_BRANCH' and scope_branch_id is not null and cardinality(selected_branch_ids) = 0)
    or (data_scope = 'SELECTED_BRANCHES' and scope_branch_id is null and cardinality(selected_branch_ids) > 0)
    or (data_scope not in ('ONE_BRANCH', 'SELECTED_BRANCHES') and scope_branch_id is null and cardinality(selected_branch_ids) = 0)
  )
);

create table public.user_branch_access (
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references public.profiles(id),
  branch_id uuid not null references public.branches(id),
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (user_id, branch_id)
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  name text not null,
  manager_id uuid references public.profiles(id),
  fresh_assignment_mode public.assignment_mode not null default 'ROUND_ROBIN',
  qualified_assignment_mode public.assignment_mode not null default 'ROUND_ROBIN',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, branch_id, name)
);

create table public.team_members (
  organization_id uuid not null references public.organizations(id),
  team_id uuid not null references public.teams(id),
  user_id uuid not null references public.profiles(id),
  member_type text not null check (member_type in ('TEAM_MANAGER', 'SALES_CONSULTANT', 'TELECALLER_BDC')),
  eligible_for_fresh_leads boolean not null default false,
  eligible_for_qualified_leads boolean not null default false,
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create or replace function app_private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_role_assignments ura
    join public.roles r on r.id = ura.role_id
    join public.profiles p on p.id = ura.user_id
    where ura.user_id = auth.uid() and ura.active and p.active and r.role_key = 'super_admin' and ura.data_scope = 'PLATFORM'
  );
$$;

create or replace function app_private.can_access_organization(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.is_platform_admin() or exists (
    select 1 from public.profiles p
    join public.organizations o on o.id = p.organization_id
    where p.id = auth.uid() and p.active and p.organization_id = target_organization_id
      and o.status in ('ACTIVE', 'SUPPORT_MAINTENANCE', 'ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED')
  );
$$;

create or replace function app_private.has_permission(target_organization_id uuid, target_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.is_platform_admin() or exists (
    select 1 from public.user_role_assignments ura
    join public.role_permissions rp on rp.role_id = ura.role_id
    join public.permissions p on p.id = rp.permission_id
    where ura.user_id = auth.uid() and ura.organization_id = target_organization_id and ura.active and p.permission_key = target_permission
  );
$$;

create or replace function app_private.can_access_branch(target_organization_id uuid, target_branch_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.is_platform_admin() or exists (
    select 1 from public.user_role_assignments ura
    where ura.user_id = auth.uid() and ura.organization_id = target_organization_id and ura.active and (
      ura.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
      or (ura.data_scope = 'ONE_BRANCH' and ura.scope_branch_id = target_branch_id)
      or (ura.data_scope = 'SELECTED_BRANCHES' and target_branch_id = any(ura.selected_branch_ids))
      or exists (select 1 from public.user_branch_access uba where uba.user_id = auth.uid() and uba.branch_id = target_branch_id)
    )
  );
$$;

create table public.modules (
  id uuid primary key default gen_random_uuid(), module_key text not null unique, name text not null, active boolean not null default true
);
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(), name text not null unique, active boolean not null default true, created_at timestamptz not null default now()
);
create table public.plan_modules (
  plan_id uuid not null references public.subscription_plans(id) on delete cascade, module_id uuid not null references public.modules(id) on delete cascade,
  limits jsonb not null default '{}'::jsonb, primary key (plan_id, module_id)
);
create table public.organization_module_entitlements (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), module_id uuid not null references public.modules(id),
  enabled boolean not null default true, limits jsonb not null default '{}'::jsonb, valid_until timestamptz, unique (organization_id, module_id)
);
create table public.module_usage (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), module_id uuid not null references public.modules(id),
  usage_date date not null, quantity bigint not null default 0, unique (organization_id, module_id, usage_date)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  full_name text not null,
  normalized_name text generated always as (lower(trim(full_name))) stored,
  primary_phone text,
  normalized_phone text,
  primary_email text,
  normalized_email text generated always as (lower(trim(primary_email))) stored,
  created_by uuid references public.profiles(id),
  deleted_at timestamptz,
  deleted_by uuid,
  deletion_reason text,
  purge_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), customer_id uuid not null references public.customers(id),
  type text not null check (type in ('PHONE', 'EMAIL')), value text not null, normalized_value text not null, is_primary boolean not null default false, created_at timestamptz not null default now()
);
create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), customer_id uuid not null references public.customers(id),
  address_type text not null default 'HOME', address jsonb not null, created_at timestamptz not null default now()
);
create table public.customer_vehicles (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), customer_id uuid not null references public.customers(id),
  registration text, normalized_registration text, brand text, model text, variant text, model_year integer, created_at timestamptz not null default now()
);

create table public.lead_sources (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), name text not null,
  canonical_source text not null check (canonical_source in ('Facebook','Instagram','Google Ads','Website','WhatsApp Business','CarWale','CarDekho','Justdial','IndiaMART','Manual','Other')),
  active boolean not null default true, unique (organization_id, name)
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  team_id uuid references public.teams(id),
  customer_id uuid references public.customers(id),
  source text not null check (source in ('Facebook','Instagram','Google Ads','Website','WhatsApp Business','CarWale','CarDekho','Justdial','IndiaMART','Manual','Other')),
  source_detail text,
  campaign text,
  connection_id uuid,
  external_lead_id text,
  raw_payload jsonb,
  customer_name text not null,
  phone text not null,
  normalized_phone text not null,
  email text,
  interested_model text,
  lifecycle_status public.lead_lifecycle not null default 'New',
  temperature public.lead_temperature,
  assigned_user_id uuid references public.profiles(id),
  first_contacted_at timestamptz,
  next_followup_at timestamptz,
  sla_due_at timestamptz,
  lost_reason text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, connection_id, external_lead_id)
);

create table public.lead_assignments (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), lead_id uuid not null references public.leads(id),
  branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id), assigned_user_id uuid not null references public.profiles(id),
  assignment_type text not null check (assignment_type in ('FRESH', 'QUALIFIED')), method public.assignment_mode not null, assigned_by uuid references public.profiles(id), reason text,
  active boolean not null default true, created_at timestamptz not null default now()
);
create table public.lead_assignment_history (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), lead_id uuid not null references public.leads(id),
  branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id), previous_owner_id uuid references public.profiles(id), new_owner_id uuid not null references public.profiles(id),
  assigned_by uuid references public.profiles(id), method public.assignment_mode not null, reason text, created_at timestamptz not null default now()
);
create table public.lead_stage_history (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), lead_id uuid not null references public.leads(id),
  from_status public.lead_lifecycle, to_status public.lead_lifecycle not null, changed_by uuid references public.profiles(id), reason text, created_at timestamptz not null default now()
);
create table public.lead_temperature_history (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), lead_id uuid not null references public.leads(id),
  from_temperature public.lead_temperature, to_temperature public.lead_temperature not null, changed_by uuid references public.profiles(id), created_at timestamptz not null default now()
);

create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), module text not null, field_key text not null,
  label text not null, field_type text not null check (field_type in ('TEXT','NUMBER','DATE','BOOLEAN','SELECT','MULTI_SELECT')), options jsonb not null default '[]'::jsonb,
  required boolean not null default false, active boolean not null default true, unique (organization_id, module, field_key)
);
create table public.custom_field_values (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), definition_id uuid not null references public.custom_field_definitions(id),
  resource_type text not null, resource_id uuid not null, value jsonb not null, unique (definition_id, resource_type, resource_id)
);
create table public.notes (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), resource_type text not null, resource_id uuid not null,
  body text not null, created_by uuid not null references public.profiles(id), deleted_at timestamptz, created_at timestamptz not null default now()
);
create table public.activities (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), customer_id uuid references public.customers(id), lead_id uuid references public.leads(id),
  activity_type text not null, actor_id uuid references public.profiles(id), metadata jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default now()
);

create or replace view public.leads_with_work_state with (security_invoker = true) as
select l.*,
  case
    when l.first_contacted_at is null and l.sla_due_at is not null and now() > l.sla_due_at then 'SLA_RISK'
    when l.first_contacted_at is null and now() >= l.created_at + interval '24 hours' then 'PENDING'
    when l.first_contacted_at is null then 'NEW_TODAY'
    else null
  end as work_state
from public.leads l;

create index profiles_org_name_trgm_idx on public.profiles using gin (full_name gin_trgm_ops);
create index customers_org_created_idx on public.customers (organization_id, created_at desc);
create index customers_org_phone_idx on public.customers (organization_id, normalized_phone);
create index customers_name_trgm_idx on public.customers using gin (normalized_name gin_trgm_ops);
create index leads_org_created_idx on public.leads (organization_id, created_at desc, id);
create index leads_org_branch_status_idx on public.leads (organization_id, branch_id, lifecycle_status, created_at desc, id);
create index leads_org_team_created_idx on public.leads (organization_id, team_id, created_at desc, id);
create index leads_org_owner_status_idx on public.leads (organization_id, assigned_user_id, lifecycle_status, created_at desc, id);
create index leads_org_followup_idx on public.leads (organization_id, next_followup_at);
create index leads_org_phone_idx on public.leads (organization_id, normalized_phone);

create or replace function public.assign_lead(
  target_lead_id uuid, target_user_id uuid, assignment_kind text, assignment_reason text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare target_lead public.leads%rowtype; team_mode public.assignment_mode; prior_owner uuid; assignment_id uuid;
begin
  select * into target_lead from public.leads where id = target_lead_id and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND'; end if;
  if not app_private.has_permission(target_lead.organization_id, 'lead.assign') then raise exception using errcode = '42501', message = 'PERMISSION_DENIED'; end if;
  if not app_private.can_access_branch(target_lead.organization_id, target_lead.branch_id) then raise exception using errcode = '42501', message = 'SCOPE_DENIED'; end if;
  if not exists (select 1 from public.team_members tm where tm.organization_id = target_lead.organization_id and tm.user_id = target_user_id and tm.active and (target_lead.team_id is null or tm.team_id = target_lead.team_id)) then raise exception using errcode = '23514', message = 'ASSIGNEE_NOT_ELIGIBLE'; end if;
  select case when assignment_kind = 'FRESH' then fresh_assignment_mode else qualified_assignment_mode end into team_mode from public.teams where id = target_lead.team_id;
  prior_owner := target_lead.assigned_user_id;
  update public.lead_assignments set active = false where lead_id = target_lead_id and active;
  insert into public.lead_assignments (organization_id, lead_id, branch_id, team_id, assigned_user_id, assignment_type, method, assigned_by, reason)
    values (target_lead.organization_id, target_lead.id, target_lead.branch_id, target_lead.team_id, target_user_id, assignment_kind, coalesce(team_mode, 'MANUAL_ASSIGNMENT'), auth.uid(), assignment_reason) returning id into assignment_id;
  insert into public.lead_assignment_history (organization_id, lead_id, branch_id, team_id, previous_owner_id, new_owner_id, assigned_by, method, reason)
    values (target_lead.organization_id, target_lead.id, target_lead.branch_id, target_lead.team_id, prior_owner, target_user_id, auth.uid(), coalesce(team_mode, 'MANUAL_ASSIGNMENT'), assignment_reason);
  update public.leads set assigned_user_id = target_user_id, updated_at = now() where id = target_lead_id;
  return assignment_id;
end;
$$;

revoke all on function public.assign_lead(uuid, uuid, text, text) from public, anon;
grant execute on function public.assign_lead(uuid, uuid, text, text) to authenticated;

commit;
