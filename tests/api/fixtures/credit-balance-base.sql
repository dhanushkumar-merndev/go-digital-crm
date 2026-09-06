-- Minimal ledger schema for executable credit-rollup tests. Shapes mirror
-- 202608140002 so the migration under test runs unchanged.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema app_private;
grant usage on schema public,auth,app_private to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'$$;

create type public.credit_ledger_kind as enum ('AI','TRACKING');
create type public.credit_transaction_type as enum ('GRANT','CONSUMPTION','ADJUSTMENT','REVERSAL');
create table organizations(id uuid primary key,status text default 'ACTIVE');
create table profiles(id uuid primary key,organization_id uuid not null,active boolean default true,deleted_at timestamptz);
create table audit_logs(id bigserial primary key,organization_id uuid,actor_id uuid,action text,resource_type text,resource_id text,metadata jsonb,created_at timestamptz default now());
create table public.credit_ledger(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  ledger_kind public.credit_ledger_kind not null, transaction_type public.credit_transaction_type not null,
  amount bigint not null check (amount <> 0), feature text, user_id uuid references profiles(id), source text,
  reference_id text not null, reason text not null, created_by uuid references profiles(id),
  created_at timestamptz not null default now(), unique (organization_id, ledger_kind, reference_id)
);
create table public.ai_credit_reservations(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  feature text not null, reference_id text not null, amount integer not null, ledger_id uuid,
  status text not null default 'RESERVED', created_at timestamptz default now(),
  unique (organization_id, reference_id)
);
create function app_private.has_permission(org uuid,permission text) returns boolean language sql stable as $$
  select exists(select 1 from profiles where id=auth.uid() and organization_id=org and active)
$$;
create table app_private.retention_table_allowlist(table_name name primary key,disposition text,delete_order integer unique);
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' loop
    execute format('alter function %s set search_path=public,pg_catalog', f.signature);
  end loop;
end $$;
