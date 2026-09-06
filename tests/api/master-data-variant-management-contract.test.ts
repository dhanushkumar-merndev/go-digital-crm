import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
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

describe('master data variant management contract', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(`
      create table if not exists public.vehicle_brands (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        name text not null,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        unique (organization_id, name)
      );
      create table if not exists public.vehicle_models (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        brand_id uuid not null references public.vehicle_brands(id),
        name text not null,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        unique (organization_id, brand_id, name)
      );
      create table if not exists public.vehicle_variants (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        model_id uuid not null references public.vehicle_models(id),
        name text not null,
        specifications jsonb not null default '{}'::jsonb,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        unique (organization_id, model_id, name)
      );
      create table if not exists public.lead_sources (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        name text not null,
        canonical_source text not null,
        active boolean not null default true,
        created_at timestamptz not null default now()
      );
    `);
    await db.exec(source('supabase/migrations/202609060015_master_data_variant_management.sql'));

    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
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

  it('creates vehicle models and variants and queries them in the master data workspace', async () => {
    // Seed brand
    const brandRow = await db.query<{ id: string }>(
      'insert into vehicle_brands(organization_id, name) values($1, $2) returning id',
      [org, 'Honda'],
    );
    const brandId = brandRow.rows[0].id;

    // Create model via RPC
    const model = await rpc<{ id: string; name: string }>('upsert_master_model', [
      null,
      brandId,
      'Elevate',
      true,
    ]);
    expect(model.id).toBeDefined();
    expect(model.name).toBe('Elevate');

    // Create variant via RPC
    const variant = await rpc<{ id: string; name: string }>('upsert_master_variant', [
      null,
      model.id,
      'ZX CVT',
      JSON.stringify({ fuel_type: 'PETROL', transmission: 'CVT' }),
      true,
    ]);
    expect(variant.id).toBeDefined();
    expect(variant.name).toBe('ZX CVT');

    // Query VARIANTS category
    const res = await rpc<{
      records: Array<{ name: string; model_name: string; brand_name: string }>;
      total: number;
      kpis: { variants: number };
    }>('get_master_data_workspace', ['VARIANTS', 1, 25, 'ZX']);

    expect(res.total).toBe(1);
    expect(res.records[0].name).toBe('ZX CVT');
    expect(res.records[0].model_name).toBe('Elevate');
    expect(res.records[0].brand_name).toBe('Honda');
    expect(res.kpis.variants).toBe(1);

    // Toggle variant active state
    await rpc('set_master_data_active', ['VARIANTS', variant.id, false]);

    const afterDeactivate = await rpc<{ records: Array<{ active: boolean }> }>(
      'get_master_data_workspace',
      ['VARIANTS', 1, 25, 'ZX'],
    );
    expect(afterDeactivate.records[0].active).toBe(false);
  });
});
