import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610030004_tenant_dashboard_fast_page.sql',
  'utf8',
);
const api = readFileSync('src/features/dashboards/tenant-dashboard-api.ts', 'utf8');
const hook = readFileSync('src/features/dashboards/use-tenant-dashboard.ts', 'utf8');

describe('tenant dashboard browser-first read', () => {
  it('keeps the bundled direct RPC available for fallback and scripts', () => {
    expect(migration).toContain('get_tenant_dashboard_summary(target_days, target_timezone)');
    expect(migration).toContain('get_tenant_dashboard_live_items(target_timezone)');
    expect(migration).toContain('security invoker');
    expect(migration).toContain('to authenticated');
  });

  it('reads the summary through Redis and falls back to PostgreSQL only for ordinary reads', () => {
    expect(api).toContain("resource: 'tenant-dashboard'");
    expect(api).toContain('manualRefresh: options.manualRefresh');
    expect(api).toContain('if (options.manualRefresh || signal?.aborted) throw error;');
    expect(api).toContain("rpc('get_tenant_dashboard_summary'");
  });

  it('persists only the aggregate summary; live rows with names and phones stay in memory', () => {
    expect(hook).toContain('usePersistedQuery({');
    expect(hook).toContain('schema: tenantDashboardSummaryResultSchema');
    expect(hook).toContain("queryKey: [...dashboardKey, 'live']");
    expect(hook).toContain('const live = useQuery({');
  });
});
