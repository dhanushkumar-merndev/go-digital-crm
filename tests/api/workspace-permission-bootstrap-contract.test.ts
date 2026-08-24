import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('workspace bootstrap permission reuse', () => {
  it.each([
    'src/features/operations/operational-case-workspace.tsx',
    'src/features/customer-care/customer-care-workspace.tsx',
    'src/features/integrations/integration-workspace.tsx',
  ])('avoids redundant permission RPCs when the verified workspace session exists: %s', (file) => {
    const source = read(file);
    expect(source).toContain('useWorkspaceSession()');
    expect(source).toContain('hasWorkspacePermission');
    expect(source).toContain('enabled: !workspaceSession');
    expect(source).toContain('workspaceQueryScope(workspaceSession)');
  });

  it.each([
    'src/features/leads/lead-workspace.tsx',
    'src/features/calls/call-workspace.tsx',
    'src/features/customers/customer-workspace.tsx',
    'src/features/customers/customer-360-workspace.tsx',
    'src/features/work/workspace.tsx',
    'src/features/tasks/task-workspace.tsx',
    'src/features/tasks/task-center-sheet.tsx',
    'src/features/test-drives/test-drive-workspace.tsx',
    'src/features/inventory/inventory-workspace.tsx',
  ])('uses the verified role bootstrap instead of a second permission waterfall: %s', (file) => {
    const source = read(file);
    expect(source).toContain('useWorkspaceSession()');
    expect(source).toContain('hasWorkspacePermission');
    expect(source).toContain('workspaceQueryScope(workspaceSession)');
    expect(source).toMatch(/enabled:\s*(?:open && )?!useWorkspaceBootstrap/);
  });

  it.each([
    ['src/features/sales/sales-document-workspace.tsx', 'workspaceSession'],
    ['src/features/operations/sales-exchange-workspace.tsx', 'workspaceSession'],
    ['src/features/marketing/marketing-automation-workspace.tsx', 'session'],
    ['src/features/sales/sales-escalation-workspace.tsx', 'session'],
    ['src/features/reports/report-export-workspace.tsx', 'session'],
    ['src/features/administration/branch-team-workspace.tsx', 'session'],
  ])('reuses bootstrap permissions in additional role workspaces: %s', (file, sessionName) => {
    const source = read(file);
    expect(source).toContain('hasWorkspacePermission');
    expect(source).toContain(`workspaceQueryScope(${sessionName})`);
    expect(source).toContain('enabled: !useWorkspaceBootstrap');
  });

  it('retries workspace bootstrap only for classified transient failures', () => {
    for (const file of ['proxy.ts', 'src/app/page.tsx', 'src/app/[role]/layout.tsx']) {
      const source = read(file);
      expect(source).toContain('isTransientSupabaseError');
      expect(source).not.toContain('if (result.error || !result.data)');
      expect(source).not.toContain('if (bootstrap.error || !bootstrap.data) bootstrap =');
    }
  });
});
