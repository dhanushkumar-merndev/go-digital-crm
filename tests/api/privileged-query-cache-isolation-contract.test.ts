import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const scopedWorkspaces = [
  ['src/features/administration/audit-log-workspace.tsx', 1],
  ['src/features/dashboards/tenant-dashboard.tsx', 1],
  ['src/features/administration/users/user-workspace.tsx', 2],
  // Report queries compute the verified scope once and reuse it in both keys.
  ['src/features/reports/report-export-workspace.tsx', 1],
  ['src/features/administration/role-workspace.tsx', 2],
  ['src/features/administration/custom-field-workspace.tsx', 1],
  ['src/features/administration/master-data-workspace.tsx', 1],
  ['src/features/administration/tenant-module-entitlements-workspace.tsx', 1],
  ['src/features/administration/tenant-target-configuration-workspace.tsx', 1],
  ['src/features/administration/company-compliance-workspace.tsx', 1],
  ['src/features/dashboards/owner-ai-business-summary.tsx', 1],
  ['src/features/dashboards/business-overview-workspaces.tsx', 3],
  ['src/features/administration/competitor-catalog-workspace.tsx', 1],
  ['src/features/administration/security-workspace.tsx', 1],
  ['src/features/administration/system-health-workspace.tsx', 1],
  ['src/features/administration/automation-workspace.tsx', 1],
  ['src/features/administration/automation-rule-detail-workspace.tsx', 1],
  ['src/features/administration/template-workspace.tsx', 1],
] as const;

describe('privileged React Query cache isolation', () => {
  it.each(scopedWorkspaces)(
    '%s keys every privileged read by the verified workspace scope',
    (relativePath, minimumUses) => {
      const workspace = source(relativePath);
      expect(workspace).toContain('useWorkspaceSession');
      expect(workspace).toContain('workspaceQueryScope');
      expect(
        workspace.match(/workspaceQueryScope\(session\)/g)?.length ?? 0,
      ).toBeGreaterThanOrEqual(minimumUses);
    },
  );
});
