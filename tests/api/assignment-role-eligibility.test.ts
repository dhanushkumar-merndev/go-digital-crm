import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const branch = randomUUID();
const team = randomUUID();
const manager = randomUUID();
const telecaller = randomUUID();
const consultant = randomUUID();
let db: PGlite;

// Only what assign_lead touches. The guard mirrors the deployed
// enforce_sales_lead_assignment rule: fresh to a Telecaller, qualified to a
// Sales Consultant.
const fixture = `
create role anon;
create role authenticated;
create schema auth;
create schema app_private;
create type public.assignment_mode as enum ('ROUND_ROBIN', 'MANUAL_ASSIGNMENT', 'LEAST_ASSIGNED');
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;
create function app_private.has_permission(uuid, text) returns boolean language sql stable as $$ select true $$;
create function app_private.can_access_record(uuid, uuid, uuid, uuid) returns boolean language sql stable as $$ select true $$;
create function app_private.claim_least_assigned_member(uuid, uuid, text) returns uuid language sql as $$ select null::uuid $$;
create table public.profiles (id uuid primary key, organization_id uuid, full_name text, active boolean default true, deleted_at timestamptz);
create table public.roles (id uuid primary key default gen_random_uuid(), organization_id uuid, role_key text);
create table public.user_role_assignments (
  organization_id uuid, user_id uuid, role_id uuid, active boolean default true
);
create table public.teams (
  id uuid primary key, organization_id uuid, branch_id uuid, active boolean default true,
  fresh_assignment_mode public.assignment_mode, qualified_assignment_mode public.assignment_mode
);
create table public.team_members (
  organization_id uuid, team_id uuid, user_id uuid, active boolean default true,
  eligible_for_fresh_leads boolean, eligible_for_qualified_leads boolean,
  joined_at timestamptz default now()
);
create table public.leads (
  id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid, team_id uuid,
  assigned_user_id uuid, lifecycle_status text default 'New', deleted_at timestamptz, updated_at timestamptz
);
create table public.lead_assignments (
  id uuid primary key default gen_random_uuid(), organization_id uuid, lead_id uuid, branch_id uuid,
  team_id uuid, assigned_user_id uuid, assignment_type text, method public.assignment_mode,
  assigned_by uuid, reason text, active boolean default true
);
create table public.lead_assignment_history (
  organization_id uuid, lead_id uuid, branch_id uuid, team_id uuid, previous_owner_id uuid,
  new_owner_id uuid, assigned_by uuid, method public.assignment_mode, reason text,
  created_at timestamptz default now()
);
create table public.audit_logs (
  organization_id uuid, actor_id uuid, action text, resource_type text, resource_id text,
  branch_id uuid, metadata jsonb
);
create function app_private.guard() returns trigger language plpgsql as $$
begin
  if new.assignment_type = 'FRESH' and not exists (
    select 1 from public.user_role_assignments a join public.roles r on r.id = a.role_id
    where a.user_id = new.assigned_user_id and a.active and r.role_key = 'telecaller_bdc'
  ) then
    raise exception using errcode = '23514', message = 'FRESH_ASSIGNMENT_REQUIRES_TELECALLER';
  end if;
  return new;
end $$;
create trigger guard before insert on public.lead_assignments
  for each row execute function app_private.guard();
`;

async function freshLead() {
  const result = await db.query<{ id: string }>(
    `insert into public.leads (organization_id, branch_id, team_id) values ($1, $2, $3) returning id`,
    [org, branch, team],
  );
  return result.rows[0]!.id;
}

async function assign(leadId: string, userId: string) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: manager }),
  ]);
  await db.query(`select public.assign_lead($1, $2, 'FRESH', 'test')`, [leadId, userId]);
  const owner = await db.query<{ assigned_user_id: string }>(
    `select assigned_user_id from public.leads where id = $1`,
    [leadId],
  );
  return owner.rows[0]!.assigned_user_id;
}

describe('assignment role eligibility (202610210012)', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(fixture);
    await db.exec(source('tests/api/fixtures/assignment-role-eligibility-base.sql'));
    await db.exec(source('supabase/migrations/202610210012_assignment_role_eligibility.sql'));
    await db.query(
      `insert into public.roles (id, organization_id, role_key) values
         ('00000000-0000-0000-0000-0000000000a1', $1, 'telecaller_bdc'),
         ('00000000-0000-0000-0000-0000000000a2', $1, 'sales_consultant')`,
      [org],
    );
    await db.query(
      `insert into public.profiles (id, organization_id, full_name) values
         ($2, $1, 'Telecaller'), ($3, $1, 'Consultant'), ($4, $1, 'Manager')`,
      [org, telecaller, consultant, manager],
    );
    await db.query(
      `insert into public.user_role_assignments (organization_id, user_id, role_id) values
         ($1, $2, '00000000-0000-0000-0000-0000000000a1'),
         ($1, $3, '00000000-0000-0000-0000-0000000000a2')`,
      [org, telecaller, consultant],
    );
    // The consultant joined first and has never been assigned, so the old
    // rotation picked them before the Telecaller.
    await db.query(
      `insert into public.team_members (organization_id, team_id, user_id, eligible_for_fresh_leads, eligible_for_qualified_leads, joined_at) values
         ($1, $2, $3, true, true, now() - interval '2 days'),
         ($1, $2, $4, true, false, now() - interval '1 day')`,
      [org, team, consultant, telecaller],
    );
  });

  beforeEach(async () => {
    await db.query(`delete from public.teams`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('round robin hands a fresh lead to a Telecaller, never a Sales Consultant', async () => {
    await db.query(
      `insert into public.teams values ($1, $2, $3, true, 'ROUND_ROBIN', 'ROUND_ROBIN')`,
      [team, org, branch],
    );
    // The browser sends the consultant it showed; round robin ignores it.
    expect(await assign(await freshLead(), consultant)).toBe(telecaller);
    expect(await assign(await freshLead(), consultant)).toBe(telecaller);
  });

  it('manual mode refuses a Sales Consultant for a fresh lead with a clear code', async () => {
    await db.query(
      `insert into public.teams values ($1, $2, $3, true, 'MANUAL_ASSIGNMENT', 'MANUAL_ASSIGNMENT')`,
      [team, org, branch],
    );
    await expect(assign(await freshLead(), consultant)).rejects.toThrow('ASSIGNEE_NOT_ELIGIBLE');
    expect(await assign(await freshLead(), telecaller)).toBe(telecaller);
  });

  it('round robin with no Telecaller in the team fails as not eligible', async () => {
    await db.query(`update public.user_role_assignments set active = false where user_id = $1`, [
      telecaller,
    ]);
    await db.query(
      `insert into public.teams values ($1, $2, $3, true, 'ROUND_ROBIN', 'ROUND_ROBIN')`,
      [team, org, branch],
    );
    await expect(assign(await freshLead(), consultant)).rejects.toThrow('ASSIGNEE_NOT_ELIGIBLE');
    await db.query(`update public.user_role_assignments set active = true where user_id = $1`, [
      telecaller,
    ]);
  });

  it('shows the queue the same role rule the assignment enforces', async () => {
    const definition = await db.query<{ d: string }>(
      `select pg_get_functiondef('app_private.build_lead_assignment_workspace(uuid,uuid,uuid[],text,integer,integer)'::regprocedure) as d`,
    );
    const body = definition.rows[0]!.d;
    expect(body).toMatch(/eligible_for_fresh_leads and exists[\s\S]*?'telecaller_bdc'/);
    expect(body).toMatch(/eligible_for_qualified_leads and exists[\s\S]*?'sales_consultant'/);
  });
});
