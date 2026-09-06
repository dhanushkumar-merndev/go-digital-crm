import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = resolve(packageDirectory, '../..');
const configurationNames = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'PERSONAL_WHATSAPP_ENCRYPTION_KEY',
  'PERSONAL_WHATSAPP_SIGNING_SECRET',
  'PERSONAL_WHATSAPP_MAX_SESSIONS',
  'PERSONAL_WHATSAPP_MEMORY_MB',
  'PORT',
];

async function optionalEnv(path) {
  try {
    return parseEnv(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('LOCAL_ENV_UNREADABLE');
  }
}

export async function loadLocalEnvironment(root = repositoryDirectory, runtime = process.env) {
  const base = {
    ...(await optionalEnv(resolve(root, '.env'))),
    ...(await optionalEnv(resolve(root, '.env.local'))),
  };
  const local = await optionalEnv(resolve(root, 'services/whatsapp-gateway/.env.local'));
  const merged = { ...base, ...local, ...runtime };
  const selected = Object.fromEntries(
    configurationNames.filter((name) => merged[name]).map((name) => [name, merged[name]]),
  );
  selected.SUPABASE_URL ||= merged.NEXT_PUBLIC_SUPABASE_URL;
  selected.PERSONAL_WHATSAPP_MAX_SESSIONS ||= '1';
  selected.PERSONAL_WHATSAPP_MEMORY_MB ||= '512';
  selected.PORT ||= '10000';
  // Never bind a laptop pilot to the LAN by inheriting Render's bind address.
  selected.HOST = '127.0.0.1';
  return selected;
}

export function configurationProblems(env) {
  const missing = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PERSONAL_WHATSAPP_ENCRYPTION_KEY',
    'PERSONAL_WHATSAPP_SIGNING_SECRET',
  ].filter((name) => !env[name]);
  const problems = missing.map((name) => `${name}_MISSING`);
  if (env.SUPABASE_URL) {
    try {
      const url = new URL(env.SUPABASE_URL);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      )
        problems.push('SUPABASE_URL_INVALID');
    } catch {
      problems.push('SUPABASE_URL_INVALID');
    }
  }
  if (env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY.length < 20)
    problems.push('SUPABASE_SERVICE_ROLE_KEY_INVALID');
  if (
    env.PERSONAL_WHATSAPP_ENCRYPTION_KEY &&
    (!/^[A-Za-z0-9+/]{43}=$/.test(env.PERSONAL_WHATSAPP_ENCRYPTION_KEY) ||
      Buffer.from(env.PERSONAL_WHATSAPP_ENCRYPTION_KEY, 'base64').length !== 32)
  )
    problems.push('PERSONAL_WHATSAPP_ENCRYPTION_KEY_INVALID');
  if (env.PERSONAL_WHATSAPP_SIGNING_SECRET && env.PERSONAL_WHATSAPP_SIGNING_SECRET.length < 32)
    problems.push('PERSONAL_WHATSAPP_SIGNING_SECRET_INVALID');
  for (const [name, maximum, minimum] of [
    ['PORT', 65535, 1],
    ['PERSONAL_WHATSAPP_MAX_SESSIONS', 5, 1],
    ['PERSONAL_WHATSAPP_MEMORY_MB', 512, 128],
  ]) {
    if (
      !/^\d+$/.test(env[name] ?? '') ||
      Number(env[name]) < minimum ||
      Number(env[name]) > maximum
    )
      problems.push(`${name}_INVALID`);
  }
  return problems;
}

export async function initializeLocalSecrets(root = repositoryDirectory, runtime = process.env) {
  const env = await loadLocalEnvironment(root, runtime);
  const path = resolve(root, 'services/whatsapp-gateway/.env.local');
  // wx refuses existing files and symlinks: restarting setup never rotates keys.
  const encryption = env.PERSONAL_WHATSAPP_ENCRYPTION_KEY || randomBytes(32).toString('base64');
  const signing = env.PERSONAL_WHATSAPP_SIGNING_SECRET || randomBytes(36).toString('base64url');
  if (/\r|\n/.test(encryption + signing)) throw new Error('LOCAL_SECRET_INVALID');
  try {
    await writeFile(
      path,
      `# Private laptop-only gateway configuration. Never commit or print these values.\nPERSONAL_WHATSAPP_ENCRYPTION_KEY=${encryption}\nPERSONAL_WHATSAPP_SIGNING_SECRET=${signing}\nPERSONAL_WHATSAPP_MAX_SESSIONS=1\nPERSONAL_WHATSAPP_MEMORY_MB=512\nPORT=10000\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw new Error('LOCAL_SECRET_FILE_UNWRITABLE');
  }
}

export async function probeDatabase(env, request = fetch) {
  // GET + limit=0 inspects readiness, never reads personal data or restores sockets.
  const names = [
    'personal_whatsapp_sessions',
    'personal_whatsapp_keys',
    'personal_whatsapp_conversations',
    'personal_whatsapp_messages',
  ];
  const results = [];
  for (const name of names) {
    try {
      const url = new URL(`/rest/v1/${name}?select=*&limit=0`, env.SUPABASE_URL);
      const response = await request(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      // Do not print the database body: even errors can include private context.
      results.push({ resource: name, ready: response.ok, status: response.status });
      await response.body?.cancel();
    } catch {
      results.push({ resource: name, ready: false, status: 'UNREACHABLE' });
    }
  }
  return results;
}

async function main() {
  const mode = process.argv[2] ?? '--check';
  if (!['--init', '--check', '--start'].includes(mode)) throw new Error('USE_INIT_CHECK_OR_START');
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('NODE_24_OR_NEWER_REQUIRED');
  if (mode === '--init') {
    console.log(
      (await initializeLocalSecrets())
        ? 'Created private services/whatsapp-gateway/.env.local (mode 0600). Root .env unchanged.'
        : 'Local configuration already exists; no secrets overwritten.',
    );
    return;
  }
  const env = await loadLocalEnvironment();
  const problems = configurationProblems(env);
  for (const code of problems) console.log(code);
  let readiness = [];
  if (
    env.SUPABASE_URL &&
    env.SUPABASE_SERVICE_ROLE_KEY &&
    !problems.includes('SUPABASE_URL_INVALID')
  ) {
    readiness = await probeDatabase(env);
    for (const row of readiness)
      console.log(`${row.resource}: ${row.ready ? 'ready' : `not ready (${row.status})`}`);
  }
  const ready = !problems.length && readiness.length === 4 && readiness.every((row) => row.ready);
  if (!ready) {
    console.log(
      'Gateway not started. Initialize local secrets and apply the reviewed pilot migration to your chosen test database first.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    'Local configuration and tables ready. This does not verify deployed Edge functions or tunnel/signing configuration.',
  );
  if (mode === '--check') return;
  console.log(
    `Starting local gateway at http://127.0.0.1:${env.PORT}/health. Existing pilot sessions may be restored. Ctrl+C stops this process.`,
  );
  const child = spawn(process.execPath, [resolve(packageDirectory, 'dist/index.js')], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('error', () => {
    console.error('LOCAL_GATEWAY_START_FAILED');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.exitCode = code ?? 0;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('LOCAL_GATEWAY_SETUP_FAILED');
    process.exitCode = 1;
  });
}
