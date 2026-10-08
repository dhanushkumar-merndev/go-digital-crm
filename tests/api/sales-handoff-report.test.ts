import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const migration = source('supabase/migrations/202610080301_sales_handoff_report.sql');
const org = randomUUID();
const otherOrg = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const teamA = randomUUID();
const teamB = randomUUID();
const users = {
  telecaller: randomUUID(),
  otherTelecaller: randomUUID(),
  consultantOne: randomUUID(),
  consultantTwo: randomUUID(),
  teamManager: randomUUID(),
  showroomManager: randomUUID(),
  clientAdmin: randomUUID(),
  owner: randomUUID(),
  gm: randomUUID(),
};
let db: PGlite;

// The owner fixture predates handoffs; add only what the report reads.
const extension = `
alter table leads add column team_id uuid, add column customer_name text default 'Customer',
  add column phone text default '9000000000', add column normalized_phone text default '919000000000',
  add column next_followup_at timestamptz, add column updated_at timestamptz default now();
alter table bookings add column lead_id uuid, add column status text default 'CONFIRMED',
  add column deleted_at timestamptz;
create table teams(id uuid primary key,organization_id uuid,manager_id uuid,active boolean default true);
create table lead_assignments(id uuid primary key default gen_random_uuid(),organization_id uuid,
  lead_id uuid,branch_id uuid,team_id uuid,assigned_user_id uuid,assignment_type text,
  assigned_by uuid,created_at timestamptz default now());
create table quotations(id uuid primary key default gen_random_uuid(),organization_id uuid,
  lead_id uuid,deleted_at timestamptz);
create table test_drive_appointments(id uuid primary key default gen_random_uuid(),
  organization_id uuid,lead_id uuid);
create table test_access(user_id uuid primary key,role_key text);
create function public.get_access_context() returns jsonb language sql stable as $$
  select jsonb_build_object('destination','CRM',
    'role_key',(select role_key from public.test_access where user_id=auth.uid()),
    'organization_id',(select organization_id from public.profiles where id=auth.uid()))
$$;
create function app_private.can_access_team(org uuid,team uuid) returns boolean
  language sql stable as $$ select true $$;
`;

type Summary = {
  kpis: Record<string, number>;
  by_consultant: Array<Record<string, number | string>>;
  by_telecaller: Array<Record<string, number | string>>;
  matrix: Array<Record<string, number | string>>;
  by_branch: Array<Record<string, number | string>>;
};
type Leads = {
  total: number;
  rows: Array<Record<string, string | boolean | null>>;
};

async function as(user: string) {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }),
  ]);
}
async function summary(...filters: Array<string | null>) {
  const [branch = null, team = null, telecaller = null] = filters;
  const result = await db.query<{ result: Summary }>(
    "select public.get_sales_handoff_summary(30, 'Asia/Kolkata', $1, $2, $3) as result",
    [branch, team, telecaller],
  );
  return result.rows[0].result;
}
async function leads(
  options: { consultant?: string; stage?: string; search?: string; pageSize?: number } = {},
) {
  const result = await db.query<{ result: Leads }>(
    `select public.get_sales_handoff_leads(30, 'Asia/Kolkata', null, null, null, $1, $2, $3, 1, $4)
       as result`,
    [
      options.consultant ?? null,
      options.stage ?? null,
      options.search ?? null,
      options.pageSize ?? 25,
    ],
  );
  return result.rows[0].result;
}

/** Expected errors abort the test transaction; a savepoint keeps it usable. */
async function refused(call: () => Promise<unknown>, message: string) {
  await db.exec('savepoint expected_error');
  await expect(call()).rejects.toThrow(message);
  await db.exec('rollback to savepoint expected_error');
}

/** A lead a telecaller owned, then handed to a consultant. */
async function handoff(
  telecaller: string,
  consultant: string,
  fields: { branch?: string; team?: string; name?: string; phone?: string; lost?: boolean } = {},
) {
  const branch = fields.branch ?? branchA;
  const team = fields.team ?? teamA;
  const lead = await db.query<{ id: string }>(
    `insert into leads(organization_id,branch_id,team_id,assigned_user_id,customer_name,
       normalized_phone,lifecycle_status)
     values($1,$2,$3,$4,$5,$6,$7::public.lead_lifecycle) returning id`,
    [
      org,
      branch,
      team,
      consultant,
      fields.name ?? 'Customer',
      fields.phone ?? '919000000000',
      fields.lost ? 'Lost' : 'Transferred to Sales',
    ],
  );
  const leadId = lead.rows[0].id;
  await db.query(
    `insert into lead_assignments(organization_id,lead_id,branch_id,team_id,assigned_user_id,
       assignment_type,assigned_by,created_at)
     values($1,$2,$3,$4,$5,'FRESH',null,now() - interval '2 days'),
           ($1,$2,$3,$4,$6,'QUALIFIED',$5,now() - interval '1 day')`,
    [org, leadId, branch, team, telecaller, consultant],
  );
  return leadId;
}

describe('telecaller to sales consultant handoff report', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/owner-overview-base.sql'));
    await db.exec(source('supabase/migrations/202609070201_business_owner_overview_pages.sql'));
    await db.exec(extension);
    await db.exec(migration);
    await db.query('insert into organizations(id) values($1),($2)', [org, otherOrg]);
    const names: Record<string, string> = {
      telecaller: 'Tara Telecaller',
      otherTelecaller: 'Omar Telecaller',
      consultantOne: 'Chitra Consultant',
      consultantTwo: 'Dev Consultant',
      teamManager: 'Team Manager',
      showroomManager: 'Showroom Manager',
      clientAdmin: 'Client Admin',
      owner: 'Owner',
      gm: 'GM',
    };
    const roles: Record<string, string> = {
      telecaller: 'telecaller',
      otherTelecaller: 'telecaller',
      consultantOne: 'sales-consultant',
      consultantTwo: 'sales-consultant',
      teamManager: 'team-manager',
      showroomManager: 'showroom-manager',
      clientAdmin: 'client-admin',
      owner: 'business-owner',
      gm: 'gm-sales',
    };
    for (const [key, id] of Object.entries(users)) {
      await db.query('insert into profiles(id,organization_id,full_name) values($1,$2,$3)', [
        id,
        org,
        names[key],
      ]);
      await db.query('insert into test_access(user_id,role_key) values($1,$2)', [id, roles[key]]);
    }
    await db.query(
      "insert into branches(id,organization_id,name) values($1,$3,'MG Road'),($2,$3,'Whitefield')",
      [branchA, branchB, org],
    );
    await db.query(
      'insert into teams(id,organization_id,manager_id) values($1,$3,$4),($2,$3,null)',
      [teamA, teamB, org, users.teamManager],
    );
    await db.query(
      `insert into user_role_assignments(organization_id,user_id,data_scope,scope_branch_id)
       values($1,$2,'ONE_BRANCH',$3),($1,$4,'ORGANIZATION',null),($1,$5,'ORGANIZATION',null)`,
      [org, users.showroomManager, branchA, users.clientAdmin, users.owner],
    );
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

  it('splits a telecaller handoffs by consultant with each lead current stage', async () => {
    const booked = await handoff(users.telecaller, users.consultantOne);
    const quoted = await handoff(users.telecaller, users.consultantOne);
    await handoff(users.telecaller, users.consultantOne, { lost: true });
    const drive = await handoff(users.telecaller, users.consultantTwo);
    await handoff(users.telecaller, users.consultantTwo);
    await handoff(users.otherTelecaller, users.consultantTwo);
    await db.query('insert into bookings(organization_id,branch_id,lead_id) values($1,$2,$3)', [
      org,
      branchA,
      booked,
    ]);
    // A booked lead with a quotation still reads Booking: the furthest stage wins.
    await db.query('insert into quotations(organization_id,lead_id) values($1,$2),($1,$3)', [
      org,
      booked,
      quoted,
    ]);
    await db.query('insert into test_drive_appointments(organization_id,lead_id) values($1,$2)', [
      org,
      drive,
    ]);

    await as(users.telecaller);
    const result = await summary();
    expect(result.kpis).toMatchObject({
      transferred: 5,
      booked: 1,
      quotation: 1,
      test_drive: 1,
      lost: 1,
      with_sales: 1,
      conversion_pct: 20,
    });
    expect(result.by_consultant).toEqual([
      expect.objectContaining({
        consultant: 'Chitra Consultant',
        transferred: 3,
        booked: 1,
        quotation: 1,
        lost: 1,
        conversion_pct: 33.3,
      }),
      expect.objectContaining({
        consultant: 'Dev Consultant',
        transferred: 2,
        test_drive: 1,
        with_sales: 1,
      }),
    ]);
    // A telecaller sees only their own handoffs and no per-telecaller breakdown.
    expect(result.by_telecaller).toEqual([]);
    expect(result.by_branch).toEqual([]);
  });

  it('keeps a reassigned lead on the consultant who received it', async () => {
    const lead = await handoff(users.telecaller, users.consultantOne);
    await db.query('update leads set assigned_user_id=$1 where id=$2', [users.consultantTwo, lead]);
    await db.query(
      `insert into lead_assignments(organization_id,lead_id,branch_id,team_id,assigned_user_id,
         assignment_type,assigned_by)
       values($1,$2,$3,$4,$5,'QUALIFIED',$6)`,
      [org, lead, branchA, teamA, users.consultantTwo, users.teamManager],
    );
    await as(users.telecaller);
    const result = await summary();
    expect(result.kpis).toMatchObject({ transferred: 1, reassigned: 1 });
    expect(result.by_consultant).toEqual([
      expect.objectContaining({ consultant: 'Chitra Consultant', transferred: 1, reassigned: 1 }),
    ]);
    const list = await leads();
    expect(list.rows[0]).toMatchObject({
      received_by: 'Chitra Consultant',
      current_owner: 'Dev Consultant',
      reassigned: true,
    });
  });

  it('gives managers the telecaller by consultant breakdown inside their scope', async () => {
    await handoff(users.telecaller, users.consultantOne);
    await handoff(users.otherTelecaller, users.consultantOne);
    await handoff(users.otherTelecaller, users.consultantTwo, { branch: branchB, team: teamB });

    await as(users.teamManager);
    const team = await summary();
    expect(team.kpis.transferred).toBe(2);
    expect(team.by_telecaller.map((row) => row.telecaller).sort()).toEqual([
      'Omar Telecaller',
      'Tara Telecaller',
    ]);
    expect(team.matrix).toHaveLength(2);

    await as(users.showroomManager);
    expect((await summary()).kpis.transferred).toBe(2);
    await refused(() => summary(branchB), 'SALES_HANDOFF_OUT_OF_SCOPE');

    await as(users.clientAdmin);
    const organization = await summary();
    expect(organization.kpis.transferred).toBe(3);
    expect(organization.by_branch.map((row) => [row.branch, row.transferred])).toEqual([
      ['MG Road', 2],
      ['Whitefield', 1],
    ]);
    const omar = await summary(null, null, users.otherTelecaller);
    expect(omar.kpis.transferred).toBe(2);

    await as(users.owner);
    expect((await summary(branchB)).kpis.transferred).toBe(1);
  });

  it('refuses roles outside the report and a telecaller reading someone else', async () => {
    await as(users.gm);
    await refused(() => summary(), 'SALES_HANDOFF_ACCESS_DENIED');
    await as(users.consultantOne);
    await refused(() => summary(), 'SALES_HANDOFF_ACCESS_DENIED');
    await as(users.telecaller);
    await refused(() => summary(null, null, users.otherTelecaller), 'SALES_HANDOFF_OUT_OF_SCOPE');
  });

  it('counts only the first handoff and ignores handoffs outside the window', async () => {
    const lead = await handoff(users.telecaller, users.consultantOne);
    await db.query(
      `insert into lead_assignments(organization_id,lead_id,branch_id,team_id,assigned_user_id,
         assignment_type,assigned_by)
       values($1,$2,$3,$4,$5,'QUALIFIED',$6)`,
      [org, lead, branchA, teamA, users.consultantTwo, users.telecaller],
    );
    const old = await handoff(users.telecaller, users.consultantTwo);
    await db.query(
      "update lead_assignments set created_at = now() - interval '90 days' where lead_id=$1",
      [old],
    );
    await as(users.telecaller);
    expect((await summary()).kpis.transferred).toBe(1);
  });

  it('pages, searches and filters the handed-over leads', async () => {
    await handoff(users.telecaller, users.consultantOne, {
      name: 'Ravi Kumar',
      phone: '919036215854',
    });
    await handoff(users.telecaller, users.consultantOne, { name: 'Sneha Rao', lost: true });
    await handoff(users.telecaller, users.consultantTwo, { name: 'Ravindra' });
    await as(users.telecaller);
    expect((await leads()).total).toBe(3);
    expect((await leads({ search: 'ravi' })).total).toBe(2);
    expect((await leads({ search: '036215' })).rows.map((row) => row.customer_name)).toEqual([
      'Ravi Kumar',
    ]);
    expect((await leads({ stage: 'LOST' })).rows.map((row) => row.customer_name)).toEqual([
      'Sneha Rao',
    ]);
    expect((await leads({ consultant: users.consultantTwo })).total).toBe(1);
    // LIKE wildcards in a search are literal text, not patterns.
    expect((await leads({ search: '%' })).total).toBe(0);
    await refused(() => leads({ stage: 'Booking' }), 'INVALID_SALES_HANDOFF_QUERY');
    await refused(() => leads({ pageSize: 10 }), 'INVALID_SALES_HANDOFF_QUERY');
  });

  it('accepts a custom range end date and rejects a malformed window', async () => {
    await as(users.telecaller);
    await expect(
      db.query("select public.get_sales_handoff_summary(7, 'Asia/Kolkata|2026-10-08')"),
    ).resolves.toBeTruthy();
    await refused(
      () => db.query("select public.get_sales_handoff_summary(0, 'Asia/Kolkata')"),
      'INVALID_SALES_HANDOFF_WINDOW',
    );
    await refused(
      () => db.query("select public.get_sales_handoff_summary(7, 'Europe/London')"),
      'INVALID_SALES_HANDOFF_WINDOW',
    );
  });

  it('exposes only the two report functions to signed-in users', () => {
    expect(migration).toMatch(
      /revoke all on function app_private\.sales_handoff_rows\([^)]*\)\s+from public, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.get_sales_handoff_summary\([^)]*\)\s+to authenticated;/,
    );
    expect(migration).toMatch(/grant execute on function public\.get_sales_handoff_leads\(/);
    expect(migration.match(/security definer\s+set search_path = ''/g)).toHaveLength(5);
  });
});
