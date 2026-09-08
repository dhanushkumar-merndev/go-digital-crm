import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

let db: PGlite;
const org = '10000000-0000-4000-8000-000000000001';
const actor = '10000000-0000-4000-8000-000000000002';
const branch = '10000000-0000-4000-8000-000000000003';
const brand = '10000000-0000-4000-8000-000000000004';
const city = '10000000-0000-4000-8000-000000000005';
const jazz = '10000000-0000-4000-8000-000000000006';
const role = '10000000-0000-4000-8000-000000000007';
type Row = { id: string; target_units: number; booked_units: number; updated_at: string | null };
type Result = {
  records: Row[];
  target_units: number;
  booked_units: number;
  unmatched_units: number;
  total: number;
};
async function workspace(search = '', page = 1, branchId: string | null = branch) {
  return (
    await db.query<{ result: Result }>(
      "select public.get_branch_model_targets('2026-09-01',$1,$2,$3) as result",
      [branchId, search, page],
    )
  ).rows[0].result;
}
async function save(model = city, units = 10, version: string | null = null) {
  return db.query("select public.save_branch_model_target($1,'2026-09-01',$2,$3,$4)", [
    branch,
    model,
    units,
    version,
  ]);
}
async function booking(
  name: string,
  status = 'CONFIRMED',
  created = '2026-09-10T10:00:00Z',
  deleted = false,
) {
  await db.query(
    `with l as (insert into leads(id,organization_id,interested_model) values(gen_random_uuid(),$1,$2) returning id)
    insert into bookings(id,organization_id,branch_id,lead_id,status,created_at,deleted_at)
    select gen_random_uuid(),$1,$3,id,$4,$5::timestamptz,case when $6 then now() else null end from l`,
    [org, name, branch, status, created, deleted],
  );
}
describe('monthly model quantity targets database', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema app_private;
      create table app_private.retention_table_allowlist(table_name text primary key,disposition text,delete_order integer unique);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
      create function app_private.current_tenant_organization() returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
      create function app_private.mfa_policy_satisfied(uuid) returns boolean language sql stable as $$select current_setting('test.mfa',true)='yes'$$;
      create function app_private.has_organization_wide_scope(uuid) returns boolean language sql stable as $$select true$$;
      create function app_private.has_permission(uuid,text) returns boolean language sql stable as $$select true$$;
      create table organizations(id uuid primary key);
      create table branches(id uuid primary key,organization_id uuid,name text,active boolean default true,deleted_at timestamptz);
      create table roles(id uuid primary key,organization_id uuid,role_key text);
      create table user_role_assignments(organization_id uuid,user_id uuid,role_id uuid,active boolean default true,data_scope text);
      create table vehicle_brands(id uuid primary key,organization_id uuid,name text,active boolean default true);
      create table vehicle_models(id uuid primary key,organization_id uuid,brand_id uuid,name text,active boolean default true);
      create table vehicle_variants(id uuid primary key,organization_id uuid,model_id uuid);
      create table stock_units(id uuid primary key,organization_id uuid,variant_id uuid);
      create table stock_allocations(id uuid primary key,organization_id uuid,stock_unit_id uuid,booking_id uuid,status text,allocated_at timestamptz);
      create table leads(id uuid primary key,organization_id uuid,interested_model text);
      create table quotation_items(id uuid primary key,organization_id uuid,quotation_id uuid,item_type text,description text);
      create table bookings(id uuid primary key,organization_id uuid,branch_id uuid,lead_id uuid,quotation_id uuid,status text,created_at timestamptz,deleted_at timestamptz);
      create table audit_logs(organization_id uuid,actor_id uuid,action text,resource_type text,resource_id text,metadata jsonb);
    `);
    await db.exec(
      readFileSync('supabase/migrations/202609080001_branch_model_targets.sql', 'utf8'),
    );
    await db.query('insert into organizations values($1)', [org]);
    await db.query("insert into branches(id,organization_id,name) values($1,$2,'Main')", [
      branch,
      org,
    ]);
    await db.query("insert into vehicle_brands(id,organization_id,name) values($1,$2,'Honda')", [
      brand,
      org,
    ]);
    await db.query(
      "insert into vehicle_models(id,organization_id,brand_id,name) values($1,$3,$4,'City'),($2,$3,$4,'Jazz')",
      [city, jazz, org, brand],
    );
    await db.query("insert into roles values($1,$2,'client_admin')", [role, org]);
    await db.query("insert into user_role_assignments values($1,$2,$3,true,'ORGANIZATION')", [
      org,
      actor,
      role,
    ]);
  }, 30000);
  beforeEach(async () => {
    await db.exec('begin');
    await db.query(
      "select set_config('test.actor',$1,false),set_config('test.org',$2,false),set_config('test.mfa','yes',false)",
      [actor, org],
    );
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('stores independent model quantities and audits before and after values', async () => {
    await save(city, 10);
    await save(jazz, 5);
    const result = await workspace();
    expect(result.target_units).toBe(15);
    expect(result.records.find((r) => r.id === city)?.target_units).toBe(10);
    const version = result.records.find((r) => r.id === city)!.updated_at;
    await save(city, 20, version);
    const audit = await db.query<{
      metadata: { old: { target_units: number }; new: { target_units: number } };
    }>("select metadata from audit_logs where (metadata->'new'->>'target_units')='20'");
    expect(audit.rows[0].metadata.old.target_units).toBe(10);
    expect(audit.rows[0].metadata.new.target_units).toBe(20);
  });
  it('counts units by model with IST month boundaries, excluding cancelled and deleted bookings', async () => {
    await booking('Honda City');
    await booking('Jazz');
    await booking('City', 'CONFIRMED', '2026-08-31T18:30:00Z');
    await booking('City', 'CONFIRMED', '2026-09-30T18:30:00Z');
    await booking('City', 'CANCELLED');
    await booking('City', 'CONFIRMED', '2026-09-10T10:00:00Z', true);
    await booking('Unknown');
    const result = await workspace();
    expect(result.booked_units).toBe(3);
    expect(result.unmatched_units).toBe(1);
    expect(result.records.find((r) => r.id === city)?.booked_units).toBe(2);
  });
  it('does not let another model with the same name double-count a booking', async () => {
    await db.query("insert into vehicle_models values(gen_random_uuid(),$1,$2,'City',true)", [
      org,
      brand,
    ]);
    await booking('City');
    expect((await workspace()).unmatched_units).toBe(1);
  });
  it('keeps branch totals stable while searching the paginated model list', async () => {
    await save(city, 10);
    await save(jazz, 5);
    const result = await workspace('Jazz');
    expect(result.total).toBe(1);
    expect(result.target_units).toBe(15);
    expect(result.records[0].id).toBe(jazz);
    expect((await workspace('', 2)).records).toEqual([]);
  });
  it('rejects stale edits', async () => {
    await save();
    await expect(save(city, 20)).rejects.toThrow(/VERSION_CONFLICT/);
  });
  it('prefers the quoted model over the lead enquiry model', async () => {
    await booking('Jazz');
    await db.exec(`update bookings set quotation_id=gen_random_uuid();
      insert into quotation_items select gen_random_uuid(),organization_id,quotation_id,'VEHICLE','City · ZX · White' from bookings;`);
    const result = await workspace();
    expect(result.records.find((r) => r.id === city)?.booked_units).toBe(1);
    expect(result.records.find((r) => r.id === jazz)?.booked_units).toBe(0);
  });
  it('uses a single latest allocation and the model UUID ahead of names', async () => {
    await booking('Jazz');
    await db.query('insert into vehicle_variants values($1,$2,$3)', [actor, org, city]);
    await db.query('insert into stock_units values($1,$2,$3)', [actor, org, actor]);
    await db.query(
      `insert into stock_allocations
      select gen_random_uuid(),organization_id,$1::uuid,id,'ACTIVE',now() from bookings
      union all select gen_random_uuid(),organization_id,$1::uuid,id,'ALLOCATED',now()-interval '1 day' from bookings`,
      [actor],
    );
    const result = await workspace();
    expect(result.booked_units).toBe(1);
    expect(result.records.find((r) => r.id === city)?.booked_units).toBe(1);
  });
  it('keeps targets separate between months', async () => {
    await save(city, 10);
    await db.query("select public.save_branch_model_target($1,'2026-10-01',$2,20)", [branch, city]);
    expect((await workspace()).target_units).toBe(10);
  });
  it('retains inactive models with targets and allows clearing them', async () => {
    await save();
    await db.query('update vehicle_models set active=false where id=$1', [city]);
    const model = (await workspace()).records.find((r) => r.id === city)!;
    expect(model.target_units).toBe(10);
    await save(city, 0, model.updated_at);
    expect((await workspace()).target_units).toBe(0);
  });
  it('rejects negative quantities', async () => {
    await expect(save(city, -1)).rejects.toThrow(/INVALID_MODEL_TARGET/);
  });
  it('rejects foreign branch access', async () => {
    await expect(workspace('', 1, actor)).rejects.toThrow(/TARGET_BRANCH_DENIED/);
  });
  it('requires MFA', async () => {
    await db.exec("select set_config('test.mfa','no',false)");
    await expect(workspace()).rejects.toThrow(/TENANT_TARGET_CONFIGURATION_REQUIRED/);
  });
  it('allows the Business Owner to read but not change targets', async () => {
    await db.exec("update roles set role_key='business_owner'");
    expect((await workspace()).total).toBe(2);
    await expect(save()).rejects.toThrow(/TENANT_TARGET_CONFIGURATION_REQUIRED/);
  });
  it('blocks direct authenticated table access', async () => {
    await db.exec('set role authenticated');
    await expect(db.query('select * from public.branch_model_targets')).rejects.toThrow(
      /permission denied/,
    );
  });
});
