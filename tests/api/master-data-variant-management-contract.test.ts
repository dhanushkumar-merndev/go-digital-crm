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
    await db.exec(source('supabase/migrations/202609070101_vehicle_master_completion.sql'));

    // RLS is exercised as authenticated, not as the database owner. These are
    // only the reads needed by the minimal identity/permission fixture helpers.
    await db.exec('grant select on public.profiles, public.organizations to authenticated');

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

  it('creates, searches, edits and deactivates colours without changing saved stock snapshots', async () => {
    const colour = await rpc<{ id: string }>('save_vehicle_master', [
      'COLOURS',
      null,
      null,
      'Pearl White',
      '{}',
      true,
    ]);
    await db.exec(
      "create temporary table stock_snapshot(color text); insert into stock_snapshot values ('Pearl White')",
    );
    await rpc('save_vehicle_master', ['COLOURS', colour.id, null, 'Platinum White', '{}', true]);
    await rpc('set_master_data_active', ['COLOURS', colour.id, false]);
    const page = await rpc<{
      records: Array<{ name: string; active: boolean }>;
      total: number;
      kpis: { colours: number };
    }>('get_master_data_workspace', ['COLOURS', 1, 25, 'Platinum']);
    expect(page.records).toMatchObject([{ name: 'Platinum White', active: false }]);
    expect(page.total).toBe(1);
    expect(page.kpis.colours).toBe(1);
    expect((await db.query('select color from stock_snapshot')).rows).toEqual([
      { color: 'Pearl White' },
    ]);
    const audit = await db.query<{ metadata: { old: { name: string }; new: { name: string } } }>(
      "select metadata from audit_logs where action='master_data.saved' and metadata->'old' is not null and resource_id=$1 order by id desc limit 1",
      [colour.id],
    );
    expect(audit.rows[0].metadata.old.name).toBe('Pearl White');
    expect(audit.rows[0].metadata.new.name).toBe('Platinum White');
  });

  it('paginates colours on the server and searches beyond the first page', async () => {
    await db.query(
      "insert into vehicle_colours(organization_id,name) select $1, 'Colour ' || lpad(i::text,3,'0') from generate_series(1,60) i",
      [org],
    );
    const page = await rpc<{ records: Array<{ name: string }>; total: number }>(
      'get_master_data_workspace',
      ['COLOURS', 2, 25, ''],
    );
    expect(page.records).toHaveLength(25);
    expect(page.records[0].name).toBe('Colour 026');
    expect(page.total).toBe(60);
    const searched = await rpc<{ records: Array<{ name: string }> }>('get_master_data_workspace', [
      'COLOURS',
      1,
      25,
      '060',
    ]);
    expect(searched.records).toHaveLength(1);
  });

  it.each(['MODELS', 'VARIANTS'])(
    'rejects a %s parent from another dealership',
    async (category) => {
      const foreignOrg = randomUUID();
      await db.query('insert into organizations(id) values($1)', [foreignOrg]);
      const brand = (
        await db.query<{ id: string }>(
          "insert into vehicle_brands(organization_id,name) values($1,'Foreign') returning id",
          [foreignOrg],
        )
      ).rows[0].id;
      const model = (
        await db.query<{ id: string }>(
          "insert into vehicle_models(organization_id,brand_id,name) values($1,$2,'Foreign model') returning id",
          [foreignOrg, brand],
        )
      ).rows[0].id;
      if (category === 'MODELS') {
        await expect(
          rpc('upsert_master_model', [null, brand, 'Wrong tenant', true]),
        ).rejects.toThrow('MASTER_DATA_PARENT_NOT_FOUND');
      } else {
        await expect(
          rpc('upsert_master_variant', [null, model, 'Wrong tenant', '{}', true]),
        ).rejects.toThrow('MASTER_DATA_PARENT_NOT_FOUND');
      }
    },
  );

  it('returns not-found when editing a foreign record and leaves it unchanged', async () => {
    const foreignOrg = randomUUID();
    await db.query('insert into organizations(id) values($1)', [foreignOrg]);
    const id = (
      await db.query<{ id: string }>(
        "insert into vehicle_colours(organization_id,name) values($1,'Private colour') returning id",
        [foreignOrg],
      )
    ).rows[0].id;
    await expect(
      rpc('save_vehicle_master', ['COLOURS', id, null, 'Overwrite', '{}', true]),
    ).rejects.toThrow('MASTER_DATA_RECORD_NOT_FOUND');
  });

  it('does not let an ordinary role directly insert colours', async () => {
    await db.exec('set role authenticated');
    await expect(
      db.query("insert into vehicle_colours(organization_id,name) values($1,'Bypass')", [org]),
    ).rejects.toThrow(/permission denied/);
  });

  it('filters colour reads and RPC pages to the current dealership', async () => {
    const foreignOrg = randomUUID();
    await db.query('insert into organizations(id) values($1)', [foreignOrg]);
    await db.query(
      "insert into vehicle_colours(organization_id,name) values($1,'Ours'),($2,'Theirs')",
      [org, foreignOrg],
    );
    await db.exec('set role authenticated');
    expect((await db.query('select name from vehicle_colours')).rows).toEqual([{ name: 'Ours' }]);
    const page = await rpc<{ records: Array<{ name: string }> }>('get_master_data_workspace', [
      'COLOURS',
      1,
      25,
      '',
    ]);
    expect(page.records.map((row) => row.name)).toEqual(['Ours']);
  });

  it('denies an inactive user and anonymous execution', async () => {
    await db.query('update profiles set active=false where id=$1', [actor]);
    await expect(
      rpc('save_vehicle_master', ['BRANDS', null, null, 'Denied', '{}', true]),
    ).rejects.toThrow('MASTER_DATA_MANAGE_PERMISSION_REQUIRED');
  });

  it('revokes public execution of all vehicle-master writes', async () => {
    const result = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('anon','public.save_vehicle_master(text,uuid,uuid,text,jsonb,boolean)','EXECUTE') or has_function_privilege('anon','public.upsert_master_model(uuid,uuid,text,boolean)','EXECUTE') or has_function_privilege('anon','public.upsert_master_variant(uuid,uuid,text,jsonb,boolean)','EXECUTE') as allowed",
    );
    expect(result.rows[0].allowed).toBe(false);
  });

  it.each(['[]', 'null', '"text"'])('rejects non-object specifications %s', async (specs) => {
    await expect(
      rpc('save_vehicle_master', ['VARIANTS', null, randomUUID(), 'Invalid', specs, true]),
    ).rejects.toThrow('INVALID_MASTER_DATA');
  });

  it('rejects missing records rather than reporting a successful empty update', async () => {
    await expect(
      rpc('upsert_master_model', [randomUUID(), randomUUID(), 'Missing', true]),
    ).rejects.toThrow('MASTER_DATA_RECORD_NOT_FOUND');
  });

  it('rejects a null page size instead of returning the whole catalog', async () => {
    await expect(rpc('get_master_data_workspace', ['COLOURS', 1, null, ''])).rejects.toThrow(
      'INVALID_MASTER_DATA_QUERY',
    );
  });

  it('saves specification changes while preserving other supplied specification keys', async () => {
    const brand = await rpc<{ id: string }>('save_vehicle_master', [
      'BRANDS',
      null,
      null,
      'Honda',
      '{}',
      true,
    ]);
    const model = await rpc<{ id: string }>('upsert_master_model', [null, brand.id, 'City', true]);
    const variant = await rpc<{ id: string }>('upsert_master_variant', [
      null,
      model.id,
      'ZX',
      '{"fuel_type":"PETROL","custom_feature":"sunroof"}',
      true,
    ]);
    await rpc('upsert_master_variant', [
      variant.id,
      model.id,
      'ZX CVT',
      '{"fuel_type":"PETROL","custom_feature":"sunroof","seating_capacity":5}',
      true,
    ]);
    const page = await rpc<{ records: Array<{ specifications: Record<string, unknown> }> }>(
      'get_master_data_workspace',
      ['VARIANTS', 1, 25, 'ZX'],
    );
    expect(page.records[0].specifications).toEqual({
      fuel_type: 'PETROL',
      custom_feature: 'sunroof',
      seating_capacity: 5,
    });
  });
});
