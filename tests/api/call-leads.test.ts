import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/202610090503_call_leads.sql', 'utf8');

const org = randomUUID();
const otherOrg = randomUUID();
const caller = randomUUID();
const colleague = randomUUID();
const phone = '+918593939234';

let db: PGlite;
let callId: string;
let primaryLead: string;
let siblingLead: string;
let colleagueLead: string;
let otherMobileLead: string;
let otherTenantLead: string;

async function addLead(owner: string, phoneValue = phone, tenant = org) {
  const result = await db.query<{ id: string }>(
    `insert into public.leads(organization_id, normalized_phone, assigned_user_id, interested_model)
     values ($1, $2, $3, 'Curvv') returning id`,
    [tenant, phoneValue, owner],
  );
  return result.rows[0]!.id;
}

const setLeads = (leadIds: string[], asUser = caller) =>
  db
    .exec(`select set_config('test.uid', '${asUser}', false)`)
    .then(() =>
      db.query<{ result: { changed: boolean; lead_ids: string[] } }>(
        'select public.set_call_leads($1, $2) as result',
        [callId, leadIds],
      ),
    );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    set check_function_bodies = off;
    create role anon; create role authenticated;
    create schema app_private; create schema auth;
    create function auth.uid() returns uuid language sql
      as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function app_private.current_tenant_organization() returns uuid language sql
      as $$ select '${org}'::uuid $$;
    create function app_private.can_access_call(uuid, uuid) returns boolean language sql
      as $$ select true $$;
    create function app_private.can_access_lead(uuid) returns boolean language sql
      as $$ select true $$;
    create table public.organizations(id uuid primary key);
    create table public.profiles(id uuid primary key);
    create table public.leads(id uuid primary key default gen_random_uuid(),
      organization_id uuid, customer_id uuid, normalized_phone text, assigned_user_id uuid,
      interested_model text, lifecycle_status text default 'New', source text default 'Manual',
      created_at timestamptz default now(), deleted_at timestamptz);
    create table public.calls(id uuid primary key default gen_random_uuid(),
      organization_id uuid, branch_id uuid, lead_id uuid, assigned_user_id uuid,
      started_at timestamptz default now());
    create table public.activities(organization_id uuid, customer_id uuid, lead_id uuid,
      activity_type text, actor_id uuid, metadata jsonb, occurred_at timestamptz);
    create table public.audit_logs(organization_id uuid, actor_id uuid, action text,
      resource_type text, resource_id text, branch_id uuid, metadata jsonb);
    insert into public.organizations values ('${org}'), ('${otherOrg}');
    insert into public.profiles values ('${caller}'), ('${colleague}');
  `);
  primaryLead = await addLead(caller);
  siblingLead = await addLead(caller);
  colleagueLead = await addLead(colleague);
  otherMobileLead = await addLead(caller, '+919000000001');
  otherTenantLead = await addLead(caller, phone, otherOrg);
  callId = (
    await db.query<{ id: string }>(
      `insert into public.calls(organization_id, lead_id, assigned_user_id)
       values ($1, $2, $3) returning id`,
      [org, primaryLead, caller],
    )
  ).rows[0]!.id;
  // Only the new table and functions are exercised; the patched readers need
  // the full schema and are covered by the live probes.
  await db.exec(migration.replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
}, 30000);

afterAll(async () => {
  await db?.close();
});

describe('get_call_lead_options', () => {
  it('lists the caller’s own leads on the same mobile, the call’s lead first', async () => {
    await db.exec(`select set_config('test.uid', '${caller}', false)`);
    const result = await db.query<{
      result: { can_edit: boolean; leads: { lead_id: string; is_primary: boolean }[] };
    }>('select public.get_call_lead_options($1, $2) as result', [primaryLead, callId]);
    const options = result.rows[0]!.result;
    expect(options.can_edit).toBe(true);
    expect(options.leads.map((lead) => lead.lead_id)).toEqual([primaryLead, siblingLead]);
    expect(options.leads[0]!.is_primary).toBe(true);
  });
});

describe('set_call_leads', () => {
  it('links an eligible lead once and treats a replay as no change', async () => {
    const first = await setLeads([siblingLead]);
    expect(first.rows[0]!.result).toMatchObject({ changed: true, lead_ids: [siblingLead] });
    const replay = await setLeads([siblingLead, primaryLead]);
    expect(replay.rows[0]!.result.changed).toBe(false);
  });

  it('rejects another person’s lead, another mobile and another tenant', async () => {
    for (const leadId of [colleagueLead, otherMobileLead, otherTenantLead]) {
      await expect(setLeads([leadId])).rejects.toThrow('CALL_LEAD_NOT_ELIGIBLE');
    }
  });

  it('only lets the person who made the call change it', async () => {
    await expect(setLeads([], colleague)).rejects.toThrow('CALL_OWNER_REQUIRED');
  });

  it('caps the number of extra leads at ten', async () => {
    const many = Array.from({ length: 11 }, () => randomUUID());
    await expect(setLeads(many)).rejects.toThrow('TOO_MANY_CALL_LEADS');
  });

  it('shows the call on each linked lead and records link history', async () => {
    const ids = await db.query<{ ids: string[] }>(
      'select app_private.lead_call_ids($1, $2) as ids',
      [org, siblingLead],
    );
    expect(ids.rows[0]!.ids).toEqual([callId]);

    await setLeads([]);
    const after = await db.query<{ ids: string[] }>(
      'select app_private.lead_call_ids($1, $2) as ids',
      [org, siblingLead],
    );
    expect(after.rows[0]!.ids).toEqual([]);
    const primaryIds = await db.query<{ ids: string[] }>(
      'select app_private.lead_call_ids($1, $2) as ids',
      [org, primaryLead],
    );
    expect(primaryIds.rows[0]!.ids).toEqual([callId]);

    const activity = await db.query<{ activity_type: string }>(
      'select activity_type from public.activities where lead_id = $1 order by occurred_at',
      [siblingLead],
    );
    expect(activity.rows.map((row) => row.activity_type)).toEqual(['CALL_LINKED', 'CALL_UNLINKED']);
  });
});

describe('lead-level call readers', () => {
  it('read linked calls through lead_call_ids', () => {
    for (const reader of [
      'app_private.lead_latest_call_summary_json',
      'public.get_lead_detail_workspace',
      'public.get_lead_journey',
      'public.get_lead_activity_page',
    ]) {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${reader}(`);
      expect(start).toBeGreaterThan(0);
      const body = migration.slice(start, migration.indexOf('$function$;', start));
      expect(body).toContain('app_private.lead_call_ids(');
      expect(body).not.toMatch(/call_row\.lead_id = (lead_row\.id|target_lead_id)/);
    }
  });
});
