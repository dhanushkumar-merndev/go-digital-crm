import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
const customer = randomUUID();
const booking = randomUUID();
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

describe('accessories management contract', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(`
      create table if not exists public.bookings (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        customer_id uuid not null references public.customers(id),
        booking_number text not null default 'BK-001'
      );
    `);
    await db.exec(source('supabase/migrations/202609060012_accessories_management.sql'));

    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into customers(id,organization_id,full_name) values($1,$2,$3)', [
      customer,
      org,
      'Test Customer',
    ]);
    await db.query('insert into bookings(id,organization_id,customer_id) values($1,$2,$3)', [
      booking,
      org,
      customer,
    ]);
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

  it('creates and updates catalog accessories with category and stock counts', async () => {
    const created = await rpc<{
      id: string;
      name: string;
      part_number: string;
      stock_quantity: number;
    }>('upsert_accessory', [null, '7D Floor Mats', 'ACC-MAT-7D', 'INTERIOR', 2500, 15, true, true]);

    expect(created.id).toBeDefined();
    expect(created.name).toBe('7D Floor Mats');
    expect(created.part_number).toBe('ACC-MAT-7D');
    expect(created.stock_quantity).toBe(15);

    const catalog = await rpc<{
      records: Array<{ name: string }>;
      total: number;
      kpis: { total_items: number };
    }>('get_accessories_catalog', ['INTERIOR', null, 1, 25]);

    expect(catalog.total).toBe(1);
    expect(catalog.records[0].name).toBe('7D Floor Mats');
    expect(catalog.kpis.total_items).toBe(1);
  });

  it('links an accessory to a customer booking and updates fitment status to FITTED', async () => {
    const acc = await rpc<{ id: string }>('upsert_accessory', [
      null,
      'Reverse Camera Kit',
      'ACC-CAM-01',
      'ELECTRICAL',
      4200,
      8,
      true,
      true,
    ]);

    const lineItem = await rpc<{ id: string; status: string; quantity: number }>(
      'add_booking_accessory',
      [booking, acc.id, 1, 4200],
    );

    expect(lineItem.id).toBeDefined();
    expect(lineItem.status).toBe('ORDERED');

    const updated = await rpc<{ id: string; status: string; fitted_at: string | null }>(
      'set_booking_accessory_status',
      [lineItem.id, 'FITTED'],
    );

    expect(updated.status).toBe('FITTED');
    expect(updated.fitted_at).not.toBeNull();

    const bookingAccessories = await rpc<Array<{ status: string; name: string }>>(
      'get_booking_accessories',
      [booking],
    );
    expect(bookingAccessories).toHaveLength(1);
    expect(bookingAccessories[0].status).toBe('FITTED');
    expect(bookingAccessories[0].name).toBe('Reverse Camera Kit');
  });
});
