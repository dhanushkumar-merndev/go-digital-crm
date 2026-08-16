import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const runtimeTargets = {
  web: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  mobile: ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'],
  edge: [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'APP_BASE_URL',
    'PUBLIC_EDGE_FUNCTION_BASE_URL',
    'INTEGRATION_OAUTH_CALLBACK_URL',
    'INTEGRATION_ENCRYPTION_KEY',
    'META_APP_ID',
    'META_APP_SECRET',
    'META_GRAPH_API_VERSION',
    'META_OAUTH_SCOPES',
    'META_WEBHOOK_VERIFY_TOKEN',
    'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_ADS_API_VERSION',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'BREVO_API_KEY',
    'TIGRIS_ENDPOINT',
    'TIGRIS_REGION',
    'TIGRIS_BUCKET',
    'TIGRIS_ACCESS_KEY_ID',
    'TIGRIS_SECRET_ACCESS_KEY',
  ],
  trigger: [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'INTEGRATION_ENCRYPTION_KEY',
    'META_GRAPH_API_VERSION',
    'BREVO_API_KEY',
    'TIGRIS_ENDPOINT',
    'TIGRIS_REGION',
    'TIGRIS_BUCKET',
    'TIGRIS_ACCESS_KEY_ID',
    'TIGRIS_SECRET_ACCESS_KEY',
    'TRIGGER_SECRET_KEY',
    'TRIGGER_PROJECT_REF',
    'IVR_RECORDING_ALLOWED_HOSTS',
    'MAX_RECORDING_BYTES',
  ],
  deployment: [
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_DB_PASSWORD',
    'SUPABASE_PROJECT_ID',
    'TRIGGER_ACCESS_TOKEN',
  ],
};

const exampleOnlyNames = ['NEXT_PUBLIC_ENABLE_LOCAL_PREVIEW'];
const optionalRuntimeNames = [
  'PROVIDER_EVENT_BATCH_SIZE',
  'PROVIDER_EVENT_CONCURRENCY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_CACHE_PREFIX',
  'UPSTASH_REDIS_ENABLED',
];
const documentedRuntimeNames = new Set([
  ...['web', 'mobile', 'edge', 'trigger'].flatMap((name) => runtimeTargets[name]),
  ...exampleOnlyNames,
  ...optionalRuntimeNames,
]);
const safeExampleDefaults = new Set([
  'NEXT_PUBLIC_ENABLE_LOCAL_PREVIEW',
  'APP_BASE_URL',
  'META_OAUTH_SCOPES',
  'TIGRIS_REGION',
  'MAX_RECORDING_BYTES',
  'PROVIDER_EVENT_BATCH_SIZE',
  'PROVIDER_EVENT_CONCURRENCY',
  'UPSTASH_REDIS_CACHE_PREFIX',
  'UPSTASH_REDIS_ENABLED',
]);
const publicCredentialNames = new Set([
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
]);

function parseArguments(argv) {
  const options = {
    target: 'all',
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    file: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split('=', 2);
    if (!['--target', '--mode', '--file'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = inlineValue ?? argv[index + 1];
    if (!inlineValue) index += 1;
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--target') options.target = value;
    if (flag === '--mode') options.mode = value;
    if (flag === '--file') options.file = value;
  }
  if (![...Object.keys(runtimeTargets), 'all', 'example'].includes(options.target)) {
    throw new Error(`Unknown target: ${options.target}`);
  }
  if (!['development', 'test', 'production'].includes(options.mode)) {
    throw new Error(`Unknown mode: ${options.mode}`);
  }
  return options;
}

function parseEnvironmentFile(filePath) {
  const values = {};
  const duplicates = new Set();
  const seen = new Set();
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[name] = value;
  }
  return { values, duplicates };
}

function loadRuntimeEnvironment(mode, explicitFile) {
  const values = {};
  const candidates = explicitFile
    ? [resolve(root, explicitFile)]
    : [
        resolve(root, '.env'),
        resolve(root, `.env.${mode}`),
        ...(mode === 'test' ? [] : [resolve(root, '.env.local')]),
        resolve(root, `.env.${mode}.local`),
      ];
  for (const candidate of candidates) {
    try {
      Object.assign(values, parseEnvironmentFile(candidate).values);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { ...values, ...process.env };
}

function requiredNamesFor(target) {
  if (target !== 'all') return [...runtimeTargets[target]];
  return [...new Set(['web', 'mobile', 'edge', 'trigger'].flatMap((name) => runtimeTargets[name]))];
}

function isSensitiveName(name) {
  return /(?:SERVICE_ROLE|SECRET|PASSWORD|PRIVATE|ACCESS_KEY|API_KEY|ENCRYPTION_KEY|VERIFY_TOKEN|ACCESS_TOKEN)/.test(
    name,
  );
}

function validatePublicNames(names, errors) {
  for (const name of names) {
    if (!name.startsWith('NEXT_PUBLIC_') && !name.startsWith('EXPO_PUBLIC_')) continue;
    if (isSensitiveName(name) && !publicCredentialNames.has(name)) {
      errors.push(`${name}: a secret-like name cannot use a public prefix`);
    }
  }
}

function validateUrl(name, values, mode, errors) {
  const value = values[name];
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    if (url.username || url.password) throw new Error('credentials are not allowed in URLs');
    if (mode === 'production' && url.protocol !== 'https:') {
      throw new Error('production URLs must use HTTPS');
    }
    if (
      mode === 'production' &&
      (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || isIP(url.hostname))
    ) {
      throw new Error('production URLs cannot use localhost or an IP literal');
    }
  } catch (error) {
    errors.push(`${name}: ${error instanceof Error ? error.message : 'invalid URL'}`);
  }
}

function validateEncryptionKey(value, errors) {
  if (!value) return;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    errors.push('INTEGRATION_ENCRYPTION_KEY: must be base64url encoded');
    return;
  }
  try {
    if (Buffer.from(value, 'base64url').byteLength !== 32) {
      errors.push('INTEGRATION_ENCRYPTION_KEY: must decode to exactly 32 bytes');
    }
  } catch {
    errors.push('INTEGRATION_ENCRYPTION_KEY: must be valid base64url');
  }
}

function decodeJwtRole(value) {
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.role === 'string' ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

function validateSupabaseKey(name, value, errors) {
  if (!value) return;
  if (value.length < 20 || /\s/.test(value)) {
    errors.push(`${name}: malformed Supabase key`);
    return;
  }
  const role = decodeJwtRole(value);
  if (name === 'SUPABASE_SERVICE_ROLE_KEY') {
    if (value.startsWith('sb_publishable_') || (role && role !== 'service_role')) {
      errors.push('SUPABASE_SERVICE_ROLE_KEY: does not contain service-role credentials');
    }
    return;
  }
  if (role === 'service_role' || value.startsWith('sb_secret_')) {
    errors.push(`${name}: service-role credentials cannot be used as an anon/public key`);
  }
}

function validateAllowedHosts(value, errors) {
  if (!value) return;
  const entries = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) {
    errors.push('IVR_RECORDING_ALLOWED_HOSTS: at least one exact host is required');
    return;
  }
  for (const entry of entries) {
    const host = entry.startsWith('*.') ? entry.slice(2) : entry;
    if (
      entry.includes('://') ||
      entry.includes('/') ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      isIP(host) ||
      !/^[a-z0-9.-]+$/.test(host) ||
      !host.includes('.')
    ) {
      errors.push('IVR_RECORDING_ALLOWED_HOSTS: contains an unsafe or malformed host entry');
      break;
    }
  }
}

function validateRuntime(target, mode, values) {
  const required = requiredNamesFor(target);
  const requiredSet = new Set(required);
  const errors = [];
  for (const name of required) {
    if (!values[name]?.trim()) errors.push(`${name}: missing`);
  }
  validatePublicNames(
    [...requiredSet, ...(requiredSet.has('NEXT_PUBLIC_SUPABASE_URL') ? exampleOnlyNames : [])],
    errors,
  );

  const urlNames = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'EXPO_PUBLIC_SUPABASE_URL',
    'SUPABASE_URL',
    'APP_BASE_URL',
    'PUBLIC_EDGE_FUNCTION_BASE_URL',
    'INTEGRATION_OAUTH_CALLBACK_URL',
    'TIGRIS_ENDPOINT',
  ];
  for (const name of urlNames) {
    if (requiredSet.has(name)) validateUrl(name, values, mode, errors);
  }
  for (const name of [
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]) {
    if (requiredSet.has(name)) validateSupabaseKey(name, values[name], errors);
  }

  if (mode === 'production' && values.NEXT_PUBLIC_ENABLE_LOCAL_PREVIEW === 'true') {
    errors.push('NEXT_PUBLIC_ENABLE_LOCAL_PREVIEW: must not be true in production');
  }
  if (
    requiredSet.has('SUPABASE_SERVICE_ROLE_KEY') &&
    values.SUPABASE_ANON_KEY &&
    values.SUPABASE_SERVICE_ROLE_KEY &&
    values.SUPABASE_ANON_KEY === values.SUPABASE_SERVICE_ROLE_KEY
  ) {
    errors.push('SUPABASE_SERVICE_ROLE_KEY: must differ from SUPABASE_ANON_KEY');
  }
  if (
    requiredSet.has('SUPABASE_SERVICE_ROLE_KEY') &&
    values.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    values.SUPABASE_SERVICE_ROLE_KEY &&
    values.NEXT_PUBLIC_SUPABASE_ANON_KEY === values.SUPABASE_SERVICE_ROLE_KEY
  ) {
    errors.push('SUPABASE_SERVICE_ROLE_KEY: must never equal a browser key');
  }
  if (
    requiredSet.has('SUPABASE_SERVICE_ROLE_KEY') &&
    values.EXPO_PUBLIC_SUPABASE_ANON_KEY &&
    values.SUPABASE_SERVICE_ROLE_KEY &&
    values.EXPO_PUBLIC_SUPABASE_ANON_KEY === values.SUPABASE_SERVICE_ROLE_KEY
  ) {
    errors.push('SUPABASE_SERVICE_ROLE_KEY: must never equal a mobile key');
  }
  if (
    requiredSet.has('NEXT_PUBLIC_SUPABASE_URL') &&
    requiredSet.has('SUPABASE_URL') &&
    values.NEXT_PUBLIC_SUPABASE_URL !== values.SUPABASE_URL
  ) {
    errors.push('NEXT_PUBLIC_SUPABASE_URL: must identify the same project as SUPABASE_URL');
  }
  if (
    requiredSet.has('EXPO_PUBLIC_SUPABASE_URL') &&
    requiredSet.has('SUPABASE_URL') &&
    values.EXPO_PUBLIC_SUPABASE_URL !== values.SUPABASE_URL
  ) {
    errors.push('EXPO_PUBLIC_SUPABASE_URL: must identify the same project as SUPABASE_URL');
  }

  if (requiredSet.has('INTEGRATION_ENCRYPTION_KEY')) {
    validateEncryptionKey(values.INTEGRATION_ENCRYPTION_KEY, errors);
  }
  if (target === 'edge' || target === 'all') {
    if (!['true', 'false'].includes(values.UPSTASH_REDIS_ENABLED ?? '')) {
      errors.push('UPSTASH_REDIS_ENABLED: expected true or false');
    }
    if (values.UPSTASH_REDIS_ENABLED === 'true') {
      for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
        if (!values[name]?.trim()) errors.push(`${name}: required when UPSTASH_REDIS_ENABLED=true`);
      }
      validateUrl('UPSTASH_REDIS_REST_URL', values, mode, errors);
    }
    if (
      values.UPSTASH_REDIS_CACHE_PREFIX &&
      !/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(values.UPSTASH_REDIS_CACHE_PREFIX)
    ) {
      errors.push('UPSTASH_REDIS_CACHE_PREFIX: expected a short Redis-safe namespace');
    }
  }
  if (requiredSet.has('IVR_RECORDING_ALLOWED_HOSTS')) {
    validateAllowedHosts(values.IVR_RECORDING_ALLOWED_HOSTS, errors);
  }

  if (
    requiredSet.has('META_GRAPH_API_VERSION') &&
    values.META_GRAPH_API_VERSION &&
    !/^v\d+\.\d+$/.test(values.META_GRAPH_API_VERSION)
  ) {
    errors.push('META_GRAPH_API_VERSION: expected a configurable version such as v26.0');
  }
  if (
    requiredSet.has('GOOGLE_ADS_API_VERSION') &&
    values.GOOGLE_ADS_API_VERSION &&
    !/^v\d+$/.test(values.GOOGLE_ADS_API_VERSION)
  ) {
    errors.push('GOOGLE_ADS_API_VERSION: expected a configurable version such as v25');
  }
  if (requiredSet.has('MAX_RECORDING_BYTES') && values.MAX_RECORDING_BYTES) {
    const maximum = Number(values.MAX_RECORDING_BYTES);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 5 * 1024 ** 3) {
      errors.push('MAX_RECORDING_BYTES: expected an integer between 1 byte and 5 GiB');
    }
  }
  if (values.PROVIDER_EVENT_BATCH_SIZE) {
    const batchSize = Number(values.PROVIDER_EVENT_BATCH_SIZE);
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) {
      errors.push('PROVIDER_EVENT_BATCH_SIZE: expected an integer between 1 and 50');
    }
  }
  if (values.PROVIDER_EVENT_CONCURRENCY) {
    const concurrency = Number(values.PROVIDER_EVENT_CONCURRENCY);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) {
      errors.push('PROVIDER_EVENT_CONCURRENCY: expected an integer between 1 and 10');
    }
  }
  if (requiredSet.has('INTEGRATION_OAUTH_CALLBACK_URL') && values.INTEGRATION_OAUTH_CALLBACK_URL) {
    try {
      const callback = new URL(values.INTEGRATION_OAUTH_CALLBACK_URL);
      if (!callback.pathname.endsWith('/integration-oauth-callback')) {
        errors.push(
          'INTEGRATION_OAUTH_CALLBACK_URL: path must end with /integration-oauth-callback',
        );
      }
    } catch {
      // The URL validator above reports the actionable error.
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  return required.length;
}

function validateExample() {
  const examplePath = resolve(root, '.env.example');
  const { values, duplicates } = parseEnvironmentFile(examplePath);
  const errors = [];
  for (const duplicate of [...duplicates].sort()) errors.push(`${duplicate}: duplicated`);
  for (const name of [...documentedRuntimeNames].sort()) {
    if (!(name in values)) errors.push(`${name}: missing from .env.example`);
  }
  for (const name of Object.keys(values)) {
    if (!documentedRuntimeNames.has(name)) errors.push(`${name}: undocumented environment key`);
    if (isSensitiveName(name) && values[name] && !safeExampleDefaults.has(name)) {
      errors.push(`${name}: secret-like values must remain empty in .env.example`);
    }
  }
  validatePublicNames(Object.keys(values), errors);
  if (values.NEXT_PUBLIC_ENABLE_LOCAL_PREVIEW !== 'false') {
    errors.push('NEXT_PUBLIC_ENABLE_LOCAL_PREVIEW: example must default to false');
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return Object.keys(values).length;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const count =
    options.target === 'example'
      ? validateExample()
      : validateRuntime(
          options.target,
          options.mode,
          loadRuntimeEnvironment(options.mode, options.file),
        );
  process.stdout.write(
    `Environment contract valid for target "${options.target}" (${count} variables checked).\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown environment validation error';
  process.stderr.write(`Environment validation failed:\n${message}\n`);
  process.exitCode = 1;
}
