import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultLeadQuery,
  parseLeadQuery,
  toLeadQueryString,
} from '../../src/features/leads/lead-workspace-query';
import {
  defaultWorkQuery,
  parseWorkQuery,
  toWorkQueryString,
} from '../../src/features/work/workspace-query';

const MIGRATION = 'supabase/migrations/202610100471_lead_buyer_type_company.sql';
const org = randomUUID();
const actor = randomUUID();
const customer = randomUUID();
const lead = randomUUID();
const siblingLead = randomUUID();
const strangerLead = randomUUID();
let db: PGlite;

const migration = readFileSync(MIGRATION, 'utf8');

/** Schema and RPCs only; the rest of the migration patches deployed functions. */
function buyerTypeSlice() {
  const start = migration.indexOf('-- --- 1. Buyer type on the lead');
  const end = migration.indexOf('-- --- 4. Patch the deployed readers');
  if (start < 0 || end < 0) throw new Error('migration markers moved');
  return migration.slice(start, end);
}

const company = {
  company_name: '  Sharma Logistics Pvt Ltd ',
  company_type: 'Private Limited',
  gstin: '29abcps1234k1z5',
  pan: 'abcps1234k',
  company_email: 'Accounts@Sharma.example',
  funding_mode: 'LEASE',
  lease_type: 'OPERATING',
  lessor_name: 'ORIX',
  lease_tenure_months: 48,
};

async function register(
  target: string,
  buyerType: string,
  expectedVersion: number | null,
  payload: Record<string, unknown> | null,
  request = randomUUID(),
) {
  const result = await db.query<{
    result: { lead_id: string; buyer_type: string; version: number | null; replayed: boolean };
  }>('select public.set_lead_buyer_type($1,$2,$3,$4::jsonb,$5) as result', [
    target,
    buyerType,
    expectedVersion,
    payload === null ? null : JSON.stringify(payload),
    request,
  ]);
  return result.rows[0].result;
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('expected the call to fail');
}

describe('set_lead_buyer_type', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema app_private;
      create function auth.uid() returns uuid language sql as
        $$select nullif(current_setting('request.test_uid', true), '')::uuid$$;
      create function app_private.has_permission(uuid, text) returns boolean language sql as
        $$select current_setting('request.test_permitted', true) = 'true'$$;
      create function app_private.can_access_record(uuid, uuid, uuid, uuid) returns boolean language sql as
        $$select current_setting('request.test_in_scope', true) = 'true'$$;
      create function app_private.can_access_lead(target uuid) returns boolean language sql as
        $$select target::text <> current_setting('request.test_hidden_lead', true)$$;
      create table organizations(id uuid primary key);
      create table profiles(id uuid primary key);
      create table leads(id uuid primary key, organization_id uuid, branch_id uuid, team_id uuid,
        customer_id uuid, assigned_user_id uuid, normalized_phone text not null default '',
        updated_at timestamptz not null default now(), deleted_at timestamptz,
        unique (organization_id, id));
      create table activities(organization_id uuid, customer_id uuid, lead_id uuid, activity_type text,
        actor_id uuid, metadata jsonb);
      create table audit_logs(organization_id uuid, actor_id uuid, action text, resource_type text,
        resource_id text, branch_id uuid, request_id uuid, metadata jsonb);
    `);
    await db.exec(`set search_path = public, pg_catalog; ${buyerTypeSlice()}`);
    await db.query('insert into organizations(id) values ($1)', [org]);
    await db.query('insert into profiles(id) values ($1)', [actor]);
    await db.query(
      `insert into leads(id, organization_id, branch_id, customer_id, assigned_user_id, normalized_phone)
       values ($1,$2,$3,$4,$5,'+919845012345'), ($6,$2,$3,$4,$5,'+919845012345'), ($7,$2,$3,null,$5,'+919000000000')`,
      [lead, org, randomUUID(), customer, actor, siblingLead, strangerLead],
    );
  });

  beforeEach(async () => {
    await db.exec(`
      select set_config('request.test_uid', '${actor}', false);
      select set_config('request.test_permitted', 'true', false);
      select set_config('request.test_in_scope', 'true', false);
      select set_config('request.test_hidden_lead', '', false);
      delete from lead_company_profiles; delete from audit_logs; delete from activities;
      update leads set buyer_type = 'INDIVIDUAL';
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  it('defaults every lead to an individual', async () => {
    const rows = await db.query<{ buyer_type: string }>('select distinct buyer_type from leads');
    expect(rows.rows).toEqual([{ buyer_type: 'INDIVIDUAL' }]);
  });

  it('registers a company, normalising its tax ids, and marks only that lead', async () => {
    const result = await register(lead, 'COMPANY', null, company);
    expect(result).toMatchObject({ buyer_type: 'COMPANY', version: 1, replayed: false });
    const profile = await db.query<Record<string, unknown>>(
      'select company_name, gstin, pan, company_email, funding_mode, lessor_name, lease_tenure_months from lead_company_profiles where lead_id = $1',
      [lead],
    );
    expect(profile.rows[0]).toEqual({
      company_name: 'Sharma Logistics Pvt Ltd',
      gstin: '29ABCPS1234K1Z5',
      pan: 'ABCPS1234K',
      company_email: 'accounts@sharma.example',
      funding_mode: 'LEASE',
      lessor_name: 'ORIX',
      lease_tenure_months: 48,
    });
    // One lead is one vehicle: the sibling lead of the same customer is untouched.
    const types = await db.query<{ id: string; buyer_type: string }>(
      'select id, buyer_type from leads where id = any($1)',
      [[lead, siblingLead]],
    );
    expect(Object.fromEntries(types.rows.map((row) => [row.id, row.buyer_type]))).toEqual({
      [lead]: 'COMPANY',
      [siblingLead]: 'INDIVIDUAL',
    });
    const audit = await db.query<{ metadata: { before: { buyer_type: string } } }>(
      `select metadata from audit_logs where action = 'lead.buyer_type_updated'`,
    );
    expect(audit.rows[0].metadata.before.buyer_type).toBe('INDIVIDUAL');
  });

  it('drops lease details when the vehicle is not leased', async () => {
    await register(lead, 'COMPANY', null, { ...company, funding_mode: 'LOAN' });
    const profile = await db.query<Record<string, unknown>>(
      'select funding_mode, lease_type, lessor_name, lease_tenure_months from lead_company_profiles',
    );
    expect(profile.rows[0]).toEqual({
      funding_mode: 'LOAN',
      lease_type: null,
      lessor_name: null,
      lease_tenure_months: null,
    });
  });

  it('rejects a missing name, a malformed GSTIN or PAN and an unknown lease type', async () => {
    const message = async (payload: Record<string, unknown>) =>
      (await errorOf(register(lead, 'COMPANY', null, payload))).message;
    expect(await message({ company_name: ' ' })).toBe('LEAD_COMPANY_NAME_REQUIRED');
    expect(await message({ company_name: 'X Co', gstin: '123' })).toBe(
      'LEAD_COMPANY_GSTIN_INVALID',
    );
    expect(await message({ company_name: 'X Co', pan: '123' })).toBe('LEAD_COMPANY_PAN_INVALID');
    expect(await message({ company_name: 'X Co', funding_mode: 'LEASE', lease_type: 'RENT' })).toBe(
      'LEAD_COMPANY_LEASE_INVALID',
    );
    expect((await errorOf(register(lead, 'FLEET', null, company))).message).toBe(
      'LEAD_BUYER_TYPE_INVALID',
    );
  });

  it('replays an idempotent request and rejects a stale version with PT409', async () => {
    const request = randomUUID();
    await register(lead, 'COMPANY', null, company, request);
    const replay = await register(lead, 'COMPANY', null, { company_name: 'Other Co' }, request);
    expect(replay).toMatchObject({ version: 1, replayed: true });
    expect((await errorOf(register(lead, 'COMPANY', null, company))).code).toBe('PT409');
    expect((await errorOf(register(lead, 'COMPANY', 7, company))).code).toBe('PT409');
    expect((await register(lead, 'COMPANY', 1, company)).version).toBe(2);
  });

  it('keeps the company when the lead goes back to an individual', async () => {
    await register(lead, 'COMPANY', null, company);
    const back = await register(lead, 'INDIVIDUAL', 1, null);
    expect(back).toMatchObject({ buyer_type: 'INDIVIDUAL', version: 1 });
    const kept = await db.query('select 1 from lead_company_profiles where lead_id = $1', [lead]);
    expect(kept.rows).toHaveLength(1);
    expect((await errorOf(register(lead, 'INDIVIDUAL', 1, null))).message).toBe(
      'LEAD_BUYER_TYPE_UNCHANGED',
    );
    const activity = await db.query<{ activity_type: string }>(
      'select activity_type from activities',
    );
    expect(activity.rows.map((row) => row.activity_type)).toEqual([
      'LEAD_REGISTERED_AS_COMPANY',
      'LEAD_REGISTERED_AS_INDIVIDUAL',
    ]);
  });

  it('denies a caller without lead.update or outside the record scope', async () => {
    await db.exec(`select set_config('request.test_permitted', 'false', false)`);
    expect((await errorOf(register(lead, 'COMPANY', null, company))).message).toBe(
      'PERMISSION_DENIED',
    );
    await db.exec(`
      select set_config('request.test_permitted', 'true', false);
      select set_config('request.test_in_scope', 'false', false);
    `);
    expect((await errorOf(register(lead, 'COMPANY', null, company))).message).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('suggests the company of a sibling lead, without funding, and only from visible leads', async () => {
    const suggest = async (target: string) =>
      (
        await db.query<{ result: Record<string, unknown> | null }>(
          'select public.get_lead_company_suggestion($1) as result',
          [target],
        )
      ).rows[0].result;
    await register(lead, 'COMPANY', null, company);
    const suggestion = await suggest(siblingLead);
    expect(suggestion).toMatchObject({
      source_lead_id: lead,
      company_name: 'Sharma Logistics Pvt Ltd',
      gstin: '29ABCPS1234K1Z5',
    });
    expect(suggestion).not.toHaveProperty('funding_mode');
    expect(suggestion).not.toHaveProperty('lessor_name');
    // A lead never suggests its own company, nor one from an unrelated customer.
    expect(await suggest(lead)).toBeNull();
    expect(await suggest(strangerLead)).toBeNull();
    // A sibling the caller cannot see is not a source.
    await db.exec(`select set_config('request.test_hidden_lead', '${lead}', false)`);
    expect(await suggest(siblingLead)).toBeNull();
  });
});

describe('buyer type list filter', () => {
  it('patches every lead and follow-up reader with a defaulted trailing argument', () => {
    for (const reader of [
      'app_private.get_sales_role_lead_workspace_page(',
      'public.get_lead_workspace_page_v2_legacy(',
      'public.get_lead_workspace_page_v2(',
      'get_sales_consultant_followup_workspace_filtered_page',
      'get_telecaller_followup_workspace_filtered_page',
      'app_private.get_scoped_followup_workspace_filtered_page(',
      'public.get_followup_workspace_filtered_page(',
    ])
      expect(migration).toContain(reader);
    // Defaulted, so a caller that predates the filter (the mobile app) still resolves.
    expect(migration.match(/target_buyer_type text DEFAULT 'all'::text\)\$n\$/g)).toHaveLength(6);
    // The functions are patched from their deployed text, never re-emitted.
    expect(migration).toContain('pg_get_functiondef(target)');
    expect(migration).not.toMatch(/create or replace function app_private\.get_sales_role/i);
    // A follow-up without a lead belongs to a person.
    expect(migration).toContain("coalesce(lead_row.buyer_type::text, 'INDIVIDUAL')");
  });

  it('round-trips the lead list filter through the URL and ignores unknown values', () => {
    const query = { ...defaultLeadQuery, buyerType: 'COMPANY' as const };
    expect(toLeadQueryString(query)).toBe('buyer=COMPANY');
    expect(parseLeadQuery(new URLSearchParams('buyer=COMPANY')).buyerType).toBe('COMPANY');
    expect(parseLeadQuery(new URLSearchParams('buyer=FLEET')).buyerType).toBe('all');
    expect(toLeadQueryString(defaultLeadQuery)).toBe('');
  });

  it('applies the follow-up filter to follow-ups only', () => {
    const query = { ...defaultWorkQuery, buyerType: 'INDIVIDUAL' as const };
    expect(toWorkQueryString(query)).toBe('buyer=INDIVIDUAL');
    expect(parseWorkQuery(new URLSearchParams('buyer=INDIVIDUAL'), 'followups').buyerType).toBe(
      'INDIVIDUAL',
    );
    expect(parseWorkQuery(new URLSearchParams('buyer=INDIVIDUAL'), 'appointments').buyerType).toBe(
      'all',
    );
  });

  it('sends the filter from both list requests', () => {
    expect(readFileSync('src/features/leads/lead-workspace-api.ts', 'utf8')).toContain(
      'target_buyer_type: query.buyerType',
    );
    expect(readFileSync('src/features/work/workspace-api.ts', 'utf8')).toContain(
      'parameters.target_buyer_type = query.buyerType',
    );
  });
});
