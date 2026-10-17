import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const otherOrg = randomUUID();
const staff = randomUUID();
const colleague = randomUUID();
const branch = randomUUID();
const legacyBranch = randomUUID();
const customer = randomUUID();
const connection = randomUUID();
const googleLink = 'https://search.google.com/local/writereview?placeid=ChIJdemo';
let db: PGlite;

async function claims(user: string | null) {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    user ? JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }) : '',
  ]);
}
async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
  const result = await db.query<{ result: T }>(
    `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`,
    values,
  );
  return result.rows[0].result;
}
async function mapLocation(
  branchId: string,
  metadata: Record<string, unknown>,
  type = 'GBP_LOCATION',
) {
  await db.query(
    `insert into integration_branch_mappings(organization_id,connected_account_id,branch_id,
       external_resource_type,external_resource_id,external_resource_label,mapping_metadata)
     values($1,$2,$3,$4,$5,'Showroom',$6)`,
    [org, connection, branchId, type, `locations/${randomUUID().slice(0, 8)}`, metadata],
  );
}
async function branchRow(id = branch) {
  const row = await db.query<{
    google_review_url: string | null;
    version: number;
    feedback_brand_color: string | null;
    feedback_logo_object_file_id: string | null;
  }>(
    'select google_review_url,version,feedback_brand_color,feedback_logo_object_file_id from branches where id=$1',
    [id],
  );
  return row.rows[0];
}
async function logoFile(overrides: Partial<Record<string, unknown>> = {}) {
  const values = {
    organization_id: org,
    resource_type: 'organization',
    resource_id: org,
    mime_type: 'image/png',
    size_bytes: 40_000,
    uploaded_by: staff,
    ...overrides,
  };
  const row = await db.query<{ id: string }>(
    `insert into object_files(organization_id,resource_type,resource_id,bucket,object_key,mime_type,size_bytes,uploaded_by)
     values($1,$2,$3,'crm','logos/${randomUUID()}.png',$4,$5,$6) returning id`,
    [
      values.organization_id,
      values.resource_type,
      values.resource_id,
      values.mime_type,
      values.size_bytes,
      values.uploaded_by,
    ],
  );
  return row.rows[0].id;
}
async function issuedToken() {
  const row = await db.query<{ id: string }>(
    'insert into feedback_requests(organization_id,branch_id,customer_id) values($1,$2,$3) returning id',
    [org, branch, customer],
  );
  await claims(staff);
  return (await rpc<{ token: string }>('issue_feedback_form_link', [row.rows[0].id, 30])).token;
}

describe('branch feedback branding and Google review link', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/public-feedback-base.sql'));
    await db.exec(source('supabase/migrations/202609070202_public_feedback_forms.sql'));
    await db.exec(source('tests/api/fixtures/branch-feedback-branding-base.sql'));
    await db.exec(source('supabase/migrations/202610142271_branch_feedback_branding.sql'));
    await db.query("insert into organizations(id,name) values($1,'Demo Motors'),($2,'Other')", [
      org,
      otherOrg,
    ]);
    await db.query('insert into profiles(id,organization_id) values($1,$3),($2,$3)', [
      staff,
      colleague,
      org,
    ]);
    await db.query(
      "insert into branches(id,organization_id,name) values($1,$3,'MG Road'),($2,$3,'Legacy invalid')",
      [branch, legacyBranch, org],
    );
    await db.query('insert into customers(id,organization_id) values($1,$2)', [customer, org]);
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
    await claims(staff);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  describe('review link from Google Business Profile', () => {
    it('fills an empty branch link when a location is mapped, and audits it', async () => {
      await mapLocation(branch, { review_url: googleLink });
      expect((await branchRow()).google_review_url).toBe(googleLink);
      const audit = await db.query<{ action: string }>(
        "select action from audit_logs where action='branch.google_review_url_filled'",
      );
      expect(audit.rows).toHaveLength(1);
    });

    it('never overwrites a link that is already set', async () => {
      await db.query('update branches set google_review_url=$2 where id=$1', [
        branch,
        'https://g.page/r/typed/review',
      ]);
      await mapLocation(branch, { review_url: googleLink });
      expect((await branchRow()).google_review_url).toBe('https://g.page/r/typed/review');
    });

    it('ignores links off Google hosts and non-GBP mappings', async () => {
      await mapLocation(branch, { review_url: 'https://evil.example/review' });
      await mapLocation(branch, { review_url: 'http://search.google.com/insecure' });
      await mapLocation(branch, { review_url: googleLink }, 'META_PAGE');
      expect((await branchRow()).google_review_url).toBeNull();
    });

    it('still saves the mapping when the branch row fails its own validation', async () => {
      await mapLocation(legacyBranch, { review_url: googleLink });
      expect((await branchRow(legacyBranch)).google_review_url).toBeNull();
      const mappings = await db.query(
        'select 1 from integration_branch_mappings where branch_id=$1',
        [legacyBranch],
      );
      expect(mappings.rows).toHaveLength(1);
    });
  });

  describe('feedback page branding', () => {
    it('saves a colour and an uploaded logo, bumping the branch version', async () => {
      const logo = await logoFile();
      const result = await rpc<{ version: number; brand_color: string }>(
        'set_branch_feedback_branding',
        [branch, 1, '#1D4ED8', 'REPLACE', logo],
      );
      expect(result).toMatchObject({ version: 2, brand_color: '#1d4ed8' });
      expect(await branchRow()).toMatchObject({
        feedback_brand_color: '#1d4ed8',
        feedback_logo_object_file_id: logo,
      });
    });

    it('refuses a stale version with PT409 (HTTP 409), not a retried 40001', async () => {
      await expect(
        rpc('set_branch_feedback_branding', [branch, 7, '#1d4ed8', 'KEEP', null]),
      ).rejects.toMatchObject({ code: 'PT409' });
    });

    it('rejects a colour outside #rrggbb', async () => {
      await expect(
        rpc('set_branch_feedback_branding', [branch, 1, 'blue', 'KEEP', null]),
      ).rejects.toThrow(/INVALID_BRAND_COLOR/);
    });

    it.each([
      ['uploaded by someone else', { uploaded_by: colleague }],
      ['not an image', { mime_type: 'application/pdf' }],
      ['larger than 2 MB', { size_bytes: 3 * 1024 * 1024 }],
      ['from another organization', { organization_id: otherOrg, resource_id: otherOrg }],
      ['attached to another record', { resource_type: 'customer', resource_id: customer }],
    ])('will not publish a file %s as the logo', async (_label, overrides) => {
      const file = await logoFile(overrides);
      await expect(
        rpc('set_branch_feedback_branding', [branch, 1, null, 'REPLACE', file]),
      ).rejects.toThrow(/INVALID_LOGO_FILE/);
    });

    it('refuses a caller without branch management', async () => {
      await claims(randomUUID());
      // Each refusal aborts the statement; the savepoint keeps the transaction usable.
      await db.exec('savepoint before_read');
      await expect(rpc('get_branch_feedback_branding', [branch])).rejects.toThrow(
        /BRANCH_MANAGE_PERMISSION_REQUIRED/,
      );
      await db.exec('rollback to savepoint before_read');
      await expect(
        rpc('set_branch_feedback_branding', [branch, 1, '#000000', 'KEEP', null]),
      ).rejects.toThrow(/BRANCH_MANAGE_PERMISSION_REQUIRED/);
    });

    it('shows the theme on the public form and resolves the logo only while the link is live', async () => {
      const logo = await logoFile();
      await rpc('set_branch_feedback_branding', [branch, 1, '#0f766e', 'REPLACE', logo]);
      const token = await issuedToken();
      await claims(null);
      expect(await rpc('get_public_feedback_form', [token])).toMatchObject({
        status: 'OPEN',
        brand_color: '#0f766e',
        has_logo: true,
      });
      expect(await rpc('resolve_public_feedback_logo', [token])).toMatchObject({
        bucket: 'crm',
        mime_type: 'image/png',
      });
      await rpc('submit_public_feedback', [token, 5, 'Great']);
      expect(await rpc('resolve_public_feedback_logo', [token])).toBeNull();
      expect(await rpc('resolve_public_feedback_logo', ['nope'])).toBeNull();
    });

    it('lets only the service role resolve logo storage keys', async () => {
      const grants = await db.query<{ grantee: string }>(
        `select grantee from information_schema.routine_privileges
         where routine_name='resolve_public_feedback_logo' and privilege_type='EXECUTE'`,
      );
      const grantees = grants.rows.map((row) => row.grantee);
      expect(grantees).toContain('service_role');
      expect(grantees).not.toContain('anon');
      expect(grantees).not.toContain('authenticated');
    });
  });
});
