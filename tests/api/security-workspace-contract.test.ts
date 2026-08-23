import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}
const migration = source('supabase/migrations/202608150001_foundation_security_hardening.sql');
const api = source('src/features/administration/security-workspace-api.ts');
const workspace = source('src/features/administration/security-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('security posture workspace contract', () => {
  it('uses existing access-gate MFA state and RLS-scoped immutable audit events', () => {
    expect(migration).toContain("'mfa_satisfied', aal = 'aal2'");
    expect(migration).toContain('create policy audit_logs_read on public.audit_logs');
    expect(api).toContain("rpc('get_access_context')");
    expect(api).toContain(".from('audit_logs')");
    expect(api).toContain('getAuthenticatorAssuranceLevel()');
  });
  it('does not invent external security claims and routes System Administrator security', () => {
    expect(workspace).toMatch(
      /It does not\s+claim external monitoring, backups, or threat detection\./,
    );
    expect(route).toContain("role === 'system-administrator' && slug[0] === 'security'");
    expect(route.indexOf('return <SecurityWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
