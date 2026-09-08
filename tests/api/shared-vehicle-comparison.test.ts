import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vehicleSpecificationsSchema } from '../../src/features/administration/vehicle-specifications';

let db: PGlite;
let inTest = false;
async function query<T>(sql: string, params: unknown[] = []) {
  if (!inTest) return db.query<T>(sql, params);
  await db.exec('savepoint request');
  try {
    const result = await db.query<T>(sql, params);
    await db.exec('release savepoint request');
    return result;
  } catch (error) {
    await db.exec('rollback to savepoint request; release savepoint request');
    throw error;
  }
}
const org = randomUUID(),
  otherOrg = randomUUID(),
  actor = randomUUID(),
  otherActor = randomUUID();
const brand = randomUUID(),
  model = randomUUID(),
  variant = randomUUID(),
  otherVariant = randomUUID();
const specs = {
  battery_capacity: '55 kWh',
  fast_charging: '10–80% in 45 min',
  power: '150 PS',
  range: '430 km',
  torque: '310 Nm',
  warranty: '8 years',
};
async function as(user: string = actor, tenant: string = org, role = 'authenticated') {
  await query(
    "select set_config('test.actor',$1,false),set_config('test.org',$2,false),set_config('test.role',$3,false)",
    [user, tenant, role],
  );
}
async function rpc<T = Record<string, unknown>>(name: string, args: unknown[] = []) {
  return (
    await query<{ result: T }>(
      `select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`,
      args,
    )
  ).rows[0].result;
}
async function sharing(enabled = true, version = 0) {
  return rpc('set_vehicle_catalog_sharing', [
    enabled,
    version,
    enabled ? 'vehicle-catalog-v1' : null,
  ]);
}
async function bothShared() {
  await sharing();
  await as(otherActor, otherOrg);
  await sharing();
  await as();
}
type Search = { records: Array<{ id: string; dealership_name: string }>; total: number };

describe('shared vehicle comparison database', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema app_private;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
      create function auth.role() returns text language sql stable as $$select current_setting('test.role',true)$$;
      create function app_private.current_tenant_organization() returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
      create function app_private.can_access_organization(uuid) returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
      create function app_private.mfa_policy_satisfied(uuid) returns boolean language sql stable as $$select current_setting('test.mfa',true)='yes'$$;
      create function app_private.has_permission(uuid,text) returns boolean language sql stable as $$select current_setting('test.permission',true)='yes'$$;
      create table app_private.retention_table_allowlist(table_name text primary key,disposition text,delete_order integer unique);
      create table organizations(id uuid primary key,name text,status text default 'ACTIVE',deleted_at timestamptz);
      create table profiles(id uuid primary key,organization_id uuid,active boolean default true,deleted_at timestamptz);
      create table roles(id uuid primary key,organization_id uuid,role_key text);
      create table user_role_assignments(organization_id uuid,user_id uuid,role_id uuid,active boolean default true,data_scope text);
      create table vehicle_brands(id uuid primary key,organization_id uuid,name text,active boolean default true);
      create table vehicle_models(id uuid primary key,organization_id uuid,brand_id uuid,name text,active boolean default true);
      create table vehicle_variants(id uuid primary key,organization_id uuid,model_id uuid,name text,active boolean default true,specifications jsonb default '{}',ex_showroom_price numeric,insurance_amount numeric);
      create table audit_logs(organization_id uuid,actor_id uuid,action text,resource_type text,resource_id text,metadata jsonb);
      create table credit_ledger(id uuid primary key default gen_random_uuid(),organization_id uuid,ledger_kind text,transaction_type text,amount bigint,feature text,reference_id text,reason text,user_id uuid,unique(organization_id,ledger_kind,reference_id));
      create table credit_balances(organization_id uuid,ledger_kind text,balance bigint,primary key(organization_id,ledger_kind));
      create function app_private.balance_update() returns trigger language plpgsql as $$begin insert into public.credit_balances values(new.organization_id,new.ledger_kind,new.amount) on conflict(organization_id,ledger_kind) do update set balance=public.credit_balances.balance+excluded.balance;return new;end$$;
      create trigger credit_balance after insert on credit_ledger for each row execute function app_private.balance_update();
    `);
    const creditMigration = readFileSync(
      'supabase/migrations/202608220031_ai_call_processing_pipeline.sql',
      'utf8',
    );
    const begin = creditMigration.indexOf(
      'create or replace function public.consume_platform_ai_credits(',
    );
    const end = creditMigration.indexOf('\n$$;', begin) + 4;
    await db.exec(creditMigration.slice(begin, end));
    await db.exec(
      readFileSync('supabase/migrations/202609080005_shared_vehicle_comparison.sql', 'utf8'),
    );
    await query("insert into organizations(id,name) values($1,'Demo Motors'),($2,'Other Motors')", [
      org,
      otherOrg,
    ]);
    await query('insert into profiles(id,organization_id) values($1,$2),($3,$4)', [
      actor,
      org,
      otherActor,
      otherOrg,
    ]);
    for (const [o, u] of [
      [org, actor],
      [otherOrg, otherActor],
    ]) {
      const r = randomUUID();
      await query("insert into roles values($1,$2,'business_owner')", [r, o]);
      await query("insert into user_role_assignments values($1,$2,$3,true,'ORGANIZATION')", [
        o,
        u,
        r,
      ]);
    }
    await query("insert into vehicle_brands values($1,$2,'Honda',true)", [brand, org]);
    await query("insert into vehicle_models values($1,$2,$3,'City',true)", [model, org, brand]);
    await query(
      "insert into vehicle_variants(id,organization_id,model_id,name,specifications,ex_showroom_price,insurance_amount) values($1,$2,$3,'ZX',$4,1000000,55000)",
      [variant, org, model, JSON.stringify({ ...specs, margin: 999 })],
    );
    const b = randomUUID(),
      m = randomUUID();
    await query("insert into vehicle_brands values($1,$2,'Mahindra',true)", [b, otherOrg]);
    await query("insert into vehicle_models values($1,$2,$3,'XUV400',true)", [m, otherOrg, b]);
    await query(
      "insert into vehicle_variants(id,organization_id,model_id,name,specifications) values($1,$2,$3,'EL Pro',$4)",
      [otherVariant, otherOrg, m, JSON.stringify(specs)],
    );
    await db.exec(
      readFileSync('supabase/migrations/202609080006_vehicle_specs_ai_comparison.sql', 'utf8'),
    );
  }, 30000);
  beforeEach(async () => {
    inTest = true;
    await db.exec(
      "begin;select set_config('test.access','yes',false),set_config('test.mfa','yes',false),set_config('test.permission','yes',false)",
    );
    await as();
  });
  afterEach(async () => {
    inTest = false;
    await db.exec('rollback;reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('defaults to private and returns only own variants, including legacy endpoints', async () => {
    expect(await rpc('get_vehicle_catalog_sharing')).toMatchObject({
      enabled: false,
      version: 0,
      can_manage: true,
    });
    const result = await rpc<Search>('search_comparison_vehicles');
    expect(result.records.map((r) => r.id)).toEqual([variant]);
    expect(JSON.stringify(await rpc('get_sales_competitor_comparison_options'))).not.toContain(
      otherVariant,
    );
  });
  it('requires both dealerships to consent', async () => {
    await sharing();
    expect((await rpc<Search>('search_comparison_vehicles')).total).toBe(1);
    await as(otherActor, otherOrg);
    await sharing();
    await as();
    expect((await rpc<Search>('search_comparison_vehicles')).total).toBe(2);
    expect(await rpc('get_vehicle_comparison', [variant, otherVariant])).toHaveProperty('other');
  });
  it('withdrawal immediately denies direct ID lookups and search', async () => {
    await bothShared();
    await as(otherActor, otherOrg);
    await sharing(false, 1);
    await as();
    expect((await rpc<Search>('search_comparison_vehicles')).total).toBe(1);
    await expect(rpc('get_vehicle_comparison', [variant, otherVariant])).rejects.toThrow(
      'NOT_ACCESSIBLE',
    );
  });
  it('withdrawal by the viewer disables global access even with other dealers shared', async () => {
    await bothShared();
    await sharing(false, 1);
    await expect(rpc('get_vehicle_comparison', [variant, otherVariant])).rejects.toThrow(
      'NOT_ACCESSIBLE',
    );
    expect(await rpc('get_vehicle_comparison', [variant, variant])).toHaveProperty('ours');
  });
  it('projects company/model attribution and public price but not internal pricing or tenant data', async () => {
    const result = await rpc<{
      ours: { specifications: Record<string, unknown>; dealership_name: string };
    }>('get_vehicle_comparison', [variant, variant]);
    expect(result.ours.dealership_name).toBe('Demo Motors');
    expect(result.ours.specifications.ex_showroom_price).toBe(1000000);
    expect(result.ours.specifications).not.toHaveProperty('margin');
    expect(JSON.stringify(result)).not.toContain('insurance_amount');
    expect(JSON.stringify(result)).not.toContain(org);
  });
  it('automatically shares future variants and updates without duplicating catalog rows', async () => {
    await bothShared();
    await query(
      "insert into vehicle_variants(id,organization_id,model_id,name,specifications) values($1,$2,$3,'New trim',$4)",
      [randomUUID(), org, model, JSON.stringify(specs)],
    );
    await query(
      'update vehicle_variants set specifications=specifications||\'{"sunroof":"Yes"}\' where id=$1',
      [variant],
    );
    await as(otherActor, otherOrg);
    expect((await rpc<Search>('search_comparison_vehicles')).total).toBe(3);
    expect(JSON.stringify(await rpc('get_vehicle_comparison', [otherVariant, variant]))).toContain(
      'sunroof',
    );
  });
  it('filters inactive variants and suspended/deleted dealerships', async () => {
    await bothShared();
    await query("update organizations set status='SUSPENDED' where id=$1", [otherOrg]);
    expect((await rpc<Search>('search_comparison_vehicles')).total).toBe(1);
    await query('update vehicle_variants set active=false where id=$1', [variant]);
    expect((await rpc<Search>('search_comparison_vehicles')).total).toBe(0);
  });
  it('requires explicit versioned consent, records audit, and rejects stale updates', async () => {
    await expect(rpc('set_vehicle_catalog_sharing', [true, 0, null])).rejects.toThrow(
      'EXPLICIT_CATALOG_CONSENT',
    );
    await sharing();
    await expect(sharing(false, 0)).rejects.toThrow('CHANGED_REFRESH');
    expect(
      (
        await query(
          "select metadata from audit_logs where action='vehicle_catalog.sharing_changed'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('sales and client admin can read but cannot consent', async () => {
    for (const role of ['sales_consultant', 'client_admin']) {
      await query('update roles set role_key=$1 where organization_id=$2', [role, org]);
      expect(await rpc('get_vehicle_catalog_sharing')).toHaveProperty('can_manage', false);
      await expect(sharing()).rejects.toThrow('ACCESS_REQUIRED');
    }
  });
  it('rejects unauthenticated, unassured and branch-scoped owner access', async () => {
    await as('');
    await expect(rpc('search_comparison_vehicles')).rejects.toThrow('ACCESS_REQUIRED');
    await as();
    await db.exec("select set_config('test.mfa','no',false)");
    await expect(sharing()).rejects.toThrow('ACCESS_REQUIRED');
    await db.exec(
      "select set_config('test.mfa','yes',false);update user_role_assignments set data_scope='ONE_BRANCH'",
    );
    await expect(sharing()).rejects.toThrow('ACCESS_REQUIRED');
  });
  it('enforces database grants against browser direct reads/writes', async () => {
    await db.exec('set role authenticated');
    await expect(query('select * from public.vehicle_catalog_sharing')).rejects.toThrow(
      'permission denied',
    );
    await expect(query('select * from public.vehicle_comparison_ai_requests')).rejects.toThrow(
      'permission denied',
    );
  });
  it('searches company/model with server pagination and validates page limits', async () => {
    await bothShared();
    expect(
      (await rpc<Search>('search_comparison_vehicles', ['Other Motors', false, 1, 25])).records[0]
        .id,
    ).toBe(otherVariant);
    expect((await rpc<Search>('search_comparison_vehicles', ['', true, 1, 25])).total).toBe(1);
    expect(
      (await rpc<Search>('search_comparison_vehicles', ['', false, 2, 25])).records,
    ).toHaveLength(0);
    await expect(rpc('search_comparison_vehicles', ['', false, 0, 500])).rejects.toThrow(
      'INVALID_COMPARISON_SEARCH',
    );
  });
  it('standard specifications are required, explicit absence and custom fields are supported', async () => {
    expect(vehicleSpecificationsSchema.safeParse({}).success).toBe(false);
    expect(
      vehicleSpecificationsSchema.safeParse({
        ...specs,
        battery_capacity: 'NOT_AVAILABLE',
        sunroof: 'Yes',
      }).success,
    ).toBe(true);
    await expect(
      query("update vehicle_variants set specifications='{}' where id=$1", [variant]),
    ).rejects.toThrow('COMPLETE_STANDARD');
    await query('update vehicle_variants set specifications=$1 where id=$2', [
      JSON.stringify({ ...specs, battery_capacity: 'NOT_AVAILABLE', sunroof: 'Yes' }),
      variant,
    ]);
  });
  it('shows balance only, without granting ledger access', async () => {
    expect(await rpc('get_my_credit_balance')).toEqual({ ai: 0, tracking: 0 });
    await query(
      "insert into credit_ledger(organization_id,ledger_kind,transaction_type,amount,reference_id) values($1,'AI','ALLOCATION',5,'seed')",
      [org],
    );
    expect(await rpc('get_my_credit_balance')).toEqual({ ai: 5, tracking: 0 });
  });
  it('denies browser AI billing, insufficient funds, and charges/refunds exactly once', async () => {
    const id = randomUUID();
    await expect(rpc('begin_vehicle_comparison_ai', [actor, variant, variant, id])).rejects.toThrow(
      'SERVICE_ROLE_REQUIRED',
    );
    await as(actor, org, 'service_role');
    await expect(rpc('begin_vehicle_comparison_ai', [actor, variant, variant, id])).rejects.toThrow(
      'INSUFFICIENT_CREDITS',
    );
    await query(
      "insert into credit_ledger(organization_id,ledger_kind,transaction_type,amount,reference_id) values($1,'AI','ALLOCATION',2,'seed')",
      [org],
    );
    expect(await rpc('begin_vehicle_comparison_ai', [actor, variant, variant, id])).toHaveProperty(
      'replayed',
      false,
    );
    expect(await rpc('begin_vehicle_comparison_ai', [actor, variant, variant, id])).toHaveProperty(
      'replayed',
      true,
    );
    expect(await rpc('get_my_credit_balance')).toHaveProperty('ai', 1);
    await rpc('finish_vehicle_comparison_ai', [id, null]);
    await rpc('finish_vehicle_comparison_ai', [id, null]);
    expect(await rpc('get_my_credit_balance')).toHaveProperty('ai', 2);
  });
  it('completed AI retries return the same result without charging again', async () => {
    const id = randomUUID();
    await as(actor, org, 'service_role');
    await query(
      "insert into credit_ledger(organization_id,ledger_kind,transaction_type,amount,reference_id) values($1,'AI','ALLOCATION',2,'seed')",
      [org],
    );
    await rpc('begin_vehicle_comparison_ai', [actor, variant, variant, id]);
    await rpc('finish_vehicle_comparison_ai', [id, 'Dealer-provided summary']);
    expect(await rpc('begin_vehicle_comparison_ai', [actor, variant, variant, id])).toMatchObject({
      replayed: true,
      status: 'COMPLETED',
      summary: 'Dealer-provided summary',
    });
    await rpc('finish_vehicle_comparison_ai', [id, null]);
    expect(await rpc('get_my_credit_balance')).toHaveProperty('ai', 1);
    await expect(
      rpc('begin_vehicle_comparison_ai', [otherActor, otherVariant, otherVariant, id]),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });
  it('refunds abandoned requests once through the scheduled cleanup boundary', async () => {
    await as(actor, org, 'service_role');
    await query(
      "insert into credit_ledger(organization_id,ledger_kind,transaction_type,amount,reference_id) values($1,'AI','ALLOCATION',2,'seed')",
      [org],
    );
    const id = randomUUID();
    await rpc('begin_vehicle_comparison_ai', [actor, variant, variant, id]);
    await query(
      "update vehicle_comparison_ai_requests set created_at=now()-interval '3 minutes' where id=$1",
      [id],
    );
    expect(await rpc('expire_vehicle_comparison_ai')).toBe(1);
    expect(await rpc('expire_vehicle_comparison_ai')).toBe(0);
    expect(await rpc('get_my_credit_balance')).toHaveProperty('ai', 2);
    await as();
    await expect(rpc('expire_vehicle_comparison_ai')).rejects.toThrow('SERVICE_ROLE_REQUIRED');
  });
});
