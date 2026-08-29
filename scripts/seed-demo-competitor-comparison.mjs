/*
 * Seed a small, clearly identified comparison fixture for the isolated demo
 * tenant. It gives the Sales Consultant a meaningful Competitor Compare page
 * without touching a production tenant.
 *
 * Run: pnpm seed:demo:competitor-comparison
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEMO_SLUG = 'go-digital-demo-test';
const env = new Map();

for (const line of fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) env.set(match[1], match[2]);
}

const projectUrl = env.get('SUPABASE_URL')?.replace(/\/$/, '');
const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
const allowedProjectRef = env.get('DEMO_ALLOWED_SUPABASE_PROJECT_REF')?.trim();

if (!process.argv.includes('--apply')) {
  console.error('Refusing to write demo comparison data. Re-run with --apply.');
  process.exit(1);
}
if (!projectUrl || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (
  env.get('DEMO_ALLOW_REMOTE_SEED') !== 'true' ||
  !allowedProjectRef ||
  !/^[a-z]{20}$/.test(allowedProjectRef) ||
  new URL(projectUrl).hostname !== `${allowedProjectRef}.supabase.co`
) {
  console.error(
    'Remote demo seed is blocked: this command only targets the isolated demo project.',
  );
  process.exit(1);
}

const headers = {
  apikey: serviceRoleKey,
  authorization: `Bearer ${serviceRoleKey}`,
  'content-type': 'application/json',
};

function url(table, query = {}) {
  const params = new URLSearchParams(query);
  return `${projectUrl}/rest/v1/${table}${params.size ? `?${params}` : ''}`;
}

async function request(target, options = {}) {
  const response = await fetch(target, { ...options, headers: { ...headers, ...options.headers } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function select(table, query) {
  return request(url(table, query));
}

async function upsert(table, rows, onConflict) {
  return request(url(table, { on_conflict: onConflict }), {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
}

async function patch(table, query, row) {
  return request(url(table, query), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
}

const demoSpecifications = {
  'Battery capacity': '55 kWh',
  Range: '430 km (claimed)',
  Power: '150 PS',
  Torque: '310 Nm',
  'Fast charging': '10–80% in 45 min',
  Warranty: '8 years / 160,000 km battery',
};

const competitors = [
  {
    manufacturer: 'Mahindra',
    model: 'XUV400',
    variant: 'EL Pro',
    fuel_type: 'Electric',
    ex_showroom_price: 1799000,
    specifications: {
      'Battery capacity': '39.4 kWh',
      Range: '456 km (claimed)',
      Power: '150 PS',
      Torque: '310 Nm',
      'Fast charging': '0–80% in 50 min',
      Warranty: '8 years / 160,000 km battery',
    },
    advantages: ['Long claimed range', 'Strong torque for city driving', 'Five-star safety focus'],
  },
  {
    manufacturer: 'MG',
    model: 'ZS EV',
    variant: 'Executive',
    fuel_type: 'Electric',
    ex_showroom_price: 1898000,
    specifications: {
      'Battery capacity': '50.3 kWh',
      Range: '461 km (claimed)',
      Power: '177 PS',
      Torque: '280 Nm',
      'Fast charging': '0–80% in 60 min',
      Warranty: '8 years / 150,000 km battery',
    },
    advantages: [
      'Higher power output',
      'Established EV ownership ecosystem',
      'Spacious crossover cabin',
    ],
  },
];

async function main() {
  const [organization] = await select('organizations', {
    slug: `eq.${DEMO_SLUG}`,
    select: 'id,name',
    limit: '1',
  });
  if (!organization) throw new Error(`Demo organization "${DEMO_SLUG}" was not found.`);

  const variants = await select('vehicle_variants', {
    organization_id: `eq.${organization.id}`,
    active: 'eq.true',
    select: 'id,name,specifications',
    order: 'name.asc',
  });
  const selectedVariant =
    variants.find((variant) => variant.name === 'Demo SUV Premium') ?? variants[0];
  if (!selectedVariant)
    throw new Error('Seed a demo vehicle variant before creating a comparison.');

  await patch(
    'vehicle_variants',
    { id: `eq.${selectedVariant.id}` },
    { specifications: demoSpecifications },
  );
  const profiles = await upsert(
    'competitor_vehicle_profiles',
    competitors.map((profile) => ({
      organization_id: organization.id,
      ...profile,
      active: true,
    })),
    'organization_id,manufacturer,model,variant',
  );

  console.log(
    `Seeded ${profiles.length} competitor profile(s) and specifications for ${selectedVariant.name}.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
