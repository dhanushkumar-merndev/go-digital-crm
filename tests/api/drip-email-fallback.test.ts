import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
// Load the real functions, with only their unrelated table dependencies represented
// by the fixture. The new migration itself runs unchanged, including its patches.
function definition(path: string, name: string) {
  const text = source(path);
  const start = text.toLowerCase().indexOf(`create or replace function ${name.toLowerCase()}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const end = text.indexOf('$function$;', text.indexOf('$function$', start) + 10);
  return text.slice(start, end + '$function$;'.length);
}
const matching = 'supabase/migrations/202610091612_conditional_drip_matching.sql';
const builder = 'supabase/migrations/202610091613_conditional_drip_builder.sql';
const org = randomUUID();
const branch = randomUUID();
const actor = randomUUID();
const template = randomUUID();
let db: PGlite;

async function rpc(name: string, values: unknown[] = []) {
  const r = await db.query<{ result: Record<string, unknown> }>(
    `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) result`,
    values,
  );
  return r.rows[0].result;
}
async function lead(
  email: string | null,
  sourceName = 'Facebook',
  temperature = 'COLD',
  customerId: string | null = null,
) {
  const id = randomUUID();
  await db.query(
    `insert into leads(id,organization_id,branch_id,customer_id,email,phone,customer_name,source,temperature)
    values($1,$2,$3,$4,$5,'919876543210','Dhanush',$6,$7::lead_temperature)`,
    [id, org, branch, customerId, email, sourceName, temperature],
  );
  return id;
}
async function campaign() {
  const id = randomUUID();
  const step = randomUUID();
  await db.query(
    `insert into marketing_drip_campaigns(id,organization_id,branch_id,name,status,created_by,trigger_type,trigger_conditions,activated_at)
    values($1,$2,$3,'No email thank-you','ACTIVE',$4,'LEAD_CREATED','{"sources":["Facebook"],"email_presence":"MISSING"}',now()-interval '1 minute')`,
    [id, org, branch, actor],
  );
  await db.query(
    `insert into marketing_drip_steps(id,organization_id,campaign_id,step_order,delay_hours,channel,message_body)
    values($1,$2,$3,1,0,'SMS','Thanks')`,
    [step, org, id],
  );
  await db.query(
    `insert into marketing_drip_step_channels(step_id,campaign_id,channel,template_id,variable_map)
    values($1,$2,'SMS',$3,'{"NAME":"customer_first_name"}')`,
    [step, id, template],
  );
  return id;
}

describe('SMS thank-you when email is missing', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(source('supabase/migrations/202609060003_customer_drip_dispatch.sql'));
    await db.exec(`
      create type public.branch_scope_mode as enum ('ONE_BRANCH','SELECTED_BRANCHES','ALL_BRANCHES');
      alter table connected_accounts alter scope_mode type public.branch_scope_mode using scope_mode::public.branch_scope_mode;
      alter table leads add email text, add phone text, add customer_name text, add interested_model text;
      alter table customers add whatsapp_phone text;
      alter table branches add name text default 'Showroom', add contact_phone text;
      alter table marketing_drip_campaigns add trigger_type text default 'AUDIENCE', add trigger_conditions jsonb default '{}', add activated_at timestamptz;
      alter table templates add placeholders jsonb default '[]', add category text default 'MARKETING';
      alter table customer_drip_enrollments alter customer_id drop not null, add trigger_type text, add trigger_resource_id uuid, add occurrence_key text;
      create unique index occurrence on customer_drip_enrollments(organization_id,source_campaign_id,occurrence_key) where occurrence_key is not null;
      alter table customer_drip_messages add skip_reason text, add constraint customer_drip_messages_skip_reason_check check(skip_reason is null);
      alter table integration_branch_mappings add deleted_at timestamptz;
      create table marketing_drip_step_channels(step_id uuid,campaign_id uuid,channel text,template_id uuid,variable_map jsonb);
      create table customer_marketing_opt_outs(organization_id uuid,customer_id uuid,channel text,revoked_at timestamptz);
      create table custom_field_definitions(id uuid,organization_id uuid,module text,field_type text,active boolean,field_key text);
      create table custom_field_values(organization_id uuid,definition_id uuid,resource_type text,value jsonb,resource_id uuid);
      create table bookings(id uuid,organization_id uuid,customer_id uuid,lead_id uuid,branch_id uuid,deleted_at timestamptz,status text,created_at timestamptz,assigned_user_id uuid,booking_number text,expected_delivery_date date);
      create table delivery_cases(id uuid,organization_id uuid,customer_id uuid,branch_id uuid,deleted_at timestamptz,status text,delivered_at timestamptz,booking_id uuid);
      create function app_private.customer_is_dormant(o uuid,c uuid) returns boolean language sql as $$select exists(select 1 from leads where organization_id=o and customer_id=c and temperature='DORMANT' and deleted_at is null)$$;
    `);
    for (const name of [
      'app_private.drip_variable_tokens',
      'app_private.render_drip_variables',
      'app_private.render_drip_body',
      'public.run_event_drip_matches',
      'public.claim_due_drip_messages',
    ])
      await db.exec(definition(matching, name));
    for (const name of [
      'app_private.drip_lead_sources',
      'app_private.normalize_drip_campaign_payload',
      'public.preview_marketing_drip_audience',
    ])
      await db.exec(definition(builder, name));
    await db.exec(source('supabase/migrations/202610091701_drip_email_presence.sql'));
    await db.exec(`
      alter table connected_accounts add auth_type text, add created_by uuid, add last_tested_at timestamptz,
        add last_error_code text, add connection_config jsonb;
      alter table integration_branch_mappings add external_resource_type text, add external_resource_id text;
      create table integration_credentials(organization_id uuid,connected_account_id uuid primary key,
        encrypted_payload bytea,key_version integer,cipher_version text,replaced_by uuid);
    `);
    await db.exec(source('supabase/migrations/202610091702_brevo_drip_connection.sql'));
    await db.exec(source('supabase/migrations/202610091703_brevo_scope_enum.sql'));
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    await db.query(
      `insert into templates(id,organization_id,channel,name,content,status,placeholders)
      values($1,$2,'SMS','Thanks','{"body":"Thanks {{NAME}}"}','APPROVED','["NAME"]')`,
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

  it('enrolls null, empty and whitespace emails only, once, honoring source and DORMANT', async () => {
    await campaign();
    const expected = [await lead(null), await lead(''), await lead('   ')];
    await lead('dhanush@example.com');
    await lead(null, 'Other');
    await lead(null, 'Facebook', 'DORMANT');
    expect(await rpc('run_event_drip_matches', [500])).toMatchObject({ enrolled: 3, messages: 3 });
    expect(await rpc('run_event_drip_matches', [500])).toMatchObject({ enrolled: 0, messages: 0 });
    const rows = await db.query<{ lead_id: string }>(
      'select lead_id from customer_drip_enrollments',
    );
    expect(rows.rows.map((r) => r.lead_id).sort()).toEqual(expected.sort());
  });

  it('uses a linked customer email and never reads a customer from another tenant', async () => {
    await campaign();
    const otherOrg = randomUUID();
    const own = randomUUID();
    const other = randomUUID();
    await db.query('insert into organizations(id) values($1)', [otherOrg]);
    await db.query(
      `insert into customers(id,organization_id,primary_email) values($1,$2,'own@example.com'),($3,$4,'other@example.com')`,
      [own, org, other, otherOrg],
    );
    await lead(null, 'Facebook', 'COLD', own);
    const eligible = await lead(null, 'Facebook', 'COLD', other);
    expect(await rpc('run_event_drip_matches', [500])).toMatchObject({ enrolled: 1, messages: 1 });
    const rows = await db.query<{ lead_id: string }>(
      'select lead_id from customer_drip_enrollments',
    );
    expect(rows.rows[0].lead_id).toBe(eligible);
  });

  it('cancels the queued fallback if an email is added before delivery', async () => {
    await campaign();
    const id = await lead(null);
    await rpc('run_event_drip_matches', [500]);
    await db.query("update leads set email='added@example.com' where id=$1", [id]);
    await db.query("select * from claim_due_drip_messages('test-worker',20)");
    const r = await db.query<{ status: string; skip_reason: string }>(
      'select status,skip_reason from customer_drip_messages',
    );
    expect(r.rows[0]).toEqual({ status: 'CANCELLED', skip_reason: 'EMAIL_CONDITION_CHANGED' });
  });

  it('retains the condition on save and rejects malformed values', async () => {
    const payload = {
      name: 'Fallback campaign',
      trigger_type: 'LEAD_CREATED',
      trigger_conditions: { email_presence: 'MISSING' },
      steps: [
        {
          delay_hours: 0,
          channels: [
            {
              channel: 'SMS',
              template_id: template,
              variable_map: { NAME: 'customer_first_name' },
            },
          ],
        },
      ],
    };
    const normalize = (p: unknown) =>
      db.query<{ result: { trigger_conditions: { email_presence: string } } }>(
        'select app_private.normalize_drip_campaign_payload($1,$2) result',
        [org, JSON.stringify(p)],
      );
    expect((await normalize(payload)).rows[0].result.trigger_conditions.email_presence).toBe(
      'MISSING',
    );
    await expect(
      normalize({ ...payload, trigger_conditions: { email_presence: 'FALSE' } }),
    ).rejects.toThrow('INVALID_DRIP_EMAIL_PRESENCE');
  });

  it('previews the same no-email audience and refuses an authenticated worker call', async () => {
    await lead(null);
    await lead('provided@example.com');
    const result = await rpc('preview_marketing_drip_audience', [
      'LEAD_CREATED',
      JSON.stringify({ email_presence: 'MISSING' }),
      branch,
    ]);
    expect(result).toMatchObject({ count: 1 });
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: actor, role: 'authenticated' }),
    ]);
    await expect(rpc('run_event_drip_matches', [500])).rejects.toThrow('SERVICE_ROLE_REQUIRED');
  });

  it('saves a tenant Brevo connection with encrypted credentials, branch mapping and audit', async () => {
    const result = await rpc('save_brevo_integration_connection', [
      org,
      actor,
      null,
      'Branch email',
      'ONE_BRANCH',
      [branch],
      new Uint8Array([1]),
      null,
      null,
      randomUUID(),
    ]);
    expect(result).toMatchObject({ provider_key: 'brevo', status: 'CONNECTED' });
    expect(result).not.toHaveProperty('encrypted_payload');
    const rows = await db.query<{
      branch_id: string;
      provider_key: string;
      cipher_version: string;
    }>(
      `select m.branch_id,a.provider_key,c.cipher_version from connected_accounts a join integration_credentials c on c.connected_account_id=a.id join integration_branch_mappings m on m.connected_account_id=a.id`,
    );
    expect(rows.rows[0]).toEqual({
      branch_id: branch,
      provider_key: 'brevo',
      cipher_version: 'AES-256-GCM-v1',
    });
    const audit = await db.query<{ action: string }>(
      "select action from audit_logs where action='integration.connected'",
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('resolves email to its own branch Brevo account, retaining its id after disconnect', async () => {
    const result = await rpc('save_brevo_integration_connection', [
      org,
      actor,
      null,
      'Branch email',
      'ONE_BRANCH',
      [branch],
      new Uint8Array([1]),
      null,
      null,
      randomUUID(),
    ]);
    const id = await campaign();
    await db.query("update marketing_drip_campaigns set trigger_conditions='{}' where id=$1", [id]);
    await db.query("update templates set channel='EMAIL',provider_template_id='1' where id=$1", [
      template,
    ]);
    await db.query("update marketing_drip_step_channels set channel='EMAIL' where campaign_id=$1", [
      id,
    ]);
    await lead('dhanush@example.com');
    await rpc('run_event_drip_matches', [500]);
    await db.query("update connected_accounts set status='DISCONNECTED' where id=$1", [
      result.connection_id,
    ]);
    const rows = await db.query<{ connected_account_id: string }>(
      "select * from claim_due_drip_messages('test-worker',20)",
    );
    expect(rows.rows[0].connected_account_id).toBe(result.connection_id);
  });

  it('refuses cross-tenant branch mapping before creating an account', async () => {
    const otherOrg = randomUUID();
    const otherBranch = randomUUID();
    await db.query('insert into organizations(id) values($1)', [otherOrg]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [
      otherBranch,
      otherOrg,
    ]);
    await expect(
      rpc('save_brevo_integration_connection', [
        org,
        actor,
        null,
        'Branch email',
        'ONE_BRANCH',
        [otherBranch],
        new Uint8Array([1]),
        null,
        null,
        randomUUID(),
      ]),
    ).rejects.toThrow('INVALID_BREVO_CONNECTION');
  });
});
