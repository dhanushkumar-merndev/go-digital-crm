import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
const branch = randomUUID();
const customer = randomUUID();
const lead = randomUUID();
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
    "insert into templates(id,organization_id,channel,name,content,status,created_by) values($1,$2,$3,'T',$4,'DRAFT',$5)",
    [id, org, channel, JSON.stringify({ body: 'Hi {{1}}' }), actor],
  );
  await rpc('approve_template', [id, providerId, randomUUID()]);
  return id;
}
function step(channel: string, templateId: string | null, extra: Record<string, unknown> = {}) {
  return {
    step_order: 1,
    delay_hours: 24,
    channel,
    message_body: 'Hi Asha, your test drive is booked.',
    ...(templateId ? { template_id: templateId } : {}),
    ...extra,
  };
}
function enrol(steps: unknown[]) {
  return rpc('create_customer_drip_enrollment', [
    customer,
    null,
    null,
    'Welcome sequence',
    JSON.stringify(steps),
    randomUUID(),
  ]);
}

describe('drip enrolment template binding', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(source('supabase/migrations/202609060002_template_approval_lifecycle.sql'));
    await db.exec(source('supabase/migrations/202609060003_customer_drip_dispatch.sql'));
    await db.exec(source('supabase/migrations/202609060004_customer_drip_template_binding.sql'));
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    await db.query(
      "insert into customers(id,organization_id,full_name,primary_phone,primary_email) values($1,$2,'Asha','919876543210','asha@example.com')",
      [customer, org],
    );
    await db.query(
      'insert into leads(id,organization_id,branch_id,customer_id,assigned_user_id) values($1,$2,$3,$4,$5)',
      [lead, org, branch, customer, actor],
    );
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

  it('binds an approved template onto the queued message', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    const result = await enrol([step('EMAIL', template, { template_variables: { '1': 'Asha' } })]);
    expect(result).toMatchObject({ status: 'ACTIVE', steps: 1 });
    const row = await db.query<{ template_id: string; template_variables: Record<string, string> }>(
      'select template_id,template_variables from customer_drip_messages',
    );
    expect(row.rows[0]).toMatchObject({
      template_id: template,
      template_variables: { '1': 'Asha' },
    });
  });

  it('refuses a step with no template, which is what used to queue undeliverable rows', async () => {
    await expect(enrol([step('EMAIL', null)])).rejects.toThrow(/INVALID_CUSTOMER_DRIP_STEP/);
  });

  it('refuses a template the provider has not approved', async () => {
    const id = randomUUID();
    await db.query(
      "insert into templates(id,organization_id,channel,name,content,status,created_by) values($1,$2,'EMAIL','T','{}'::jsonb,'DRAFT',$3)",
      [id, org, actor],
    );
    await expect(enrol([step('EMAIL', id)])).rejects.toThrow(/CUSTOMER_DRIP_TEMPLATE_NOT_APPROVED/);
  });

  it('refuses an email template used for a WhatsApp step', async () => {
    const template = await approvedTemplate('EMAIL', '42');
    await expect(enrol([step('WHATSAPP', template)])).rejects.toThrow(
      /CUSTOMER_DRIP_TEMPLATE_CHANNEL_MISMATCH/,
    );
  });

  it('accepts a WHATSAPP_BUSINESS template for a WHATSAPP step', async () => {
    // Meta templates are stored under either channel name.
    const template = await approvedTemplate('WHATSAPP_BUSINESS', 'welcome_v1');
    await expect(enrol([step('WHATSAPP', template)])).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('offers the consultant only approved templates, normalised by channel', async () => {
    await approvedTemplate('WHATSAPP_BUSINESS', 'welcome_v1');
    const id = randomUUID();
    await db.query(
      "insert into templates(id,organization_id,channel,name,content,status,created_by) values($1,$2,'EMAIL','Unapproved','{}'::jsonb,'DRAFT',$3)",
      [id, org, actor],
    );
    const options = (await rpc('get_customer_drip_template_options')) as Array<{
      channel: string;
      name: string;
    }>;
    expect(options).toHaveLength(1);
    expect(options[0].channel).toBe('WHATSAPP');
  });

  it('produces a message the dispatcher can immediately claim and send', async () => {
    // The end-to-end point of this migration: enrolment now yields a row that
    // resolves to an approved provider template rather than failing at send.
    const template = await approvedTemplate('EMAIL', '42');
    await enrol([
      { ...step('EMAIL', template, { template_variables: { '1': 'Asha' } }), delay_hours: 0 },
    ]);
    await claims(actor, 'service_role');
    const claimed = await db.query<{ template_provider_id: string; recipient: string }>(
      'select * from public.claim_due_drip_messages($1,$2)',
      ['worker:test', 10],
    );
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]).toMatchObject({
      template_provider_id: '42',
      recipient: 'asha@example.com',
    });
  });
});
