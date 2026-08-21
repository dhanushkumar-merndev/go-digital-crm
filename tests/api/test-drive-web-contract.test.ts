import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const api = source('src/features/test-drives/test-drive-workspace-api.ts');
const workspace = source('src/features/test-drives/test-drive-workspace.tsx');
const dialogs = source('src/features/test-drives/test-drive-workspace-dialogs.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('test-drive web API boundary', () => {
  it('calls only focused scoped RPC boundaries with versioned lifecycle mutations', () => {
    for (const rpc of [
      'get_test_drive_workspace_page',
      'get_test_drive_lead_options',
      'get_test_drive_vehicle_options',
      'create_test_drive',
      'cancel_test_drive',
      'record_test_drive_anchor_v2',
      'finalize_test_drive_route_v2',
      'save_test_drive_feedback',
    ])
      expect(api).toContain(`'${rpc}'`);
    expect(api).toContain('expected_version: input.expectedVersion');
    expect(api).toContain('target_request_id: input.requestId');
    expect(api).toContain("target_permission: 'test_drive.manage'");
    expect(api).toContain("target_permission: 'customer.view'");
    expect(api).not.toContain('service_role');
    expect(api).not.toContain('NEXT_PUBLIC_');
  });

  it('uses a retryable anchor-only web completion flow and gates feedback on route finalization', () => {
    expect(dialogs).toContain("kind === 'start' ? 'Start'");
    expect(dialogs).toContain('finalizeTestDriveRoute({');
    expect(dialogs).toContain('recordedAt.current ??= new Date().toISOString()');
    expect(dialogs).toContain('recordedAt: recordedAt.current');
    expect(dialogs).toContain('record.start_anchor, record.reached_anchor, record.end_anchor');
    expect(workspace).toContain('Boolean(record.start_anchor && record.end_anchor)');
    expect(workspace).toContain('Boolean(record.route_finalized_at)');
    expect(workspace).toContain('!record.feedback_id');
    expect(workspace).toContain('record.assigned_user_id === permissions.userId');
  });
});

describe('test-drive web runtime contract', () => {
  it('uses shadcn, TanStack Query/Table, server pagination, debounce and private work invalidation', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@tanstack/react-table'");
    expect(workspace).toContain('manualPagination: true');
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).toContain('useDebouncedValue(query.model, 300)');
    expect(workspace).toContain("label: 'Conversion after Test Drive'");
    expect(workspace).toContain("setScreen('create')");
    expect(workspace).toContain('<TestDriveActiveView');
    expect(workspace).toContain("resource: 'work'");
    expect(workspace).toContain("resource: 'sales'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain("boxShadow: 'inset 0 -2px 0 #2563eb'");
    expect(dialogs).toContain("from '@/components/ui/dialog'");
    expect(dialogs).toContain("from '@/components/ui/map'");
    expect(dialogs).toContain('<TestDriveRoutePreview record={record} />');
    expect(dialogs).toContain('aria-label="Simplified test-drive route preview"');
    expect(`${workspace}\n${dialogs}`).not.toMatch(/recharts|chart\.js|apexcharts|@mui/i);
  });

  it('wires only configured consultant, team-manager and showroom-manager routes before fallback', () => {
    expect(route).toContain("spec.category === 'test-drives'");
    expect(route).toContain("role === 'sales-consultant'");
    expect(route).toContain("role === 'team-manager'");
    expect(route).toContain("role === 'showroom-manager'");
    expect(route).toContain('<TestDriveWorkspace spec={spec} role={role} />');
    expect(route.indexOf("spec.category === 'test-drives'")).toBeLessThan(
      route.indexOf('if (!isLocalPreviewMode()) return <ProductionDataUnavailable />'),
    );
  });
});
