import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220014_gm_sales_analytics_workspace.sql');
const api = source('src/features/dashboards/gm-sales-analytics-api.ts');
const workspace = source('src/features/dashboards/gm-sales-analytics-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('GM sales analytics backend contract', () => {
  it('allows only bounded time periods and a GM Sales Executive CRM context', () => {
    expect(migration).toContain(
      'create or replace function public.get_gm_sales_analytics_workspace(',
    );
    expect(migration).toContain('target_days not in (7, 14, 30)');
    expect(migration).toContain("target_timezone not in ('Asia/Kolkata', 'UTC')");
    expect(migration).toContain("access_context->>'role_key' <> 'gm-sales'");
    expect(migration).toContain("message = 'GM_SALES_ACCESS_REQUIRED'");
    expect(migration).toContain("'lead.view'");
  });

  it('computes aggregate-only analytics from the caller-authorized scope', () => {
    expect(migration).toContain('accessible_branches as materialized');
    expect(migration).toContain('scoped_leads as materialized');
    expect(migration).toContain('scoped_calls as materialized');
    expect(migration).toContain('scoped_drives as materialized');
    expect(migration).toContain('scoped_quotations as materialized');
    expect(migration).toContain('scoped_bookings as materialized');
    expect(migration).toContain('app_private.can_access_branch(');
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain("'branches', coalesce(");
    expect(migration).toContain("'consultants', coalesce(");
    expect(migration).toContain("'models', coalesce(");
    expect(migration).toContain("'daily', coalesce(");
  });

  it('uses indexes for the branch/date fact-table paths and grants only authenticated execution', () => {
    for (const index of [
      'leads_gm_analytics_branch_created_idx',
      'calls_gm_analytics_branch_started_idx',
      'test_drive_appointments_gm_analytics_branch_scheduled_idx',
      'quotations_gm_analytics_branch_created_idx',
      'bookings_gm_analytics_branch_created_idx',
    ])
      expect(migration).toContain(index);
    expect(migration).toContain(
      'revoke all on function public.get_gm_sales_analytics_workspace(integer, text) from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.get_gm_sales_analytics_workspace(integer, text) to authenticated',
    );
  });
});

describe('GM sales analytics web contract', () => {
  it('validates the small RPC response before rendering charts or tables', () => {
    expect(api).toContain('const analyticsSchema = z.object({');
    expect(api).toContain("rpc('get_gm_sales_analytics_workspace'");
    expect(api).toContain("target_timezone: 'Asia/Kolkata'");
    expect(api).toContain('return analyticsSchema.parse(data)');
  });

  it('uses TanStack Query, shadcn, and the approved ECharts wrapper', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@/components/charts/e-chart'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain('kind="line"');
    expect(workspace).toContain('kind="funnel"');
    expect(workspace).toContain('kind="bar"');
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
  });

  it('routes each GM view before the fail-closed unavailable fallback', () => {
    for (const slug of [
      'sales-performance',
      'showroom-comparison',
      'consultant-ranking',
      'model-performance',
    ])
      expect(route).toContain(`'${slug}'`);
    expect(route.indexOf('<GmSalesAnalyticsWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
