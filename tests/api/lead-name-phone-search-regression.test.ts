import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const patchPath = 'supabase/migrations/202610091501_restore_phone_only_lead_search.sql';
const signature =
  'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)';
const currentId = 'eb0812db-6689-4374-bbc1-4732d977e628';
const oldId = 'e87ed3b6-71a6-4b84-a392-466cbeb59480';
const unrelatedId = '11111111-1111-4111-8111-111111111111';
let db: PGlite;

function sqlFunction(path: string, marker: string, ending: string) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf(marker);
  const end = source.indexOf(ending, start);
  if (start < 0 || end < 0) throw new Error(`Function missing: ${marker}`);
  return source.slice(start, end + ending.length);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec('create schema app_private;');
  await db.exec(
    sqlFunction(
      'supabase/migrations/202608150011_customer_workspace.sql',
      'create or replace function app_private.normalize_phone_digits(',
      '$$;',
    ),
  );
  await db.exec(
    sqlFunction(
      'supabase/migrations/20260928190000_phone_search_only_for_phone_like_terms.sql',
      'create or replace function app_private.phone_search_digits(',
      '$$;',
    ),
  );
  await db.exec(
    sqlFunction(
      'supabase/migrations/202610090401_same_mobile_context_and_phone_search.sql',
      'CREATE OR REPLACE FUNCTION app_private.get_sales_role_lead_workspace_page(',
      '$function$;',
    ),
  );
  if (existsSync(patchPath)) await db.exec(readFileSync(patchPath, 'utf8'));
  const result = await db.query<{ definition: string }>(
    'select pg_get_functiondef($1::regprocedure) as definition',
    [signature],
  );
  const definition = result.rows[0]!.definition;
  // Execute the actual workspace's normalization and exact search predicate.
  // The rest of that large query concerns tenancy, sales stages and paging.
  const normalizationStart = definition.indexOf('  normalized_search := left(');
  const normalizationEnd = definition.indexOf('  normalized_model :=', normalizationStart);
  const predicateEnd = definition.indexOf('    ), phone_group_lead_ids');
  const predicateStart = definition.lastIndexOf(
    '      and (\n        normalized_search',
    predicateEnd,
  );
  if (
    [normalizationStart, normalizationEnd, predicateStart, predicateEnd].some((index) => index < 0)
  )
    throw new Error('Workspace search query shape changed');
  await db.exec(`
    create table test_leads(id uuid primary key, customer_name text, normalized_phone text);
    insert into test_leads values
      ('${currentId}', 'Amal browser QA mv0vjgn8', '+918593939234'),
      ('${oldId}', 'Old completed booking', '+918593939234'),
      ('${unrelatedId}', 'Unrelated customer', '+918123456789');
    create function public.test_lead_search(target_search text) returns uuid[] language plpgsql as $test$
    declare normalized_search text; search_phone_digits text; search_lead_id uuid; matches uuid[];
    begin
      ${definition.slice(normalizationStart, normalizationEnd)}
      if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then search_lead_id := normalized_search::uuid; end if;
      select coalesce(array_agg(lead_row.id order by lead_row.id), '{}'::uuid[]) into matches
      from test_leads lead_row where true
      ${definition.slice(predicateStart, predicateEnd)};
      return matches;
    end;
    $test$;
  `);
}, 30000);

afterAll(async () => {
  await db?.close();
});

async function search(value: string) {
  return (await db.query<{ ids: string[] }>('select public.test_lead_search($1) as ids', [value]))
    .rows[0]!.ids;
}

describe('lead names containing digits stay text searches', () => {
  it('returns the named enquiry without unrelated or older same-phone enquiries', async () => {
    expect(await search('Amal browser QA mv0vjgn8')).toEqual([currentId]);
  });
  it('does not return phone-prefix matches for a missing customer name', async () => {
    expect(await search('Missing customer 08')).toEqual([]);
  });
  it('still supports a lead UUID search', async () => {
    expect(await search(currentId)).toEqual([currentId]);
  });
  it.each([
    '8593939234',
    '+918593939234',
    '918593939234',
    '08593939234',
    '+91 85939 39234',
    '(+91) 85939-39234',
  ])('keeps actual phone search working: %s', async (value) => {
    expect(await search(value)).toEqual([oldId, currentId].sort());
  });
  it('applies the migration twice without changing the function again', async () => {
    if (!existsSync(patchPath)) return;
    const before = await db.query('select pg_get_functiondef($1::regprocedure) as definition', [
      signature,
    ]);
    await db.exec(readFileSync(patchPath, 'utf8'));
    const after = await db.query('select pg_get_functiondef($1::regprocedure) as definition', [
      signature,
    ]);
    expect(after.rows).toEqual(before.rows);
  });
});
