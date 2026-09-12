import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(file, 'utf8');
const org = randomUUID();
const otherOrg = randomUUID();
const actor = randomUUID();
const otherUser = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const team = randomUUID();
let db: PGlite;

async function report(name = 'get_marketing_workspace_page', search = '', page = 1) {
  const result = await db.query<{
    result: { total: number; records: unknown[]; kpis: Record<string, number> };
  }>(`select public.${name}('SOURCES',$1,$2,25,'updated:desc','Asia/Kolkata') as result`, [
    search,
    page,
  ]);
  return result.rows[0].result;
}

describe('marketing performance aggregation', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/marketing-performance-base.sql'));
    const original = source('supabase/migrations/202608150030_marketing_workspace.sql');
    const fn = original.slice(
      original.indexOf('create or replace function public.get_marketing_workspace_page('),
      original.indexOf('alter table public.marketing_campaigns enable row level security;'),
    );
    await db.exec(
      fn.replace(
        'public.get_marketing_workspace_page(',
        'public.get_marketing_workspace_page_before(',
      ),
    );
    await db.exec(
      source('supabase/migrations/202609100001_optimize_marketing_performance_scope.sql'),
    );
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query(
      'insert into user_role_assignments(organization_id,user_id,data_scope,scope_branch_id,role_id) values($1,$2,$3,$4,$5)',
      [org, actor, 'ORGANIZATION', branchA, team],
    );
    for (const [organization, branch, owner, teamId, count] of [
      [org, branchA, actor, team, 1000],
      [org, branchB, otherUser, null, 20],
      [otherOrg, branchA, actor, team, 15],
    ] as const) {
      await db.query(
        "insert into leads(organization_id,branch_id,assigned_user_id,team_id,source,campaign) select $1,$2,$3,$4,'Manual','Fresh fixture' from generate_series(1,$5::integer)",
        [organization, branch, owner, teamId, count],
      );
    }
    await db.exec(
      "insert into bookings(organization_id,lead_id) select organization_id,id from leads where campaign='Fresh fixture' limit 1; insert into bookings(organization_id,lead_id) select organization_id,lead_id from bookings; insert into quotations(organization_id,lead_id,deleted_at) select organization_id,lead_id,now() from bookings; insert into test_drives(organization_id,lead_id) select organization_id,lead_id from bookings;",
    );
  }, 30_000);
  beforeEach(async () => {
    await db.query("select set_config('test.denied_permission','',false)");
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: actor }),
    ]);
    await db.exec(
      "update user_role_assignments set data_scope='ORGANIZATION'; update profiles set active=true;",
    );
  });
  afterAll(async () => db?.close());

  it.each(['ORGANIZATION', 'ONE_BRANCH', 'OWN_RECORDS', 'OWN_TEAM'])(
    'preserves the previous permission boundary and totals for %s',
    async (scope) => {
      await db.query('update user_role_assignments set data_scope=$1', [scope]);
      expect(await report()).toEqual(await report('get_marketing_workspace_page_before'));
      expect((await report()).kpis.leads_generated).toBe(scope === 'ORGANIZATION' ? 1020 : 1000);
    },
  );
  it('counts leads with sales events once, excluding deleted quotations and other tenants', async () => {
    const result = await report();
    expect(result.kpis.bookings).toBe(1);
    expect(result.records).toEqual([
      expect.objectContaining({ leads: 1020, bookings: 1, test_drives: 1, quotations: 0 }),
    ]);
  });
  it('keeps search and pagination server-side without inventing empty-state values', async () => {
    expect((await report(undefined, 'no-match')).kpis.leads_generated).toBe(0);
    const page = await report(undefined, 'Fresh fixture', 2);
    expect(page.records).toEqual([]);
    expect(page.total).toBe(1);
    expect(page.kpis.leads_generated).toBe(1020);
  });
  it('rejects inactive and unauthenticated actors', async () => {
    await db.exec('update profiles set active=false');
    await expect(report()).rejects.toThrow('MARKETING_VIEW_PERMISSION_REQUIRED');
    await db.query("select set_config('request.jwt.claims','{}',false)");
    await expect(report()).rejects.toThrow('MARKETING_VIEW_PERMISSION_REQUIRED');
  });
  it('rejects invalid pagination', async () => {
    await expect(report(undefined, '', 0)).rejects.toThrow('INVALID_MARKETING_QUERY');
  });
  it('requires lead visibility as well as marketing visibility', async () => {
    await db.query("select set_config('test.denied_permission','lead.view',false)");
    expect((await report()).kpis.leads_generated).toBe(0);
    expect(await report()).toEqual(await report('get_marketing_workspace_page_before'));
    await db.query("select set_config('test.denied_permission','marketing.view',false)");
    await expect(report()).rejects.toThrow('MARKETING_VIEW_PERMISSION_REQUIRED');
  });
  it('does not grant anonymous RPC access', async () => {
    const result = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('anon','public.get_marketing_workspace_page(text,text,integer,integer,text,text)','execute') as allowed",
    );
    expect(result.rows[0].allowed).toBe(false);
  });
});
