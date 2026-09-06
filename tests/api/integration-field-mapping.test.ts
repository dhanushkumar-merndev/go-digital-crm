import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
const branch = randomUUID();
let db: PGlite;
let connection: string;

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
function save(mappings: unknown[]) {
  return rpc('save_integration_field_mappings', [
    connection,
    JSON.stringify(mappings),
    randomUUID(),
  ]);
}

describe('integration field mapping', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(
      source('supabase/migrations/202609060011_integration_field_mapping_management.sql'),
    );
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    const row = await db.query<{ id: string }>(
      "insert into connected_accounts(organization_id,provider_key,display_name,scope_mode,status) values($1,'google_ads','Ads','ALL_BRANCHES','CONNECTED') returning id",
      [org],
    );
    connection = row.rows[0].id;
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

  it('maps an ads column onto a CRM field', async () => {
    const result = await save([
      { external_field: 'FULL_NAME', canonical_field: 'customerName' },
      { external_field: 'PHONE_NUMBER', canonical_field: 'phone' },
    ]);
    expect(result).toMatchObject({ mapping_count: 2 });
    const view = (await rpc('get_integration_field_mappings', [connection])) as {
      mappings: Array<{ external_field: string; canonical_field: string }>;
    };
    expect(view.mappings).toHaveLength(2);
  });

  it('offers exactly the canonical fields ingestion can accept', async () => {
    const view = (await rpc('get_integration_field_mappings', [connection])) as {
      canonical_fields: string[];
    };
    expect(view.canonical_fields).toContain('customerName');
    expect(view.canonical_fields).toContain('interestedModel');
    expect(view.canonical_fields).not.toContain('notAField');
  });

  it('refuses a target field ingestion would silently drop', async () => {
    await expect(
      save([{ external_field: 'FULL_NAME', canonical_field: 'nickname' }]),
    ).rejects.toThrow(/INVALID_FIELD_MAPPING_ENTRY/);
  });

  it('refuses two rules for the same ads column', async () => {
    await expect(
      save([
        { external_field: 'PHONE', canonical_field: 'phone' },
        { external_field: 'PHONE', canonical_field: 'email' },
      ]),
    ).rejects.toThrow(/DUPLICATE_EXTERNAL_FIELD/);
  });

  it('replaces the whole set so a mapping is never half-applied', async () => {
    await save([{ external_field: 'A', canonical_field: 'phone' }]);
    await save([{ external_field: 'B', canonical_field: 'email' }]);
    const view = (await rpc('get_integration_field_mappings', [connection])) as {
      mappings: Array<{ external_field: string }>;
    };
    expect(view.mappings).toHaveLength(1);
    expect(view.mappings[0].external_field).toBe('B');
  });

  it('leaves the existing mapping untouched when the new set is invalid', async () => {
    await save([{ external_field: 'GOOD', canonical_field: 'phone' }]);
    // A savepoint is needed only because the raised exception aborts the test's
    // own transaction; the function's atomicity is Postgres's, not the test's.
    await db.exec('savepoint attempt');
    await expect(
      save([
        { external_field: 'GOOD', canonical_field: 'phone' },
        { external_field: 'BAD', canonical_field: 'notAField' },
      ]),
    ).rejects.toThrow(/INVALID_FIELD_MAPPING_ENTRY/);
    await db.exec('rollback to savepoint attempt');
    const view = (await rpc('get_integration_field_mappings', [connection])) as {
      mappings: Array<{ external_field: string }>;
    };
    expect(view.mappings).toHaveLength(1);
    expect(view.mappings[0].external_field).toBe('GOOD');
  });

  it('carries a transform config through', async () => {
    await save([
      {
        external_field: 'PHONE',
        canonical_field: 'phone',
        transform_config: { strip: 'non_digits' },
      },
    ]);
    const view = (await rpc('get_integration_field_mappings', [connection])) as {
      mappings: Array<{ transform_config: Record<string, string> }>;
    };
    expect(view.mappings[0].transform_config).toEqual({ strip: 'non_digits' });
  });

  it('refuses a connection outside this tenant', async () => {
    await expect(rpc('get_integration_field_mappings', [randomUUID()])).rejects.toThrow(
      /INTEGRATION_CONNECTION_NOT_FOUND/,
    );
  });

  it('requires integration management permission', async () => {
    await claims(randomUUID());
    await expect(rpc('get_integration_field_mappings', [connection])).rejects.toThrow(
      /INTEGRATION_MANAGE_PERMISSION_REQUIRED/,
    );
  });

  it('accepts clearing every mapping', async () => {
    await save([{ external_field: 'A', canonical_field: 'phone' }]);
    const result = await save([]);
    expect(result).toMatchObject({ mapping_count: 0 });
  });
});
