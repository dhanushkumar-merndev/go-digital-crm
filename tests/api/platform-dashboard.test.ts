import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/202608150017_platform_dashboard.sql', 'utf8');
const api = readFileSync('src/features/platform/platform-dashboard-api.ts', 'utf8');
const workspace = readFileSync('src/features/platform/platform-dashboard.tsx', 'utf8');
const chart = readFileSync('src/components/charts/e-chart.tsx', 'utf8');
const route = readFileSync('src/app/[role]/[[...slug]]/page.tsx', 'utf8');

describe('platform dashboard contract', () => {
  it('uses one MFA-protected aggregate RPC instead of independent KPI queries', () => {
    expect(migration).toContain('get_platform_dashboard');
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain('security definer');
    expect(migration).toContain("message = 'PLATFORM_MFA_REQUIRED'");
    expect(api).toContain("rpc('get_platform_dashboard')");
  });

  it('returns bounded sanitized attention links and a 14-day series', () => {
    expect(migration).toContain("interval '13 days'");
    expect(migration).toContain('limit 8');
    expect(migration).toContain("'/super-admin/support-sessions?status=pending'");
    expect(api).toContain('/^\\/super-admin\\/');
    expect(migration).not.toContain('encrypted_payload');
    expect(migration).not.toContain('payload_reference');
  });

  it('renders charts only through the shared Apache ECharts wrapper', () => {
    expect(workspace).toContain("import { EChart } from '@/components/charts/e-chart'");
    expect(workspace).toContain('kind="line"');
    expect(workspace).toContain('kind="donut"');
    expect(workspace).toContain('seriesNames={platformActivitySeriesNames}');
    expect(chart).toContain("import * as echarts from 'echarts'");
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
  });

  it('subscribes through private platform invalidation and wires only the completed route', () => {
    expect(workspace).toContain('usePlatformRealtimeInvalidation');
    expect(route).toContain("role === 'super-admin' && slug[0] === 'dashboard'");
    expect(route).toContain('<PlatformDashboard spec={spec} />');
  });
});
