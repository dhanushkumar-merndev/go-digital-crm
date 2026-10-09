import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const baseline = readFileSync('supabase/migrations/202610090502_customer_owner_rules.sql', 'utf8');
const migrationPath = 'supabase/migrations/202610091301_optional_same_phone_sales_handoff.sql';
const followupMigrationPath =
  'supabase/migrations/202610091302_followup_sales_consultant_choice.sql';
const org = randomUUID();
const foreignOrg = randomUUID();
const branch = randomUUID();
const team = randomUUID();
const foreignTeam = randomUUID();
const caller = randomUUID();
const manager = randomUUID();
const consultantA = randomUUID();
const consultantB = randomUUID();
const invalidRecipient = randomUUID();
const customer = randomUUID();
const phone = '+918593939234';
let db: PGlite;
let sibling: string;
let enquiry: string;

function baselineFunction(name: string) {
  const start = baseline.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = baseline.indexOf('$function$;', start) + '$function$;'.length;
  return baseline.slice(start, end);
}

function workFunction(source: string, name: string) {
  const start = source.indexOf(`create or replace function ${name}(`);
  const end = source.indexOf('$$;', start) + '$$;'.length;
  return source.slice(start, end);
}

async function addFollowup() {
  return (
    await db.query<{ id: string }>(
      `insert into public.followups(organization_id,branch_id,team_id,customer_id,lead_id,
        assigned_user_id,status,version,due_at) values ($1,$2,$3,$4,$5,$6,'OPEN',1,now()) returning id`,
      [org, branch, team, customer, enquiry, caller],
    )
  ).rows[0]!.id;
}

async function completeAndTransfer(
  followupId: string,
  recipient: string,
  requestId = randomUUID(),
) {
  return (
    await db.query<{ result: { status: string; replayed: boolean } }>(
      "select public.complete_followup($1,1,$2,$3,'TRANSFER_TO_SALES',$4) as result",
      [followupId, 'Customer is ready for Sales.', requestId, recipient],
    )
  ).rows[0]!.result;
}

async function transfer(recipient: string | null) {
  return (
    await db.query<{ result: { assigned_user_id: string; method: string } }>(
      'select public.transfer_lead_to_sales($1, $2, $3) as result',
      [enquiry, recipient, 'Customer asked to work this enquiry with the selected consultant.'],
    )
  ).rows[0]!.result;
}

async function candidates(search = '') {
  return (
    await db.query<{ user_id: string; recommended: boolean; assignment_mode: string }>(
      'select * from public.get_sales_handoff_candidates($1, $2)',
      [enquiry, search],
    )
  ).rows;
}

async function expectUnchangedAfterRefusal(recipient: string, error: string) {
  await expect(transfer(recipient)).rejects.toThrow(error);
  const lead = await db.query<{ assigned_user_id: string; lifecycle_status: string }>(
    'select assigned_user_id, lifecycle_status from public.leads where id = $1',
    [enquiry],
  );
  expect(lead.rows).toEqual([{ assigned_user_id: caller, lifecycle_status: 'Contacted' }]);
  for (const table of ['lead_assignments', 'lead_assignment_history', 'audit_logs']) {
    const count = await db.query<{ count: number }>(
      `select count(*)::int as count from public.${table}`,
    );
    expect(count.rows[0]!.count).toBe(0);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema app_private;
    create type public.lead_lifecycle as enum
      ('New','Contacted','Qualified','Transferred to Sales','Lost');
    create type public.assignment_mode as enum
      ('ROUND_ROBIN','MANUAL_ASSIGNMENT','LEAST_ASSIGNED','SAME_CUSTOMER');
    create function auth.uid() returns uuid language sql as $$
      select current_setting('test.actor')::uuid $$;
    create function app_private.current_tenant_organization() returns uuid language sql as $$
      select '${org}'::uuid $$;
    create function app_private.has_permission(uuid, text) returns boolean language sql as $$
      select $1 = '${org}'::uuid and case $2
        when 'lead.update' then current_setting('test.can_update')::boolean
        when 'lead.assign' then current_setting('test.can_assign')::boolean
        when 'followup.complete' then current_setting('test.can_update')::boolean
        when 'followup.override_complete' then current_setting('test.can_assign')::boolean
        else false end $$;
    create function app_private.can_access_record(uuid, uuid, uuid, uuid) returns boolean
      language sql as $$ select $1 = '${org}'::uuid and $2 = '${branch}'::uuid
        and $3 = '${team}'::uuid and
        ($4 = auth.uid() or app_private.has_permission($1, 'lead.assign')) $$;
    create table public.profiles(id uuid primary key, organization_id uuid, full_name text,
      active boolean default true, deleted_at timestamptz);
    create table public.roles(id uuid primary key default gen_random_uuid(), organization_id uuid,
      role_key text);
    create table public.user_role_assignments(organization_id uuid, user_id uuid, role_id uuid,
      active boolean default true);
    create table public.teams(id uuid primary key, organization_id uuid,
      qualified_assignment_mode public.assignment_mode);
    create table public.team_members(organization_id uuid, team_id uuid, user_id uuid,
      active boolean default true, eligible_for_fresh_leads boolean default true,
      eligible_for_qualified_leads boolean default true,
      last_qualified_assigned_at timestamptz, joined_at timestamptz default now());
    create table public.leads(id uuid primary key default gen_random_uuid(), organization_id uuid,
      branch_id uuid, team_id uuid, customer_id uuid, normalized_phone text, assigned_user_id uuid,
      lifecycle_status public.lead_lifecycle, temperature text default 'COLD',
      first_contacted_at timestamptz, next_followup_at timestamptz, deleted_at timestamptz,
      updated_at timestamptz default now());
    create table public.followups(id uuid primary key default gen_random_uuid(),
      organization_id uuid, branch_id uuid, team_id uuid, customer_id uuid, lead_id uuid,
      assigned_user_id uuid, status text, version bigint default 1, due_at timestamptz,
      completed_at timestamptz, completion_note text, outcome text, updated_at timestamptz);
    create table public.lead_assignments(id uuid primary key default gen_random_uuid(),
      organization_id uuid, lead_id uuid, branch_id uuid, team_id uuid, assigned_user_id uuid,
      assignment_type text, method public.assignment_mode, assigned_by uuid, reason text,
      active boolean default true);
    create table public.lead_stage_history(organization_id uuid, lead_id uuid,
      from_status public.lead_lifecycle, to_status public.lead_lifecycle, changed_by uuid, reason text);
    create table public.lead_assignment_history(organization_id uuid, lead_id uuid,
      branch_id uuid, team_id uuid, previous_owner_id uuid, new_owner_id uuid,
      assigned_by uuid, method public.assignment_mode, reason text);
    create table public.audit_logs(id uuid primary key default gen_random_uuid(),
      organization_id uuid, actor_id uuid, action text, resource_type text, resource_id text,
      branch_id uuid, request_id uuid, metadata jsonb, created_at timestamptz default now());
    create table public.activities(organization_id uuid, customer_id uuid, lead_id uuid,
      activity_type text, actor_id uuid, metadata jsonb);
  `);
  await db.exec(baselineFunction('app_private.same_customer_owner'));
  await db.exec(baselineFunction('public.transfer_lead_to_sales'));
  await db.exec(baselineFunction('public.get_sales_handoff_candidates'));
  const workSource = readFileSync(
    'supabase/migrations/202608150016_work_appointments_workspace.sql',
    'utf8',
  );
  for (const name of [
    'app_private.work_request_fingerprint',
    'app_private.replay_work_request',
    'app_private.refresh_lead_next_followup',
  ]) {
    await db.exec(workFunction(workSource, name));
  }
  await db.exec(
    workFunction(
      readFileSync('supabase/migrations/202609160014_add_followup_transfer_outcome.sql', 'utf8'),
      'public.complete_followup',
    ),
  );
  // The baseline deliberately reproduces the restriction until the new
  // migration exists; these behavior tests must fail against that baseline.
  if (existsSync(migrationPath)) await db.exec(readFileSync(migrationPath, 'utf8'));
  if (existsSync(followupMigrationPath)) await db.exec(readFileSync(followupMigrationPath, 'utf8'));
}, 30_000);

beforeEach(async () => {
  await db.exec(`
    truncate public.leads, public.profiles, public.roles, public.user_role_assignments,
      public.teams, public.team_members, public.followups, public.lead_assignments,
      public.lead_stage_history, public.lead_assignment_history, public.audit_logs, public.activities;
    select set_config('test.actor', '${caller}', false);
    select set_config('test.can_update', 'true', false);
    select set_config('test.can_assign', 'false', false);
    insert into public.teams values ('${team}', '${org}', 'ROUND_ROBIN');
  `);
  for (const [id, name, role] of [
    [caller, 'Caller', 'telecaller_bdc'],
    [manager, 'Manager', 'team_manager'],
    [consultantA, 'Consultant A', 'sales_consultant'],
    [consultantB, 'Consultant B', 'sales_consultant'],
  ]) {
    await db.query(
      'insert into public.profiles(id, organization_id, full_name) values ($1,$2,$3)',
      [id, org, name],
    );
    const roleRow = await db.query<{ id: string }>(
      'insert into public.roles(organization_id, role_key) values ($1,$2) returning id',
      [org, role],
    );
    await db.query(
      'insert into public.user_role_assignments(organization_id,user_id,role_id) values ($1,$2,$3)',
      [org, id, roleRow.rows[0]!.id],
    );
    await db.query(
      'insert into public.team_members(organization_id,team_id,user_id) values ($1,$2,$3)',
      [org, team, id],
    );
  }
  const leads = await db.query<{ id: string }>(
    `
    insert into public.leads(organization_id,branch_id,team_id,customer_id,normalized_phone,
      assigned_user_id,lifecycle_status) values
      ($1,$2,$3,$4,$5,$6,'Transferred to Sales'), ($1,$2,$3,$4,$5,$7,'Contacted') returning id`,
    [org, branch, team, customer, phone, consultantA, caller],
  );
  [sibling, enquiry] = leads.rows.map((row) => row.id);
});

afterAll(async () => {
  await db?.close();
});

describe('optional same-phone Sales handoff', () => {
  it('offers both eligible consultants and recommends the existing one without locking the choice', async () => {
    const rows = await candidates();
    expect(rows.map((row) => row.user_id).sort()).toEqual([consultantA, consultantB].sort());
    expect(rows.filter((row) => row.recommended).map((row) => row.user_id)).toEqual([consultantA]);
  });

  it('filters candidate search even when another enquiry already has a consultant', async () => {
    expect((await candidates('Consultant B')).map((row) => row.user_id)).toEqual([consultantB]);
    expect(await candidates('No matching consultant')).toEqual([]);
  });

  it('allows a different consultant for the same customer and phone, with a manual audit trail', async () => {
    expect(await transfer(consultantB)).toMatchObject({
      assigned_user_id: consultantB,
      method: 'MANUAL_ASSIGNMENT',
    });
    const owners = await db.query<{ id: string; assigned_user_id: string }>(
      'select id,assigned_user_id from public.leads order by id',
    );
    expect(Object.fromEntries(owners.rows.map((row) => [row.id, row.assigned_user_id]))).toEqual({
      [sibling]: consultantA,
      [enquiry]: consultantB,
    });
    const history = await db.query(
      'select previous_owner_id,new_owner_id,assigned_by,method::text from public.lead_assignment_history',
    );
    expect(history.rows).toEqual([
      {
        previous_owner_id: caller,
        new_owner_id: consultantB,
        assigned_by: caller,
        method: 'MANUAL_ASSIGNMENT',
      },
    ]);
    const audit = await db.query<{
      metadata: { method: string; sales_consultant_id: string };
      actor_id: string;
    }>('select metadata,actor_id from public.audit_logs');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: caller,
      metadata: { method: 'MANUAL_ASSIGNMENT', sales_consultant_id: consultantB },
    });
  });

  it('records an explicit selection of the existing consultant as manual', async () => {
    expect(await transfer(consultantA)).toMatchObject({
      assigned_user_id: consultantA,
      method: 'MANUAL_ASSIGNMENT',
    });
  });

  it('prefers the existing eligible consultant only for automatic assignment', async () => {
    expect(await transfer(null)).toMatchObject({
      assigned_user_id: consultantA,
      method: 'SAME_CUSTOMER',
    });
  });

  it('allows an authorized manager to make the manual choice', async () => {
    await db.exec(
      `select set_config('test.actor','${manager}',false); select set_config('test.can_assign','true',false);`,
    );
    expect(await transfer(consultantB)).toMatchObject({
      assigned_user_id: consultantB,
      method: 'MANUAL_ASSIGNMENT',
    });
  });

  it.each([
    'foreign tenant',
    'foreign team',
    'inactive membership',
    'inactive profile',
    'ineligible',
    'non-sales role',
  ])('refuses a %s recipient without changing the lead or audit trail', async (kind) => {
    await db.query(
      'insert into public.profiles(id,organization_id,full_name,active) values ($1,$2,$3,$4)',
      [
        invalidRecipient,
        kind === 'foreign tenant' ? foreignOrg : org,
        'Invalid recipient',
        kind !== 'inactive profile',
      ],
    );
    const role = await db.query<{ id: string }>(
      'insert into public.roles(organization_id,role_key) values ($1,$2) returning id',
      [
        kind === 'foreign tenant' ? foreignOrg : org,
        kind === 'non-sales role' ? 'telecaller_bdc' : 'sales_consultant',
      ],
    );
    await db.query(
      'insert into public.user_role_assignments(organization_id,user_id,role_id) values ($1,$2,$3)',
      [kind === 'foreign tenant' ? foreignOrg : org, invalidRecipient, role.rows[0]!.id],
    );
    await db.query(
      'insert into public.team_members(organization_id,team_id,user_id,active,eligible_for_qualified_leads) values ($1,$2,$3,$4,$5)',
      [
        kind === 'foreign tenant' ? foreignOrg : org,
        kind === 'foreign team' ? foreignTeam : team,
        invalidRecipient,
        kind !== 'inactive membership',
        kind !== 'ineligible',
      ],
    );
    await expectUnchangedAfterRefusal(invalidRecipient, 'SALES_CONSULTANT_NOT_ELIGIBLE');
  });

  it('refuses an actor without update or assignment authority', async () => {
    await db.exec("select set_config('test.can_update','false',false)");
    await expectUnchangedAfterRefusal(consultantB, 'PERMISSION_DENIED');
    await expect(candidates()).rejects.toThrow('PERMISSION_DENIED');
  });

  it('refuses a different Telecaller who cannot access this lead', async () => {
    await db.exec(`select set_config('test.actor','${randomUUID()}',false)`);
    await expectUnchangedAfterRefusal(consultantB, 'SCOPE_DENIED');
  });

  it('keeps customer-link and pending-follow-up guards on a manual override', async () => {
    await db.query('update public.leads set customer_id=null where id=$1', [enquiry]);
    await expectUnchangedAfterRefusal(consultantB, 'LEAD_CUSTOMER_REQUIRED');
    await db.query('update public.leads set customer_id=$1 where id=$2', [customer, enquiry]);
    await db.query(
      "insert into public.followups(organization_id,lead_id,status) values ($1,$2,'OPEN')",
      [org, enquiry],
    );
    await expectUnchangedAfterRefusal(consultantB, 'FOLLOWUP_PENDING_BEFORE_SALES_HANDOFF');
  });
});

describe('follow-up completion with a chosen Sales Consultant', () => {
  it('keeps five-argument automatic transfers working', async () => {
    const id = await addFollowup();
    const result = await db.query<{ result: Record<string, unknown> }>(
      "select public.complete_followup($1,1,'Ready for Sales',$2,'TRANSFER_TO_SALES') result",
      [id, randomUUID()],
    );
    expect(result.rows[0]!.result).toMatchObject({
      status: 'COMPLETED',
      handoff: { assigned_user_id: consultantA },
    });
  });

  it('replays a five-argument transfer completed before the migration', async () => {
    const id = await addFollowup();
    const request = randomUUID();
    await db.exec('drop function public.complete_followup(uuid,bigint,text,uuid,text,uuid)');
    await db.exec(
      workFunction(
        readFileSync('supabase/migrations/202609160014_add_followup_transfer_outcome.sql', 'utf8'),
        'public.complete_followup',
      ),
    );
    await db.query(
      "select public.complete_followup($1,1,'Ready for Sales',$2,'TRANSFER_TO_SALES')",
      [id, request],
    );
    await db.exec(readFileSync(followupMigrationPath, 'utf8'));
    const replay = await db.query<{ result: Record<string, unknown> }>(
      "select public.complete_followup($1,1,'Ready for Sales',$2,'TRANSFER_TO_SALES') result",
      [id, request],
    );
    expect(replay.rows[0]!.result).toMatchObject({ status: 'COMPLETED', replayed: true });
    expect((await db.query('select * from public.lead_assignment_history')).rows).toHaveLength(0);
  });

  it('returns an immediate version conflict and leaves both records unchanged', async () => {
    const id = await addFollowup();
    try {
      await db.query(
        "select public.complete_followup($1,99,'Ready for Sales',$2,'TRANSFER_TO_SALES',$3)",
        [id, randomUUID(), consultantB],
      );
      throw new Error('Expected version conflict');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PT409', message: 'WORK_VERSION_CONFLICT' });
    }
    expect(
      (await db.query('select status,version from public.followups where id=$1', [id])).rows,
    ).toEqual([{ status: 'OPEN', version: 1 }]);
    expect(
      (await db.query('select assigned_user_id from public.leads where id=$1', [enquiry])).rows,
    ).toEqual([{ assigned_user_id: caller }]);
  });

  it('completes the follow-up and transfers its lead to the chosen eligible consultant', async () => {
    const id = await addFollowup();
    expect(await completeAndTransfer(id, consultantB)).toMatchObject({
      status: 'COMPLETED',
      replayed: false,
    });
    const followup = await db.query(
      'select status,outcome,version from public.followups where id=$1',
      [id],
    );
    expect(followup.rows).toEqual([
      { status: 'COMPLETED', outcome: 'TRANSFER_TO_SALES', version: 2 },
    ]);
    const lead = await db.query('select assigned_user_id from public.leads where id=$1', [enquiry]);
    expect(lead.rows[0]).toEqual({ assigned_user_id: consultantB });
  });

  it('rolls back completion when the selected consultant is ineligible', async () => {
    const id = await addFollowup();
    await expect(completeAndTransfer(id, invalidRecipient)).rejects.toThrow(
      'SALES_CONSULTANT_NOT_ELIGIBLE',
    );
    const followup = await db.query('select status,version from public.followups where id=$1', [
      id,
    ]);
    expect(followup.rows).toEqual([{ status: 'OPEN', version: 1 }]);
    expect((await db.query('select * from public.audit_logs')).rows).toEqual([]);
    expect((await db.query('select * from public.activities')).rows).toEqual([]);
  });

  it('keeps the follow-up open when another open follow-up prevents the handoff', async () => {
    const id = await addFollowup();
    await addFollowup();
    await expect(completeAndTransfer(id, consultantB)).rejects.toThrow(
      'FOLLOWUP_PENDING_BEFORE_SALES_HANDOFF',
    );
    expect((await db.query('select status,version from public.followups')).rows).toEqual([
      { status: 'OPEN', version: 1 },
      { status: 'OPEN', version: 1 },
    ]);
  });

  it('replays a successful request without making another assignment and refuses a changed recipient', async () => {
    const id = await addFollowup();
    const requestId = randomUUID();
    await completeAndTransfer(id, consultantB, requestId);
    expect(await completeAndTransfer(id, consultantB, requestId)).toMatchObject({
      status: 'COMPLETED',
      replayed: true,
    });
    expect((await db.query('select * from public.lead_assignment_history')).rows).toHaveLength(1);
    await expect(completeAndTransfer(id, consultantA, requestId)).rejects.toThrow(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('refuses an unauthorized completion before either record changes', async () => {
    const id = await addFollowup();
    await db.exec("select set_config('test.can_update','false',false)");
    await expect(completeAndTransfer(id, consultantB)).rejects.toThrow('PERMISSION_DENIED');
    expect((await db.query('select status from public.followups where id=$1', [id])).rows).toEqual([
      { status: 'OPEN' },
    ]);
    expect((await db.query('select * from public.lead_assignment_history')).rows).toEqual([]);
  });
});
