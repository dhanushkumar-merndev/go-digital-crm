import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// CREATE INDEX CONCURRENTLY cannot run inside the implicit transaction PGlite
// wraps a multi-statement script in; the index itself is not under test.
const source = (name: string) =>
  readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8').replaceAll(
    'index concurrently',
    'index',
  );
const org = randomUUID();
const otherOrg = randomUUID();
const customer = randomUUID();
const hiddenBranch = randomUUID();
const branch = randomUUID();
const user = randomUUID();
let db: PGlite;

type Result = {
  departments: string[];
  cases: Array<{ department: string; status: string; booking_number: string | null }>;
};

// The policy helpers are stubs driven by session settings: test.desks lists the
// desks the caller may view, test.hidden_branch a branch outside their scope.
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
  select $2 = 'customer.view' and coalesce(current_setting('test.customer_view', true), 'on') = 'on'
$$;
create function app_private.operational_case_permission(uuid, text, text) returns boolean
language sql stable as $$
  select $2 = any(string_to_array(coalesce(current_setting('test.desks', true), ''), ','))
$$;
create function app_private.can_access_customer(uuid, uuid) returns boolean language sql stable as $$
  select true
$$;
create function app_private.can_access_record(uuid, uuid, uuid, uuid) returns boolean
language sql stable as $$
  select $2::text <> coalesce(current_setting('test.hidden_branch', true), '')
$$;
create table public.bookings (
  id uuid primary key, organization_id uuid not null, booking_number text not null,
  deleted_at timestamptz
);
${['finance', 'insurance', 'rto', 'exchange', 'delivery']
  .map(
    (desk) => `create table public.${desk}_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  customer_id uuid not null,
  booking_id uuid,
  assigned_user_id uuid,
  status text not null,
  priority text not null default 'NORMAL',
  due_at timestamptz,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);`,
  )
  .join('\n')}
`;

async function as(desks: string[], options: { customerView?: boolean } = {}) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user, role: 'authenticated' }),
  ]);
  await db.query("select set_config('test.org', $1, true)", [org]);
  await db.query("select set_config('test.desks', $1, true)", [desks.join(',')]);
  await db.query("select set_config('test.hidden_branch', $1, true)", [hiddenBranch]);
  await db.query("select set_config('test.customer_view', $1, true)", [
    options.customerView === false ? 'off' : 'on',
  ]);
}

async function read(customerId = customer) {
  const result = await db.query<{ result: Result }>(
    'select public.get_customer_operational_cases($1) as result',
    [customerId],
  );
  return result.rows[0].result;
}

async function deskCase(desk: string, status: string, values: Record<string, unknown> = {}) {
  await db.query(
    `insert into public.${desk}_cases (organization_id, branch_id, customer_id, booking_id, status, deleted_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      values.organization ?? org,
      values.branch ?? branch,
      values.customer ?? customer,
      values.booking ?? null,
      status,
      values.deleted ? new Date().toISOString() : null,
    ],
  );
}

describe('get_customer_operational_cases', () => {
  const booking = randomUUID();

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(fixture);
    await db.exec(source('supabase/migrations/202610210011_customer_operational_cases.sql'));
  }, 30_000);

  beforeEach(async () => {
    await db.exec('begin');
    await db.query("insert into public.bookings values ($1, $2, 'BK-1042')", [booking, org]);
    await deskCase('finance', 'APPROVED', { booking });
    await deskCase('rto', 'SUBMITTED', { booking });
    await deskCase('delivery', 'PLANNING', { booking });
    // Excluded: soft deleted, another customer, another tenant, out-of-scope branch.
    await deskCase('finance', 'NEW', { deleted: true });
    await deskCase('finance', 'NEW', { customer: randomUUID() });
    await deskCase('finance', 'NEW', { organization: otherOrg });
    await deskCase('insurance', 'QUOTE_PENDING', { branch: hiddenBranch });
  });

  afterEach(async () => {
    await db.exec('rollback');
  });

  afterAll(async () => {
    await db?.close();
  });

  it("returns only the desks the caller may view, in this customer's scope", async () => {
    await as(['FINANCE', 'INSURANCE', 'RTO']);
    const result = await read();
    expect(result.departments).toEqual(['FINANCE', 'INSURANCE', 'RTO']);
    expect(
      result.cases.map((row) => [row.department, row.status, row.booking_number]).sort(),
    ).toEqual([
      ['FINANCE', 'APPROVED', 'BK-1042'],
      ['RTO', 'SUBMITTED', 'BK-1042'],
    ]);
  });

  it('gives a user without any desk permission nothing', async () => {
    await as([]);
    expect(await read()).toEqual({ departments: [], cases: [] });
  });

  it('refuses a caller without customer access', async () => {
    await as(['FINANCE'], { customerView: false });
    await expect(read()).rejects.toThrow('CUSTOMER_VIEW_PERMISSION_REQUIRED');
  });
});
