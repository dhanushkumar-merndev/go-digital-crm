import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const otherOrg = randomUUID();
const actor = randomUUID();
const colleague = randomUUID();
const branch = randomUUID();
const otherBranch = randomUUID();
let db: PGlite;

type Performance = {
  department: string;
  kpis: {
    open: number;
    overdue: number;
    due_today: number;
    handled: number;
    completed: number;
    avg_close_hours: number | null;
  };
  daily: Array<{ day: string; handled: number; completed: number }>;
};

// The scope helpers are exercised by their own tests; here they are stubs
// driven by session settings, so each test can grant or withhold access.
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
create function app_private.has_permission(uuid, text) returns boolean language sql stable as $$
  select coalesce(current_setting('test.permission', true), '') = $2
$$;
create function app_private.customer_care_actor_scope(uuid, text)
returns table (
  actor_id uuid, organization_wide boolean, branch_ids uuid[], own_records boolean,
  own_record_branch_ids uuid[], own_team boolean, team_ids uuid[]
) language sql stable as $$
  select auth.uid(), false, string_to_array(current_setting('test.branches', true), ',')::uuid[],
    false, '{}'::uuid[], false, '{}'::uuid[]
$$;
create table public.customer_care_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  assigned_user_id uuid,
  status text not null,
  sla_due_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
`;

async function as(
  user: string,
  options: { permission?: string; organization?: string; branches?: string[] } = {},
) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user, role: 'authenticated' }),
  ]);
  await db.query("select set_config('test.org', $1, true)", [options.organization ?? org]);
  await db.query("select set_config('test.permission', $1, true)", [
    options.permission ?? 'customer_care.view',
  ]);
  await db.query("select set_config('test.branches', $1, true)", [
    (options.branches ?? [branch]).join(','),
  ]);
}

async function performance(from: string, to: string) {
  const result = await db.query<{ result: Performance }>(
    "select public.get_customer_care_performance($1::date, $2::date, 'UTC') as result",
    [from, to],
  );
  return result.rows[0].result;
}

async function careCase(values: {
  owner?: string;
  status: string;
  branchId?: string;
  organizationId?: string;
  createdAt?: string;
  updatedAt?: string;
  resolvedAt?: string | null;
  slaDueAt?: string;
  deleted?: boolean;
}) {
  await db.query(
    `insert into public.customer_care_cases
       (organization_id, branch_id, assigned_user_id, status, sla_due_at, resolved_at,
        created_at, updated_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      values.organizationId ?? org,
      values.branchId ?? branch,
      values.owner ?? actor,
      values.status,
      values.slaDueAt ?? '2099-01-01T00:00:00Z',
      values.resolvedAt ?? null,
      values.createdAt ?? '2026-10-10T08:00:00Z',
      values.updatedAt ?? '2026-10-10T08:00:00Z',
      values.deleted ? '2026-10-11T00:00:00Z' : null,
    ],
  );
}

describe('get_customer_care_performance', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(fixture);
    await db.exec(source('supabase/migrations/202610210007_customer_care_performance.sql'));
  }, 30_000);

  beforeEach(async () => {
    await db.exec('begin');
  });

  afterEach(async () => {
    await db.exec('rollback');
  });

  afterAll(async () => {
    await db?.close();
  });

  it("counts only the caller's own live cases in their authorized branches", async () => {
    await careCase({ status: 'IN_PROGRESS', slaDueAt: '2026-10-01T00:00:00Z' });
    await careCase({ status: 'NEW' });
    await careCase({
      status: 'RESOLVED',
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-12T00:00:00Z',
      resolvedAt: '2026-10-12T00:00:00Z',
    });
    // Excluded: a colleague's case, another branch, another tenant, soft deleted.
    await careCase({ owner: colleague, status: 'NEW' });
    await careCase({ branchId: otherBranch, status: 'NEW' });
    await careCase({ organizationId: otherOrg, status: 'NEW' });
    await careCase({ status: 'NEW', deleted: true });

    await as(actor);
    const result = await performance('2026-10-01', '2026-10-31');
    expect(result.department).toBe('CUSTOMER_CARE');
    expect(result.kpis).toMatchObject({ open: 2, overdue: 1, handled: 3, completed: 1 });
    expect(Number(result.kpis.avg_close_hours)).toBe(48);
    expect(result.daily).toHaveLength(31);
    expect(result.daily.find((day) => day.day === '2026-10-12')).toMatchObject({
      handled: 1,
      completed: 1,
    });
  });

  it('refuses a caller without customer-care access or without a tenant', async () => {
    await as(actor, { permission: 'lead.view' });
    await expect(performance('2026-10-01', '2026-10-31')).rejects.toThrow(
      'CUSTOMER_CARE_VIEW_PERMISSION_REQUIRED',
    );
    await db.exec('rollback; begin');
    await as(actor, { organization: '' });
    await expect(performance('2026-10-01', '2026-10-31')).rejects.toThrow(
      'CUSTOMER_CARE_VIEW_PERMISSION_REQUIRED',
    );
  });

  it('rejects an inverted or over-wide range instead of scanning it', async () => {
    await as(actor);
    await expect(performance('2026-10-31', '2026-10-01')).rejects.toThrow(
      'INVALID_CUSTOMER_CARE_PERFORMANCE_QUERY',
    );
    await db.exec('rollback; begin');
    await as(actor);
    await expect(performance('2024-01-01', '2026-10-31')).rejects.toThrow(
      'INVALID_CUSTOMER_CARE_PERFORMANCE_QUERY',
    );
  });
});
