/*
 * Authenticated smoke test for the isolated remote demo tenant.
 *
 * This never prints credentials or customer data.  It verifies that each
 * provisioned role can establish a Supabase session and resolve its workspace
 * access context through the same RPC used by the applications.
 *
 * Run: pnpm test:demo:roles
 */
import fs from 'node:fs';
import path from 'node:path';

const roleKeys = [
  'super_admin',
  'business_owner',
  'client_admin',
  'system_administrator',
  'gm_sales',
  'showroom_manager',
  'team_manager',
  'sales_consultant',
  'telecaller_bdc',
  'inventory_manager',
  'inventory_executive',
  'finance_manager',
  'insurance_manager',
  'rto_manager',
  'exchange_manager',
  'delivery_manager',
  'customer_relationship_manager',
  'digital_marketing_manager',
];

function readEnv() {
  const values = new Map();
  for (const line of fs.readFileSync(path.resolve('.env'), 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const env = readEnv();
const projectUrl = env.get('SUPABASE_URL')?.replace(/\/$/, '');
const anonKey = env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const demoPassword = env.get('DEMO_TEST_PASSWORD');

if (!projectUrl || !anonKey || !demoPassword) {
  throw new Error(
    'SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and DEMO_TEST_PASSWORD are required.',
  );
}

async function json(response) {
  const body = await response.text();
  const payload = body ? JSON.parse(body) : null;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function signIn(roleKey) {
  const email = `${roleKey.replaceAll('_', '-')}@demo.go-digital.invalid`;
  return json(
    await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: demoPassword }),
    }),
  );
}

async function bootstrap(accessToken) {
  return json(
    await fetch(`${projectUrl}/rest/v1/rpc/get_workspace_bootstrap`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    }),
  );
}

const results = [];
for (const roleKey of roleKeys) {
  try {
    const session = await signIn(roleKey);
    const workspace = await bootstrap(session.access_token);
    const hasAccessContext = Boolean(workspace && typeof workspace === 'object');
    if (!hasAccessContext) throw new Error('workspace bootstrap returned no access context');
    results.push({ role: roleKey, result: 'passed' });
  } catch (error) {
    results.push({
      role: roleKey,
      result: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

const failed = results.filter((result) => result.result === 'failed');
console.table(results.map(({ role, result }) => ({ role, result })));
if (failed.length) {
  console.error(
    JSON.stringify({
      failed: failed.map(({ role, detail }) => ({
        role,
        detail: detail?.replaceAll(demoPassword, '[redacted]'),
      })),
    }),
  );
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ passed: results.length, demo_tenant: 'go-digital-demo-test' }));
}
