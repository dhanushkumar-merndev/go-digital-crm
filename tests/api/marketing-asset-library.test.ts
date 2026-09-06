import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const other = randomUUID();
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
/** Produces a completed generation with one stored output, as the worker would. */
async function generatedImage(organization = org, status = 'COMPLETED') {
  const generation = randomUUID();
  const file = randomUUID();
  await db.query(
    'insert into ai_image_generations(id,organization_id,branch_id,status) values($1,$2,$3,$4)',
    [generation, organization, organization === org ? branch : null, status],
  );
  await db.query(
    "insert into object_files(id,organization_id,resource_type,resource_id,bucket,object_key,mime_type,size_bytes,checksum) values($1,$2,'ai_image_generation',$3,'b',$4,'image/png',1024,'c')",
    [file, organization, generation, `key-${file}`],
  );
  await db.query(
    'insert into ai_image_generation_outputs(organization_id,generation_id,object_file_id,ordinal) values($1,$2,$3,1)',
    [organization, generation, file],
  );
  return file;
}

describe('marketing asset library', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(source('supabase/migrations/202609060006_marketing_asset_library.sql'));
    for (const id of [org, other]) await db.query('insert into organizations(id) values($1)', [id]);
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

  it('promotes a generated image into the reusable library', async () => {
    const file = await generatedImage();
    const result = await rpc('save_ai_image_as_asset', [
      file,
      'Diwali offer poster',
      ['diwali', 'offer'],
      randomUUID(),
    ]);
    expect(result).toMatchObject({ name: 'Diwali offer poster', replayed: false });
    const row = await db.query<{ tags: string[]; source: string; generation_id: string }>(
      'select tags,source,generation_id from marketing_assets',
    );
    expect(row.rows[0]).toMatchObject({ tags: ['diwali', 'offer'], source: 'AI_GENERATED' });
    expect(row.rows[0].generation_id).not.toBeNull();
  });

  it('lowercases and de-duplicates tags so search never has to case-fold', async () => {
    const file = await generatedImage();
    await rpc('save_ai_image_as_asset', [
      file,
      'Poster',
      ['Diwali', 'diwali', 'OFFER'],
      randomUUID(),
    ]);
    const row = await db.query<{ tags: string[] }>('select tags from marketing_assets');
    expect([...row.rows[0].tags].sort()).toEqual(['diwali', 'offer']);
  });

  it('treats saving the same image twice as a double click', async () => {
    const file = await generatedImage();
    const first = await rpc<{ id: string }>('save_ai_image_as_asset', [
      file,
      'Poster',
      [],
      randomUUID(),
    ]);
    const second = await rpc<{ id: string; replayed: boolean }>('save_ai_image_as_asset', [
      file,
      'Poster again',
      [],
      randomUUID(),
    ]);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('refuses an image belonging to another tenant', async () => {
    const foreign = await generatedImage(other);
    await expect(
      rpc('save_ai_image_as_asset', [foreign, 'Stolen', [], randomUUID()]),
    ).rejects.toThrow(/ASSET_SOURCE_NOT_FOUND/);
  });

  it('refuses an image whose generation has not completed', async () => {
    const pending = await generatedImage(org, 'RUNNING');
    await expect(
      rpc('save_ai_image_as_asset', [pending, 'Too early', [], randomUUID()]),
    ).rejects.toThrow(/ASSET_SOURCE_NOT_READY/);
  });

  it('pages server-side with an exact count rather than handing over the library', async () => {
    for (let index = 0; index < 3; index += 1) {
      const file = await generatedImage();
      await rpc('save_ai_image_as_asset', [file, `Poster ${index}`, ['diwali'], randomUUID()]);
    }
    const page = (await rpc('get_marketing_asset_library', [1, 25, null, null])) as {
      records: unknown[];
      total: number;
    };
    expect(page.total).toBe(3);
    expect(page.records).toHaveLength(3);
  });

  it('filters by tag and by name', async () => {
    const first = await generatedImage();
    const second = await generatedImage();
    await rpc('save_ai_image_as_asset', [first, 'Diwali poster', ['diwali'], randomUUID()]);
    await rpc('save_ai_image_as_asset', [second, 'Summer banner', ['summer'], randomUUID()]);
    const byTag = (await rpc('get_marketing_asset_library', [1, 25, null, 'DIWALI'])) as {
      total: number;
    };
    expect(byTag.total).toBe(1);
    const byName = (await rpc('get_marketing_asset_library', [1, 25, 'summer', null])) as {
      total: number;
    };
    expect(byName.total).toBe(1);
  });

  it('archives without destroying the file a live campaign may still render', async () => {
    const file = await generatedImage();
    const asset = await rpc<{ id: string }>('save_ai_image_as_asset', [
      file,
      'Poster',
      [],
      randomUUID(),
    ]);
    await expect(rpc('archive_marketing_asset', [asset.id])).resolves.toBe(true);
    const library = (await rpc('get_marketing_asset_library', [1, 25, null, null])) as {
      total: number;
    };
    expect(library.total).toBe(0);
    const files = await db.query('select 1 from object_files where id=$1', [file]);
    expect(files.rows).toHaveLength(1);
  });

  it('rejects an unsupported page size instead of scanning the whole library', async () => {
    await expect(rpc('get_marketing_asset_library', [1, 5000, null, null])).rejects.toThrow(
      /INVALID_ASSET_PAGE/,
    );
  });
});
