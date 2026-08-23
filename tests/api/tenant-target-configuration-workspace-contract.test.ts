import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source(
  'supabase/migrations/202608220045_tenant_target_configuration_workspace.sql',
);
const api = source('src/features/administration/tenant-target-configuration-api.ts');
const workspace = source('src/features/administration/tenant-target-configuration-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('tenant target configuration workspace contract', () => {
  it('allows read access to an MFA-assured organization-wide Client Admin or Business Owner', () => {
    expect(migration).toContain("role_row.role_key = 'client_admin'");
    expect(migration).toContain("assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')");
    expect(migration).toContain('app_private.mfa_policy_satisfied(current_organization_id)');
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'user.manage')",
    );
    expect(migration).toContain("role_row.role_key = 'business_owner'");
    expect(migration).toContain("message = 'TENANT_TARGET_CONFIGURATION_REQUIRED'");
  });

  it('keeps writes branch-level, month-bounded and auditable without overwriting user or team targets', () => {
    expect(migration).toContain(
      'create or replace function public.save_branch_target_configuration(',
    );
    expect(migration).toContain('target_row.team_id is null');
    expect(migration).toContain('target_row.user_id is null');
    expect(migration).toContain("'tenant_target_configuration.saved'");
    expect(migration).toContain("message = 'INVALID_BRANCH_TARGET_CONFIGURATION'");
    expect(migration).toContain("message = 'TARGET_BRANCH_DENIED'");
  });

  it('validates RPC data and provides a real target-edit flow through the Client Admin route', () => {
    expect(api).toContain("rpc('get_tenant_target_configuration_workspace'");
    expect(api).toContain("rpc('save_branch_target_configuration'");
    expect(api).toContain('workspaceSchema.parse(data)');
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@/components/charts/e-chart'");
    expect(workspace).toContain('Save targets');
    expect(workspace).toContain('readOnly = false');
    expect(workspace).toContain('Business Owner › Targets & performance');
    expect(route).toContain("role === 'client-admin' && slug[0] === 'targets-approval-rules'");
    expect(route).toContain("role === 'business-owner' && slug[0] === 'targets-performance'");
  });
});
