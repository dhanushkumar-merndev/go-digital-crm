/*
 * Put bookable vehicles in the demo branch so a test drive can actually be
 * scheduled.
 *
 * `get_test_drive_vehicle_options` only returns stock units that are AVAILABLE,
 * in the lead's branch, not already held by a SCHEDULED or ACTIVE test drive,
 * and whose variant -> model -> brand chain is all active. With an empty
 * inventory the vehicle picker is permanently empty and the form cannot be
 * completed, which reads as a broken page rather than as missing data.
 *
 * Idempotent: every row is keyed by a fixture VIN, so re-running tops the branch
 * back up to the requested count instead of duplicating it.
 *
 * Run: pnpm seed:demo:test-drive-inventory
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEMO_SLUG = 'go-digital-demo-test';
const BRANCH_CODE = 'BLR-01';
// VINs are constrained to a real 17-character VIN alphabet: [A-HJ-NPR-Z0-9],
// which excludes I, O and Q. "DEMO" is therefore not usable in a VIN.
const VIN_PREFIX = 'DEMTDRV';
const FIXTURE_PREFIX = 'DEMOTD';
const DEFAULT_UNIT_COUNT = 6;
const MAX_UNIT_COUNT = 24;

// Kept deliberately small and recognisable: these are demo cars, and anyone
// looking at the inventory should be able to tell at a glance that they are.
const CATALOGUE = [
  { brand: 'Tata', model: 'Curvv EV', variants: ['Empowered+ A', 'Accomplished'] },
  { brand: 'Tata', model: 'Harrier', variants: ['Fearless+', 'Adventure'] },
  { brand: 'Tata', model: 'Nexon', variants: ['Creative+ PS'] },
];
const COLOURS = ['Pristine White', 'Flame Red', 'Daytona Grey', 'Pure Grey', 'Calgary White'];

function readEnv() {
  const values = new Map();
  const envPath = path.resolve(process.cwd(), '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function requestedUnitCount() {
  const argument = process.argv.find((value) => value.startsWith('--count='));
  if (!argument) return DEFAULT_UNIT_COUNT;
  const value = Number.parseInt(argument.slice('--count='.length), 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_UNIT_COUNT) {
    console.error(`--count must be a whole number from 1 to ${MAX_UNIT_COUNT}.`);
    process.exit(1);
  }
  return value;
}

const targetCount = requestedUnitCount();
const env = readEnv();
const projectUrl = env.get('SUPABASE_URL')?.replace(/\/$/, '');
const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
const remoteSeedAllowed = env.get('DEMO_ALLOW_REMOTE_SEED') === 'true';
const allowedProjectRef = env.get('DEMO_ALLOWED_SUPABASE_PROJECT_REF')?.trim();

if (!process.argv.includes('--apply')) {
  console.error(
    'Refusing to write demo inventory. Re-run with --apply after confirming the isolated demo project.',
  );
  process.exit(1);
}
if (!projectUrl || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

let projectHostname;
try {
  projectHostname = new URL(projectUrl).hostname;
} catch {
  projectHostname = undefined;
}
// Same guard as the other demo seeds: this writes with the service role key, so
// it must be impossible to point at production by accident.
if (
  !remoteSeedAllowed ||
  !allowedProjectRef ||
  !/^[a-z]{20}$/.test(allowedProjectRef) ||
  projectHostname !== `${allowedProjectRef}.supabase.co`
) {
  console.error(
    'Remote demo seed blocked. Set DEMO_ALLOW_REMOTE_SEED=true and make DEMO_ALLOWED_SUPABASE_PROJECT_REF match SUPABASE_URL for an isolated dev/staging project.',
  );
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

function restUrl(table, query = {}) {
  const search = new URLSearchParams(query);
  return `${projectUrl}/rest/v1/${table}${search.size ? `?${search}` : ''}`;
}

async function select(table, query) {
  return request(restUrl(table, query));
}

async function upsert(table, rows, onConflict) {
  if (rows.length === 0) return [];
  return request(restUrl(table, { on_conflict: onConflict }), {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
}

async function main() {
  const [organization] = await select('organizations', {
    slug: `eq.${DEMO_SLUG}`,
    select: 'id,name',
    limit: '1',
  });
  if (!organization) throw new Error(`Demo organization "${DEMO_SLUG}" not found.`);

  const [branch] = await select('branches', {
    organization_id: `eq.${organization.id}`,
    code: `eq.${BRANCH_CODE}`,
    select: 'id,name',
    limit: '1',
  });
  if (!branch) throw new Error(`Demo branch "${BRANCH_CODE}" not found.`);

  // Brand -> model -> variant, each upserted on its natural key so re-running
  // reuses the existing rows rather than colliding on the unique constraints.
  const variantIds = [];
  for (const entry of CATALOGUE) {
    const [brand] = await upsert(
      'vehicle_brands',
      [{ organization_id: organization.id, name: entry.brand, active: true }],
      'organization_id,name',
    );
    const [model] = await upsert(
      'vehicle_models',
      [
        {
          organization_id: organization.id,
          brand_id: brand.id,
          name: entry.model,
          active: true,
        },
      ],
      'organization_id,brand_id,name',
    );
    const variants = await upsert(
      'vehicle_variants',
      entry.variants.map((name) => ({
        organization_id: organization.id,
        model_id: model.id,
        name,
        active: true,
      })),
      'organization_id,model_id,name',
    );
    for (const variant of variants)
      variantIds.push({ id: variant.id, label: `${entry.brand} ${entry.model} ${variant.name}` });
  }

  const units = Array.from({ length: targetCount }, (_, index) => {
    const variant = variantIds[index % variantIds.length];
    const serial = String(index + 1).padStart(3, '0');
    return {
      organization_id: organization.id,
      branch_id: branch.id,
      variant_id: variant.id,
      vin: `${VIN_PREFIX}${String(index + 1).padStart(10, '0')}`,
      chassis_number: `${FIXTURE_PREFIX}CHS${serial}`,
      engine_number: `${FIXTURE_PREFIX}ENG${serial}`,
      color: COLOURS[index % COLOURS.length],
      // AVAILABLE is the only status the vehicle picker accepts.
      status: 'AVAILABLE',
      received_at: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
      deleted_at: null,
    };
  });

  const written = await upsert('stock_units', units, 'organization_id,vin');

  const available = await select('stock_units', {
    organization_id: `eq.${organization.id}`,
    branch_id: `eq.${branch.id}`,
    status: 'eq.AVAILABLE',
    deleted_at: 'is.null',
    select: 'id',
  });

  console.log(
    `Seeded ${written.length} demo stock unit(s) into ${branch.name}. ` +
      `${available.length} vehicle(s) now AVAILABLE in that branch.`,
  );
  console.log(
    'Note: a vehicle disappears from the picker while it is held by a SCHEDULED or ACTIVE test drive.',
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
