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
async function draft(platform = 'FACEBOOK', status = 'DRAFT') {
  const id = randomUUID();
  await db.query(
    'insert into social_posts(id,organization_id,branch_id,platform,content,status,created_by) values($1,$2,$3,$4,$5,$6,$7)',
    [id, org, branch, platform, 'Diwali offer is live', status, actor],
  );
  return id;
}
async function asset() {
  const generation = randomUUID();
  const file = randomUUID();
  await db.query(
    "insert into ai_image_generations(id,organization_id,branch_id,status) values($1,$2,$3,'COMPLETED')",
    [generation, org, branch],
  );
  await db.query(
    "insert into object_files(id,organization_id,resource_type,resource_id,bucket,object_key,mime_type,size_bytes,checksum) values($1,$2,'ai_image_generation',$3,'b',$4,'image/png',10,'c')",
    [file, org, generation, `k-${file}`],
  );
  await db.query(
    'insert into ai_image_generation_outputs(organization_id,generation_id,object_file_id,ordinal) values($1,$2,$3,1)',
    [org, generation, file],
  );
  const saved = await rpc<{ id: string }>('save_ai_image_as_asset', [
    file,
    'Diwali poster',
    [],
    randomUUID(),
  ]);
  return { assetId: saved.id, file };
}

describe('social post publishing', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(source('supabase/migrations/202609060006_marketing_asset_library.sql'));
    await db.exec(source('supabase/migrations/202609060009_social_post_publishing.sql'));
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    const row = await db.query<{ id: string }>(
      "insert into connected_accounts(organization_id,provider_key,display_name,scope_mode,status) values($1,'meta','Page','ALL_BRANCHES','CONNECTED') returning id",
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

  it('moves a reviewed draft into the publish queue', async () => {
    const post = await draft();
    const result = await rpc('request_social_post_publish', [
      post,
      connection,
      null,
      null,
      randomUUID(),
    ]);
    expect(result).toMatchObject({ status: 'PUBLISH_REQUESTED', replayed: false });
  });

  it('attaches an asset as the post media', async () => {
    const post = await draft();
    const { assetId, file } = await asset();
    await rpc('request_social_post_publish', [post, connection, assetId, null, randomUUID()]);
    const row = await db.query<{ media_object_file_ids: string[] }>(
      'select media_object_file_ids from social_posts where id=$1',
      [post],
    );
    expect(row.rows[0].media_object_file_ids).toEqual([file]);
  });

  it('refuses an Instagram post with no image, which Meta would reject', async () => {
    const post = await draft('INSTAGRAM');
    await expect(
      rpc('request_social_post_publish', [post, connection, null, null, randomUUID()]),
    ).rejects.toThrow(/SOCIAL_IMAGE_REQUIRED/);
  });

  it('refuses a platform this worker cannot publish to', async () => {
    const post = await draft('GOOGLE_BUSINESS_PROFILE');
    await expect(
      rpc('request_social_post_publish', [post, connection, null, null, randomUUID()]),
    ).rejects.toThrow(/SOCIAL_PLATFORM_NOT_PUBLISHABLE/);
  });

  it('refuses a connection that is not a connected Meta account', async () => {
    const post = await draft();
    await expect(
      rpc('request_social_post_publish', [post, randomUUID(), null, null, randomUUID()]),
    ).rejects.toThrow(/SOCIAL_CONNECTION_NOT_AVAILABLE/);
  });

  it('treats a repeated publish request as a double click', async () => {
    const post = await draft();
    await rpc('request_social_post_publish', [post, connection, null, null, randomUUID()]);
    const again = await rpc<{ replayed: boolean }>('request_social_post_publish', [
      post,
      connection,
      null,
      null,
      randomUUID(),
    ]);
    expect(again.replayed).toBe(true);
  });

  it('will not re-publish something already published', async () => {
    const post = await draft('FACEBOOK', 'PUBLISHED');
    await db.query('update social_posts set published_at=now() where id=$1', [post]);
    await expect(
      rpc('request_social_post_publish', [post, connection, null, null, randomUUID()]),
    ).rejects.toThrow(/SOCIAL_POST_NOT_PUBLISHABLE/);
  });

  it('claims a due post once and marks it published', async () => {
    const post = await draft();
    await rpc('request_social_post_publish', [post, connection, null, null, randomUUID()]);
    await claims(actor, 'service_role');
    const claimed = await db.query<{ id: string; lease_token: string }>(
      'select * from public.claim_due_social_posts($1,$2)',
      ['worker:test', 5],
    );
    expect(claimed.rows).toHaveLength(1);
    const second = await db.query('select * from public.claim_due_social_posts($1,$2)', [
      'worker:two',
      5,
    ]);
    expect(second.rows).toHaveLength(0);
    await expect(
      rpc('complete_social_post', [post, claimed.rows[0].lease_token, 'fb_123']),
    ).resolves.toBe(true);
    const row = await db.query<{ status: string; provider_post_id: string }>(
      'select status,provider_post_id from social_posts where id=$1',
      [post],
    );
    expect(row.rows[0]).toMatchObject({ status: 'PUBLISHED', provider_post_id: 'fb_123' });
  });

  it('does not claim a post scheduled for later', async () => {
    const post = await draft();
    await rpc('request_social_post_publish', [
      post,
      connection,
      null,
      new Date(Date.now() + 3_600_000).toISOString(),
      randomUUID(),
    ]);
    await claims(actor, 'service_role');
    const claimed = await db.query('select * from public.claim_due_social_posts($1,$2)', [
      'worker:test',
      5,
    ]);
    expect(claimed.rows).toHaveLength(0);
  });

  it('backs off, then fails with a visible reason at the attempt cap', async () => {
    const post = await draft();
    await rpc('request_social_post_publish', [post, connection, null, null, randomUUID()]);
    await claims(actor, 'service_role');
    const claimed = await db.query<{ lease_token: string }>(
      'select * from public.claim_due_social_posts($1,$2)',
      ['worker:test', 5],
    );
    await rpc('retry_social_post', [post, claimed.rows[0].lease_token, 'SOCIAL_PROVIDER_REJECTED']);
    const requeued = await db.query<{ status: string; lease_token: string | null }>(
      'select status,lease_token from social_posts where id=$1',
      [post],
    );
    expect(requeued.rows[0]).toMatchObject({ status: 'PUBLISH_REQUESTED', lease_token: null });

    await db.query('update social_posts set attempts=10,lease_token=$2 where id=$1', [post, 'w:x']);
    await rpc('retry_social_post', [post, 'w:x', 'SOCIAL_PROVIDER_REJECTED']);
    const failed = await db.query<{ status: string; safe_error_code: string }>(
      'select status,safe_error_code from social_posts where id=$1',
      [post],
    );
    expect(failed.rows[0]).toMatchObject({
      status: 'FAILED',
      safe_error_code: 'SOCIAL_PROVIDER_REJECTED',
    });
  });

  it('returns a stalled claim to the queue', async () => {
    const post = await draft();
    await rpc('request_social_post_publish', [post, connection, null, null, randomUUID()]);
    await claims(actor, 'service_role');
    await db.query('select * from public.claim_due_social_posts($1,$2)', ['worker:test', 5]);
    await db.query("update social_posts set updated_at=now()-interval '40 minutes' where id=$1", [
      post,
    ]);
    await expect(rpc('release_stalled_social_posts', [20])).resolves.toBe(1);
  });

  it('keeps the publish queue callable only by the worker role', async () => {
    await expect(
      db.query('select * from public.claim_due_social_posts($1,$2)', ['worker:test', 5]),
    ).rejects.toThrow(/SERVICE_ROLE_REQUIRED/);
  });
});
