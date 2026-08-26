import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const tenantDashboard = read('src/features/dashboards/tenant-dashboard.tsx');
const dashboardCache = read('supabase/functions/dashboard-cache/index.ts');
const callWorkspace = read('src/features/calls/call-workspace.tsx');
const header = read('src/components/shared/app-header.tsx');

describe('telecaller workspace parity', () => {
  // Telecaller reaches these through the same components as Sales Consultant,
  // so parity is a property of the shared files rather than a second set.
  const shared = [
    'src/features/leads/lead-workspace.tsx',
    'src/features/work/workspace.tsx',
    'src/features/tasks/task-workspace.tsx',
    'src/features/inbox/inbox-workspace.tsx',
    'src/features/calls/call-workspace.tsx',
  ];

  it.each(shared)('%s refreshes through the shared registry', (path) => {
    expect(read(path)).toContain('salesConsultantCache.');
  });

  it('gives the telecaller dashboard the same read-through policy', () => {
    expect(tenantDashboard).toContain('staleTime: DASHBOARD_QUERY_STALE_TIME_MS');
    expect(tenantDashboard).toContain('gcTime: DASHBOARD_QUERY_GC_TIME_MS');
    expect(dashboardCache).toContain('const DASHBOARD_CACHE_TTL_SECONDS = 24 * 60 * 60;');
    expect(dashboardCache).toContain('ttlSeconds: DASHBOARD_CACHE_TTL_SECONDS');
  });

  it('states the real refresh window on every dashboard', () => {
    // The budget is three per thirty minutes; the old copy said one minute.
    expect(tenantDashboard).toContain('Try again after the 30-minute window.');
    expect(tenantDashboard).not.toContain('one-minute window');
  });

  it('refreshes the lead row when a call is logged', () => {
    expect(callWorkspace).toContain("salesConsultantCache.invalidate('call.logged'");
  });

  it('lays every telecaller workspace out on one page width', () => {
    // 1600px is the app-wide norm, but the sales surface standardised on
    // 1800px. Mixing the two inside one sidebar shifts the layout as you
    // navigate and leaves dead margin on the narrower pages.
    const surface = [
      ...shared,
      'src/features/dashboards/tenant-dashboard.tsx',
      'src/features/dashboards/sales-consultant-activity-timeline.tsx',
      'src/features/dashboards/sales-consultant-performance.tsx',
    ];
    const offenders = surface.filter((file) => !read(file).includes('mx-auto max-w-[1800px]'));
    expect(offenders).toEqual([]);
  });

  it('gives telecaller the same header furniture as sales consultant', () => {
    expect(header).toContain(
      "const salesWorkspace = role === 'sales-consultant' || role === 'telecaller';",
    );
  });

  it('routes quick add into the acting role and hides what it cannot reach', () => {
    // Telecaller has no test-drives or quotations route; a hardcoded
    // /sales-consultant/... path would 404 or cross into another workspace.
    expect(header).toContain('roleHasNavigationSlug(role, item.slug)');
    expect(header).toContain('router.push(`/${role}/${item.slug}?action=create`)');
    expect(header).not.toContain("'/sales-consultant/my-leads?action=create'");
    expect(header).not.toContain("'/sales-consultant/quotations?action=create'");
  });
});
