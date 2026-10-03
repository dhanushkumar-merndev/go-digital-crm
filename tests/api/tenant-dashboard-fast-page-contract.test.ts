import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610030004_tenant_dashboard_fast_page.sql',
  'utf8',
);
const api = readFileSync('src/features/dashboards/tenant-dashboard-api.ts', 'utf8');

describe('tenant dashboard fast read', () => {
  it('bundles the permission-scoped summary and bounded live rows in one RPC', () => {
    expect(migration).toContain('get_tenant_dashboard_summary(target_days, target_timezone)');
    expect(migration).toContain('get_tenant_dashboard_live_items(target_timezone)');
    expect(migration).toContain('security invoker');
    expect(migration).toContain('to authenticated');
  });

  it('uses the direct bundle normally and keeps explicit refresh on the rate-limited Edge path', () => {
    expect(api).toContain("rpc('get_tenant_dashboard_page'");
    expect(api).toContain('if (!options.manualRefresh)');
    expect(api).toContain('manualRefresh: true');
    expect(api).toContain("resource: 'tenant-dashboard'");
  });
});
