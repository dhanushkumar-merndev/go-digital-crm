import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const seeder = resolve(process.cwd(), 'scripts/seed-demo-sales-consultant-leads.mjs');
const temporaryDirectories: string[] = [];

function runSeeder(environment: Record<string, string>) {
  const directory = mkdtempSync(resolve(tmpdir(), 'go-digital-sales-volume-seed-'));
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

describe('Sales Consultant dummy lead seed safety', () => {
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

  it('creates a bounded, idempotent, customer-linked fixture with assignment history', () => {
    const source = readFileSync(seeder, 'utf8');
    expect(source).toContain('const DEFAULT_LEAD_COUNT = 100');
    expect(source).toContain("const FIXTURE_PREFIX = 'demo-sales-consultant-volume'");
    expect(source).toContain('connection_id: null');
    expect(source).toContain("await insert('lead_assignments', assignmentRows)");
    expect(source).toContain("await insert('lead_assignment_history', historyRows)");
    expect(source).toContain("fixture?.state === 'FOLLOW_UP'");
    expect(source).toContain("await insert('followups', followupRows)");
    expect(source).toContain('reason: `${FIXTURE_MARKER} follow-up`');
    expect(source).toContain("status: 'OPEN'");
    expect(source).toContain("await insert('lead_stage_history', handoffRows)");
    expect(source).toContain("to_status: 'Transferred to Sales'");
    expect(source).toContain("'LEAD_TRANSFERRED_TO_SALES'");
    expect(source).toContain('assigned_user_id: target.salesConsultantId');
    expect(source).toContain("deleted_at: 'is.null'");
    expect(source).not.toContain("method: 'DELETE'");
  });
});
