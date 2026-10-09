import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const org = randomUUID();
const otherOrg = randomUUID();
const existing = randomUUID();
let db: PGlite;

function mapping(userId = '101_33338826', phone = '919876543210') {
  return JSON.stringify({ parallel_agents: [{ user_id: userId, phone }] });
}
async function insert(config: string, organization = org, app = '33338826') {
  return db.query(
    `insert into connected_accounts(organization_id,provider_key,external_account_id,connection_config)
     values($1,'telecmi',$2,$3::jsonb) returning id`,
    [organization, app, config],
  );
}
async function reservations(excluded: string | null = null) {
  const result = await db.query<{ result: Array<{ user_id: string; phone: string }> }>(
    'select public.get_telecmi_agent_reservations($1,$2,$3) as result',
    [org, '33338826', excluded],
  );
  return result.rows[0].result;
}

describe('TeleCMI agent reservations', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema app_private;
      create function auth.role() returns text language sql as
        $$select current_setting('request.test_role',true)$$;
      create table public.connected_accounts(
        id uuid primary key default gen_random_uuid(), organization_id uuid not null,
        provider_key text not null, external_account_id text, connection_config jsonb not null,
        deleted_at timestamptz
      );
    `);
    await db.exec(
      readFileSync('supabase/migrations/202610080601_telecmi_agent_availability.sql', 'utf8'),
    );
  }, 30_000);
  beforeEach(async () => {
    await db.exec("begin; select set_config('request.test_role','service_role',false)");
    await db.query(
      `insert into connected_accounts(id,organization_id,provider_key,external_account_id,connection_config)
       values($1,$2,'telecmi','33338826',$3::jsonb)`,
      [existing, org, mapping()],
    );
  });
  afterEach(async () => {
    await db.exec('rollback');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('reports reservations only for the tenant and app and excludes the edited connection', async () => {
    await insert(mapping('102_33338826', '919876543211'), otherOrg);
    await insert(mapping('103_2223012', '919876543212'), org, '2223012');
    expect(await reservations()).toEqual([{ user_id: '101_33338826', phone: '919876543210' }]);
    expect(await reservations(existing)).toEqual([]);
  });

  it('rejects reuse of an agent ID on a second connection', async () => {
    await expect(insert(mapping('101_33338826', '919876543219'))).rejects.toThrow(
      'TELECMI_AGENT_MAPPING_CONFLICT',
    );
  });

  it('rejects reuse of a mobile even if it is formatted differently', async () => {
    await expect(insert(mapping('102_33338826', '+91 98765 43210'))).rejects.toThrow(
      'TELECMI_AGENT_MAPPING_CONFLICT',
    );
  });

  it('allows unchanged mappings on the same connection and independent tenants or apps', async () => {
    await db.query('update connected_accounts set connection_config=$1::jsonb where id=$2', [
      mapping(),
      existing,
    ]);
    await insert(mapping(), otherOrg);
    await insert(mapping('101_2223012'), org, '2223012');
    expect(await reservations()).toHaveLength(1);
  });

  it('releases a mapping when a connection is soft deleted', async () => {
    await db.query('update connected_accounts set deleted_at=now() where id=$1', [existing]);
    expect(await reservations()).toEqual([]);
    await insert(mapping());
    expect(await reservations()).toHaveLength(1);
  });

  it('refuses duplicate mappings inside one connection', async () => {
    await expect(
      insert(
        JSON.stringify({
          parallel_agents: [
            { user_id: '102_33338826', phone: '919876543211' },
            { user_id: '103_33338826', phone: '919876543211' },
          ],
        }),
      ),
    ).rejects.toThrow('TELECMI_AGENT_MAPPING_CONFLICT');
  });

  it('does not expose reservations to an authenticated browser', async () => {
    await db.exec("select set_config('request.test_role','authenticated',false)");
    await expect(reservations()).rejects.toThrow('SERVICE_ROLE_REQUIRED');
  });
});
