import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const seeder = resolve(process.cwd(), 'scripts/seed-demo-tenant.mjs');
const temporaryDirectories: string[] = [];

function runSeeder(environment: Record<string, string>) {
  const directory = mkdtempSync(resolve(tmpdir(), 'go-digital-demo-seed-'));
  temporaryDirectories.push(directory);
  writeFileSync(
    resolve(directory, '.env'),
    Object.entries(environment)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
  );

  return () =>
    execFileSync(process.execPath, [seeder, '--apply'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: 'pipe',
    });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('remote demo seed safety gate', () => {
  const baseEnvironment = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    DEMO_TEST_PASSWORD: 'test-password-that-is-long-enough',
  };

  it('blocks when remote seeding is not explicitly enabled', () => {
    expect(
      runSeeder({
        ...baseEnvironment,
        DEMO_ALLOW_REMOTE_SEED: 'false',
        DEMO_ALLOWED_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      }),
    ).toThrow(/Remote demo seed blocked/);
  });

  it('blocks when the authorized project does not exactly match the URL', () => {
    expect(
      runSeeder({
        ...baseEnvironment,
        DEMO_ALLOW_REMOTE_SEED: 'true',
        DEMO_ALLOWED_SUPABASE_PROJECT_REF: 'zyxwvutsrqponmlkjihg',
      }),
    ).toThrow(/Remote demo seed blocked/);
  });
});
