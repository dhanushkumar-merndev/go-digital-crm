/*
 * Read-load test for the lead flow against the remote demo tenant.
 *
 * Replays the read RPCs a real lead-flow run made (captured by the e2e suite
 * with E2E_API_TIMINGS=<file>) as the same demo roles, first one at a time to
 * get each API's own latency, then from many concurrent virtual users to see
 * how the APIs hold up under load. Only get_/list_/search_ RPCs are replayed;
 * nothing is written. Credentials and response bodies are never printed.
 *
 * Each virtual user pauses --think ms (randomised 0.5x-1.5x) between calls, as
 * a person reading a page does; --think=0 is a stress test, not a user count.
 * A 4xx is reported apart from failures: a replayed request can legitimately
 * be refused once the captured record has moved on (e.g. a lead handed to Sales).
 *
 * Run: node scripts/load-test-lead-flow.mjs <timings.jsonl> [--users=25] [--seconds=30] [--think=1000]
 */
import fs from 'node:fs';
import path from 'node:path';

const [timingsFile, ...flags] = process.argv.slice(2);
if (!timingsFile) {
  throw new Error('Usage: node scripts/load-test-lead-flow.mjs <timings.jsonl> [--users=N]');
}
const flag = (name, fallback) =>
  Number(flags.find((value) => value.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const virtualUsers = flag('users', 25);
const loadSeconds = flag('seconds', 30);
const soloRepeats = flag('repeats', 5);
const thinkMs = flag('think', 1000);
const skipSolo = flags.includes('--no-solo');

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

// Route segment -> demo role key.
const roleKeys = {
  telecaller: 'telecaller_bdc',
  'sales-consultant': 'sales_consultant',
  inventory: 'inventory_manager',
  finance: 'finance_manager',
  insurance: 'insurance_manager',
  rto: 'rto_manager',
  delivery: 'delivery_manager',
};

const captured = fs
  .readFileSync(timingsFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.body !== undefined && roleKeys[entry.role] && entry.status < 400);

// One replayable request per distinct (role, api, body).
const requests = [
  ...new Map(captured.map((entry) => [`${entry.role}|${entry.api}|${entry.body}`, entry])).values(),
];
if (requests.length === 0) throw new Error(`No replayable read RPCs in ${timingsFile}.`);

const tokens = new Map();
for (const role of new Set(requests.map((entry) => entry.role))) {
  const email = `${roleKeys[role].replaceAll('_', '-')}@demo.go-digital.invalid`;
  const response = await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: demoPassword }),
  });
  if (!response.ok) throw new Error(`Sign-in failed for ${role}: ${response.status}`);
  tokens.set(role, (await response.json()).access_token);
}

async function call(entry) {
  const started = performance.now();
  try {
    const response = await fetch(`${projectUrl}/rest/v1/rpc/${entry.api}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${tokens.get(entry.role)}`,
        'content-type': 'application/json',
      },
      body: entry.body,
    });
    const text = await response.text();
    const ms = performance.now() - started;
    if (!response.ok) {
      const code = (() => {
        try {
          const payload = JSON.parse(text);
          return payload.code ?? payload.message ?? String(response.status);
        } catch {
          return String(response.status);
        }
      })();
      return { ms, error: `${response.status} ${code}` };
    }
    return { ms };
  } catch (error) {
    return { ms: performance.now() - started, error: error.cause?.code ?? String(error) };
  }
}

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};

function summarise(samples) {
  const byApi = new Map();
  for (const sample of samples) {
    const key = `${sample.role} ${sample.api}`;
    if (!byApi.has(key)) byApi.set(key, { ms: [], errors: new Map() });
    const bucket = byApi.get(key);
    bucket.ms.push(sample.ms);
    if (sample.error) bucket.errors.set(sample.error, (bucket.errors.get(sample.error) ?? 0) + 1);
  }
  return [...byApi.entries()]
    .map(([api, { ms, errors }]) => ({
      api,
      calls: ms.length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      max: percentile(ms, 100),
      errors: [...errors.entries()].map(([code, count]) => `${code} x${count}`).join(', '),
    }))
    .sort((a, b) => b.p95 - a.p95);
}

// Phase 1: each API alone, so its latency is not inflated by the others.
const solo = [];
for (const entry of skipSolo ? [] : requests) {
  await call(entry); // warm the connection and plan cache
  for (let index = 0; index < soloRepeats; index += 1) {
    solo.push({ ...entry, ...(await call(entry)) });
  }
}
if (!skipSolo) {
  console.log(`\nSolo latency (${soloRepeats} calls each, network included):`);
  console.table(summarise(solo));
}

// Phase 2: virtual users each walking the captured requests in random order.
const loaded = [];
const deadline = performance.now() + loadSeconds * 1000;
await Promise.all(
  Array.from({ length: virtualUsers }, async () => {
    while (performance.now() < deadline) {
      const entry = requests[Math.floor(Math.random() * requests.length)];
      loaded.push({ ...entry, ...(await call(entry)) });
      if (thinkMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, thinkMs * (0.5 + Math.random())));
      }
    }
  }),
);
const refused = loaded.filter((sample) => /^4\d\d /.test(sample.error ?? '')).length;
const failed = loaded.filter((sample) => sample.error).length - refused;
console.log(
  `\nUnder load: ${virtualUsers} concurrent users (think ${thinkMs} ms) for ${loadSeconds}s -> ` +
    `${loaded.length} calls, ${(loaded.length / loadSeconds).toFixed(1)} req/s, ${failed} failed, ` +
    `${refused} refused (4xx), ` +
    `overall p50 ${percentile(
      loaded.map((sample) => sample.ms),
      50,
    )} ms / p95 ${percentile(
      loaded.map((sample) => sample.ms),
      95,
    )} ms`,
);
console.table(summarise(loaded));
if (failed > 0) process.exitCode = 1;
