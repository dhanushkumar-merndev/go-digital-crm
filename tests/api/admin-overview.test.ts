import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const otherOrg = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const otherBranch = randomUUID();
const orgAdmin = randomUUID();
const branchAdmin = randomUUID();
let db: PGlite;

type Overview = {
  organization_wide: boolean;
  kpis: Record<string, number>;
  roles: Array<{ name: string; value: number }>;
  branches: Array<{ name: string; value: number }>;
};

// The user-administration gate is exercised by the user directory tests; here
// it is a stub so each test chooses who passes it.
const fixture = `
create role anon;
create role authenticated;
create schema auth;
create schema app_private;
create type public.data_scope as enum (
  'OWN_RECORDS', 'OWN_TEAM', 'ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES', 'ORGANIZATION', 'PLATFORM'
);
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;
create function app_private.tenant_user_mode_allowed(uuid, text) returns boolean
language sql stable as $$ select $1 is not null and $2 = 'USER_ADMIN' $$;
create function app_private.scope_rank(scope public.data_scope) returns integer
language sql immutable as $$
  select case scope when 'ORGANIZATION' then 6 when 'ALL_BRANCHES' then 5
    when 'SELECTED_BRANCHES' then 4 when 'ONE_BRANCH' then 3 else 1 end
$$;
create table public.profiles (
  id uuid primary key, organization_id uuid, active boolean not null default true,
  mfa_required boolean not null default false, deleted_at timestamptz
);
create table public.branches (
  id uuid primary key, organization_id uuid not null, name text not null,
  active boolean not null default true, deleted_at timestamptz
);
create table public.roles (
  id uuid primary key default gen_random_uuid(), organization_id uuid, name text not null,
  role_key text not null, authority_level integer not null, mfa_required boolean not null default false
);
create table public.permissions (id uuid primary key default gen_random_uuid(), permission_key text not null);
create table public.role_permissions (role_id uuid not null, permission_id uuid not null);
create table public.user_role_assignments (
  id uuid primary key default gen_random_uuid(), organization_id uuid, user_id uuid not null,
  role_id uuid not null, data_scope public.data_scope not null, scope_branch_id uuid,
  selected_branch_ids uuid[] not null default '{}', active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.connected_accounts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  status text not null, last_error_code text, deleted_at timestamptz
);
`;

async function role(organizationId: string, key: string, name: string, authority: number) {
  const result = await db.query<{ id: string }>(
    'insert into public.roles (organization_id, name, role_key, authority_level) values ($1, $2, $3, $4) returning id',
    [organizationId, name, key, authority],
  );
  return result.rows[0].id;
}

async function person(
  id: string,
  roleId: string,
  scope: string,
  branch: string | null,
  organizationId = org,
) {
  await db.query('insert into public.profiles (id, organization_id) values ($1, $2)', [
    id,
    organizationId,
  ]);
  await db.query(
    'insert into public.user_role_assignments (organization_id, user_id, role_id, data_scope, scope_branch_id) values ($1, $2, $3, $4, $5)',
    [organizationId, id, roleId, scope, branch],
  );
}

async function overview(user: string) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user, role: 'authenticated' }),
  ]);
  const result = await db.query<{ result: Overview }>(
    'select public.get_admin_overview() as result',
  );
  return result.rows[0].result;
}

describe('get_admin_overview', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(fixture);
    await db.exec(source('supabase/migrations/202610210009_admin_overview.sql'));
  }, 30_000);

  beforeEach(async () => {
    await db.exec('begin');
    await db.query(
      `insert into public.branches (id, organization_id, name) values
         ($1, $4, 'MG Road'), ($2, $4, 'Whitefield'), ($3, $5, 'Elsewhere')`,
      [branchA, branchB, otherBranch, org, otherOrg],
    );
    const manage = await db.query<{ id: string }>(
      "insert into public.permissions (permission_key) values ('user.manage') returning id",
    );
    const clientAdmin = await role(org, 'client_admin', 'Client Admin', 850);
    const systemAdmin = await role(org, 'system_administrator', 'System Administrator', 800);
    for (const id of [clientAdmin, systemAdmin])
      await db.query('insert into public.role_permissions values ($1, $2)', [
        id,
        manage.rows[0].id,
      ]);
    const consultant = await role(org, 'sales_consultant', 'Sales Consultant', 300);
    const finance = await role(org, 'finance', 'Finance Manager', 400);
    await person(orgAdmin, clientAdmin, 'ORGANIZATION', null);
    await person(branchAdmin, systemAdmin, 'ONE_BRANCH', branchA);
    await person(randomUUID(), consultant, 'ONE_BRANCH', branchA);
    await person(randomUUID(), consultant, 'ONE_BRANCH', branchB);
    await person(randomUUID(), finance, 'ONE_BRANCH', branchB);
    // Another tenant's user and connection must never be counted.
    const foreign = await role(otherOrg, 'sales_consultant', 'Sales Consultant', 300);
    await person(randomUUID(), foreign, 'ONE_BRANCH', otherBranch, otherOrg);
    await db.query(
      `insert into public.connected_accounts (organization_id, status, last_error_code) values
         ($1, 'CONNECTED', null), ($1, 'CONNECTED', 'TOKEN_EXPIRED'), ($2, 'CONNECTED', null)`,
      [org, otherOrg],
    );
  });

  afterEach(async () => {
    await db.exec('rollback');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('gives an organization-wide admin the whole tenant and its integrations', async () => {
    const result = await overview(orgAdmin);
    expect(result.organization_wide).toBe(true);
    expect(result.kpis).toMatchObject({
      branches: 2,
      users: 5,
      sales_users: 2,
      operational_users: 1,
      integrations_connected: 2,
      integration_issues: 1,
    });
    expect(result.roles).toContainEqual({ name: 'Sales Consultant', value: 2 });
    // Busiest branch first; a tie falls back to the branch name.
    expect(result.branches).toEqual([
      { name: 'MG Road', value: 2 },
      { name: 'Whitefield', value: 2 },
    ]);
  });

  it('limits a branch-scoped admin to their branch and hides tenant integrations', async () => {
    const result = await overview(branchAdmin);
    expect(result.organization_wide).toBe(false);
    expect(result.kpis).toMatchObject({
      branches: 1,
      users: 2,
      sales_users: 1,
      operational_users: 0,
      integrations_connected: 0,
    });
    expect(result.branches).toEqual([{ name: 'MG Road', value: 2 }]);
  });

  it('refuses a user who does not hold a user.manage admin assignment', async () => {
    await expect(overview(randomUUID())).rejects.toThrow('TENANT_USER_ADMINISTRATION_REQUIRED');
  });
});
