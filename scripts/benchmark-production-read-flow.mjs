/*
 * Read-only latency benchmark for production sales dashboards and lead flow.
 *
 * It signs in as the configured demo users, discards response bodies, and
 * reports network-inclusive timings. No mutation RPC is called.
 *
 * Usage:
 *   node scripts/benchmark-production-read-flow.mjs --repeats=5
 *   node scripts/benchmark-production-read-flow.mjs --repeats=5 --out=/tmp/before.json
 */
import fs from 'node:fs';
import path from 'node:path';

function readEnv() {
  const values = new Map();
  for (const line of fs.readFileSync(path.resolve('.env'), 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, ...value] = argument.replace(/^--/, '').split('=');
    return [name, value.join('=') || 'true'];
  }),
);
const repeats = Math.max(1, Number(flags.get('repeats') ?? 5));
const outputFile = flags.get('out');
const env = readEnv();
const projectUrl = (env.get('SUPABASE_URL') ?? env.get('NEXT_PUBLIC_SUPABASE_URL'))?.replace(
  /\/$/,
  '',
);
const anonKey = env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const password = env.get('DEMO_TEST_PASSWORD');
if (!projectUrl || !anonKey || !password) {
  throw new Error('Supabase URL, anon key, and DEMO_TEST_PASSWORD are required.');
}

const roleEmails = {
  telecaller: env.get('DEMO_TELECALLER_EMAIL'),
  'sales-consultant': env.get('DEMO_SALES_CONSULTANT_EMAIL'),
  'team-manager': env.get('DEMO_TEAM_MANAGER_EMAIL'),
  'showroom-manager': env.get('DEMO_SHOWROOM_MANAGER_EMAIL'),
  'gm-sales': env.get('DEMO_GM_SALES_EMAIL'),
};

async function signIn(role, email) {
  if (!email) throw new Error(`Demo email is not configured for ${role}.`);
  const response = await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Sign-in failed for ${role}: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

const tokens = Object.fromEntries(
  await Promise.all(
    Object.entries(roleEmails).map(async ([role, email]) => [role, await signIn(role, email)]),
  ),
);

async function post(role, target, body) {
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${tokens[role]}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    let code = '';
    try {
      const payload = JSON.parse(responseBody);
      code = payload?.error?.code ?? payload?.code ?? '';
    } catch {
      // Never print response bodies; the status is enough when no stable code exists.
    }
    throw new Error(`HTTP ${response.status}${code ? ` ${code}` : ''}`);
  }
}

const rpc = (role, name, body = {}) => post(role, `${projectUrl}/rest/v1/rpc/${name}`, body);

const leadBase = {
  target_page: 1,
  target_page_size: 25,
  target_search: '',
  target_status: 'all',
  target_sort: 'updated:desc',
  target_model: null,
  target_source: null,
  target_stage: 'all',
  target_temperature: 'all',
  target_followup_from: null,
  target_followup_to: null,
};
const followupBase = {
  target_search: '',
  target_status: 'all',
  target_branch_id: null,
  target_team_id: null,
  target_owner_id: null,
  target_page: 1,
  target_page_size: 25,
  target_sort: 'scheduled:asc',
  target_timezone: 'Asia/Kolkata',
  target_priority: 'all',
  target_model: '',
  target_source: '',
  target_temperature: 'all',
  target_followup_from: null,
  target_followup_to: null,
};
const appointmentBase = {
  target_search: '',
  target_status: 'all',
  target_branch_id: null,
  target_team_id: null,
  target_owner_id: null,
  target_page: 1,
  target_page_size: 25,
  target_sort: 'scheduled:asc',
  target_timezone: 'Asia/Kolkata',
  target_appointment_type: 'all',
};
const inboxBase = {
  target_lead_id: null,
  target_customer_id: null,
  target_search: '',
  target_channel: 'all',
  target_page: 1,
  target_page_size: 25,
};

function leadRecords(role) {
  return rpc(role, 'get_lead_workspace_page_v2', {
    ...leadBase,
    target_include_records: true,
    target_include_kpis: false,
  });
}

function leadMeta(role) {
  return rpc(role, 'get_lead_workspace_page_v2', {
    ...leadBase,
    target_include_records: false,
    target_include_kpis: true,
  });
}

function tenantDashboard(role) {
  return rpc(role, 'get_tenant_dashboard_page', {
    target_days: 14,
    target_timezone: 'Asia/Kolkata',
  });
}

const allScenarios = [
  {
    role: 'sales-consultant',
    page: 'Dashboard',
    request: () =>
      rpc('sales-consultant', 'get_sales_consultant_dashboard_page', {
        target_timezone: 'Asia/Kolkata',
      }),
  },
  {
    role: 'telecaller',
    page: 'Dashboard',
    request: () => tenantDashboard('telecaller'),
  },
  {
    role: 'team-manager',
    page: 'Dashboard',
    request: () => tenantDashboard('team-manager'),
  },
  {
    role: 'showroom-manager',
    page: 'Dashboard',
    request: () => tenantDashboard('showroom-manager'),
  },
  {
    role: 'gm-sales',
    page: 'Dashboard',
    request: () => tenantDashboard('gm-sales'),
  },
  ...['telecaller', 'sales-consultant', 'team-manager', 'showroom-manager', 'gm-sales'].map(
    (role) => ({
      role,
      page: 'Leads',
      request: () => Promise.all([leadRecords(role), leadMeta(role)]),
    }),
  ),
  ...['telecaller', 'sales-consultant', 'team-manager'].map((role) => ({
    role,
    page: 'Follow-ups',
    request: () => rpc(role, 'get_followup_workspace_filtered_page', followupBase),
  })),
  {
    role: 'sales-consultant',
    page: 'Appointments',
    request: () => rpc('sales-consultant', 'get_appointment_workspace_page', appointmentBase),
  },
  ...['telecaller', 'sales-consultant'].map((role) => ({
    role,
    page: 'Inbox',
    request: () => rpc(role, 'get_context_inbox_page', inboxBase),
  })),
];
const selectedRole = flags.get('role');
const selectedPage = flags.get('page');
const scenarios = allScenarios.filter(
  (scenario) =>
    (!selectedRole || selectedRole === 'true' || scenario.role === selectedRole) &&
    (!selectedPage ||
      selectedPage === 'true' ||
      scenario.page.toLowerCase() === selectedPage.toLowerCase()),
);
if (scenarios.length === 0) throw new Error('No benchmark scenario matched the selected filters.');

const percentile = (values, percentage) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]);
};

const samples = [];
for (const scenario of scenarios) {
  await scenario.request().catch(() => undefined);
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const started = performance.now();
    let error = '';
    try {
      await scenario.request();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    samples.push({
      role: scenario.role,
      page: scenario.page,
      ms: Math.round(performance.now() - started),
      error,
    });
  }
}

const summary = scenarios.map(({ role, page }) => {
  const matching = samples.filter((sample) => sample.role === role && sample.page === page);
  const successful = matching.filter((sample) => !sample.error).map((sample) => sample.ms);
  return {
    role,
    page,
    calls: matching.length,
    median_ms: successful.length ? percentile(successful, 50) : null,
    p95_ms: successful.length ? percentile(successful, 95) : null,
    min_ms: successful.length ? Math.min(...successful) : null,
    max_ms: successful.length ? Math.max(...successful) : null,
    errors: matching.filter((sample) => sample.error).length,
  };
});

console.table(summary);
if (outputFile && outputFile !== 'true') {
  fs.writeFileSync(
    path.resolve(outputFile),
    `${JSON.stringify({ measured_at: new Date().toISOString(), repeats, summary, samples }, null, 2)}\n`,
  );
  console.log(`Saved ${outputFile}`);
}
if (summary.some((row) => row.errors > 0)) process.exitCode = 1;
