import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
const branch = randomUUID();
let db: PGlite;

async function claims(user: string, role = 'authenticated') {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, role, aal: 'aal2' }),
  ]);
}
async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
  const result = await db.query<{ result: T }>(
    `select public.${name}(${values.map((_, index) => `$${index + 1}`).join(',')}) as result`,
    values,
  );
  return result.rows[0].result;
}
async function approvedTemplate() {
  const id = randomUUID();
  await db.query(
    "insert into templates(id,organization_id,channel,name,content,status,created_by) values($1,$2,'EMAIL','T','{}'::jsonb,'DRAFT',$3)",
    [id, org, actor],
  );
  await claims(actor);
  await rpc('approve_template', [id, String(Math.floor(Math.random() * 1e9)), randomUUID()]);
  return id;
}
async function campaign(filter: unknown, templateId: string | null, steps = 2) {
  const id = randomUUID();
  await db.query(
    "insert into marketing_drip_campaigns(id,organization_id,name,audience_filter,status,created_by) values($1,$2,'Welcome',$3::jsonb,'ACTIVE',$4)",
    [id, org, JSON.stringify(filter), actor],
  );
  for (let index = 1; index <= steps; index += 1) {
    await db.query(
      "insert into marketing_drip_steps(organization_id,campaign_id,step_order,delay_hours,channel,message_body,template_id) values($1,$2,$3,$4,'EMAIL','Hi',$5)",
      [org, id, index, index === 1 ? 0 : 24, templateId],
    );
  }
  return id;
}
async function customer(lifecycle = 'New') {
  const id = randomUUID();
  await db.query(
    "insert into customers(id,organization_id,full_name,primary_email) values($1,$2,'C',$3)",
    [id, org, `c${id.slice(0, 8)}@example.com`],
  );
  await db.query(
    'insert into leads(id,organization_id,branch_id,customer_id,assigned_user_id,lifecycle_status) values($1,$2,$3,$4,$5,$6::public.lead_lifecycle)',
    [randomUUID(), org, branch, id, actor, lifecycle],
  );
  return id;
}

describe('drip auto-match enrolment', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(source('supabase/migrations/202609060002_template_approval_lifecycle.sql'));
    await db.exec(source('supabase/migrations/202609060003_customer_drip_dispatch.sql'));
    await db.exec(source('supabase/migrations/202609060010_drip_auto_match_enrolment.sql'));
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
    await claims(actor);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('enrols the matched audience and materialises every step', async () => {
    const template = await approvedTemplate();
    const id = await campaign({ lifecycle_status: ['New'] }, template, 2);
    await customer('New');
    await customer('New');
    await claims(actor, 'service_role');
    const result = await rpc<{ enrolled: number; messages: number }>('run_drip_auto_match', [
      id,
      500,
    ]);
    expect(result).toMatchObject({ enrolled: 2, messages: 4 });
  });

  it('schedules steps cumulatively rather than all at once', async () => {
    const template = await approvedTemplate();
    const id = await campaign({}, template, 2);
    await customer();
    await claims(actor, 'service_role');
    await rpc('run_drip_auto_match', [id, 500]);
    const rows = await db.query<{ step_order: number; scheduled_for: Date }>(
      'select step_order,scheduled_for from customer_drip_messages order by step_order',
    );
    expect(rows.rows).toHaveLength(2);
    const gapHours =
      (rows.rows[1].scheduled_for.getTime() - rows.rows[0].scheduled_for.getTime()) / 3_600_000;
    expect(Math.round(gapHours)).toBe(24);
  });

  it('honours the audience filter instead of enrolling everyone', async () => {
    const template = await approvedTemplate();
    const id = await campaign({ lifecycle_status: ['New'] }, template, 1);
    await customer('New');
    await customer('Lost');
    await claims(actor, 'service_role');
    const result = await rpc<{ enrolled: number }>('run_drip_auto_match', [id, 500]);
    expect(result.enrolled).toBe(1);
  });

  it('is safe to run on a schedule: a second pass adds nobody', async () => {
    const template = await approvedTemplate();
    const id = await campaign({}, template, 1);
    await customer();
    await claims(actor, 'service_role');
    await rpc('run_drip_auto_match', [id, 500]);
    const second = await rpc<{ enrolled: number }>('run_drip_auto_match', [id, 500]);
    expect(second.enrolled).toBe(0);
  });

  it('picks up only the newly matching on a later pass', async () => {
    const template = await approvedTemplate();
    const id = await campaign({}, template, 1);
    await customer();
    await claims(actor, 'service_role');
    await rpc('run_drip_auto_match', [id, 500]);
    await claims(actor);
    await customer();
    await claims(actor, 'service_role');
    const second = await rpc<{ enrolled: number }>('run_drip_auto_match', [id, 500]);
    expect(second.enrolled).toBe(1);
  });

  it('refuses a campaign whose steps have no approved template', async () => {
    // Otherwise auto-match would mass-produce messages the dispatcher can only fail.
    const id = await campaign({}, null, 1);
    await customer();
    await claims(actor, 'service_role');
    await expect(rpc('run_drip_auto_match', [id, 500])).rejects.toThrow(
      /DRIP_CAMPAIGN_TEMPLATE_NOT_APPROVED/,
    );
  });

  it('produces messages the dispatcher can immediately claim', async () => {
    const template = await approvedTemplate();
    const id = await campaign({}, template, 1);
    await customer();
    await claims(actor, 'service_role');
    await rpc('run_drip_auto_match', [id, 500]);
    const claimed = await db.query<{ template_provider_id: string }>(
      'select * from public.claim_due_drip_messages($1,$2)',
      ['worker:test', 10],
    );
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0].template_provider_id).toBeTruthy();
  });

  it('caps how many it enrols in one pass', async () => {
    const template = await approvedTemplate();
    const id = await campaign({}, template, 1);
    await customer();
    await customer();
    await customer();
    await claims(actor, 'service_role');
    const result = await rpc<{ enrolled: number }>('run_drip_auto_match', [id, 2]);
    expect(result.enrolled).toBe(2);
  });

  it('lets one broken campaign not stop the rest of the scheduled sweep', async () => {
    const template = await approvedTemplate();
    await campaign({}, null, 1);
    const good = await campaign({}, template, 1);
    await customer();
    await claims(actor, 'service_role');
    const result = await rpc<{ enrolled: number; skipped: number }>(
      'run_all_drip_auto_matches',
      [500],
    );
    expect(result.skipped).toBe(1);
    expect(result.enrolled).toBeGreaterThan(0);
    expect(good).toBeTruthy();
  });

  it('stays off limits to ordinary callers', async () => {
    await expect(rpc('run_all_drip_auto_matches', [500])).rejects.toThrow(/SERVICE_ROLE_REQUIRED/);
  });
});
