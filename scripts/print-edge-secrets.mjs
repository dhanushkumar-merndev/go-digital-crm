import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const secretNames = [
  'INTEGRATION_ENCRYPTION_KEY',
  'META_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'BREVO_API_KEY',
  'TIGRIS_ENDPOINT',
  'TIGRIS_REGION',
  'TIGRIS_BUCKET',
  'TIGRIS_ACCESS_KEY_ID',
  'TIGRIS_SECRET_ACCESS_KEY',
  'PUBLIC_EDGE_FUNCTION_BASE_URL',
  'INTEGRATION_OAUTH_CALLBACK_URL',
];

const envPath = path.resolve(process.cwd(), '.env');
const values = new Map();

for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;

  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) values.set(match[1], match[2]);
}

const missing = secretNames.filter((name) => !values.get(name));
if (missing.length > 0) {
  console.error(`Cannot prepare Supabase secrets; missing: ${missing.join(', ')}`);
  process.exit(1);
}

// Intentionally prints to the local terminal only. Never commit or paste this
// output into chat, source control, screenshots, or browser-exposed variables.
process.stdout.write(`${secretNames.map((name) => `${name}=${values.get(name)}`).join('\n')}\n`);
