import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/202610090502_customer_owner_rules.sql', 'utf8');

const org = randomUUID();
const branch = randomUUID();
const team = randomUUID();
const otherTeam = randomUUID();
const telecaller1 = randomUUID();
const telecaller2 = randomUUID();
const consultant1 = randomUUID();
const consultant2 = randomUUID();
const phone = '+918593939234';

let db: PGlite;

async function addLead(input: {
  owner: string | null;
  lifecycle?: string;
  contacted?: boolean;
  teamId?: string;
  phoneValue?: string;
  createdOffset?: string;
}) {
  const result = await db.query<{ id: string }>(
    `insert into public.leads(organization_id, branch_id, team_id, normalized_phone, assigned_user_id,
       lifecycle_status, first_contacted_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6::public.lead_lifecycle,
       case when $7 then now() end, now() - $8::interval, now() - $8::interval)
     returning id`,
    [
      org,
      branch,
      input.teamId ?? team,
      input.phoneValue ?? phone,
      input.owner,
      input.lifecycle ?? 'New',
      input.contacted ?? false,
      input.createdOffset ?? '0 seconds',
    ],
  );
  return result.rows[0]!.id;
}

const owner = async (kind: 'FRESH' | 'QUALIFIED', excludeLeadId: string | null = null) =>
  (
    await db.query<{ owner: string | null }>(
      'select app_private.same_customer_owner($1, $2, $3, null, $4, $5) as owner',
      [org, team, phone, excludeLeadId, kind],
    )
  ).rows[0]!.owner;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    set check_function_bodies = off;
    create role anon; create role authenticated;
    create schema app_private; create schema auth;
    create type public.lead_lifecycle as enum
      ('New','Contacted','Qualified','Appointment Scheduled','Transferred to Sales','Lost');
    create type public.assignment_mode as enum
      ('ROUND_ROBIN','MANUAL_ASSIGNMENT','LEAST_ASSIGNED','SAME_CUSTOMER');
    create function auth.uid() returns uuid language sql
      as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function app_private.current_tenant_organization() returns uuid language sql
      as $$ select '${org}'::uuid $$;
    create function app_private.has_permission(uuid, text) returns boolean language sql
      as $$ select true $$;
    create function app_private.can_access_record(uuid, uuid, uuid, uuid) returns boolean
      language sql as $$ select true $$;
    create table public.leads(
      id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid,
      team_id uuid, customer_id uuid, normalized_phone text, assigned_user_id uuid,
      lifecycle_status public.lead_lifecycle, first_contacted_at timestamptz,
      deleted_at timestamptz, created_at timestamptz default now(),
      updated_at timestamptz default now());
    create table public.profiles(id uuid primary key, organization_id uuid, full_name text,
      active boolean default true, deleted_at timestamptz);
    create table public.roles(id uuid primary key default gen_random_uuid(),
      organization_id uuid, role_key text);
    create table public.user_role_assignments(organization_id uuid, user_id uuid,
      role_id uuid, active boolean default true);
    create table public.team_members(organization_id uuid, team_id uuid, user_id uuid,
      active boolean default true, eligible_for_fresh_leads boolean default true,
      eligible_for_qualified_leads boolean default true);
    create table public.lead_stage_history(organization_id uuid, lead_id uuid,
      from_status public.lead_lifecycle, to_status public.lead_lifecycle, changed_by uuid,
      reason text);
    create table public.activities(organization_id uuid, customer_id uuid, lead_id uuid,
      activity_type text, actor_id uuid, metadata jsonb, occurred_at timestamptz);
    create table public.audit_logs(organization_id uuid, actor_id uuid, action text,
      resource_type text, resource_id text, branch_id uuid, metadata jsonb);
    create table public.lead_assignments(organization_id uuid, lead_id uuid, branch_id uuid,
      team_id uuid, assigned_user_id uuid, assignment_type text,
      method public.assignment_mode, assigned_by uuid, reason text,
      active boolean default true);
    create table public.lead_assignment_history(organization_id uuid, lead_id uuid,
      branch_id uuid, team_id uuid, previous_owner_id uuid, new_owner_id uuid,
      assigned_by uuid, method public.assignment_mode, reason text,
      created_at timestamptz default now());
    insert into public.roles(organization_id, role_key) values
      ('${org}', 'telecaller_bdc'), ('${org}', 'sales_consultant');
  `);
  for (const [user, role] of [
    [telecaller1, 'telecaller_bdc'],
    [telecaller2, 'telecaller_bdc'],
    [consultant1, 'sales_consultant'],
    [consultant2, 'sales_consultant'],
  ] as const) {
    await db.query(
      `insert into public.profiles(id, organization_id, full_name) values ($1, $2, $3)`,
      [user, org, role],
    );
    await db.query(
      `insert into public.user_role_assignments(organization_id, user_id, role_id)
       select $1, $2, id from public.roles where role_key = $3`,
      [org, user, role],
    );
    await db.query(
      'insert into public.team_members(organization_id, team_id, user_id) values ($1, $2, $3)',
      [org, team, user],
    );
  }
  // The migration patches functions this stub schema does not carry; only the
  // helper and record_telecaller_lead_contact are exercised here.
  await db.exec(migration.replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
}, 30000);

afterAll(async () => {
  await db?.close();
});

describe('same_customer_owner', () => {
  it('finds the telecaller holding an open intake lead on the mobile', async () => {
    expect(await owner('FRESH')).toBeNull();
    await addLead({ owner: telecaller1, lifecycle: 'Contacted', contacted: true });
    expect(await owner('FRESH')).toBe(telecaller1);
  });

  it('prefers a live sales lead, then the most recent consultant', async () => {
    expect(await owner('QUALIFIED')).toBeNull();
    await addLead({ owner: consultant2, lifecycle: 'Lost', createdOffset: '0 seconds' });
    expect(await owner('QUALIFIED')).toBe(consultant2);
    const live = await addLead({
      owner: consultant1,
      lifecycle: 'Transferred to Sales',
      createdOffset: '1 day',
    });
    expect(await owner('QUALIFIED')).toBe(consultant1);
    // The lead being transferred never names itself as the owner.
    expect(await owner('QUALIFIED', live)).toBe(consultant2);
  });

  it('skips an owner who cannot take leads in this team', async () => {
    await db.query(
      'update public.team_members set eligible_for_qualified_leads = false where user_id = $1',
      [consultant1],
    );
    expect(await owner('QUALIFIED')).toBe(consultant2);
    await db.query(
      'update public.team_members set eligible_for_qualified_leads = true where user_id = $1',
      [consultant1],
    );
  });
});

describe('record_telecaller_lead_contact first-contact takeover', () => {
  it('moves only the other telecaller’s untouched same-team leads', async () => {
    await db.query('update public.leads set deleted_at = now() where normalized_phone = $1', [
      phone,
    ]);
    const contacted = await addLead({ owner: telecaller1 });
    const untouched = await addLead({ owner: telecaller2 });
    const alreadyWorked = await addLead({
      owner: telecaller2,
      lifecycle: 'Contacted',
      contacted: true,
    });
    const otherTeamLead = await addLead({ owner: telecaller2, teamId: otherTeam });
    const otherMobile = await addLead({ owner: telecaller2, phoneValue: '+919000000001' });

    await db.exec(`select set_config('test.uid', '${telecaller1}', false)`);
    const result = await db.query<{ result: { taken_over_lead_ids: string[] } }>(
      "select public.record_telecaller_lead_contact($1, 'CALL') as result",
      [contacted],
    );
    expect(result.rows[0]!.result.taken_over_lead_ids).toEqual([untouched]);

    const owners = await db.query<{ id: string; assigned_user_id: string }>(
      'select id, assigned_user_id from public.leads where id = any($1)',
      [[untouched, alreadyWorked, otherTeamLead, otherMobile]],
    );
    const ownerOf = Object.fromEntries(owners.rows.map((row) => [row.id, row.assigned_user_id]));
    expect(ownerOf[untouched]).toBe(telecaller1);
    expect(ownerOf[alreadyWorked]).toBe(telecaller2);
    expect(ownerOf[otherTeamLead]).toBe(telecaller2);
    expect(ownerOf[otherMobile]).toBe(telecaller2);

    const history = await db.query<{ method: string; previous_owner_id: string }>(
      'select method::text, previous_owner_id from public.lead_assignment_history where lead_id = $1',
      [untouched],
    );
    expect(history.rows).toEqual([{ method: 'SAME_CUSTOMER', previous_owner_id: telecaller2 }]);
    const activity = await db.query<{ activity_type: string }>(
      'select activity_type from public.activities where lead_id = $1',
      [untouched],
    );
    expect(activity.rows.map((row) => row.activity_type)).toEqual(['LEAD_TAKEN_OVER']);
  });
});

describe('owner rules wiring', () => {
  it('routes fresh leads and sales handoffs through the helper', () => {
    expect(migration).toContain("team_mode := 'SAME_CUSTOMER';");
    expect(migration).toContain("team_row.fresh_assignment_mode := 'SAME_CUSTOMER';");
  });

  it('keeps SAME_CUSTOMER out of the team mode picker', () => {
    const modes = readFileSync('src/features/leads/assignment-mode.ts', 'utf8');
    expect(modes).toMatch(
      /assignmentModes = \['ROUND_ROBIN', 'LEAST_ASSIGNED', 'MANUAL_ASSIGNMENT'\] as const/,
    );
    expect(modes).toContain("SAME_CUSTOMER: 'Same customer'");
  });
});
