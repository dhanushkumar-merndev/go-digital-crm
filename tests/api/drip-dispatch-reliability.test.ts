import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
// The deployed functions are text-patched migration by migration, so the chain is
// loaded in order and the migration under test runs unchanged on top of it.
function definition(path: string, name: string, delimiter = '$function$') {
  const text = source(path);
  const start = text.toLowerCase().indexOf(`create or replace function ${name.toLowerCase()}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const end = text.indexOf(`${delimiter};`, text.indexOf(delimiter, start) + delimiter.length);
  return text.slice(start, end + delimiter.length + 1);
}
const matching = 'supabase/migrations/202610091612_conditional_drip_matching.sql';
const builder = 'supabase/migrations/202610091613_conditional_drip_builder.sql';
const org = randomUUID();
const branch = randomUUID();
const actor = randomUUID();
const customer = randomUUID();
const template = randomUUID();
let db: PGlite;

async function enrollment(status = 'ACTIVE') {
  const id = randomUUID();
  await db.query(
    `insert into customer_drip_enrollments(id,organization_id,branch_id,customer_id,source_name,status,enrolled_by)
    values($1,$2,$3,$4,'Sequence',$5,$6)`,
    [id, org, branch, customer, status, actor],
  );
  return id;
}
async function message(
  enrollmentId: string,
  options: { status?: string; attempts?: number; stale?: boolean; order?: number } = {},
) {
  const id = randomUUID();
  await db.query(
    `insert into customer_drip_messages
      (id,organization_id,enrollment_id,step_order,channel,message_body,scheduled_for,status,template_id,attempts,lease_token,updated_at)
    values($1,$2,$3,$4,'EMAIL','Copy',now()-interval '1 hour',$5,$6,$7,$8,now()-$9::interval)`,
    [
      id,
      org,
      enrollmentId,
      options.order ?? 1,
      options.status ?? 'QUEUED',
      template,
      options.attempts ?? 0,
      options.status === 'SENDING' ? 'lease' : null,
      options.stale ? '1 hour' : '0 seconds',
    ],
  );
  return id;
}
async function claim() {
  const result = await db.query<{ id: string; lease_token: string }>(
    "select id,lease_token from claim_due_drip_messages('test-worker',20)",
  );
  return result.rows;
}
async function messageRow(id: string) {
  const result = await db.query<{ status: string; attempts: number; skip_reason: string | null }>(
    'select status,attempts,skip_reason from customer_drip_messages where id=$1',
    [id],
  );
  return result.rows[0];
}
async function enrollmentStatus(id: string) {
  const result = await db.query<{ status: string }>(
    'select status from customer_drip_enrollments where id=$1',
    [id],
  );
  return result.rows[0].status;
}

describe('drip dispatch reliability', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(source('supabase/migrations/202609060003_customer_drip_dispatch.sql'));
    await db.exec(source('supabase/migrations/202609020010_suppress_dormant_drip_enrollment.sql'));
    await db.exec(`
      create type public.branch_scope_mode as enum ('ONE_BRANCH','SELECTED_BRANCHES','ALL_BRANCHES');
      alter table connected_accounts alter scope_mode type public.branch_scope_mode using scope_mode::public.branch_scope_mode;
      alter table leads add email text, add phone text, add customer_name text, add interested_model text;
      alter table customers add whatsapp_phone text;
      alter table branches add name text default 'Showroom', add contact_phone text;
      alter table marketing_drip_campaigns add trigger_type text default 'AUDIENCE', add trigger_conditions jsonb default '{}', add activated_at timestamptz,
        add description text, add version bigint default 1, add starts_at timestamptz, add paused_at timestamptz;
      alter table templates add placeholders jsonb default '[]', add category text default 'MARKETING';
      alter table customer_drip_enrollments alter customer_id drop not null, add trigger_type text, add trigger_resource_id uuid, add occurrence_key text;
      alter table customer_drip_messages add skip_reason text, add constraint customer_drip_messages_skip_reason_check check(skip_reason is null);
      alter table integration_branch_mappings add deleted_at timestamptz;
      create table marketing_drip_step_channels(organization_id uuid,step_id uuid references marketing_drip_steps(id) on delete cascade,campaign_id uuid,channel text,template_id uuid,variable_map jsonb,unique(step_id,channel));
      create function app_private.has_organization_wide_scope(uuid) returns boolean language sql as $$select true$$;
      create table customer_marketing_opt_outs(organization_id uuid,customer_id uuid,channel text,revoked_at timestamptz);
    `);
    // plpgsql bodies are not resolved until they run, so the functions the later
    // migrations patch are loaded whole without the tables only they read.
    for (const name of [
      'public.run_event_drip_matches',
      'public.run_drip_auto_match',
      'public.claim_due_drip_messages',
    ])
      await db.exec(definition(matching, name));
    for (const name of [
      'app_private.drip_lead_sources',
      'app_private.normalize_drip_campaign_payload',
      'public.preview_marketing_drip_audience',
      'public.get_marketing_drip_campaign',
      'public.set_marketing_drip_campaign_status',
    ])
      await db.exec(definition(builder, name));
    await db.exec(source('supabase/migrations/202610091701_drip_email_presence.sql'));
    await db.exec(source('supabase/migrations/202610092001_drip_campaign_editing.sql'));
    await db.exec(source('supabase/migrations/202610092002_drip_audience_filter_validation.sql'));
    await db.exec(source('supabase/migrations/202610100671_drip_dispatch_reliability.sql'));
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    await db.query(
      "insert into customers(id,organization_id,full_name,primary_email) values($1,$2,'Asha','asha@example.com')",
      [customer, org],
    );
    await db.query(
      `insert into templates(id,organization_id,channel,name,content,status,provider_template_id)
      values($1,$2,'EMAIL','Welcome','{"body":"Welcome"}','APPROVED','42')`,
      [template, org],
    );
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: actor, role: 'service_role' }),
    ]);
  });
  afterEach(async () => {
    await db.exec('rollback');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('keeps claiming when a message is already at the attempt cap', async () => {
    // Before the fix the increment broke the attempts check and the claim raised
    // for every tenant on every pass.
    const capped = await message(await enrollment(), { attempts: 10 });
    const fresh = await message(await enrollment());
    const claimed = await claim();
    expect(claimed.map((row) => row.id).sort()).toEqual([capped, fresh].sort());
    expect(await messageRow(capped)).toMatchObject({ status: 'SENDING', attempts: 10 });
  });

  it('fails a message on its tenth attempt and finishes the enrollment', async () => {
    const enrollmentId = await enrollment();
    const id = await message(enrollmentId, { attempts: 9 });
    const [claimed] = await claim();
    await db.query('select retry_drip_message($1,$2,$3)', [
      id,
      claimed.lease_token,
      'DRIP_EMAIL_REJECTED',
    ]);
    expect(await messageRow(id)).toMatchObject({ status: 'FAILED', attempts: 10 });
    // An enrollment with nothing left to send must not stay ACTIVE forever.
    expect(await enrollmentStatus(enrollmentId)).toBe('COMPLETED');
  });

  it('keeps the enrollment active while a later step is still queued', async () => {
    const enrollmentId = await enrollment();
    const id = await message(enrollmentId, { attempts: 9 });
    await db.query(
      `insert into customer_drip_messages(organization_id,enrollment_id,step_order,channel,message_body,scheduled_for,next_attempt_at,template_id)
      values($1,$2,2,'EMAIL','Later',now()+interval '1 day',now()+interval '1 day',$3)`,
      [org, enrollmentId, template],
    );
    const [claimed] = await claim();
    await db.query('select retry_drip_message($1,$2,$3)', [id, claimed.lease_token, 'DRIP_X']);
    expect(await enrollmentStatus(enrollmentId)).toBe('ACTIVE');
  });

  it('closes a message queued on a cancelled enrollment instead of claiming it', async () => {
    const id = await message(await enrollment('CANCELLED'));
    expect(await claim()).toEqual([]);
    expect(await messageRow(id)).toMatchObject({
      status: 'CANCELLED',
      skip_reason: 'ENROLLMENT_CLOSED',
      attempts: 0,
    });
  });

  it('does not re-queue a failed send once its enrollment was cancelled', async () => {
    const enrollmentId = await enrollment();
    const id = await message(enrollmentId);
    const [claimed] = await claim();
    await db.query("update customer_drip_enrollments set status='CANCELLED' where id=$1", [
      enrollmentId,
    ]);
    await db.query('select retry_drip_message($1,$2,$3)', [
      id,
      claimed.lease_token,
      'DRIP_EMAIL_RATE_LIMITED',
    ]);
    expect(await messageRow(id)).toMatchObject({
      status: 'CANCELLED',
      skip_reason: 'ENROLLMENT_CLOSED',
    });
  });

  it('re-queues an expired lease, but fails it on the last attempt', async () => {
    const retryable = await message(await enrollment(), {
      status: 'SENDING',
      attempts: 3,
      stale: true,
    });
    const exhaustedEnrollment = await enrollment();
    const exhausted = await message(exhaustedEnrollment, {
      status: 'SENDING',
      attempts: 10,
      stale: true,
    });
    const released = await db.query<{ released: number }>(
      'select release_stalled_drip_messages(15) as released',
    );
    expect(released.rows[0].released).toBe(2);
    expect(await messageRow(retryable)).toMatchObject({ status: 'QUEUED', attempts: 3 });
    expect(await messageRow(exhausted)).toMatchObject({ status: 'FAILED', attempts: 10 });
    expect(await enrollmentStatus(exhaustedEnrollment)).toBe('COMPLETED');
  });

  it('skips dormant customers in the audience match without failing the pass', async () => {
    // The enrollment trigger rejects a dormant lead per row, so one dormant
    // customer in the audience used to abort the whole campaign's pass.
    const campaign = randomUUID();
    await db.query(
      `insert into marketing_drip_campaigns(id,organization_id,name,status,created_by,trigger_type)
      values($1,$2,'Nurture','ACTIVE',$3,'AUDIENCE')`,
      [campaign, org, actor],
    );
    await db.query(
      `insert into marketing_drip_steps(organization_id,campaign_id,step_order,delay_hours,channel,message_body,template_id)
      values($1,$2,1,0,'EMAIL','Welcome',$3)`,
      [org, campaign, template],
    );
    const dormant = randomUUID();
    await db.query(
      "insert into customers(id,organization_id,full_name,primary_email) values($1,$2,'Dormant','d@example.com')",
      [dormant, org],
    );
    await db.query(
      `insert into leads(id,organization_id,branch_id,customer_id,temperature)
      values($1,$2,$3,$4,'DORMANT'),($5,$2,$3,$6,'HOT')`,
      [randomUUID(), org, branch, dormant, randomUUID(), customer],
    );
    const result = await db.query<{ result: { enrolled: number; messages: number } }>(
      'select run_drip_auto_match($1,500) as result',
      [campaign],
    );
    expect(result.rows[0].result).toEqual({ enrolled: 1, messages: 1 });
    const enrolled = await db.query<{ customer_id: string }>(
      'select customer_id from customer_drip_enrollments where source_campaign_id=$1',
      [campaign],
    );
    expect(enrolled.rows.map((row) => row.customer_id)).toEqual([customer]);
  });

  it('rejects an audience filter key the matcher would silently ignore', async () => {
    const valid = async (filter: unknown) =>
      (
        await db.query<{ valid: boolean }>(
          'select app_private.validate_drip_audience_filter($1::jsonb) as valid',
          [JSON.stringify(filter)],
        )
      ).rows[0].valid;
    // An ignored key reads as "no filter", which is the whole customer base.
    expect(await valid({ lifecycle: 'NEW_LEADS' })).toBe(false);
    expect(await valid({ lifecycle_status: ['New'], created_within_days: 30 })).toBe(true);
    expect(await valid({})).toBe(true);
  });
});
