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
create function app_private.operational_case_permission(uuid, text, text)
returns boolean language sql stable as $$
  select coalesce(current_setting('test.permission', true), '') = $2
$$;
create function app_private.operational_case_actor_scope(uuid, text)
returns table (
  actor_id uuid, full_branch_ids uuid[], own_record_branch_ids uuid[], all_customers boolean,
  customer_branch_ids uuid[], customer_own_record_branch_ids uuid[],
  customer_own_records boolean, customer_own_team boolean, customer_team_ids uuid[]
) language sql stable as $$
  select auth.uid(), string_to_array(current_setting('test.branches', true), ',')::uuid[],
    '{}'::uuid[], false, '{}'::uuid[], '{}'::uuid[], false, false, '{}'::uuid[]
$$;
create function app_private.operational_case_terminal(target_department text, target_status text)
returns boolean language sql immutable as $$
  select case upper(coalesce(target_department, ''))
    when 'FINANCE' then upper(target_status) in ('DISBURSED', 'REJECTED', 'CANCELLED')
    when 'INSURANCE' then upper(target_status) in ('POLICY_ISSUED', 'CANCELLED')
    when 'RTO' then upper(target_status) in ('REGISTERED', 'CANCELLED')
    when 'EXCHANGE' then upper(target_status) in ('ACCEPTED', 'REJECTED', 'CANCELLED')
    when 'DELIVERY' then upper(target_status) in ('DELIVERED', 'CANCELLED')
    else false
  end
$$;
${['finance', 'insurance', 'rto', 'exchange', 'delivery']
  .map(
    (desk) => `create table public.${desk}_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  assigned_user_id uuid,
  status text not null,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);`,
  )
  .join('\n')}
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
    options.permission ?? 'FINANCE',
  ]);
  await db.query("select set_config('test.branches', $1, true)", [
    (options.branches ?? [branch]).join(','),
  ]);
}

async function performance(department: string, from: string, to: string) {
  const result = await db.query<{ result: Performance }>(
    "select public.get_operational_case_performance($1, $2::date, $3::date, 'UTC') as result",
    [department, from, to],
  );
  return result.rows[0].result;
}

async function financeCase(values: {
  owner?: string;
  status: string;
  branchId?: string;
  organizationId?: string;
  createdAt?: string;
  updatedAt?: string;
  dueAt?: string | null;
  deleted?: boolean;
}) {
  await db.query(
    `insert into public.finance_cases
       (organization_id, branch_id, assigned_user_id, status, due_at, created_at, updated_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      values.organizationId ?? org,
      values.branchId ?? branch,
      values.owner ?? actor,
      values.status,
      values.dueAt ?? null,
      values.createdAt ?? '2026-10-10T08:00:00Z',
      values.updatedAt ?? '2026-10-10T08:00:00Z',
      values.deleted ? '2026-10-11T00:00:00Z' : null,
    ],
  );
}

describe('get_operational_case_performance', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(fixture);
    await db.exec(source('supabase/migrations/202610181900_operational_case_performance.sql'));
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
    await financeCase({ status: 'DOCUMENTS_PENDING', dueAt: '2026-10-01T00:00:00Z' });
    await financeCase({ status: 'UNDER_REVIEW' });
    await financeCase({
      status: 'DISBURSED',
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-12T00:00:00Z',
    });
    await financeCase({ status: 'CANCELLED', updatedAt: '2026-10-12T00:00:00Z' });
    // Excluded: a colleague's case, another branch, another tenant, soft deleted.
    await financeCase({ owner: colleague, status: 'UNDER_REVIEW' });
    await financeCase({ branchId: otherBranch, status: 'UNDER_REVIEW' });
    await financeCase({ organizationId: otherOrg, status: 'UNDER_REVIEW' });
    await financeCase({ status: 'UNDER_REVIEW', deleted: true });

    await as(actor);
    const result = await performance('FINANCE', '2026-10-01', '2026-10-31');
    expect(result.department).toBe('FINANCE');
    expect(result.kpis).toMatchObject({ open: 2, overdue: 1, handled: 4, completed: 1 });
    // A cancelled case is closed but is not completed work.
    expect(Number(result.kpis.avg_close_hours)).toBe(48);
    expect(result.daily).toHaveLength(31);
    expect(result.daily.find((day) => day.day === '2026-10-12')).toMatchObject({
      handled: 2,
      completed: 1,
    });
    expect(result.daily.find((day) => day.day === '2026-10-05')).toMatchObject({
      handled: 0,
      completed: 0,
    });
  });

  it('reads the requested desk only', async () => {
    await financeCase({ status: 'UNDER_REVIEW' });
    await db.query(
      `insert into public.delivery_cases (organization_id, branch_id, assigned_user_id, status)
       values ($1, $2, $3, 'READY')`,
      [org, branch, actor],
    );
    await as(actor, { permission: 'DELIVERY' });
    const result = await performance('DELIVERY', '2026-10-01', '2026-10-31');
    expect(result.kpis.open).toBe(1);
  });

  it('refuses a caller without the desk permission or without a tenant', async () => {
    await as(actor, { permission: 'INSURANCE' });
    await expect(performance('FINANCE', '2026-10-01', '2026-10-31')).rejects.toThrow(
      'OPERATIONAL_CASE_VIEW_PERMISSION_REQUIRED',
    );
    await db.exec('rollback; begin');
    await as(actor, { organization: '' });
    await expect(performance('FINANCE', '2026-10-01', '2026-10-31')).rejects.toThrow(
      'OPERATIONAL_CASE_VIEW_PERMISSION_REQUIRED',
    );
  });

  it('rejects unknown desks, reversed ranges and ranges wider than 366 days', async () => {
    await as(actor);
    for (const [department, from, to] of [
      ['SALES', '2026-10-01', '2026-10-31'],
      ['FINANCE', '2026-10-31', '2026-10-01'],
      ['FINANCE', '2025-01-01', '2026-10-31'],
    ]) {
      await expect(performance(department, from, to)).rejects.toThrow(
        'INVALID_OPERATIONAL_PERFORMANCE_QUERY',
      );
      await db.exec('rollback; begin');
      await as(actor);
    }
  });

  it('answers a full-year range with one row per day', async () => {
    await financeCase({ status: 'DISBURSED', updatedAt: '2026-03-15T10:00:00Z' });
    await as(actor);
    const result = await performance('FINANCE', '2025-10-31', '2026-10-31');
    expect(result.daily).toHaveLength(366);
    expect(result.kpis.completed).toBe(1);
  });
});
