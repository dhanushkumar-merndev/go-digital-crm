import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const secretNames = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'INTEGRATION_ENCRYPTION_KEY',
  'BREVO_API_KEY',
  'TIGRIS_ENDPOINT',
  'TIGRIS_REGION',
  'TIGRIS_BUCKET',
  'TIGRIS_ACCESS_KEY_ID',
  'TIGRIS_SECRET_ACCESS_KEY',
  'TRIGGER_SECRET_KEY',
  'TRIGGER_PROJECT_REF',
  'MAX_RECORDING_BYTES',
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
  console.error(`Cannot prepare Trigger.dev variables; missing: ${missing.join(', ')}`);
  process.exit(1);
}

// This output is intended only for the local Trigger.dev Variables form.
// Never commit it, paste it into chat, or expose it to browser/mobile variables.
process.stdout.write(`${secretNames.map((name) => `${name}=${values.get(name)}`).join('\n')}\n`);
