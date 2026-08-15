import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const tracking = source('mobile/src/lib/test-drive-tracking.ts');
const routeBuffer = source('mobile/src/lib/route-buffer.ts');
const mobileApi = source('mobile/src/features/test-drives/test-drive-api.ts');
const mobileScreen = source('mobile/src/features/test-drives/test-drive-screen.tsx');
const mobileRoute = source('mobile/app/sales/test-drives.tsx');
const rootLayout = source('mobile/app/_layout.tsx');
const mobileConfig = source('mobile/app.json');
const anchorEdge = source('supabase/functions/test-drive-anchor/index.ts');
const completeEdge = source('supabase/functions/test-drive-complete/index.ts');

describe('test-drive mobile backend contract', () => {
  it('uses only the versioned, idempotent GPS mutation boundaries', () => {
    expect(anchorEdge).toContain("rpc('record_test_drive_anchor_v2'");
    expect(completeEdge).toContain("rpc('finalize_test_drive_route_v2'");
    for (const edge of [anchorEdge, completeEdge]) {
      expect(edge).toContain('expected_version:');
      expect(edge).toContain('target_request_id:');
      expect(edge).toContain('request_id: z.uuid()');
    }
    expect(anchorEdge).not.toContain("rpc('record_test_drive_anchor'");
    expect(completeEdge).not.toContain("rpc('finalize_test_drive_route'");
  });

  it('persists exact pending mutations and retains SQLite points until final confirmation', () => {
    for (const phase of ['STARTING', 'REACHING', 'ENDING', 'ROUTE_PENDING', 'FINALIZING'])
      expect(tracking).toContain(`'${phase}'`);
    expect(tracking).toContain('pendingAnchor: anchorFromLocation');
    expect(tracking).toContain('finalizeRequestId: state.finalizeRequestId ?? createRequestId()');
    expect(tracking.indexOf("'test-drive-complete'")).toBeLessThan(
      tracking.indexOf('markRoutePointsUploaded(state.testDriveId'),
    );
    expect(tracking.indexOf('markRoutePointsUploaded(state.testDriveId')).toBeLessThan(
      tracking.indexOf('clearCompletedRoute(state.testDriveId)'),
    );
    expect(routeBuffer).toContain('primary key (test_drive_id, sequence_no)');
    expect(routeBuffer).toContain('maximumBufferedRoutePoints = 2000');
    expect(routeBuffer).toContain('database.withTransactionSync');
    expect(routeBuffer).toContain('recorded_at <= ?');
  });

  it('registers background tracking at app startup and supports restart recovery', () => {
    expect(rootLayout).toContain("import '@/lib/test-drive-tracking'");
    expect(tracking).toContain('TaskManager.defineTask');
    expect(tracking).toContain('TaskManager.isAvailableAsync()');
    expect(tracking).toContain('export async function resumeTestDriveTracking()');
    expect(tracking).toContain("state.phase === 'ROUTE_PENDING' || state.phase === 'FINALIZING'");
    expect(tracking).toContain('await stopLocationUpdates()');
    expect(mobileConfig).toContain('"isIosBackgroundLocationEnabled": true');
    expect(mobileConfig).toContain('"isAndroidBackgroundLocationEnabled": true');
    expect(mobileConfig).toContain('"isAndroidForegroundServiceEnabled": true');
  });
});

describe('test-drive mobile live workspace contract', () => {
  it('loads the scoped server page and submits transactional feedback', () => {
    expect(mobileApi).toContain("supabase.rpc('get_test_drive_workspace_page'");
    expect(mobileApi).toContain('target_page_size: 25');
    expect(mobileApi).toContain("supabase.rpc('save_test_drive_feedback'");
    expect(mobileApi).not.toContain('service_role');
  });

  it('replaces the demo list with GPS lifecycle, recovery and feedback actions', () => {
    expect(mobileRoute).toContain('<TestDriveScreen />');
    expect(mobileRoute).not.toContain('WorkListScreen');
    for (const action of [
      'startTestDriveTracking',
      'markDestinationReached',
      'stopTestDriveTracking',
      'resumeTestDriveTracking',
      'saveTestDriveFeedback',
    ])
      expect(mobileScreen).toContain(action);
    expect(mobileScreen).toContain('<RefreshControl');
    expect(mobileScreen).toContain("label: 'Overdue'");
    expect(mobileScreen).toContain("view, setView] = useState<TestDriveView>('TODAY')");
  });
});
