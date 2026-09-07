import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const staff = randomUUID();
const branch = randomUUID();
const customer = randomUUID();
let db: PGlite;

async function claims(user: string | null) {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    user ? JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }) : '',
  ]);
}
async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
  const result = await db.query<{ result: T }>(
    `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`,
    values,
  );
  return result.rows[0].result;
}
async function feedbackRequest() {
  const row = await db.query<{ id: string }>(
    'insert into feedback_requests(organization_id,branch_id,customer_id) values($1,$2,$3) returning id',
    [org, branch, customer],
  );
  return row.rows[0].id;
}
async function issuedToken() {
  const id = await feedbackRequest();
  await claims(staff);
  const result = await rpc<{ token: string }>('issue_feedback_form_link', [id, 30]);
  return { id, token: result.token };
}

describe('public feedback form', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/public-feedback-base.sql'));
    await db.exec(source('supabase/migrations/202609070202_public_feedback_forms.sql'));
    await db.query("insert into organizations(id,name) values($1,'Demo Motors')", [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [staff, org]);
    await db.query("insert into branches(id,organization_id,name) values($1,$2,'MG Road')", [
      branch,
      org,
    ]);
    await db.query('insert into customers(id,organization_id) values($1,$2)', [customer, org]);
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
    await claims(staff);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('issues a long random token, not a guessable identifier', async () => {
    const { token } = await issuedToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets an anonymous visitor open the form with only the token', async () => {
    const { token } = await issuedToken();
    await claims(null);
    const form = await rpc('get_public_feedback_form', [token]);
    expect(form).toMatchObject({ status: 'OPEN', branch: 'MG Road', organization: 'Demo Motors' });
  });

  it('exposes no customer data to a token holder', async () => {
    // A leaked link must not become a way to read who the customer is.
    const { token } = await issuedToken();
    await claims(null);
    const form = (await rpc('get_public_feedback_form', [token])) as Record<string, unknown>;
    expect(Object.keys(form).sort()).toEqual(['branch', 'organization', 'status']);
  });

  it('rejects a malformed or unknown token without revealing which', async () => {
    await claims(null);
    expect(await rpc('get_public_feedback_form', ['nope'])).toMatchObject({ status: 'INVALID' });
    expect(await rpc('get_public_feedback_form', ['a'.repeat(64)])).toMatchObject({
      status: 'INVALID',
    });
  });

  it("records the customer's own rating", async () => {
    const { id, token } = await issuedToken();
    await claims(null);
    const result = await rpc('submit_public_feedback', [token, 5, 'Great handover']);
    expect(result).toMatchObject({ status: 'RECORDED', rating: 5 });
    const row = await db.query<{ rating: number; status: string }>(
      'select rating,status from feedback_requests where id=$1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ rating: 5, status: 'COMPLETED' });
  });

  it('spends the token so the link cannot be replayed', async () => {
    const { token } = await issuedToken();
    await claims(null);
    await rpc('submit_public_feedback', [token, 5, 'Great']);
    expect(await rpc('submit_public_feedback', [token, 1, 'again'])).toMatchObject({
      status: 'INVALID',
    });
  });

  it('returns the review link for every rating, not only happy ones', async () => {
    // Withholding it from unhappy customers is review gating, which Google's
    // policy prohibits.
    await db.query('update branches set google_review_url=$2 where id=$1', [
      branch,
      'https://g.page/r/demo/review',
    ]);
    const low = await issuedToken();
    await claims(null);
    const lowResult = (await rpc('submit_public_feedback', [low.token, 1, 'Poor'])) as {
      review_url: string;
    };
    expect(lowResult.review_url).toBe('https://g.page/r/demo/review');
  });

  it('prefers the branch listing over the organization fallback', async () => {
    await db.query('update organizations set google_review_url=$2 where id=$1', [
      org,
      'https://g.page/r/org/review',
    ]);
    await db.query('update branches set google_review_url=$2 where id=$1', [
      branch,
      'https://g.page/r/branch/review',
    ]);
    const { token } = await issuedToken();
    await claims(null);
    const result = (await rpc('submit_public_feedback', [token, 4, 'Good'])) as {
      review_url: string;
    };
    expect(result.review_url).toBe('https://g.page/r/branch/review');
  });

  it('refuses an expired link', async () => {
    const { id, token } = await issuedToken();
    await db.query(
      "update feedback_requests set token_expires_at = now() - interval '1 day' where id=$1",
      [id],
    );
    await claims(null);
    expect(await rpc('get_public_feedback_form', [token])).toMatchObject({ status: 'EXPIRED' });
    expect(await rpc('submit_public_feedback', [token, 5, 'x'])).toMatchObject({
      status: 'EXPIRED',
    });
  });

  it('invalidates an older link when a new one is issued', async () => {
    const { id, token: first } = await issuedToken();
    await claims(staff);
    await rpc('issue_feedback_form_link', [id, 30]);
    await claims(null);
    expect(await rpc('get_public_feedback_form', [first])).toMatchObject({ status: 'INVALID' });
  });

  it('turns an approved submission into a queued review invitation', async () => {
    const { id, token } = await issuedToken();
    await claims(null);
    await rpc('submit_public_feedback', [token, 5, 'Great']);
    await claims(staff);
    const approved = await rpc<{ review_request_id: string; replayed: boolean }>(
      'approve_feedback_review_invite',
      [id, 'Thanks! Would you share a Google review?', randomUUID()],
    );
    expect(approved.replayed).toBe(false);
    const invite = await db.query<{ status: string; channel: string }>(
      'select status,channel from customer_review_requests where id=$1',
      [approved.review_request_id],
    );
    expect(invite.rows[0]).toMatchObject({ status: 'QUEUED', channel: 'EMAIL' });
  });

  it('treats a second approval as a double click, not a second invitation', async () => {
    const { id, token } = await issuedToken();
    await claims(null);
    await rpc('submit_public_feedback', [token, 5, 'Great']);
    await claims(staff);
    const first = await rpc<{ review_request_id: string }>('approve_feedback_review_invite', [
      id,
      'Thanks!',
      randomUUID(),
    ]);
    const second = await rpc<{ review_request_id: string; replayed: boolean }>(
      'approve_feedback_review_invite',
      [id, 'Thanks!', randomUUID()],
    );
    expect(second).toMatchObject({ review_request_id: first.review_request_id, replayed: true });
    const count = await db.query<{ count: string }>(
      'select count(*) from customer_review_requests',
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('will not invite before the customer has actually submitted', async () => {
    const id = await feedbackRequest();
    await expect(
      rpc('approve_feedback_review_invite', [id, 'Thanks!', randomUUID()]),
    ).rejects.toThrow(/FEEDBACK_NOT_SUBMITTED/);
  });

  it('keeps link issuing and approval off limits to anonymous callers', async () => {
    const id = await feedbackRequest();
    await claims(null);
    await expect(rpc('issue_feedback_form_link', [id, 30])).rejects.toThrow(
      /FEEDBACK_ACCESS_REQUIRED/,
    );
  });
});

describe('review approval queue', () => {
  let db2: PGlite;
  const org2 = randomUUID();
  const staff2 = randomUUID();
  const branch2 = randomUUID();
  const customer2 = randomUUID();

  async function claims2(user: string | null) {
    await db2.query("select set_config('request.jwt.claims',$1,false)", [
      user ? JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }) : '',
    ]);
  }
  async function rpc2<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
    const result = await db2.query<{ result: T }>(
      `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`,
      values,
    );
    return result.rows[0].result;
  }
  async function completed(rating: number) {
    const row = await db2.query<{ id: string }>(
      "insert into feedback_requests(organization_id,branch_id,customer_id,status,rating,completed_at) values($1,$2,$3,'COMPLETED',$4,now()) returning id",
      [org2, branch2, customer2, rating],
    );
    return row.rows[0].id;
  }

  beforeAll(async () => {
    db2 = new PGlite();
    await db2.exec(source('tests/api/fixtures/public-feedback-base.sql'));
    await db2.exec(source('supabase/migrations/202609070202_public_feedback_forms.sql'));
    await db2.exec(source('supabase/migrations/202609070204_review_approval_queue.sql'));
    await db2.query("insert into organizations(id,name) values($1,'Demo')", [org2]);
    await db2.query('insert into profiles(id,organization_id) values($1,$2)', [staff2, org2]);
    await db2.query("insert into branches(id,organization_id,name) values($1,$2,'MG Road')", [
      branch2,
      org2,
    ]);
    await db2.query('insert into customers(id,organization_id) values($1,$2)', [customer2, org2]);
  }, 30_000);
  beforeEach(async () => {
    await db2.exec('begin');
    await claims2(staff2);
  });
  afterEach(async () => {
    await db2.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db2?.close();
  });

  it('surfaces a promoter, which previously produced no visible record at all', async () => {
    await completed(5);
    const queue = (await rpc2('get_review_approval_queue', ['AWAITING', 1, 25])) as {
      total: number;
      records: Array<{ rating: number; customer: string; branch: string }>;
    };
    expect(queue.total).toBe(1);
    expect(queue.records[0]).toMatchObject({ rating: 5, customer: 'Asha', branch: 'MG Road' });
  });

  it('lists low ratings too rather than hiding them from the queue', async () => {
    await completed(2);
    const queue = (await rpc2('get_review_approval_queue', ['AWAITING', 1, 25])) as {
      total: number;
    };
    expect(queue.total).toBe(1);
  });

  it('moves a row out of AWAITING once it has been invited', async () => {
    const id = await completed(5);
    await rpc2('approve_feedback_review_invite', [id, 'Thanks!', randomUUID()]);
    const awaiting = (await rpc2('get_review_approval_queue', ['AWAITING', 1, 25])) as {
      total: number;
    };
    const invited = (await rpc2('get_review_approval_queue', ['INVITED', 1, 25])) as {
      total: number;
    };
    expect(awaiting.total).toBe(0);
    expect(invited.total).toBe(1);
  });

  it('counts both tabs in one pass', async () => {
    const id = await completed(5);
    await completed(4);
    await rpc2('approve_feedback_review_invite', [id, 'Thanks!', randomUUID()]);
    const queue = (await rpc2('get_review_approval_queue', ['ALL', 1, 25])) as {
      counts: { awaiting: number; invited: number };
    };
    expect(queue.counts).toMatchObject({ awaiting: 1, invited: 1 });
  });

  it('rejects an unsupported page size instead of scanning everything', async () => {
    await expect(rpc2('get_review_approval_queue', ['AWAITING', 1, 5000])).rejects.toThrow(
      /INVALID_REVIEW_QUEUE_PAGE/,
    );
  });

  it('refuses a caller with no tenant context', async () => {
    await claims2(randomUUID());
    await expect(rpc2('get_review_approval_queue', ['AWAITING', 1, 25])).rejects.toThrow(
      /REVIEW_QUEUE_ACCESS_REQUIRED/,
    );
  });
});
