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
async function approvedTemplate(channel: string, providerId: string) {
  const id = randomUUID();
  await db.query(
    "insert into templates(id,organization_id,channel,name,content,status,created_by) values($1,$2,$3,'T','{}'::jsonb,'DRAFT',$4)",
    [id, org, channel, actor],
  );
  await rpc('approve_template', [id, providerId, randomUUID()]);
  return id;
}
/** A customer with one lead, which is what makes them reachable. */
async function customerWithLead(
  options: {
    email?: string | null;
    phone?: string | null;
    lifecycle?: string;
    temperature?: string | null;
    leads?: number;
  } = {},
) {
  const customer = randomUUID();
  await db.query(
    'insert into customers(id,organization_id,full_name,primary_phone,primary_email) values($1,$2,$3,$4,$5)',
    [
      customer,
      org,
      'Cust',
      options.phone === undefined ? '919876543210' : options.phone,
      options.email === undefined ? `c${customer.slice(0, 8)}@example.com` : options.email,
    ],
  );
  for (let index = 0; index < (options.leads ?? 1); index += 1) {
    await db.query(
      'insert into leads(id,organization_id,branch_id,customer_id,assigned_user_id,lifecycle_status,temperature) values($1,$2,$3,$4,$5,$6::public.lead_lifecycle,$7::public.lead_temperature)',
      [
        randomUUID(),
        org,
        branch,
        customer,
        actor,
        options.lifecycle ?? 'New',
        options.temperature ?? null,
      ],
    );
  }
  return customer;
}
function createCampaign(templateId: string, filter: unknown = {}, channel = 'EMAIL') {
  return rpc('create_bulk_campaign', [
    'Diwali blast',
    channel,
    templateId,
    JSON.stringify({ '1': 'Asha' }),
    null,
    null,
    JSON.stringify(filter),
    randomUUID(),
  ]);
}

describe('bulk campaign send', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(source('supabase/migrations/202609060002_template_approval_lifecycle.sql'));
    await db.exec(source('supabase/migrations/202609060006_marketing_asset_library.sql'));
    await db.exec(source('supabase/migrations/202609060008_bulk_campaign_send.sql'));
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

  it('materialises the audience once, in one statement', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    await customerWithLead();
    const result = (await createCampaign(template)) as { recipient_count: number };
    expect(result.recipient_count).toBe(2);
  });

  it('sends a customer once even when they have several leads', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead({ leads: 3 });
    const result = (await createCampaign(template)) as { recipient_count: number };
    expect(result.recipient_count).toBe(1);
  });

  it('skips a customer with no address on the chosen channel', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead({ email: null });
    await customerWithLead();
    const result = (await createCampaign(template)) as { recipient_count: number };
    expect(result.recipient_count).toBe(1);
  });

  it('narrows by lifecycle status and temperature', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead({ lifecycle: 'New', temperature: 'HOT' });
    await customerWithLead({ lifecycle: 'Lost', temperature: 'COLD' });
    const byLifecycle = (await createCampaign(template, { lifecycle_status: ['New'] })) as {
      recipient_count: number;
    };
    expect(byLifecycle.recipient_count).toBe(1);
    const byTemperature = (await createCampaign(template, { temperature: ['HOT'] })) as {
      recipient_count: number;
    };
    expect(byTemperature.recipient_count).toBe(1);
  });

  it('treats an empty filter as everyone reachable', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    const result = (await createCampaign(template, {})) as { recipient_count: number };
    expect(result.recipient_count).toBe(1);
  });

  it('refuses a template the provider has not approved', async () => {
    const id = randomUUID();
    await db.query(
      "insert into templates(id,organization_id,channel,name,content,status,created_by) values($1,$2,'EMAIL','T','{}'::jsonb,'DRAFT',$3)",
      [id, org, actor],
    );
    await expect(createCampaign(id)).rejects.toThrow(/BULK_CAMPAIGN_TEMPLATE_NOT_APPROVED/);
  });

  it('refuses an email template used for a WhatsApp blast', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await expect(createCampaign(template, {}, 'WHATSAPP')).rejects.toThrow(
      /BULK_CAMPAIGN_TEMPLATE_CHANNEL_MISMATCH/,
    );
  });

  it('treats a resubmitted request as one blast, not two', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    const requestId = randomUUID();
    const args = [
      'Diwali blast',
      'EMAIL',
      template,
      JSON.stringify({}),
      null,
      null,
      JSON.stringify({}),
      requestId,
    ];
    const first = await rpc<{ id: string }>('create_bulk_campaign', args);
    const second = await rpc<{ id: string; replayed: boolean }>('create_bulk_campaign', args);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('claims a bounded batch and resolves the approved provider template', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    await createCampaign(template);
    await claims(actor, 'service_role');
    const claimed = await db.query<{ template_provider_id: string; recipient: string }>(
      'select * from public.claim_due_bulk_messages($1,$2)',
      ['worker:test', 25],
    );
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0].template_provider_id).toBe('42');
    expect(claimed.rows[0].recipient).toContain('@');
  });

  it('does not serve the same recipient to a second worker', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    await createCampaign(template);
    await claims(actor, 'service_role');
    const first = await db.query('select * from public.claim_due_bulk_messages($1,$2)', [
      'worker:one',
      25,
    ]);
    const second = await db.query('select * from public.claim_due_bulk_messages($1,$2)', [
      'worker:two',
      25,
    ]);
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
  });

  it('completes the campaign once nothing is left to attempt', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    const campaign = (await createCampaign(template)) as { id: string };
    await claims(actor, 'service_role');
    const claimed = await db.query<{ id: string; lease_token: string }>(
      'select * from public.claim_due_bulk_messages($1,$2)',
      ['worker:test', 25],
    );
    await rpc('complete_bulk_message', [
      claimed.rows[0].id,
      claimed.rows[0].lease_token,
      'brevo-1',
    ]);
    const row = await db.query<{ status: string }>(
      'select status from bulk_campaigns where id=$1',
      [campaign.id],
    );
    expect(row.rows[0].status).toBe('COMPLETED');
  });

  it('backs off on retry and gives up at the attempt cap', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    await createCampaign(template);
    await claims(actor, 'service_role');
    const claimed = await db.query<{ id: string; lease_token: string }>(
      'select * from public.claim_due_bulk_messages($1,$2)',
      ['worker:test', 25],
    );
    await rpc('retry_bulk_message', [
      claimed.rows[0].id,
      claimed.rows[0].lease_token,
      'BULK_EMAIL_REJECTED',
    ]);
    const queued = await db.query<{ status: string; next_attempt_at: Date }>(
      'select status,next_attempt_at from bulk_campaign_recipients where id=$1',
      [claimed.rows[0].id],
    );
    expect(queued.rows[0].status).toBe('QUEUED');
    expect(queued.rows[0].next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    await db.query('update bulk_campaign_recipients set attempts=10,status=$2 where id=$1', [
      claimed.rows[0].id,
      'SENDING',
    ]);
    await rpc('retry_bulk_message', [
      claimed.rows[0].id,
      claimed.rows[0].lease_token,
      'BULK_EMAIL_REJECTED',
    ]);
    const failed = await db.query<{ status: string }>(
      'select status from bulk_campaign_recipients where id=$1',
      [claimed.rows[0].id],
    );
    expect(failed.rows[0].status).toBe('FAILED');
  });

  it('cancels queued recipients but leaves in-flight sends alone', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    await customerWithLead();
    const campaign = (await createCampaign(template)) as { id: string };
    await claims(actor, 'service_role');
    await db.query('select * from public.claim_due_bulk_messages($1,$2)', ['worker:test', 1]);
    await claims(actor);
    const cancelled = await rpc<number>('cancel_bulk_campaign', [campaign.id]);
    expect(cancelled).toBe(1);
    const sending = await db.query<{ count: string }>(
      "select count(*) from bulk_campaign_recipients where campaign_id=$1 and status='SENDING'",
      [campaign.id],
    );
    expect(Number(sending.rows[0].count)).toBe(1);
  });

  it('returns a stalled claim to the queue', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    await createCampaign(template);
    await claims(actor, 'service_role');
    const claimed = await db.query<{ id: string }>(
      'select * from public.claim_due_bulk_messages($1,$2)',
      ['worker:test', 25],
    );
    await db.query(
      "update bulk_campaign_recipients set updated_at=now()-interval '30 minutes' where id=$1",
      [claimed.rows[0].id],
    );
    await expect(rpc('release_stalled_bulk_messages', [15])).resolves.toBe(1);
  });

  it('keeps the queue callable only by the worker role', async () => {
    await expect(
      db.query('select * from public.claim_due_bulk_messages($1,$2)', ['worker:test', 25]),
    ).rejects.toThrow(/SERVICE_ROLE_REQUIRED/);
  });

  it('counts campaign progress in one grouped pass, not once per campaign', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await customerWithLead();
    await createCampaign(template);
    const workspace = (await rpc('get_bulk_campaign_workspace', [1, 25])) as {
      records: Array<{ pending: number; sent: number }>;
      total: number;
    };
    expect(workspace.total).toBe(1);
    expect(workspace.records[0].pending).toBe(1);
    expect(workspace.records[0].sent).toBe(0);
  });
});
