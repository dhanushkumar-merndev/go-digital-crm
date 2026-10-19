import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const otherOrg = randomUUID();
const consultant = randomUUID();
const colleague = randomUUID();
const branch = randomUUID();
const customer = randomUUID();
const lead = randomUUID();
const leadWithoutCustomer = randomUUID();
const colleagueLead = randomUUID();
let db: PGlite;

type Created = { feedback_id: string; token: string; reused: boolean; branch: string };
type Workspace = {
  kpis: Record<string, number | string | null>;
  ratings: { rating: number; count: number }[];
  daily: { day: string; sent: number; filled: number }[];
  total: number;
  records: Record<string, unknown>[];
};

async function claims(user: string | null, role = 'authenticated') {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    user || role === 'service_role' ? JSON.stringify({ sub: user, role }) : '',
  ]);
}
async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
  const result = await db.query<{ result: T }>(
    `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`,
    values,
  );
  return result.rows[0].result;
}
// A raised error aborts the test transaction; a savepoint keeps it usable.
async function rejects(promise: () => Promise<unknown>, message: string) {
  await db.exec('savepoint expected_failure');
  await expect(promise()).rejects.toThrow(message);
  await db.exec('rollback to savepoint expected_failure');
}
const today = () => new Date().toISOString().slice(0, 10);
const workspace = (view = 'ALL', search = '') =>
  rpc<Workspace>('get_my_review_requests', [today(), today(), view, search, 1, 25]);

describe('lead review requests', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/public-feedback-base.sql'));
    await db.exec(source('supabase/migrations/202609070202_public_feedback_forms.sql'));
    await db.exec(source('tests/api/fixtures/branch-feedback-branding-base.sql'));
    await db.exec(source('supabase/migrations/202610142271_branch_feedback_branding.sql'));
    await db.exec(source('tests/api/fixtures/lead-review-requests-base.sql'));
    await db.exec(source('supabase/migrations/202610182000_lead_review_requests.sql'));
    await db.query("insert into organizations(id,name) values($1,'Demo Motors'),($2,'Other')", [
      org,
      otherOrg,
    ]);
    await db.query(
      "insert into profiles(id,organization_id,full_name) values($1,$3,'Rahul Sharma'),($2,$3,'Sneha')",
      [consultant, colleague, org],
    );
    await db.query(
      "insert into branches(id,organization_id,name,google_review_url) values($1,$2,'MG Road','https://g.page/r/demo/review')",
      [branch, org],
    );
    await db.query(
      "insert into customers(id,organization_id,full_name,primary_phone) values($1,$2,'Asha Rao','9876543210')",
      [customer, org],
    );
    await db.query(
      `insert into leads(id,organization_id,branch_id,customer_id,customer_name,phone,normalized_phone,interested_model,assigned_user_id)
       values($1,$4,$5,$6,'Asha Rao','9876543210','919876543210','Elevate',$7),
             ($2,$4,$5,null,'New Lead','9000000001','919000000001','City',$7),
             ($3,$4,$5,$6,'Asha Rao','9876543210','919876543210','City',$8)`,
      [lead, leadWithoutCustomer, colleagueLead, org, branch, customer, consultant, colleague],
    );
    await db.query(
      `insert into connected_accounts(organization_id,provider_key,scope_mode,status,connection_config)
       values($1,'openrouter','ALL_BRANCHES','CONNECTED','{"capabilities":["TEXT_GENERATION"],"models":{"text_model":"m"}}')`,
      [org],
    );
    await db.query(
      "insert into credit_ledger(organization_id,ledger_kind,transaction_type,amount,reference_id) values($1,'AI','ALLOCATION',2,'grant')",
      [org],
    );
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
    await claims(consultant);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('sends a request for an own lead and counts it for the sender', async () => {
    const created = await rpc<Created>('create_lead_review_request', [lead, null, 'WHATSAPP']);
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created).toMatchObject({ reused: false, branch: 'MG Road' });
    const audit = await db.query<{ actor_id: string }>(
      "select actor_id from audit_logs where action='feedback_request.link_issued' and resource_id=$1",
      [created.feedback_id],
    );
    expect(audit.rows[0].actor_id).toBe(consultant);
    const mine = await workspace();
    expect(mine.kpis).toMatchObject({ sent: 1, filled: 0, awaiting: 1 });
    expect(mine.records[0]).toMatchObject({ customer_name: 'Asha Rao', state: 'AWAITING' });
    expect(mine.daily.at(-1)).toMatchObject({ sent: 1 });
  });

  it('resends to the same lead by reissuing one open request', async () => {
    const first = await rpc<Created>('create_lead_review_request', [lead, null, 'WHATSAPP']);
    const second = await rpc<Created>('create_lead_review_request', [null, customer, 'SMS']);
    expect(second.feedback_id).toBe(first.feedback_id);
    expect(second.reused).toBe(true);
    expect(second.token).not.toBe(first.token);
    expect(await rpc('get_public_feedback_form', [first.token])).toMatchObject({
      status: 'INVALID',
    });
    expect((await workspace()).kpis.sent).toBe(1);
  });

  it('asks a new lead with no customer, and records a low rating without a care case', async () => {
    const created = await rpc<Created & { customer_name: string; phone: string }>(
      'create_lead_review_request',
      [leadWithoutCustomer, null, 'WHATSAPP'],
    );
    expect(created).toMatchObject({ customer_name: 'New Lead', phone: '9000000001' });
    await claims(null, 'anon');
    expect(
      await rpc('submit_public_feedback_review', [created.token, 2, 'Nobody called back.', []]),
    ).toMatchObject({ status: 'RECORDED', rating: 2 });
    const audit = await db.query<{ action: string }>(
      'select action from audit_logs where resource_id=$1 order by id',
      [created.feedback_id],
    );
    expect(audit.rows.map((row) => row.action)).toContain('feedback.rating_without_customer');
    await claims(consultant);
    const mine = await workspace('FILLED');
    expect(mine.kpis).toMatchObject({ filled: 1, low_rating: 1 });
    expect(mine.records[0]).toMatchObject({ customer_name: 'New Lead', customer_id: null });
    await rejects(
      () => rpc('approve_feedback_review_invite', [created.feedback_id, 'Hi', randomUUID()]),
      'REVIEW_INVITE_CUSTOMER_REQUIRED',
    );
  });

  it('refuses a lead outside record scope', async () => {
    await rejects(
      () => rpc('create_lead_review_request', [colleagueLead, null, 'WHATSAPP']),
      'REVIEW_LEAD_NOT_ACCESSIBLE',
    );
    await rejects(
      () => rpc('create_lead_review_request', [lead, null, 'EMAIL']),
      'INVALID_REVIEW_CHANNEL',
    );
    await claims(null);
    await rejects(
      () => rpc('create_lead_review_request', [lead, null, 'LINK']),
      'REVIEW_REQUEST_ACCESS_REQUIRED',
    );
  });

  it('shows the form the review step, then records the review and the Google hand-off', async () => {
    const { token } = await rpc<Created>('create_lead_review_request', [lead, null, 'LINK']);
    await claims(null, 'anon');
    const form = await rpc<Record<string, unknown>>('get_public_feedback_form', [token]);
    expect(form).toMatchObject({
      status: 'OPEN',
      sender_first_name: 'Rahul',
      ai_available: true,
      ai_remaining: 5,
    });
    expect(JSON.stringify(form)).not.toContain('Asha');
    const result = await rpc('submit_public_feedback_review', [
      token,
      5,
      'Rahul explained everything patiently.',
      ['Friendly staff', 'Made up keyword'],
    ]);
    expect(result).toEqual({
      status: 'RECORDED',
      rating: 5,
      review_url: 'https://g.page/r/demo/review',
    });
    expect(await rpc('submit_public_feedback_review', [token, 1, 'again', []])).toEqual({
      status: 'INVALID',
    });
    await claims(consultant);
    const mine = await workspace('FILLED');
    expect(mine.kpis).toMatchObject({ filled: 1, five_star: 1, sent_to_google: 1 });
    expect(mine.records[0]).toMatchObject({
      rating: 5,
      comments: 'Rahul explained everything patiently.',
      keywords: ['Friendly staff'],
      sent_to_google: true,
    });
    expect(mine.ratings.find((row) => row.rating === 5)?.count).toBe(1);
  });

  it('charges one AI credit per rephrase, replays a retry and refunds a failure', async () => {
    const { token, feedback_id } = await rpc<Created>('create_lead_review_request', [
      lead,
      null,
      'LINK',
    ]);
    await claims(null, 'anon');
    await rejects(
      () => rpc('begin_public_review_rephrase', [token, randomUUID()]),
      'SERVICE_ROLE_REQUIRED',
    );
    await claims(null, 'service_role');
    const request = randomUUID();
    expect(await rpc('begin_public_review_rephrase', [token, request])).toMatchObject({
      replayed: false,
      branch: 'MG Road',
      sender_first_name: 'Rahul',
    });
    expect(await rpc('begin_public_review_rephrase', [token, request])).toMatchObject({
      replayed: true,
    });
    const balance = async () =>
      Number(
        (
          await db.query<{ total: string }>(
            "select sum(amount) total from credit_ledger where organization_id=$1 and ledger_kind='AI'",
            [org],
          )
        ).rows[0].total,
      );
    expect(await balance()).toBe(1);
    expect(await rpc('refund_public_review_rephrase', [token, request])).toBe(true);
    expect(await rpc('refund_public_review_rephrase', [token, request])).toBe(false);
    expect(await balance()).toBe(2);
    const count = await db.query<{ ai_rephrase_count: number }>(
      'select ai_rephrase_count from feedback_requests where id=$1',
      [feedback_id],
    );
    expect(count.rows[0].ai_rephrase_count).toBe(0);
    await rpc('begin_public_review_rephrase', [token, randomUUID()]);
    await rpc('begin_public_review_rephrase', [token, randomUUID()]);
    await rejects(
      () => rpc('begin_public_review_rephrase', [token, randomUUID()]),
      'INSUFFICIENT_CREDITS',
    );
  });

  it('lists only the caller’s own leads in the picker and only their requests', async () => {
    const picked = await rpc<{ lead_id: string; has_customer: boolean }[]>(
      'search_review_request_leads',
      ['asha'],
    );
    expect(picked.map((row) => row.lead_id)).toEqual([lead]);
    expect(
      (await rpc<{ lead_id: string }[]>('search_review_request_leads', ['90000'])).map(
        (row) => row.lead_id,
      ),
    ).toEqual([leadWithoutCustomer]);
    await rpc('create_lead_review_request', [lead, null, 'LINK']);
    await claims(colleague);
    expect((await workspace()).kpis.sent).toBe(0);
    await rejects(
      () => rpc('get_my_review_requests', ['2026-01-01', '2027-12-31', 'ALL', '', 1, 25]),
      'INVALID_REVIEW_RANGE',
    );
  });
});
