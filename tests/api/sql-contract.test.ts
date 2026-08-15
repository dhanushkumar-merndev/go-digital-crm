import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDirectory = join(process.cwd(), 'supabase', 'migrations');
const migrations = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(migrationDirectory, name), 'utf8'))
  .join('\n');

const edgeHttp = readFileSync(
  join(process.cwd(), 'supabase', 'functions', '_shared', 'http.ts'),
  'utf8',
);

describe('database security contract', () => {
  it('never defines a Team Leader role', () =>
    expect(migrations).toContain('roles_no_team_leader'));
  it('keeps Pending out of the lifecycle enum', () =>
    expect(migrations).toContain(
      "create type public.lead_lifecycle as enum ('New', 'Contacted', 'Qualified', 'Appointment Scheduled', 'Transferred to Sales', 'Lost')",
    ));
  it('derives lead work state instead of mutating lifecycle', () => {
    expect(migrations).toContain('leads_with_work_state');
    expect(migrations).toContain("then 'PENDING'");
  });
  it('enforces RLS and immutable audit/credit ledgers', () => {
    expect(migrations).toContain('force row level security');
    expect(migrations).toContain('audit_logs_immutable');
    expect(migrations).toContain('credit_ledger_immutable');
  });
  it('enforces one selected branch-scope mode', () =>
    expect(migrations).toContain('valid_branch_scope'));

  it('allows authenticated browser clients to complete an Edge Function preflight', () => {
    expect(edgeHttp).toContain("'access-control-allow-origin': '*'");
    expect(edgeHttp).toContain("request.method !== 'OPTIONS'");
    expect(edgeHttp).toContain('authorization, apikey, content-type');
  });
});
