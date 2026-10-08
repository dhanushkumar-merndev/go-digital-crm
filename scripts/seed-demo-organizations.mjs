// Rebuilds the five demo dealerships end to end on an isolated dev/staging
// project:
//
//   1. seed-demo-tenant.mjs for each organization (roles, permissions, one
//      account per role, baseline records). Metro stays owner-only because it
//      is the dealership still in onboarding review.
//   2. The Demo-org fixtures the role and flow test scripts expect.
//   3. Extra showrooms, teams and staff, so multi-branch pages have more than
//      one showroom to compare.
//   4. scripts/sql/10-seed-demo-volume.sql: leads, the whole sales and
//      operations pipeline, stock, targets and tenant states, with the edge
//      cases spread across the organizations.
//   5. Real stock photos in Tigris for part of the stock, so both the photo
//      and the fallback-artwork paths are exercised.
//   6. Metro's onboarding submission with its three documents, so Super
//      Admin's Onboarding Reviews has one to review.
//
// Afterwards, VACUUM FULL the big tables if a failed run left index bloat
// behind: the free tier counts on-disk size, not live rows.
//
//   npm install --prefix /tmp/gdm-seed pg@8.13.1   # once; pg is not a project dependency
//   NODE_PATH=/tmp/gdm-seed/node_modules node scripts/seed-demo-organizations.mjs --apply [--skip-tenants]
//
// It never creates integrations: the tenant connects real ones.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

function readEnv() {
  const values = new Map();
  for (const line of fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const env = readEnv();
const projectUrl = env.get('SUPABASE_URL')?.replace(/\/$/, '');
const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
const demoPassword = env.get('DEMO_TEST_PASSWORD');
const allowedProjectRef = env.get('DEMO_ALLOWED_SUPABASE_PROJECT_REF')?.trim();

if (!process.argv.includes('--apply')) {
  console.error('Refusing to write remote demo data. Re-run with --apply.');
  process.exit(1);
}
if (
  env.get('DEMO_ALLOW_REMOTE_SEED') !== 'true' ||
  !allowedProjectRef ||
  !projectUrl ||
  new URL(projectUrl).hostname !== `${allowedProjectRef}.supabase.co` ||
  !serviceRoleKey ||
  !demoPassword
) {
  console.error('Remote demo seed blocked: the dev project guard in .env does not match.');
  process.exit(1);
}

const headers = {
  apikey: serviceRoleKey,
  authorization: `Bearer ${serviceRoleKey}`,
  'content-type': 'application/json',
};

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok)
    throw new Error(
      `${options.method ?? 'GET'} ${url}: ${response.status} ${JSON.stringify(payload)}`,
    );
  return payload;
}
const restUrl = (table, query = {}) => {
  const search = new URLSearchParams(query);
  return `${projectUrl}/rest/v1/${table}${search.size ? `?${search}` : ''}`;
};
const select = (table, query) => request(restUrl(table, query));
const insert = (table, rows, onConflict) =>
  request(restUrl(table, onConflict ? { on_conflict: onConflict } : {}), {
    method: 'POST',
    headers: {
      Prefer: `return=representation${onConflict ? ',resolution=merge-duplicates' : ''}`,
    },
    body: JSON.stringify(rows),
  });

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
}

// --- 1 & 2: organizations and the Demo-org fixtures ---------------------------

function seedTenants() {
  for (const org of ['demo', 'sapphire', 'pioneer', 'royal'])
    run('node', ['scripts/seed-demo-tenant.mjs', '--apply', `--org=${org}`]);
  run('node', ['scripts/seed-demo-tenant.mjs', '--apply', '--org=metro', '--owner-only']);
  run('node', ['scripts/seed-demo-test-drive-inventory.mjs', '--apply']);
  run('node', ['scripts/seed-demo-competitor-comparison.mjs', '--apply']);
  run('node', ['scripts/seed-demo-sales-consultant-leads.mjs', '--apply', '--count=100']);
  run('node', ['scripts/seed-demo-sales-consultant-today-schedule.mjs', '--apply']);
  run('node', ['scripts/seed-demo-customer-personalisation.mjs', '--apply']);
}

// --- 3: extra showrooms ------------------------------------------------------

// HBL-01 is deliberately left without staff or activity: an idle showroom must
// still appear on every comparison.
const extraBranches = [
  {
    slug: 'go-digital-demo-test',
    domain: 'demo.go-digital.invalid',
    code: 'BLR-02',
    name: 'Bengaluru Whitefield Showroom',
    city: 'Bengaluru',
    state: 'Karnataka',
    staffed: true,
  },
  {
    slug: 'go-digital-demo-test',
    domain: 'demo.go-digital.invalid',
    code: 'MYS-01',
    name: 'Mysuru Showroom',
    city: 'Mysuru',
    state: 'Karnataka',
    staffed: true,
  },
  {
    slug: 'go-digital-demo-test',
    domain: 'demo.go-digital.invalid',
    code: 'HBL-01',
    name: 'Hubballi Showroom (opening soon)',
    city: 'Hubballi',
    state: 'Karnataka',
    staffed: false,
  },
  {
    slug: 'sapphire-hyundai-test',
    domain: 'sapphire.demo.go-digital.invalid',
    code: 'PUN-02',
    name: 'Pune Hinjewadi Showroom',
    city: 'Pune',
    state: 'Maharashtra',
    staffed: true,
  },
  {
    slug: 'royal-kia-test',
    domain: 'royal.demo.go-digital.invalid',
    code: 'HYD-02',
    name: 'Hyderabad Kompally Showroom',
    city: 'Hyderabad',
    state: 'Telangana',
    staffed: true,
  },
];

const branchStaff = [
  ['team_manager', 'Team Manager', 'TEAM_MANAGER', 'OWN_TEAM'],
  ['sales_consultant', 'Sales Consultant', 'SALES_CONSULTANT', 'OWN_RECORDS'],
  ['sales_consultant', 'Sales Consultant B', 'SALES_CONSULTANT', 'OWN_RECORDS'],
  ['telecaller_bdc', 'Telecaller', 'TELECALLER_BDC', 'OWN_RECORDS'],
  ['telecaller_bdc', 'Telecaller B', 'TELECALLER_BDC', 'OWN_RECORDS'],
];

async function authUserByEmail(email) {
  const payload = await request(`${projectUrl}/auth/v1/admin/users?per_page=1000`);
  return payload.users?.find((user) => user.email?.toLowerCase() === email) ?? null;
}

async function seedExtraBranches() {
  for (const spec of extraBranches) {
    const [organization] = await select('organizations', { select: 'id', slug: `eq.${spec.slug}` });
    const [clientAdmin] = await select('profiles', {
      select: 'id',
      email: `eq.client-admin@${spec.domain}`,
    });
    const [branch] = await insert(
      'branches',
      {
        organization_id: organization.id,
        code: spec.code,
        name: spec.name,
        address: { city: spec.city, state: spec.state, country: 'India' },
        timezone: 'Asia/Kolkata',
        showroom_category: spec.staffed ? 'Standard' : 'Upcoming',
      },
      'organization_id,code',
    );
    if (!spec.staffed) continue;
    const [team] = await insert(
      'teams',
      {
        organization_id: organization.id,
        branch_id: branch.id,
        name: `${spec.code} Sales Team`,
        fresh_assignment_mode: 'ROUND_ROBIN',
        qualified_assignment_mode: 'ROUND_ROBIN',
      },
      'organization_id,branch_id,name',
    );
    const roles = await select('roles', {
      select: 'id,role_key,mfa_required',
      organization_id: `eq.${organization.id}`,
    });
    for (const [roleKey, label, memberType, scope] of branchStaff) {
      const suffix = label.endsWith(' B') ? '-b' : '';
      const email = `${roleKey.replaceAll('_', '-')}${suffix}-${spec.code.toLowerCase()}@${spec.domain}`;
      const fullName = `${spec.name.split(' ')[0]} ${label}`;
      const user =
        (await authUserByEmail(email)) ??
        (await request(`${projectUrl}/auth/v1/admin/users`, {
          method: 'POST',
          body: JSON.stringify({
            email,
            password: demoPassword,
            email_confirm: true,
            user_metadata: { full_name: fullName, demo_fixture: true },
          }),
        }));
      const role = roles.find((row) => row.role_key === roleKey);
      await insert(
        'profiles',
        {
          id: user.id,
          organization_id: organization.id,
          full_name: fullName,
          email,
          phone: '+919000000000',
          normalized_phone: '+919000000000',
          employee_id: `${spec.code}-${roleKey.toUpperCase()}${suffix.toUpperCase()}`,
          active: true,
          mfa_required: role.mfa_required,
        },
        'id',
      );
      const existing = await select('user_role_assignments', {
        select: 'id',
        user_id: `eq.${user.id}`,
        active: 'eq.true',
      });
      if (existing.length === 0)
        await insert('user_role_assignments', {
          organization_id: organization.id,
          user_id: user.id,
          role_id: role.id,
          data_scope: scope,
          selected_branch_ids: [],
          active: true,
          granted_by: clientAdmin.id,
        });
      await insert(
        'user_branch_access',
        {
          organization_id: organization.id,
          user_id: user.id,
          branch_id: branch.id,
          granted_by: clientAdmin.id,
          active: true,
        },
        'user_id,branch_id',
      );
      await insert(
        'team_members',
        {
          organization_id: organization.id,
          team_id: team.id,
          user_id: user.id,
          member_type: memberType,
          eligible_for_fresh_leads: memberType !== 'TEAM_MANAGER',
          eligible_for_qualified_leads: memberType !== 'TEAM_MANAGER',
          active: true,
        },
        'team_id,user_id',
      );
      if (memberType === 'TEAM_MANAGER')
        await request(restUrl('teams', { id: `eq.${team.id}` }), {
          method: 'PATCH',
          body: JSON.stringify({ manager_id: user.id }),
        });
    }
    console.log(`Showroom ${spec.code} ready for ${spec.slug}.`);
  }
}

// --- 5: stock photos ---------------------------------------------------------

function tigris() {
  return new S3Client({
    region: env.get('TIGRIS_REGION') ?? 'auto',
    endpoint: env.get('TIGRIS_ENDPOINT'),
    credentials: {
      accessKeyId: env.get('TIGRIS_ACCESS_KEY_ID'),
      secretAccessKey: env.get('TIGRIS_SECRET_ACCESS_KEY'),
    },
  });
}

async function seedStockPhotos() {
  const bucket = env.get('TIGRIS_BUCKET');
  const s3 = tigris();
  const images = ['electric-coupe-suv.png', 'graphite-family-suv.png'].map((name) => {
    const body = fs.readFileSync(path.resolve('public/demo/vehicles', name));
    return { name, body, checksum: crypto.createHash('sha256').update(body).digest('hex') };
  });
  // Photos go on roughly every third sellable unit in the two larger active
  // dealerships; every other unit keeps the fallback artwork.
  let uploaded = 0;
  for (const slug of ['go-digital-demo-test', 'sapphire-hyundai-test']) {
    const [organization] = await select('organizations', { select: 'id', slug: `eq.${slug}` });
    const units = await select('stock_units', {
      select: 'id,branch_id',
      organization_id: `eq.${organization.id}`,
      status: 'in.(AVAILABLE,RESERVED,INCOMING)',
      deleted_at: 'is.null',
      order: 'vin.asc',
    });
    const existing = new Set(
      (
        await select('object_files', {
          select: 'resource_id',
          organization_id: `eq.${organization.id}`,
          resource_type: 'eq.stock_unit',
        })
      ).map((row) => row.resource_id),
    );
    for (const [index, unit] of units.entries()) {
      if (index % 3 !== 0 || existing.has(unit.id)) continue;
      const image = images[index % images.length];
      const objectKey = `${organization.id}/stock_unit/${unit.id}/${crypto.randomUUID()}-${image.name}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: image.body,
          ContentType: 'image/png',
        }),
      );
      await insert('object_files', {
        organization_id: organization.id,
        branch_id: unit.branch_id,
        resource_type: 'stock_unit',
        resource_id: unit.id,
        bucket,
        object_key: objectKey,
        mime_type: 'image/png',
        size_bytes: image.body.length,
        checksum: image.checksum,
        original_file_name: image.name,
      });
      uploaded += 1;
    }
  }
  console.log(`Uploaded ${uploaded} stock photo(s).`);
}

// --- 6: Metro's onboarding submission ----------------------------------------

// A one-page placeholder PDF, so the review screen has real files to open.
function placeholderPdf(title) {
  const text = `BT /F1 18 Tf 72 720 Td (${title} - demo placeholder) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function seedMetroOnboarding() {
  const [organization] = await select('organizations', {
    select: 'id,name,legal_name,gst_number,status',
    slug: 'eq.metro-mahindra-test',
  });
  const existing = await select('organization_onboarding_submissions', {
    select: 'id',
    organization_id: `eq.${organization.id}`,
  });
  if (existing.length > 0) return;
  const [owner] = await select('profiles', {
    select: 'id',
    email: 'eq.business-owner@metro.demo.go-digital.invalid',
  });
  const bucket = env.get('TIGRIS_BUCKET');
  const s3 = tigris();
  const documents = [];
  for (const [documentType, title] of [
    ['OWNER_IDENTITY', 'Owner identity proof'],
    ['GST_CERTIFICATE', 'GST registration certificate'],
    ['DEALERSHIP_AUTHORIZATION', 'Mahindra dealership letter of intent'],
  ]) {
    const body = placeholderPdf(title);
    const fileName = `${documentType.toLowerCase().replaceAll('_', '-')}.pdf`;
    const objectKey = `${organization.id}/organization/${organization.id}/${crypto.randomUUID()}-${fileName}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: body,
        ContentType: 'application/pdf',
      }),
    );
    const [file] = await insert('object_files', {
      organization_id: organization.id,
      resource_type: 'organization',
      resource_id: organization.id,
      bucket,
      object_key: objectKey,
      mime_type: 'application/pdf',
      size_bytes: body.length,
      checksum: crypto.createHash('sha256').update(body).digest('hex'),
      uploaded_by: owner.id,
      original_file_name: fileName,
    });
    documents.push({ document_type: documentType, object_file_id: file.id });
  }
  const [submission] = await insert('organization_onboarding_submissions', {
    organization_id: organization.id,
    version: 1,
    organization_name: organization.name,
    legal_name: organization.legal_name,
    gst_number: organization.gst_number,
    dealer_information: {
      oem: 'Mahindra',
      dealer_code: 'MAH-DL-0427',
      branch_count: 1,
      main_showroom: 'Delhi Dwarka Showroom',
    },
    status: 'SUBMITTED',
    submitted_by: owner.id,
    submitted_at: new Date(Date.now() - 26 * 3_600_000).toISOString(),
  });
  await insert(
    'organization_onboarding_documents',
    documents.map((document) => ({
      organization_id: organization.id,
      submission_id: submission.id,
      ...document,
    })),
  );
  await insert('tenant_status_history', {
    organization_id: organization.id,
    from_status: organization.status,
    to_status: 'UNDER_REVIEW',
    changed_by: owner.id,
    reason: 'Business Owner submitted required onboarding evidence',
  });
  await request(restUrl('organizations', { id: `eq.${organization.id}` }), {
    method: 'PATCH',
    body: JSON.stringify({ status: 'UNDER_REVIEW' }),
  });
  console.log('Metro Mahindra onboarding submitted for review.');
}

// --- SQL over the session pooler --------------------------------------------

// The volume file runs for several minutes, past the ~100 s limit of the
// Management API behind `supabase db query`, so it goes over a direct session
// on the IPv4 pooler (supabase/.temp/pooler-url, written by `supabase link`).
async function runSqlFile(file) {
  // pg is not a project dependency; resolve it through NODE_PATH (see the header).
  const require = createRequire(import.meta.url);
  let pg;
  try {
    pg = require('pg');
  } catch {
    throw new Error(
      'The pg driver is needed for the volume SQL: npm install --prefix /tmp/gdm-seed pg@8.13.1, then re-run with NODE_PATH=/tmp/gdm-seed/node_modules.',
    );
  }
  const pooler = new URL(fs.readFileSync('supabase/.temp/pooler-url', 'utf8').trim());
  pooler.password = new URL(env.get('DB_URL')).password;
  const client = new pg.Client({
    connectionString: pooler.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    console.log(`\nRunning ${file} over the session pooler…`);
    const result = await client.query(fs.readFileSync(file, 'utf8'));
    const rows = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.rows ?? []);
    console.log(JSON.stringify(rows.at(-1) ?? null));
  } finally {
    await client.end();
  }
}

async function main() {
  if (!process.argv.includes('--skip-tenants')) seedTenants();
  await seedExtraBranches();
  await runSqlFile('scripts/sql/10-seed-demo-volume.sql');
  await seedStockPhotos();
  await seedMetroOnboarding();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
