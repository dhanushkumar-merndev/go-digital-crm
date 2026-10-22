import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const telecallerDashboard = read('src/features/dashboards/telecaller-dashboard.tsx');
const salesConsultantDashboard = read('src/features/dashboards/sales-consultant-dashboard.tsx');
const dashboardCache = read('supabase/functions/dashboard-cache/index.ts');
const callWorkspace = read('src/features/calls/call-workspace.tsx');
const header = read('src/components/shared/app-header.tsx');
const tenantDashboardApi = read('src/features/dashboards/tenant-dashboard-api.ts');

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
    expect(dashboardCache).toContain('const DASHBOARD_CACHE_TTL_SECONDS = 30 * 60;');
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
    // The shell caps the content width once. A page that picks its own
    // 1600 or 1800px maximum shifts the layout as you navigate between pages
    // of one sidebar, so no workspace sets a width of its own.
    const surface = [
      ...shared,
      'src/features/dashboards/telecaller-dashboard.tsx',
      'src/features/dashboards/sales-consultant-activity-timeline.tsx',
      'src/features/dashboards/sales-consultant-performance.tsx',
    ];
    const offenders = surface.filter((file) => /max-w-\[1[4-8]00px\]/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('paints both front-line dashboards from one accent palette', () => {
    // The two pages are the same surface for two roles. Sharing the table is
    // what stops one of them from drifting to a different set of shades.
    for (const file of [telecallerDashboard, salesConsultantDashboard])
      expect(file).toContain("from './dashboard-tone'");
  });

  it('builds the telecaller dashboard from the same layout as sales consultant', () => {
    // Both pages keep the same 12-column shell and the shared KPI tile row.
    const shells = ['grid gap-4 xl:grid-cols-12', 'space-y-4 xl:col-span-8'];
    expect(shells.filter((shell) => !telecallerDashboard.includes(shell))).toEqual([]);
    expect(shells.filter((shell) => !salesConsultantDashboard.includes(shell))).toEqual([]);
    expect(telecallerDashboard).toContain('kpiGridColumns(metrics.length)');
  });

  it('shows each telecaller count once instead of repeating the KPI row', () => {
    // "Requires attention" and "Tasks & alerts" restated the KPI tiles; the
    // overdue call queue is the one action list beside them.
    expect(telecallerDashboard).not.toContain('Requires attention');
    expect(telecallerDashboard).not.toContain('Tasks &amp; alerts');
    expect(telecallerDashboard).toContain('Needs a call now');
  });

  it('shows the pipeline as a funnel with shares, never a stage-over-stage conversion', () => {
    // The pipeline RPC reports where each lead is now, so dividing one stage by
    // the previous read 233% when Contacted outnumbered New. The funnel matches
    // the Sales Consultant dashboard; its key shows each stage's share.
    expect(telecallerDashboard).toContain('kind="funnel"');
    // Cumulative stages, each a share of the leads assigned.
    expect(telecallerDashboard).toContain('function pipelineFunnel(');
    expect(telecallerDashboard).toContain('(stage.value / funnel[0]!.value) * 100');
    expect(telecallerDashboard).not.toContain('% conversion');
    expect(telecallerDashboard).toContain('title="AI calling summary"');
  });

  it('keeps appointments completely outside the telecaller surface', () => {
    expect(telecallerDashboard.toLowerCase()).not.toContain('appointment');
    expect(telecallerDashboard).toContain('Contacted leads');
    // 'Qualified' was a pass-through state -- transfer_lead_to_sales writes it
    // and record_sales_lead_handoff replaces it in the same transaction -- so
    // a tile for it could only ever read zero. Handoff output replaced it.
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

  it('reads the own-records summary straight from PostgreSQL, keeping the refresh quota on Edge', () => {
    expect(telecallerDashboard).toContain(
      'useTenantDashboard(dashboardQueryKey, manualRefreshRequest, { direct: true })',
    );
    expect(tenantDashboardApi).toContain(
      'if (options.direct && !options.manualRefresh) return readTenantDashboardSummary(signal);',
    );
  });
});
