import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const seeder = resolve(process.cwd(), 'scripts/seed-demo-sales-consultant-today-schedule.mjs');
const temporaryDirectories: string[] = [];

function runSeeder(environment: Record<string, string>) {
  const directory = mkdtempSync(resolve(tmpdir(), 'go-digital-sales-schedule-seed-'));
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

describe('Sales Consultant today schedule seed safety', () => {
  const baseEnvironment = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  };

  it('blocks writes unless the isolated remote demo project is explicitly enabled', () => {
    expect(
      runSeeder({
        ...baseEnvironment,
        DEMO_ALLOW_REMOTE_SEED: 'false',
        DEMO_ALLOWED_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      }),
    ).toThrow(/Remote demo seed blocked/);
  });

  it('uses early India-time appointment and dedicated test-drive fixtures without deletes', () => {
    const source = readFileSync(seeder, 'utf8');
    expect(source).toContain("const TIMEZONE = 'Asia/Kolkata'");
    expect(source).toContain("const FIXTURE_PREFIX = 'demo-sales-consultant-today-schedule'");
    expect(source).toContain("type: 'Showroom Visit', hour: 8, minute: 30");
    expect(source).toContain("type: 'Video Call', hour: 9, minute: 0");
    expect(source).toContain("type: 'Consultant Call', hour: 9, minute: 30");
    expect(source).toContain("type: 'Test Drive', hour: 10, minute: 0");
    expect(source).toContain("{ key: 'dedicated-test-drive-1', hour: 8, minute: 45");
    expect(source).toContain("await insert(\n      'test_drive_appointments'");
    expect(source).toContain("await insert(\n    'test_drives'");
    expect(source).toContain('vehicleRegistration: `DMS-TD-${compactDate}-${blueprint.suffix}`');
    expect(source).toContain('assigned_user_id: target.salesConsultantId');
    expect(source).toContain("status: 'SCHEDULED'");
    expect(source).toContain("status: 'READY'");
    expect(source).not.toContain("method: 'DELETE'");
  });
});
