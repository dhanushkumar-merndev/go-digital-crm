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
const admin = randomUUID();
const owner = randomUUID();
const consultant = randomUUID();
let db: PGlite;

// Session helpers are stubs; save_quotation is a stand-in that keeps the real
// anchor line, so the migration patches it exactly as it patches the live one
// and the test can read the decision it makes.
const fixture = `
create role anon;
create role authenticated;
create schema auth;
create schema app_private;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;
create function app_private.current_tenant_organization() returns uuid language sql stable as $$
  select nullif(current_setting('test.org', true), '')::uuid
$$;
create function app_private.mfa_policy_satisfied(uuid) returns boolean language sql stable as $$ select true $$;
create function app_private.has_organization_wide_scope(uuid) returns boolean language sql stable as $$ select true $$;
create function app_private.has_permission(uuid, text) returns boolean language sql stable as $$
  select $2 = 'user.manage' and auth.uid() = nullif(current_setting('test.admin', true), '')::uuid
$$;
create table public.organizations (id uuid primary key);
create table public.profiles (id uuid primary key, organization_id uuid, full_name text not null default 'Admin');
create table public.branches (
  id uuid primary key, organization_id uuid not null, name text not null,
  active boolean not null default true, deleted_at timestamptz
);
create table public.roles (id uuid primary key default gen_random_uuid(), organization_id uuid, role_key text not null);
create table public.user_role_assignments (
  user_id uuid not null, organization_id uuid, role_id uuid not null,
  data_scope text not null, active boolean not null default true
);
create table public.audit_logs (
  id bigint generated always as identity primary key, organization_id uuid, actor_id uuid,
  action text not null, resource_type text not null, resource_id text, branch_id uuid,
  request_id uuid, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.leads (id uuid primary key, organization_id uuid not null, branch_id uuid not null);
create function public.save_quotation(
  target_quotation_id uuid, expected_version bigint, target_lead_id uuid, target_items jsonb,
  target_request_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  lead_row public.leads%rowtype;
  gross_amount numeric := (target_items->>'gross')::numeric;
  discount_amount numeric := (target_items->>'discount')::numeric;
  requires_approval boolean := false;
begin
  select * into lead_row from public.leads where id = target_lead_id;
  requires_approval := discount_amount > gross_amount * 0.10;
  return jsonb_build_object('approval_required', requires_approval);
end;
$$;
`;

async function as(user: string, organizationId = org) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user, role: 'authenticated' }),
  ]);
  await db.query("select set_config('test.org', $1, true)", [organizationId]);
  await db.query("select set_config('test.admin', $1, true)", [admin]);
}

async function save(values: {
  id?: string | null;
  version?: number;
  branch?: string | null;
  percent: number;
  active?: boolean;
}) {
  const result = await db.query<{ result: Record<string, unknown> }>(
    'select public.save_approval_rule($1, $2, $3, $4, $5, $6) as result',
    [
      values.id ?? null,
      values.version ?? null,
      values.branch ?? null,
      values.percent,
      values.active ?? true,
      randomUUID(),
    ],
  );
  return result.rows[0].result as { id: string; version: number; max_discount_percent: string };
}

async function needsApproval(lead: string, gross: number, discount: number) {
  const result = await db.query<{ result: { approval_required: boolean } }>(
    'select public.save_quotation(null, null, $1, $2::jsonb, $3) as result',
    [lead, JSON.stringify({ gross, discount }), randomUUID()],
  );
  return result.rows[0].result.approval_required;
}

describe('quotation approval rules', () => {
  const leadA = randomUUID();
  const leadB = randomUUID();

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(fixture);
    await db.exec(source('supabase/migrations/202610210010_quotation_approval_rules.sql'));
  }, 30_000);

  beforeEach(async () => {
    await db.exec('begin');
    await db.query('insert into public.organizations values ($1), ($2)', [org, otherOrg]);
    await db.query(
      `insert into public.branches (id, organization_id, name) values
         ($1, $4, 'MG Road'), ($2, $4, 'Whitefield'), ($3, $5, 'Elsewhere')`,
      [branchA, branchB, otherBranch, org, otherOrg],
    );
    await db.query('insert into public.profiles (id, organization_id) values ($1, $3), ($2, $3)', [
      admin,
      owner,
      org,
    ]);
    const roles = await db.query<{ id: string; role_key: string }>(
      `insert into public.roles (organization_id, role_key) values
         ($1, 'client_admin'), ($1, 'business_owner'), ($1, 'sales_consultant') returning id, role_key`,
      [org],
    );
    const roleId = (key: string) => roles.rows.find((row) => row.role_key === key)!.id;
    await db.query(
      `insert into public.user_role_assignments (user_id, organization_id, role_id, data_scope) values
         ($1, $4, $5, 'ORGANIZATION'), ($2, $4, $6, 'ORGANIZATION'), ($3, $4, $7, 'ONE_BRANCH')`,
      [
        admin,
        owner,
        consultant,
        org,
        roleId('client_admin'),
        roleId('business_owner'),
        roleId('sales_consultant'),
      ],
    );
    await db.query('insert into public.leads values ($1, $3, $4), ($2, $3, $5)', [
      leadA,
      leadB,
      org,
      branchA,
      branchB,
    ]);
  });

  afterEach(async () => {
    await db.exec('rollback');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('keeps the original 10% limit until a rule is saved', async () => {
    await as(consultant);
    expect(await needsApproval(leadA, 100_000, 10_000)).toBe(false);
    expect(await needsApproval(leadA, 100_000, 10_001)).toBe(true);
  });

  it('applies the organization rule, and a branch rule over it', async () => {
    await as(admin);
    await save({ percent: 5 });
    await save({ branch: branchB, percent: 15 });

    await as(consultant);
    expect(await needsApproval(leadA, 100_000, 6_000)).toBe(true);
    expect(await needsApproval(leadB, 100_000, 12_000)).toBe(false);
    expect(await needsApproval(leadB, 100_000, 16_000)).toBe(true);
  });

  it('versions every change and refuses a stale save', async () => {
    await as(admin);
    const created = await save({ branch: branchA, percent: 20 });
    const updated = await save({
      id: created.id,
      version: 1,
      branch: branchA,
      percent: 20,
      active: false,
    });
    expect(updated.version).toBe(2);
    await expect(
      save({ id: created.id, version: 1, branch: branchA, percent: 25 }),
    ).rejects.toThrow('APPROVAL_RULE_VERSION_CONFLICT');
  });

  it('falls back to the organization limit when a branch rule is switched off', async () => {
    await as(admin);
    await save({ percent: 5 });
    const branchRule = await save({ branch: branchA, percent: 20 });
    await save({ id: branchRule.id, version: 1, branch: branchA, percent: 20, active: false });
    await as(consultant);
    expect(await needsApproval(leadA, 100_000, 6_000)).toBe(true);
  });

  it('records an audit row per save', async () => {
    await as(admin);
    const created = await save({ percent: 8 });
    await save({ id: created.id, version: 1, percent: 9 });
    const audit = await db.query<{ action: string }>('select action from public.audit_logs');
    expect(audit.rows).toEqual([
      { action: 'approval_rule.saved' },
      { action: 'approval_rule.saved' },
    ]);

    await as(consultant);
    expect(await needsApproval(leadA, 100_000, 8_500)).toBe(false);
    expect(await needsApproval(leadA, 100_000, 9_500)).toBe(true);
  });

  it('lets the Business Owner read but only the Client Admin change rules', async () => {
    await as(owner);
    const read = await db.query<{ result: { can_manage: boolean; default_percent: number } }>(
      'select public.get_approval_rules() as result',
    );
    expect(read.rows[0].result).toMatchObject({ can_manage: false, default_percent: 10 });
    await expect(save({ percent: 3 })).rejects.toThrow('APPROVAL_RULES_MANAGE_REQUIRED');
  });

  it("refuses another tenant's branch and an out-of-range limit", async () => {
    await as(admin);
    await expect(save({ branch: otherBranch, percent: 5 })).rejects.toThrow(
      'APPROVAL_RULE_BRANCH_DENIED',
    );
    await db.exec('rollback; begin');
    await as(admin);
    await expect(save({ percent: 101 })).rejects.toThrow('INVALID_APPROVAL_RULE');
  });
});
