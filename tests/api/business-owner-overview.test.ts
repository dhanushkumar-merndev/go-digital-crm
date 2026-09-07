import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const owner = randomUUID();
const consultant = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
let db: PGlite;

async function claims(user: string) {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }),
  ]);
}
async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
  const result = await db.query<{ result: T }>(
    `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`,
    values,
  );
  return result.rows[0].result;
}
async function lead(branch: string, stage = 'New', src = 'Manual', assigned = consultant) {
  await db.query(
    'insert into leads(organization_id,branch_id,assigned_user_id,source,lifecycle_status) values($1,$2,$3,$4,$5::public.lead_lifecycle)',
    [org, branch, assigned, src, stage],
  );
}

describe('business owner overview pages', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/owner-overview-base.sql'));
    await db.exec(source('supabase/migrations/202609070201_business_owner_overview_pages.sql'));
    await db.query('insert into organizations(id) values($1)', [org]);
    for (const id of [owner, consultant])
      await db.query('insert into profiles(id,organization_id,full_name) values($1,$2,$3)', [
        id,
        org,
        id === owner ? 'Owner' : 'Asha Consultant',
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
    await claims(owner);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  describe('sales overview', () => {
    it('groups the pipeline by stage in one pass', async () => {
      await lead(branchA, 'New');
      await lead(branchA, 'New');
      await lead(branchA, 'Lost');
      const result = (await rpc('get_business_sales_overview', [30])) as {
        pipeline: Array<{ stage: string; leads: number }>;
        totals: { leads: number; lost: number };
      };
      expect(result.totals).toMatchObject({ leads: 3, lost: 1 });
      expect(result.pipeline.find((s) => s.stage === 'New')?.leads).toBe(2);
    });

    it('reports the source mix', async () => {
      await lead(branchA, 'New', 'Facebook');
      await lead(branchA, 'New', 'Website');
      await lead(branchA, 'New', 'Facebook');
      const result = (await rpc('get_business_sales_overview', [30])) as {
        sources: Array<{ source: string; leads: number }>;
      };
      expect(result.sources.find((s) => s.source === 'Facebook')?.leads).toBe(2);
    });

    it('names consultants and counts what they moved to sales', async () => {
      await lead(branchA, 'Transferred to Sales');
      await lead(branchA, 'New');
      const result = (await rpc('get_business_sales_overview', [30])) as {
        consultants: Array<{ name: string; leads: number; won: number }>;
      };
      expect(result.consultants[0]).toMatchObject({ name: 'Asha Consultant', leads: 2, won: 1 });
    });

    it('honours the window rather than counting all history', async () => {
      await lead(branchA);
      await db.query("update leads set created_at = now() - interval '90 days'");
      const result = (await rpc('get_business_sales_overview', [30])) as {
        totals: { leads: number };
      };
      expect(result.totals.leads).toBe(0);
    });

    it('rejects an out-of-range window instead of scanning everything', async () => {
      await expect(rpc('get_business_sales_overview', [5000])).rejects.toThrow(
        /INVALID_OVERVIEW_WINDOW/,
      );
    });
  });

  describe('showroom performance', () => {
    it('compares branches side by side, which the tenant dashboard cannot', async () => {
      await lead(branchA);
      await lead(branchA);
      await lead(branchB);
      await db.query('insert into bookings(organization_id,branch_id) values($1,$2)', [
        org,
        branchA,
      ]);
      await db.query('insert into test_drives(organization_id,branch_id) values($1,$2)', [
        org,
        branchB,
      ]);
      const result = (await rpc('get_business_showroom_performance', [30])) as {
        branches: Array<{ branch: string; leads: number; bookings: number; test_drives: number }>;
      };
      const mg = result.branches.find((b) => b.branch === 'MG Road');
      const wf = result.branches.find((b) => b.branch === 'Whitefield');
      expect(mg).toMatchObject({ leads: 2, bookings: 1, test_drives: 0 });
      expect(wf).toMatchObject({ leads: 1, bookings: 0, test_drives: 1 });
    });

    it('lists a branch with no activity rather than dropping it', async () => {
      const result = (await rpc('get_business_showroom_performance', [30])) as {
        branches: Array<{ branch: string; leads: number }>;
      };
      expect(result.branches).toHaveLength(2);
      expect(result.branches.every((b) => b.leads === 0)).toBe(true);
    });
  });

  describe('operations overview', () => {
    it('shows which desk the backlog is on, per department', async () => {
      await db.query(
        "insert into finance_cases(organization_id,branch_id,status) values($1,$2,'DOCUMENTS_PENDING'),($1,$2,'DISBURSED')",
        [org, branchA],
      );
      await db.query(
        "insert into rto_cases(organization_id,branch_id,status) values($1,$2,'NEW')",
        [org, branchA],
      );
      const result = (await rpc('get_business_operations_overview')) as {
        departments: Array<{
          department: string;
          total: number;
          open: number;
          statuses: Array<{ status: string; count: number }>;
        }>;
      };
      const finance = result.departments.find((d) => d.department === 'Finance');
      expect(finance).toMatchObject({ total: 2, open: 1 });
      expect(finance?.statuses.find((s) => s.status === 'DISBURSED')?.count).toBe(1);
      expect(result.departments.find((d) => d.department === 'RTO')).toMatchObject({ open: 1 });
    });

    it('counts by the statuses actually present, not a hardcoded list', async () => {
      // These tables carry no status CHECK constraint, so an unknown value must
      // still be reported rather than silently dropped.
      await db.query(
        "insert into finance_cases(organization_id,branch_id,status) values($1,$2,'AWAITING_LENDER')",
        [org, branchA],
      );
      const result = (await rpc('get_business_operations_overview')) as {
        departments: Array<{
          department: string;
          open: number;
          statuses: Array<{ status: string }>;
        }>;
      };
      const finance = result.departments.find((d) => d.department === 'Finance');
      expect(finance?.open).toBe(1);
      expect(finance?.statuses.map((s) => s.status)).toContain('AWAITING_LENDER');
    });
  });

  describe('scope and access', () => {
    it('limits every page to the branches the actor can reach', async () => {
      await db.query(
        "update user_role_assignments set data_scope='ONE_BRANCH', scope_branch_id=$1 where user_id=$2",
        [branchA, owner],
      );
      await lead(branchA);
      await lead(branchB);
      const sales = (await rpc('get_business_sales_overview', [30])) as {
        totals: { leads: number };
      };
      expect(sales.totals.leads).toBe(1);
      const showroom = (await rpc('get_business_showroom_performance', [30])) as {
        branches: Array<{ branch: string }>;
      };
      expect(showroom.branches.map((b) => b.branch)).toEqual(['MG Road']);
    });

    it('refuses a caller with no tenant context', async () => {
      await claims(randomUUID());
      await expect(rpc('get_business_operations_overview')).rejects.toThrow(
        /OWNER_OVERVIEW_ACCESS_REQUIRED/,
      );
    });
  });
});
