-- Minimal schema for executable public feedback form tests.
create schema extensions;
-- pglite ships without pgcrypto, so the token source is stubbed for the test
-- only. Production resolves extensions.gen_random_bytes from pgcrypto itself.
create or replace function extensions.gen_random_bytes(n integer) returns bytea
  language sql as $$
    select decode(string_agg(lpad(to_hex((random() * 255)::int), 2, '0'), ''), 'hex')
    from generate_series(1, n)
  $$;
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema app_private;
grant usage on schema public,auth,app_private,extensions to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;

create table organizations(id uuid primary key,name text,google_review_url text,deleted_at timestamptz);
create table profiles(id uuid primary key,organization_id uuid not null,full_name text default 'Employee',active boolean default true,deleted_at timestamptz);
create table branches(id uuid primary key,organization_id uuid not null,name text not null,deleted_at timestamptz);
create table customers(id uuid primary key,organization_id uuid,deleted_at timestamptz);
create table bookings(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid);
create table audit_logs(id bigserial primary key,organization_id uuid,actor_id uuid,action text,resource_type text,resource_id text,branch_id uuid,request_id uuid,metadata jsonb,created_at timestamptz default now());
create table customer_review_requests(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  branch_id uuid not null references branches(id), customer_id uuid not null references customers(id),
  booking_id uuid references bookings(id), channel text not null, message_body text not null,
  status text not null default 'QUEUED', created_by uuid not null references profiles(id),
  version bigint not null default 1, deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table feedback_requests(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  branch_id uuid not null references branches(id), customer_id uuid not null references customers(id),
  booking_id uuid references bookings(id), channel text not null default 'EMAIL',
  status text not null default 'PENDING', sent_at timestamptz, completed_at timestamptz,
  rating smallint check (rating between 1 and 5), comments text,
  created_at timestamptz not null default now()
);
create function app_private.current_tenant_organization() returns uuid language sql stable as $$
  select organization_id from profiles where id=auth.uid() and active and deleted_at is null limit 1
$$;
create function app_private.has_permission(org uuid,permission text) returns boolean language sql stable as $$
  select exists(select 1 from profiles where id=auth.uid() and organization_id=org and active)
$$;
create function app_private.can_access_branch(org uuid,branch uuid) returns boolean language sql stable as $$select true$$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' loop
    execute format('alter function %s set search_path=public,pg_catalog', f.signature);
  end loop;
end $$;
