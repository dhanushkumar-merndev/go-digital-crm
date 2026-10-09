import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
function definition(path: string, name: string, delimiter: string) {
  const text = source(path);
  const start = text.indexOf(`create or replace function ${name}(`);
  const end = text.indexOf(`${delimiter};`, text.indexOf(delimiter, start) + delimiter.length);
  return text.slice(start, end + delimiter.length + 1);
}
const org = randomUUID();
const branch = randomUUID();
const actor = randomUUID();
const sms = randomUUID();
const email = randomUUID();
let db: PGlite;
let deniedBefore: boolean;

async function permitted(connection: string) {
  return (
    await db.query<{ allowed: boolean }>(
      "select authorize_integration_connection_action($1,$2,'integration.manage') allowed",
      [org, connection],
    )
  ).rows[0].allowed;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
  await db.exec(`
    create type branch_scope_mode as enum ('ONE_BRANCH','SELECTED_BRANCHES','ALL_BRANCHES');
    alter table connected_accounts alter scope_mode type branch_scope_mode using scope_mode::branch_scope_mode;
    alter table connected_accounts add auth_type text, add created_by uuid, add last_tested_at timestamptz,
      add last_error_code text, add connection_config jsonb;
    alter table integration_branch_mappings add external_resource_type text, add external_resource_id text,
      add deleted_at timestamptz;
    alter table integration_branch_mappings add primary key
      (connected_account_id,branch_id,external_resource_type,external_resource_id);
    create table integration_credentials(organization_id uuid,connected_account_id uuid primary key,
      encrypted_payload bytea,key_version integer,cipher_version text,replaced_by uuid);
    create function app_private.has_organization_wide_scope(uuid) returns boolean language sql as $$select false$$;
    create or replace function app_private.can_access_branch(org uuid,branch uuid) returns boolean language sql as $$
      select branch::text = current_setting('request.jwt.claims',true)::jsonb->>'branch'
    $$;
  `);
  await db.exec(
    definition(
      'supabase/migrations/202610091702_brevo_drip_connection.sql',
      'public.save_brevo_integration_connection',
      '$function$',
    ),
  );
  await db.exec(source('supabase/migrations/202610091703_brevo_scope_enum.sql'));
  await db.exec(
    definition(
      'supabase/migrations/202608150006_integration_asset_mapping.sql',
      'public.authorize_integration_connection_action',
      '$$',
    ),
  );
  await db.query('insert into organizations(id) values($1)', [org]);
  await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
  await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
  for (const [id, provider, type] of [
    [sms, 'msg91', 'MSG91_ACCOUNT'],
    [email, 'brevo', 'BREVO_ACCOUNT'],
  ]) {
    await db.query(
      "insert into connected_accounts(id,organization_id,provider_key,scope_mode,status) values($1,$2,$3,'ONE_BRANCH','CONNECTED')",
      [id, org, provider],
    );
    await db.query(
      'insert into integration_branch_mappings(organization_id,connected_account_id,branch_id,external_resource_type,external_resource_id) values($1,$2,$3,$4,$2::uuid::text)',
      [org, id, branch, type],
    );
  }
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: actor, role: 'authenticated', branch }),
  ]);
  deniedBefore = !(await permitted(sms));
  await db.exec(source('supabase/migrations/202610091704_messaging_connection_scope.sql'));
  await db.exec(source('supabase/migrations/202610091705_atomic_msg91_connection.sql'));
}, 30_000);

afterAll(async () => await db?.close());

it('repairs existing email/SMS mappings, preserves the branch, and audits each repair', async () => {
  expect(deniedBefore).toBe(true);
  expect(await permitted(sms)).toBe(true);
  expect(await permitted(email)).toBe(true);
  const mappings = await db.query<{ branch_id: string; external_resource_type: string }>(
    'select branch_id,external_resource_type from integration_branch_mappings',
  );
  expect(mappings.rows).toHaveLength(2);
  for (const row of mappings.rows)
    expect(row).toEqual({ branch_id: branch, external_resource_type: 'CONNECTION_SCOPE' });
  const audits = await db.query(
    "select 1 from audit_logs where action='integration.scope_mapping_repaired'",
  );
  expect(audits.rows).toHaveLength(2);
});

it('keeps users from another branch or tenant denied', async () => {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: actor, role: 'authenticated', branch: randomUUID() }),
  ]);
  expect(await permitted(sms)).toBe(false);
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: randomUUID(), role: 'authenticated', branch }),
  ]);
  expect(await permitted(sms)).toBe(false);
});

it('saves future Brevo branch scopes in the format used by authorization', async () => {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: actor, role: 'service_role', branch }),
  ]);
  const result = await db.query<{ result: { connection_id: string } }>(
    'select save_brevo_integration_connection($1,$2,null,$3,$4,$5,$6,null,null,$7) result',
    [org, actor, 'Branch email', 'ONE_BRANCH', [branch], new Uint8Array([1]), randomUUID()],
  );
  expect(await permitted(result.rows[0].result.connection_id)).toBe(true);
});

it('can repeatedly replace SMS/email credentials without losing branch access or duplicating mappings', async () => {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: actor, role: 'service_role', branch }),
  ]);
  for (const [provider, connection] of [
    ['msg91', sms],
    ['brevo', email],
  ]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await db.query(
        `select save_${provider}_integration_connection($1,$2,$3,$4,$5,$6,$7,null,$8,$9)`,
        [
          org,
          actor,
          connection,
          'Branch messaging',
          'ONE_BRANCH',
          [branch],
          new Uint8Array([attempt + 1]),
          provider === 'msg91' ? 'ARSDMI' : null,
          randomUUID(),
        ],
      );
      expect(await permitted(connection)).toBe(true);
    }
    const rows = await db.query(
      'select 1 from integration_branch_mappings where connected_account_id=$1 and deleted_at is null',
      [connection],
    );
    expect(rows.rows).toHaveLength(1);
  }
});

it('refuses invalid SMS saves before changing credentials or mappings', async () => {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: actor, role: 'service_role', branch }),
  ]);
  await expect(
    db.query('select save_msg91_integration_connection($1,$2,$3,$4,$5,$6,$7,null,$8,$9)', [
      org,
      actor,
      sms,
      'Invalid sender',
      'ONE_BRANCH',
      [branch],
      new Uint8Array([9]),
      '123',
      randomUUID(),
    ]),
  ).rejects.toThrow('INVALID_MSG91_CONNECTION');
  expect(await permitted(sms)).toBe(true);
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: actor, role: 'authenticated', branch }),
  ]);
  await expect(
    db.query('select save_msg91_integration_connection($1,$2,$3,$4,$5,$6,$7,null,$8,$9)', [
      org,
      actor,
      sms,
      'Branch SMS',
      'ONE_BRANCH',
      [branch],
      new Uint8Array([9]),
      'ARSDMI',
      randomUUID(),
    ]),
  ).rejects.toThrow('SERVICE_ROLE_REQUIRED');
});
