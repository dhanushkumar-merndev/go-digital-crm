import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
const branch = randomUUID();
const customer = randomUUID();
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
async function template(channel: string, status = 'DRAFT') {
  const id = randomUUID();
  await db.query(
    "insert into templates(id,organization_id,channel,name,content,status,created_by) values($1,$2,$3,'T','{}'::jsonb,$4,$5)",
    [id, org, channel, status, actor],
  );
  return id;
}
async function enrol() {
  const id = randomUUID();
  await db.query(
    "insert into customer_drip_enrollments(id,organization_id,branch_id,customer_id,source_name,enrolled_by) values($1,$2,$3,$4,'Seq',$5)",
    [id, org, branch, customer, actor],
  );
  return id;
}
async function queue(
  enrollment: string,
  channel: string,
  templateId: string | null,
  options: { due?: string; order?: number } = {},
) {
  const id = randomUUID();
  // `due` is a SQL expression, so it is interpolated rather than bound: it is
  // test-owned text, never caller input.
  const due = options.due ?? 'now()';
  await db.query(
    `insert into customer_drip_messages
       (id,organization_id,enrollment_id,step_order,channel,message_body,scheduled_for,template_id,template_variables,next_attempt_at)
     values($1,$2,$3,$4,$5,'Rendered copy',${due},$6,'{"1":"Asha"}'::jsonb,${due})`,
    [id, org, enrollment, options.order ?? 1, channel, templateId],
  );
  return id;
}

describe('drip dispatch on PostgreSQL', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    // The migrations under test are loaded unchanged.
    await db.exec(source('supabase/migrations/202609060002_template_approval_lifecycle.sql'));
    await db.exec(source('supabase/migrations/202609060003_customer_drip_dispatch.sql'));
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    await db.query(
      "insert into customers(id,organization_id,full_name,primary_phone,primary_email) values($1,$2,'Asha','919876543210','asha@example.com')",
      [customer, org],
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

  describe('template approval', () => {
    it('moves a draft to APPROVED so send-email can finally resolve it', async () => {
      const id = await template('EMAIL');
      const result = await rpc('approve_template', [id, '42', randomUUID()]);
      expect(result).toMatchObject({ status: 'APPROVED', provider_template_id: '42' });
      const row = await db.query<{ status: string; provider_template_id: string }>(
        'select status,provider_template_id from templates where id=$1',
        [id],
      );
      expect(row.rows[0]).toMatchObject({ status: 'APPROVED', provider_template_id: '42' });
    });

    it('rejects a non-numeric Brevo id that would silently never match at send time', async () => {
      const id = await template('EMAIL');
      await expect(rpc('approve_template', [id, 'welcome_v1', randomUUID()])).rejects.toThrow(
        /INVALID_BREVO_TEMPLATE_ID/,
      );
    });

    it('rejects a WhatsApp template name Meta would not have issued', async () => {
      const id = await template('WHATSAPP');
      await expect(rpc('approve_template', [id, 'Welcome V1', randomUUID()])).rejects.toThrow(
        /INVALID_WHATSAPP_TEMPLATE_NAME/,
      );
    });

    it('accepts a lowercase snake-case WhatsApp template name', async () => {
      const id = await template('WHATSAPP');
      await expect(
        rpc('approve_template', [id, 'welcome_v1', randomUUID()]),
      ).resolves.toMatchObject({ status: 'APPROVED' });
    });

    it('treats re-approval with the same id as a replay, not a failure', async () => {
      const id = await template('EMAIL');
      await rpc('approve_template', [id, '42', randomUUID()]);
      await expect(rpc('approve_template', [id, '42', randomUUID()])).resolves.toMatchObject({
        replayed: true,
      });
    });

    it('refuses a conflicting second decision on an approved template', async () => {
      const id = await template('EMAIL');
      await rpc('approve_template', [id, '42', randomUUID()]);
      await expect(rpc('approve_template', [id, '43', randomUUID()])).rejects.toThrow(
        /TEMPLATE_ALREADY_APPROVED/,
      );
    });

    it('keeps approved provider ids unique so resolution stays single-row', async () => {
      // send-email uses maybeSingle(): a duplicate would break every send.
      const first = await template('EMAIL');
      const second = await template('EMAIL');
      await rpc('approve_template', [first, '42', randomUUID()]);
      await expect(rpc('approve_template', [second, '42', randomUUID()])).rejects.toThrow(
        /TEMPLATE_PROVIDER_ID_IN_USE/,
      );
    });

    it('frees the provider id again once a template is rejected', async () => {
      const first = await template('EMAIL');
      const second = await template('EMAIL');
      await rpc('approve_template', [first, '42', randomUUID()]);
      await rpc('reject_template', [first, 'Meta withdrew it', randomUUID()]);
      await expect(rpc('approve_template', [second, '42', randomUUID()])).resolves.toMatchObject({
        status: 'APPROVED',
      });
    });

    it('denies approval without tenant management context', async () => {
      const id = await template('EMAIL');
      await claims(randomUUID());
      await expect(rpc('approve_template', [id, '42', randomUUID()])).rejects.toThrow(
        /TEMPLATE_MANAGE_PERMISSION_REQUIRED/,
      );
    });
  });

  describe('dispatcher queue', () => {
    it('claims a due message and resolves its recipient and approved template', async () => {
      const id = await template('EMAIL');
      await rpc('approve_template', [id, '42', randomUUID()]);
      const enrollment = await enrol();
      const message = await queue(enrollment, 'EMAIL', id);
      await claims(actor, 'service_role');
      const claimed = await db.query<{
        id: string;
        recipient: string;
        template_provider_id: string;
        lease_token: string;
      }>('select * from public.claim_due_drip_messages($1,$2)', ['worker:test', 10]);
      expect(claimed.rows).toHaveLength(1);
      expect(claimed.rows[0]).toMatchObject({
        id: message,
        recipient: 'asha@example.com',
        template_provider_id: '42',
      });
      expect(claimed.rows[0].lease_token).toContain('worker:test');
    });

    it('hands a WhatsApp message the phone rather than the email', async () => {
      const id = await template('WHATSAPP');
      await rpc('approve_template', [id, 'welcome_v1', randomUUID()]);
      const enrollment = await enrol();
      await queue(enrollment, 'WHATSAPP', id);
      await claims(actor, 'service_role');
      const claimed = await db.query<{ recipient: string; template_provider_id: string }>(
        'select * from public.claim_due_drip_messages($1,$2)',
        ['worker:test', 10],
      );
      expect(claimed.rows[0]).toMatchObject({
        recipient: '919876543210',
        template_provider_id: 'welcome_v1',
      });
    });

    it('leaves an unapproved template null so the worker can name the real reason', async () => {
      const id = await template('EMAIL');
      const enrollment = await enrol();
      await queue(enrollment, 'EMAIL', id);
      await claims(actor, 'service_role');
      const claimed = await db.query<{ template_provider_id: string | null }>(
        'select * from public.claim_due_drip_messages($1,$2)',
        ['worker:test', 10],
      );
      expect(claimed.rows[0].template_provider_id).toBeNull();
    });

    it('does not claim a message that is not due yet', async () => {
      const id = await template('EMAIL');
      await rpc('approve_template', [id, '42', randomUUID()]);
      const enrollment = await enrol();
      await queue(enrollment, 'EMAIL', id, { due: "now()+interval '1 hour'" });
      await claims(actor, 'service_role');
      const claimed = await db.query('select * from public.claim_due_drip_messages($1,$2)', [
        'worker:test',
        10,
      ]);
      expect(claimed.rows).toHaveLength(0);
    });

    it('moves a claim out of QUEUED so a second pass cannot send it again', async () => {
      const id = await template('EMAIL');
      await rpc('approve_template', [id, '42', randomUUID()]);
      const enrollment = await enrol();
      await queue(enrollment, 'EMAIL', id);
      await claims(actor, 'service_role');
      const first = await db.query('select * from public.claim_due_drip_messages($1,$2)', [
        'worker:one',
        10,
      ]);
      expect(first.rows).toHaveLength(1);
      const second = await db.query('select * from public.claim_due_drip_messages($1,$2)', [
        'worker:two',
        10,
      ]);
      expect(second.rows).toHaveLength(0);
    });

    it('refuses to serve the queue to an authenticated caller', async () => {
      await expect(
        db.query('select * from public.claim_due_drip_messages($1,$2)', ['worker:test', 10]),
      ).rejects.toThrow(/SERVICE_ROLE_REQUIRED/);
    });
  });

  describe('dispatcher outcomes', () => {
    async function claimOne() {
      const id = await template('EMAIL');
      await rpc('approve_template', [id, '42', randomUUID()]);
      const enrollment = await enrol();
      const message = await queue(enrollment, 'EMAIL', id);
      await claims(actor, 'service_role');
      const claimed = await db.query<{ lease_token: string }>(
        'select * from public.claim_due_drip_messages($1,$2)',
        ['worker:test', 10],
      );
      return { message, enrollment, lease: claimed.rows[0].lease_token };
    }

    it('marks a sent message and completes an enrollment with nothing left', async () => {
      const { message, enrollment, lease } = await claimOne();
      await expect(rpc('complete_drip_message', [message, lease, 'wamid.1'])).resolves.toBe(true);
      const row = await db.query<{ status: string; provider_message_id: string }>(
        'select status,provider_message_id from customer_drip_messages where id=$1',
        [message],
      );
      expect(row.rows[0]).toMatchObject({ status: 'SENT', provider_message_id: 'wamid.1' });
      const enrolled = await db.query<{ status: string }>(
        'select status from customer_drip_enrollments where id=$1',
        [enrollment],
      );
      expect(enrolled.rows[0].status).toBe('COMPLETED');
    });

    it('keeps an enrollment active while a later step is still queued', async () => {
      const id = await template('EMAIL');
      await rpc('approve_template', [id, '42', randomUUID()]);
      const enrollment = await enrol();
      const first = await queue(enrollment, 'EMAIL', id, { order: 1 });
      await queue(enrollment, 'EMAIL', id, { order: 2, due: "now()+interval '2 days'" });
      await claims(actor, 'service_role');
      const claimed = await db.query<{ id: string; lease_token: string }>(
        'select * from public.claim_due_drip_messages($1,$2)',
        ['worker:test', 10],
      );
      expect(claimed.rows).toHaveLength(1);
      await rpc('complete_drip_message', [first, claimed.rows[0].lease_token, 'wamid.1']);
      const enrolled = await db.query<{ status: string }>(
        'select status from customer_drip_enrollments where id=$1',
        [enrollment],
      );
      expect(enrolled.rows[0].status).toBe('ACTIVE');
    });

    it('rejects a completion carrying the wrong lease', async () => {
      const { message } = await claimOne();
      await expect(rpc('complete_drip_message', [message, 'worker:forged', 'x'])).resolves.toBe(
        false,
      );
    });

    it('requeues a retry with backoff rather than rewriting the reviewed schedule', async () => {
      const { message, lease } = await claimOne();
      const before = await db.query<{ scheduled_for: Date }>(
        'select scheduled_for from customer_drip_messages where id=$1',
        [message],
      );
      await expect(
        rpc('retry_drip_message', [message, lease, 'DRIP_EMAIL_REJECTED']),
      ).resolves.toBe(true);
      const after = await db.query<{
        status: string;
        safe_error_code: string;
        scheduled_for: Date;
        next_attempt_at: Date;
      }>(
        'select status,safe_error_code,scheduled_for,next_attempt_at from customer_drip_messages where id=$1',
        [message],
      );
      expect(after.rows[0]).toMatchObject({
        status: 'QUEUED',
        safe_error_code: 'DRIP_EMAIL_REJECTED',
      });
      expect(after.rows[0].scheduled_for).toEqual(before.rows[0].scheduled_for);
      expect(after.rows[0].next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    });

    it('gives up at the attempt cap instead of violating the attempts constraint', async () => {
      const { message, lease } = await claimOne();
      await db.query('update customer_drip_messages set attempts=10 where id=$1', [message]);
      await rpc('retry_drip_message', [message, lease, 'DRIP_EMAIL_REJECTED']);
      const row = await db.query<{ status: string; failure_reason: string }>(
        'select status,failure_reason from customer_drip_messages where id=$1',
        [message],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'FAILED',
        failure_reason: 'DRIP_EMAIL_REJECTED',
      });
    });

    it('returns a message a dead worker abandoned back to the queue', async () => {
      const { message } = await claimOne();
      await db.query(
        "update customer_drip_messages set updated_at=now()-interval '30 minutes' where id=$1",
        [message],
      );
      await expect(rpc('release_stalled_drip_messages', [15])).resolves.toBe(1);
      const row = await db.query<{ status: string; safe_error_code: string }>(
        'select status,safe_error_code from customer_drip_messages where id=$1',
        [message],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'QUEUED',
        safe_error_code: 'DRIP_LEASE_EXPIRED',
      });
    });
  });
});
