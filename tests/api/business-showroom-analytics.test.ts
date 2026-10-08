import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const migration = source('supabase/migrations/202610080101_business_showroom_analytics.sql');
const org = randomUUID();
const owner = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
let db: PGlite;

// The base owner fixture predates these measures; add only what the function reads.
const extension = `
alter table leads add column first_contacted_at timestamptz, add column temperature text,
  add column interested_model text, add column lost_reason text;
alter table bookings add column lead_id uuid, add column status text default 'CONFIRMED',
  add column total_value numeric, add column booking_amount numeric, add column deleted_at timestamptz;
alter table delivery_cases add column delivered_at timestamptz, add column deleted_at timestamptz;
create table calls(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,
  outcome text,started_at timestamptz default now());
create table test_drive_appointments(id uuid primary key default gen_random_uuid(),organization_id uuid,
  branch_id uuid,status text default 'SCHEDULED',scheduled_at timestamptz default now());
create table quotations(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,
  created_at timestamptz default now(),deleted_at timestamptz);
create table branch_model_targets(id uuid primary key default gen_random_uuid(),organization_id uuid,
  branch_id uuid,model_id uuid default gen_random_uuid(),month date,target_units integer);
`;

type Totals = Record<string, number | null>;
type Analytics = {
  window_days: number;
  per_branch: Array<
    Totals & { branch: string; branch_id: string; sources: Record<string, number> }
  >;
  focus: {
    totals: Totals;
    daily: Array<{ day: string; leads: number; bookings: number }>;
    sources: Array<{ name: string; leads: number }>;
    booking_sources: Array<{ name: string; bookings: number }>;
    lost_reasons: Array<{ name: string; leads: number }>;
  };
  targets: Array<{ branch: string; unit_target: number; bookings: number }>;
};

async function analytics(days = 30, branch: string | null = null) {
  const result = await db.query<{ result: Analytics }>(
    "select public.get_business_showroom_analytics($1, 'Asia/Kolkata', $2) as result",
    [days, branch],
  );
  return result.rows[0].result;
}
async function lead(
  branch: string,
  fields: Partial<Record<'source' | 'lifecycle_status' | 'lost_reason', string>> & {
    contacted?: boolean;
  } = {},
) {
  const result = await db.query<{ id: string }>(
    `insert into leads(organization_id,branch_id,source,lifecycle_status,lost_reason,first_contacted_at)
     values($1,$2,$3,$4::public.lead_lifecycle,$5,case when $6 then now() + interval '30 minutes' end)
     returning id`,
    [
      org,
      branch,
      fields.source ?? 'Manual',
      fields.lifecycle_status ?? 'New',
      fields.lost_reason ?? null,
      fields.contacted ?? false,
    ],
  );
  return result.rows[0].id;
}

describe('business owner showroom analytics', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/owner-overview-base.sql'));
    await db.exec(extension);
    await db.exec(source('supabase/migrations/202609070201_business_owner_overview_pages.sql'));
    await db.exec(migration);
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query("insert into profiles(id,organization_id,full_name) values($1,$2,'Owner')", [
      owner,
      org,
    ]);
    await db.query("insert into branches(id,organization_id,name) values($1,$2,'MG Road')", [
      branchA,
      org,
    ]);
    await db.query("insert into branches(id,organization_id,name) values($1,$2,'Whitefield')", [
      branchB,
      org,
    ]);
    await db.query(
      "insert into user_role_assignments(organization_id,user_id,data_scope) values($1,$2,'ORGANIZATION')",
      [org, owner],
    );
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: owner, role: 'authenticated', aal: 'aal2' }),
    ]);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('lists every showroom in scope with its measures, including an idle one', async () => {
    await lead(branchA, { contacted: true, lifecycle_status: 'Transferred to Sales' });
    await lead(branchA, { lifecycle_status: 'Lost', lost_reason: 'Price' });
    await db.query(
      'insert into bookings(organization_id,branch_id,total_value) values($1,$2,1200000)',
      [org, branchA],
    );
    await db.query(
      "insert into calls(organization_id,branch_id,outcome) values($1,$2,'CONNECTED'),($1,$2,'NO_ANSWER')",
      [org, branchA],
    );
    const result = await analytics();
    expect(result.per_branch.map((branch) => branch.branch).sort()).toEqual([
      'MG Road',
      'Whitefield',
    ]);
    const mgRoad = result.per_branch.find((branch) => branch.branch === 'MG Road')!;
    expect(mgRoad).toMatchObject({
      leads: 2,
      contacted: 1,
      moved_to_sales: 1,
      lost: 1,
      bookings: 1,
      booking_value: 1200000,
      calls: 2,
      connected_calls: 1,
      response_minutes: 30,
    });
    expect(result.per_branch.find((branch) => branch.branch === 'Whitefield')?.leads).toBe(0);
    expect(result.focus.lost_reasons).toEqual([{ name: 'Price', leads: 1 }]);
  });

  it('narrows the focus to one showroom but keeps every showroom for comparison', async () => {
    await lead(branchA, { source: 'Facebook' });
    await lead(branchB, { source: 'Website' });
    await lead(branchB, { source: 'Website' });
    const result = await analytics(30, branchB);
    expect(result.focus.totals.leads).toBe(2);
    expect(result.focus.sources).toEqual([{ name: 'Website', leads: 2 }]);
    expect(result.per_branch).toHaveLength(2);
  });

  it('credits bookings to the source of the lead they came from', async () => {
    const leadId = await lead(branchA, { source: 'Google Ads' });
    await db.query('insert into bookings(organization_id,branch_id,lead_id) values($1,$2,$3)', [
      org,
      branchA,
      leadId,
    ]);
    const result = await analytics();
    expect(result.focus.booking_sources).toEqual([{ name: 'Google Ads', bookings: 1 }]);
  });

  it('ignores cancelled bookings and test drives', async () => {
    await db.query(
      "insert into bookings(organization_id,branch_id,status) values($1,$2,'CANCELLED')",
      [org, branchA],
    );
    await db.query(
      "insert into test_drive_appointments(organization_id,branch_id,status) values($1,$2,'CANCELLED')",
      [org, branchA],
    );
    const result = await analytics();
    expect(result.focus.totals).toMatchObject({ bookings: 0, test_drives: 0 });
  });

  it('returns one daily point per day in the window', async () => {
    await lead(branchA);
    const result = await analytics(7);
    expect(result.focus.daily).toHaveLength(7);
    expect(result.focus.daily.reduce((sum, day) => sum + day.leads, 0)).toBe(1);
  });

  it('measures this month against the showroom unit targets', async () => {
    await db.query(
      `insert into branch_model_targets(organization_id,branch_id,month,target_units)
       values($1,$2,date_trunc('month', timezone('Asia/Kolkata', now()))::date,4),
             ($1,$2,date_trunc('month', timezone('Asia/Kolkata', now()))::date,6),
             ($1,$2,(date_trunc('month', timezone('Asia/Kolkata', now())) - interval '1 month')::date,99)`,
      [org, branchA],
    );
    await db.query('insert into bookings(organization_id,branch_id) values($1,$2),($1,$2)', [
      org,
      branchA,
    ]);
    const result = await analytics();
    expect(result.targets.find((row) => row.branch === 'MG Road')).toMatchObject({
      unit_target: 10,
      bookings: 2,
    });
  });

  it('refuses a showroom outside the caller scope', async () => {
    await expect(analytics(30, randomUUID())).rejects.toThrow(/SHOWROOM_OUT_OF_SCOPE/);
  });

  it('refuses windows the page does not offer instead of scanning everything', async () => {
    await expect(analytics(5000)).rejects.toThrow(/INVALID_OVERVIEW_WINDOW/);
  });

  it('refuses a caller with no tenant', async () => {
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: randomUUID(), role: 'authenticated' }),
    ]);
    await expect(analytics()).rejects.toThrow(/OWNER_OVERVIEW_ACCESS_REQUIRED/);
  });

  it('is callable by signed-in users only', () => {
    expect(migration).toContain(
      'revoke all on function public.get_business_showroom_analytics(integer, text, uuid) from public, anon;',
    );
    expect(migration).toContain(
      'grant execute on function public.get_business_showroom_analytics(integer, text, uuid) to authenticated;',
    );
    expect(migration).toContain('app_private.assert_owner_overview_access()');
    expect(migration).toContain('app_private.actor_branch_scope(current_organization_id)');
  });
});
