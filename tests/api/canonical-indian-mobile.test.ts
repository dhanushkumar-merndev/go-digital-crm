import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create schema app_private;
    create table public.leads(id serial primary key, normalized_phone text);
    create table public.customers(id serial primary key, normalized_phone text);
    insert into public.leads(normalized_phone) values ('8593939234'), ('+918593939234');
    insert into public.customers(normalized_phone) values ('08593939234'), ('918593939234');
  `);
  await db.exec(
    readFileSync('supabase/migrations/202610090301_canonical_indian_mobile.sql', 'utf8'),
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});

const canonical = async (value: string | null) =>
  (
    await db.query<{ value: string | null }>(
      'select app_private.canonical_indian_mobile($1) as value',
      [value],
    )
  ).rows[0]!.value;

describe('canonical Indian mobile', () => {
  it('adds +91 only to a bare Indian mobile', async () => {
    expect(await canonical('8593939234')).toBe('+918593939234');
    expect(await canonical('08593939234')).toBe('+918593939234');
    expect(await canonical('+918593939234')).toBe('+918593939234');
    expect(await canonical('918593939234')).toBe('918593939234');
    expect(await canonical('+9876543210')).toBe('+9876543210');
    expect(await canonical('5593939234')).toBe('5593939234');
    expect(await canonical('4412345')).toBe('4412345');
    expect(await canonical(null)).toBeNull();
  });

  it('backfills bare rows so a repeat enquiry matches the known customer', async () => {
    const leads = await db.query<{ normalized_phone: string }>(
      'select normalized_phone from public.leads order by id',
    );
    expect(leads.rows.map((row) => row.normalized_phone)).toEqual([
      '+918593939234',
      '+918593939234',
    ]);
    const customers = await db.query<{ normalized_phone: string }>(
      'select normalized_phone from public.customers order by id',
    );
    expect(customers.rows.map((row) => row.normalized_phone)).toEqual([
      '+918593939234',
      '918593939234',
    ]);
  });

  it('canonicalises every later insert and phone edit', async () => {
    const inserted = await db.query<{ normalized_phone: string }>(
      "insert into public.leads(normalized_phone) values ('9876543210') returning normalized_phone",
    );
    expect(inserted.rows[0]!.normalized_phone).toBe('+919876543210');
    const updated = await db.query<{ normalized_phone: string }>(
      "update public.customers set normalized_phone = '7012345678' where id = 2 returning normalized_phone",
    );
    expect(updated.rows[0]!.normalized_phone).toBe('+917012345678');
  });
});
