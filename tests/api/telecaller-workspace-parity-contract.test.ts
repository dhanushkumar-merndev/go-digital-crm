import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const telecallerDashboard = read('src/features/dashboards/telecaller-dashboard.tsx');
const salesConsultantDashboard = read('src/features/dashboards/sales-consultant-dashboard.tsx');
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
    expect(telecallerDashboard).toContain('staleTime: DASHBOARD_QUERY_STALE_TIME_MS');
    expect(telecallerDashboard).toContain('gcTime: DASHBOARD_QUERY_GC_TIME_MS');
    expect(dashboardCache).toContain('const DASHBOARD_CACHE_TTL_SECONDS = 24 * 60 * 60;');
    expect(dashboardCache).toContain('ttlSeconds: DASHBOARD_CACHE_TTL_SECONDS');
  });

  it('states the real refresh window on every dashboard', () => {
    // The budget is three per thirty minutes; the old copy said one minute.
    expect(telecallerDashboard).toContain('Try again after the 30-minute window.');
    expect(telecallerDashboard).not.toContain('one-minute window');
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
      'src/features/dashboards/telecaller-dashboard.tsx',
      'src/features/dashboards/sales-consultant-activity-timeline.tsx',
      'src/features/dashboards/sales-consultant-performance.tsx',
    ];
    const offenders = surface.filter((file) => !read(file).includes('mx-auto max-w-[1800px]'));
    expect(offenders).toEqual([]);
  });

  it('paints both front-line dashboards from one accent palette', () => {
    // The two pages are the same surface for two roles. Sharing the table is
    // what stops one of them from drifting to a different set of shades.
    for (const file of [telecallerDashboard, salesConsultantDashboard])
      expect(file).toContain("from './dashboard-tone'");
  });

  it('builds the telecaller dashboard from the same layout as sales consultant', () => {
    // Both pages retain the same dashboard shell. Appointment slots on the
    // Telecaller dashboard are replaced with intake and handoff information.
    const shells = [
      'grid gap-2.5 sm:grid-cols-2 lg:grid-cols-8',
      'grid gap-4 xl:grid-cols-12',
      'grid gap-2.5 p-3 sm:grid-cols-2 lg:grid-cols-5',
      'space-y-4 xl:col-span-8',
      'space-y-4 xl:col-span-4',
    ];
    const missing = shells.filter((shell) => !telecallerDashboard.includes(shell));
    expect(missing).toEqual([]);
    expect(shells.filter((shell) => !salesConsultantDashboard.includes(shell))).toEqual([]);
  });

  it('keeps appointments completely outside the telecaller surface', () => {
    expect(telecallerDashboard.toLowerCase()).not.toContain('appointment');
    expect(telecallerDashboard).toContain('Contacted leads');
    // 'Qualified' was a pass-through state -- transfer_lead_to_sales writes it
    // and record_sales_lead_handoff replaces it in the same transaction -- so
    // both tiles could only ever read zero. Replaced, not removed.
    expect(telecallerDashboard).toContain('Contacted, not yet handed off');
    expect(telecallerDashboard).toContain('Transferred to Sales');
    expect(telecallerDashboard).toContain('Handoff rate');
  });

  it('keeps every telecaller dashboard link inside the telecaller workspace', () => {
    expect(telecallerDashboard).not.toContain('/sales-consultant/');
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
