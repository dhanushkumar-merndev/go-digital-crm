import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const functionsDirectory = resolve(root, 'supabase/functions');
const configPath = resolve(root, 'supabase/config.toml');
const publicBoundaryFunctions = new Set([
  'integration-oauth-callback',
  'mobile-link-exchange',
  'provider-webhook-generic',
  'provider-webhook-meta',
  'provider-webhook-twilio',
  'provider-webhook-whatsapp',
]);

const functionNames = readdirSync(functionsDirectory)
  .filter((name) => !name.startsWith('_'))
  .filter((name) => statSync(resolve(functionsDirectory, name)).isDirectory())
  .filter((name) => {
    try {
      return statSync(resolve(functionsDirectory, name, 'index.ts')).isFile();
    } catch {
      return false;
    }
  })
  .sort();

const config = readFileSync(configPath, 'utf8');
const sections = new Map();
const sectionPattern = /^\[functions\.([a-z0-9-]+)]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
for (const match of config.matchAll(sectionPattern)) {
  const [, name, body] = match;
  if (sections.has(name)) throw new Error(`Duplicate Supabase function config: ${name}`);
  const jwtMatch = /^verify_jwt\s*=\s*(true|false)\s*$/m.exec(body);
  if (!jwtMatch) throw new Error(`Missing verify_jwt for Supabase function: ${name}`);
  sections.set(name, jwtMatch[1] === 'true');
}

const errors = [];
for (const name of functionNames) {
  if (!sections.has(name)) {
    errors.push(`${name}: missing [functions.${name}] config`);
    continue;
  }
  const expectedJwt = !publicBoundaryFunctions.has(name);
  if (sections.get(name) !== expectedJwt) {
    errors.push(
      `${name}: verify_jwt must be ${expectedJwt}; public-boundary allowlist is explicit and closed`,
    );
  }
}
for (const name of sections.keys()) {
  if (!functionNames.includes(name))
    errors.push(`${name}: config has no matching function entrypoint`);
}
for (const name of publicBoundaryFunctions) {
  if (!functionNames.includes(name))
    errors.push(`${name}: public-boundary allowlist entry is stale`);
}

if (errors.length > 0) {
  process.stderr.write(`Supabase function config validation failed:\n${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Supabase function config valid (${functionNames.length} functions; ${publicBoundaryFunctions.size} public boundaries).\n`,
  );
}
