import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspaceCache = readFileSync('supabase/functions/_shared/workspace-cache.ts', 'utf8');
const dashboardHandler = readFileSync(
  'supabase/functions/sales-consultant-dashboard/index.ts',
  'utf8',
);
const cachePolicy = readFileSync('src/lib/query/cache-policy.ts', 'utf8');
const dashboard = readFileSync('src/features/dashboards/sales-consultant-dashboard.tsx', 'utf8');
const dashboardApi = readFileSync(
  'src/features/dashboards/sales-consultant-dashboard-api.ts',
  'utf8',
);

describe('dashboard read-through cache policy', () => {
  it('keeps an in-session dashboard result in memory', () => {
    expect(cachePolicy).toContain('DASHBOARD_QUERY_STALE_TIME_MS = 30 * 60_000');
    expect(cachePolicy).toContain('DASHBOARD_QUERY_GC_TIME_MS = 24 * 60 * 60_000');
    expect(dashboard).toContain('staleTime: DASHBOARD_QUERY_STALE_TIME_MS');
    expect(dashboard).toContain('gcTime: DASHBOARD_QUERY_GC_TIME_MS');
  });

  it('holds the Redis entry for a day and explicitly invalidates it before refresh', () => {
    expect(dashboardHandler).toContain('const SALES_DASHBOARD_CACHE_TTL_SECONDS = 24 * 60 * 60');
    expect(dashboardHandler).toContain('ttlSeconds: SALES_DASHBOARD_CACHE_TTL_SECONDS');
    // The entry rebuilds on an explicit refresh, never on a passing read.
    expect(dashboardHandler).toContain('forceRefresh: parsed.data.manual_refresh');
    expect(workspaceCache).toContain('await redis.delete(key);');
  });

  it('budgets manual refreshes at three per thirty minutes', () => {
    expect(workspaceCache).toContain('const MANUAL_REFRESH_LIMIT = 3;');
    expect(workspaceCache).toContain('const MANUAL_REFRESH_WINDOW_MS = 30 * 60_000;');
    expect(dashboard).toContain('Available again at ${refreshAt}.');
    expect(dashboard).toContain('retryAfterMs');
    expect(workspaceCache).toContain('getManualRefreshStatus');
    expect(dashboardHandler).toContain('await getManualRefreshStatus');
    expect(dashboard).toContain('manualRefreshRemaining === 0');
  });

  it('reports the moment the cached payload was built so staleness stays visible', () => {
    expect(workspaceCache).toContain('synced_at: string | null;');
    expect(workspaceCache).toContain('synced_at: existing.created_at');
    expect(workspaceCache).toContain('synced_at: rebuilt.created_at');
    expect(dashboardApi).toContain('synced_at: z.string().nullish()');
    expect(dashboard).toContain('Last synced {formatTime(data.cache.synced_at');
  });

  it('keeps the last dashboard visible when only a manual refresh is rejected', () => {
    expect(dashboard).toContain("setRefreshMessage('Could not refresh right now.");
    expect(dashboard).toContain('if (!data)');
    expect(dashboard).toContain('A rejected Refresh');
    expect(dashboard).toContain('onClick={() => void refresh(false)}');
  });

  it('never lets Redis become a page availability dependency', () => {
    expect(workspaceCache).toContain("return loadWithoutCache('FALLBACK')");
    expect(workspaceCache).toContain(
      "if (!config.enabled || !config.url || !config.token) return loadWithoutCache('BYPASS')",
    );
  });
});
