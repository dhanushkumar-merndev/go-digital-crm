import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const otherOrg = randomUUID();
const actor = randomUUID();
const colleague = randomUUID();
let db: PGlite;

type Performance = {
  kpis: {
    allocations: number;
    active_allocations: number;
    movements: number;
    transfers: number;
    intakes: number;
  };
  daily: Array<{ day: string; allocations: number; movements: number }>;
};

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
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  movement_type text not null,
  moved_by uuid,
  moved_at timestamptz not null default now()
);
create table public.stock_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  status text not null default 'ACTIVE',
  allocated_by uuid,
  allocated_at timestamptz not null default now()
);
`;

async function as(user: string, options: { permission?: string; organization?: string } = {}) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user, role: 'authenticated' }),
  ]);
  await db.query("select set_config('test.org', $1, true)", [options.organization ?? org]);
  await db.query("select set_config('test.permission', $1, true)", [
    options.permission ?? 'inventory.view',
  ]);
}

async function performance(from: string, to: string) {
  const result = await db.query<{ result: Performance }>(
    "select public.get_inventory_performance($1::date, $2::date, 'UTC') as result",
    [from, to],
  );
  return result.rows[0].result;
}

async function movement(type: string, at: string, by = actor, organizationId = org) {
  await db.query(
    'insert into public.stock_movements (organization_id, movement_type, moved_by, moved_at) values ($1, $2, $3, $4)',
    [organizationId, type, by, at],
  );
}

async function allocation(status: string, at: string, by = actor, organizationId = org) {
  await db.query(
    'insert into public.stock_allocations (organization_id, status, allocated_by, allocated_at) values ($1, $2, $3, $4)',
    [organizationId, status, by, at],
  );
}

describe('get_inventory_performance', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(fixture);
    await db.exec(source('supabase/migrations/202610210008_inventory_performance.sql'));
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

  it("counts only the caller's own allocations and movements", async () => {
    await allocation('ACTIVE', '2026-10-12T09:00:00Z');
    await allocation('RELEASED', '2026-10-12T10:00:00Z');
    // Allocated before the range: still held, so it is active but not in range.
    await allocation('ALLOCATED', '2026-09-01T10:00:00Z');
    await movement('INTAKE', '2026-10-05T09:00:00Z');
    await movement('BRANCH_TRANSFER', '2026-10-12T11:00:00Z');
    await movement('STATUS_CHANGE', '2026-10-12T12:00:00Z');
    // Excluded: a colleague's work and another tenant's.
    await allocation('ACTIVE', '2026-10-12T09:00:00Z', colleague);
    await movement('INTAKE', '2026-10-12T09:00:00Z', colleague);
    await movement('INTAKE', '2026-10-12T09:00:00Z', actor, otherOrg);

    await as(actor);
    const result = await performance('2026-10-01', '2026-10-31');
    expect(result.kpis).toEqual({
      allocations: 2,
      active_allocations: 2,
      movements: 3,
      transfers: 1,
      intakes: 1,
    });
    expect(result.daily).toHaveLength(31);
    expect(result.daily.find((day) => day.day === '2026-10-12')).toEqual({
      day: '2026-10-12',
      allocations: 2,
      movements: 2,
    });
  });

  it('refuses a caller without inventory access and an over-wide range', async () => {
    await as(actor, { permission: 'lead.view' });
    await expect(performance('2026-10-01', '2026-10-31')).rejects.toThrow(
      'INVENTORY_VIEW_REQUIRED',
    );
    await db.exec('rollback; begin');
    await as(actor);
    await expect(performance('2024-01-01', '2026-10-31')).rejects.toThrow(
      'INVALID_INVENTORY_PERFORMANCE_QUERY',
    );
  });
});
