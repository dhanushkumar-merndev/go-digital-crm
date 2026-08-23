import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source(
  'supabase/migrations/202608220042_system_administrator_health_workspace.sql',
);
const api = source('src/features/administration/system-health-workspace-api.ts');
const workspace = source('src/features/administration/system-health-workspace.tsx');

describe('System Administrator health workspace contract', () => {
  it('requires an MFA-assured System Administrator and only returns accessible connections', () => {
    expect(migration).toContain('get_system_administrator_health_workspace()');
    expect(migration).toContain("role_row.role_key = 'system_administrator'");
    expect(migration).toContain('app_private.mfa_policy_satisfied(actor_organization_id)');
    expect(migration).toContain(
      "app_private.has_permission(actor_organization_id, 'integration.view')",
    );
    expect(migration).toContain(
      'app_private.can_access_connection(actor_organization_id, connection_row.id)',
    );
    expect(migration).toContain(
      'app_private.can_access_branch(actor_organization_id, branch_row.id)',
    );
  });

  it('does not leak credentials or unscoped error-log data', () => {
    expect(migration).not.toContain('integration_credentials');
    expect(migration).not.toContain('encrypted_payload');
    expect(migration).not.toContain('from public.error_logs');
    expect(migration).toContain('limit 25');
  });

  it('uses a typed RPC client and honest health labels', () => {
    expect(api).toContain("rpc('get_system_administrator_health_workspace'");
    expect(workspace).toContain(
      'does not claim external uptime, latency, backups, or tenant-wide error monitoring.',
    );
    expect(workspace).toContain("['system-health-workspace', session?.organizationId]");
  });
});
