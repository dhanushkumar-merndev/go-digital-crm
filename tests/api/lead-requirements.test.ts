import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION = 'supabase/migrations/202610090451_customer_profile_requirements.sql';
const org = randomUUID();
const otherOrg = randomUUID();
const actor = randomUUID();
const customer = randomUUID();
const otherCustomer = randomUUID();
const lead = randomUUID();
const vehicle = randomUUID();
const foreignVehicle = randomUUID();
let db: PGlite;

/** The lead-requirements slice of the migration; the rest patches live functions. */
function requirementsSlice() {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('-- --- 3. Lead requirements');
  const end = sql.indexOf('-- --- 4. Patch the live functions');
  if (start < 0 || end < 0) throw new Error('migration markers moved');
  return sql.slice(start, end);
}

async function save(
  payload: Record<string, unknown>,
  expectedVersion: number | null,
  request = randomUUID(),
) {
  const result = await db.query<{
    result: { lead_id: string; version: number; replayed: boolean };
  }>('select public.update_lead_requirements($1,$2,$3::jsonb,$4) as result', [
    lead,
    expectedVersion,
    JSON.stringify(payload),
    request,
  ]);
  return result.rows[0].result;
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('expected the call to fail');
}

describe('update_lead_requirements', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema app_private;
      create function auth.uid() returns uuid language sql as
        $$select nullif(current_setting('request.test_uid', true), '')::uuid$$;
      create function app_private.has_permission(uuid, text) returns boolean language sql as
        $$select current_setting('request.test_permitted', true) = 'true'$$;
      create function app_private.can_access_record(uuid, uuid, uuid, uuid) returns boolean language sql as
        $$select current_setting('request.test_in_scope', true) = 'true'$$;
      create function app_private.can_access_lead(uuid) returns boolean language sql as $$select true$$;
      create table organizations(id uuid primary key);
      create table profiles(id uuid primary key);
      create table customer_vehicles(id uuid primary key, organization_id uuid, customer_id uuid);
      create table leads(id uuid primary key, organization_id uuid, branch_id uuid, team_id uuid,
        customer_id uuid, assigned_user_id uuid, deleted_at timestamptz);
      create table activities(organization_id uuid, customer_id uuid, lead_id uuid, activity_type text,
        actor_id uuid, metadata jsonb);
      create table audit_logs(organization_id uuid, actor_id uuid, action text, resource_type text,
        resource_id text, branch_id uuid, request_id uuid, metadata jsonb);
    `);
    await db.exec(`set search_path = public, pg_catalog; ${requirementsSlice()}`);
    await db.query('insert into organizations(id) values ($1), ($2)', [org, otherOrg]);
    await db.query('insert into profiles(id) values ($1)', [actor]);
    await db.query(
      'insert into customer_vehicles(id, organization_id, customer_id) values ($1,$2,$3), ($4,$2,$5)',
      [vehicle, org, customer, foreignVehicle, otherCustomer],
    );
    await db.query(
      'insert into leads(id, organization_id, branch_id, customer_id, assigned_user_id) values ($1,$2,$3,$4,$5)',
      [lead, org, randomUUID(), customer, actor],
    );
  });

  beforeEach(async () => {
    await db.exec(`
      select set_config('request.test_uid', '${actor}', false);
      select set_config('request.test_permitted', 'true', false);
      select set_config('request.test_in_scope', 'true', false);
      delete from lead_requirements; delete from audit_logs; delete from activities;
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  it('creates requirements, then bumps the version on each save', async () => {
    const first = await save(
      {
        variant: 'Creative S DCA',
        budget_min: 1800000,
        budget_max: 2000000,
        competitors: ['Kia Seltos', ' '],
      },
      null,
    );
    expect(first).toMatchObject({ version: 1, replayed: false });
    const second = await save({ variant: 'Accomplished S DCA' }, 1);
    expect(second.version).toBe(2);
    const row = await db.query<{
      variant: string;
      competitors: string[];
      budget_min: string | null;
    }>('select variant, competitors, budget_min from lead_requirements where lead_id = $1', [lead]);
    // A save replaces the whole record; blank competitor entries are dropped.
    expect(row.rows[0]).toMatchObject({
      variant: 'Accomplished S DCA',
      competitors: [],
      budget_min: null,
    });
    const activity = await db.query('select 1 from activities where activity_type = $1', [
      'LEAD_REQUIREMENTS_UPDATED',
    ]);
    expect(activity.rows).toHaveLength(2);
  });

  it('replays an idempotent request without writing again', async () => {
    const request = randomUUID();
    await save({ fuel_type: 'Petrol' }, null, request);
    const replay = await save({ fuel_type: 'Diesel' }, null, request);
    expect(replay).toMatchObject({ version: 1, replayed: true });
    const row = await db.query<{ fuel_type: string }>('select fuel_type from lead_requirements');
    expect(row.rows[0].fuel_type).toBe('Petrol');
  });

  it('rejects a stale version with PT409, never 40001', async () => {
    await save({ fuel_type: 'Petrol' }, null);
    const stale = await errorOf(save({ fuel_type: 'Diesel' }, 7));
    expect(stale.code).toBe('PT409');
    const createOverExisting = await errorOf(save({ fuel_type: 'Diesel' }, null));
    expect(createOverExisting.code).toBe('PT409');
  });

  it('denies a caller without lead.update or outside the record scope', async () => {
    await db.exec(`select set_config('request.test_permitted', 'false', false)`);
    expect((await errorOf(save({}, null))).message).toBe('PERMISSION_DENIED');
    await db.exec(`select set_config('request.test_permitted', 'true', false)`);
    await db.exec(`select set_config('request.test_in_scope', 'false', false)`);
    expect((await errorOf(save({}, null))).message).toBe('PERMISSION_DENIED');
  });

  it('requires authentication', async () => {
    await db.exec(`select set_config('request.test_uid', '', false)`);
    expect((await errorOf(save({}, null))).message).toBe('AUTHENTICATION_REQUIRED');
  });

  it("only accepts an exchange vehicle owned by the lead's customer", async () => {
    const denied = await errorOf(save({ exchange_vehicle_id: foreignVehicle }, null));
    expect(denied.message).toBe('EXCHANGE_VEHICLE_SCOPE_DENIED');
    const saved = await save({ exchange_vehicle_id: vehicle, exchange_required: true }, null);
    expect(saved.version).toBe(1);
  });

  it('rejects an inverted budget range at the table constraint', async () => {
    const inverted = await errorOf(save({ budget_min: 2000000, budget_max: 1000000 }, null));
    expect(inverted.code).toBe('23514');
  });
});
