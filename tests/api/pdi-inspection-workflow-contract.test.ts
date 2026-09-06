import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
const branch = randomUUID();
const customer = randomUUID();
const booking = randomUUID();
const delivery = randomUUID();
let db: PGlite;

async function claims(user: string, role = 'authenticated') {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, role, aal: 'aal2' }),
  ]);
}

async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
  const result = await db.query<{ result: T }>(
    `select public.${name}(${values.map((_, index) => `$${index + 1}`).join(',')}) as result`,
    values,
  );
  return result.rows[0].result;
}

describe('pdi inspection workflow contract', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(`
      create table if not exists public.bookings (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        customer_id uuid not null references public.customers(id)
      );
      create table if not exists public.delivery_cases (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        branch_id uuid not null references public.branches(id),
        booking_id uuid not null references public.bookings(id),
        customer_id uuid not null references public.customers(id),
        status text not null default 'PLANNING'
      );
    `);
    await db.exec(source('supabase/migrations/202609060013_pdi_inspection_workflow.sql'));

    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    await db.query('insert into customers(id,organization_id,full_name) values($1,$2,$3)', [
      customer,
      org,
      'PDI Customer',
    ]);
    await db.query('insert into bookings(id,organization_id,customer_id) values($1,$2,$3)', [
      booking,
      org,
      customer,
    ]);
    await db.query(
      'insert into delivery_cases(id,organization_id,branch_id,booking_id,customer_id) values($1,$2,$3,$4,$5)',
      [delivery, org, branch, booking, customer],
    );
  }, 30_000);

  beforeEach(async () => {
    await db.exec('begin');
    await claims(actor);
  });

  afterEach(async () => {
    await db.exec('rollback; reset role');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('automatically seeds standard multi-point inspection points for a delivery case', async () => {
    const res = await rpc<{
      inspection: { id: string; status: string };
      items: Array<{ id: string; category: string; item_name: string; status: string }>;
      stats: { total_items: number; pending: number };
    }>('get_or_create_pdi_inspection', [delivery]);

    expect(res.inspection.id).toBeDefined();
    expect(res.inspection.status).toBe('IN_PROGRESS');
    expect(res.stats.total_items).toBe(21);
    expect(res.stats.pending).toBe(21);
    expect(res.items.some((i) => i.category === 'EXTERIOR')).toBe(true);
    expect(res.items.some((i) => i.category === 'MECHANICAL')).toBe(true);
    expect(res.items.some((i) => i.category === 'ELECTRICAL')).toBe(true);
  });

  it('detects defects, updates status to DEFECTS_FOUND, and blocks sign-off until rectified', async () => {
    const res = await rpc<{
      inspection: { id: string };
      items: Array<{ id: string; status: string }>;
    }>('get_or_create_pdi_inspection', [delivery]);

    const firstItem = res.items[0];

    // Mark defect
    const updateResult = await rpc<{ inspection_status: string }>('update_pdi_item_result', [
      firstItem.id,
      'FAILED',
      'Minor scratch on rear bumper near left reflector',
      null,
    ]);

    expect(updateResult.inspection_status).toBe('DEFECTS_FOUND');

    // Attempting to complete with defects must raise 23514
    await db.exec('savepoint err_test');
    await expect(
      rpc('complete_pdi_inspection', [res.inspection.id, 'Passed with defects']),
    ).rejects.toThrow();
    await db.exec('rollback to savepoint err_test');

    // Mark defect rectified
    await rpc('update_pdi_item_result', [
      firstItem.id,
      'RECTIFIED',
      'Bumper buffed and polished',
      null,
    ]);

    // Pass remaining 20 items
    for (let i = 1; i < res.items.length; i++) {
      await rpc('update_pdi_item_result', [res.items[i].id, 'PASSED', null, null]);
    }

    // Now sign-off succeeds
    const completed = await rpc<{ status: string; completed_at: string }>(
      'complete_pdi_inspection',
      [res.inspection.id, 'All 21 points verified and certified'],
    );

    expect(completed.status).toBe('PASSED');
    expect(completed.completed_at).toBeDefined();
  });
});
