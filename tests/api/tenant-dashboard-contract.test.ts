import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150028_tenant_performance_dashboard.sql');
const enumRepair = source(
  'supabase/migrations/202608150033_fix_tenant_dashboard_lifecycle_enum.sql',
);
const optimization = source('supabase/migrations/202608150035_optimize_tenant_dashboard.sql');
const workspace = source('src/features/dashboards/tenant-dashboard.tsx');
const api = source('src/features/dashboards/tenant-dashboard-api.ts');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('tenant performance dashboard backend contract', () => {
  it('is one bounded tenant-scoped KPI RPC rather than browser-wide table loads', () => {
    expect(migration).toContain(
      'create or replace function public.get_tenant_performance_dashboard(',
    );
    expect(migration).toContain('target_days not in (7, 14, 30)');
    expect(migration).toContain("target_timezone not in ('Asia/Kolkata', 'UTC')");
    expect(migration).toContain('app_private.current_tenant_organization()');
    expect(migration).toContain("message = 'TENANT_DASHBOARD_PERMISSION_REQUIRED'");
    expect(migration).toContain("'kpis', jsonb_build_object(");
  });

  it('checks module permission and record/customer scope before every aggregate family', () => {
    for (const permission of [
      'lead.view',
      'call.view',
      'followup.view',
      'appointment.view',
      'booking.view',
      'inventory.view',
      'test_drive.view',
      'finance.view',
      'insurance.view',
      'rto.view',
      'exchange.view',
      'delivery.view',
    ])
      expect(migration).toContain(`'${permission}'`);
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain('app_private.can_access_customer(');
    expect(migration).toContain('app_private.can_access_branch(');
    expect(migration).toContain('app_private.can_access_lead(');
  });

  it('returns scoped trends, pipeline, attention and department workflow KPIs', () => {
    expect(migration).toContain('from generate_series(');
    expect(migration).toContain("'pipeline', pipeline_result");
    expect(migration).toContain("'attention', attention_result");
    expect(migration).toContain("'followups_overdue'");
    expect(migration).toContain("'booking_value_month'");
    expect(migration).toContain("'open_cases'");
    expect(migration).toContain("'cases_completed_month'");
    expect(migration).toContain('app_private.operational_case_rows(');
  });

  it('grants only authenticated execution and keeps helper execution private', () => {
    expect(migration).toContain(
      'revoke all on function public.get_tenant_performance_dashboard(integer, text) from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.get_tenant_performance_dashboard(integer, text) to authenticated',
    );
    expect(migration).toContain(
      'revoke all on function app_private.dashboard_lifecycle_label(text)',
    );
  });

  it('accepts the lead lifecycle enum passed by the pipeline aggregation', () => {
    expect(enumRepair).toContain(
      'app_private.dashboard_lifecycle_label(target_status public.lead_lifecycle)',
    );
    expect(enumRepair).toContain('app_private.dashboard_lifecycle_label(target_status::text)');
    expect(enumRepair).toContain(
      'revoke all on function app_private.dashboard_lifecycle_label(public.lead_lifecycle)',
    );
  });

  it('materializes caller-scoped dashboard datasets once and returns the bounded lead preview', () => {
    expect(optimization).toContain('with scoped_leads as materialized');
    expect(optimization).toContain('scoped_calls as materialized');
    expect(optimization).toContain('scoped_bookings as materialized');
    expect(optimization).toContain("'lead_preview', lead_preview_result");
    expect(optimization).toContain('limit 5');
    expect(optimization).toContain(
      'One scan per visible resource replaces the old 14 correlated scans',
    );
  });
});

describe('tenant dashboard web contract', () => {
  it('uses TanStack Query, shadcn cards and Apache ECharts only', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@/components/ui/card'");
    expect(workspace).toContain("from '@/components/charts/e-chart'");
    expect(workspace).toContain('kind="line"');
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
  });

  it('subscribes only to capability-relevant private tenant topics', () => {
    expect(workspace).toContain('useTenantRealtimeInvalidation(');
    for (const resource of ['leads', 'work', 'communications', 'sales', 'inventory', 'operations'])
      expect(workspace).toContain(`'${resource}'`);
  });

  it('routes configured tenant dashboards before the fail-closed fallback', () => {
    expect(route).toContain("if (slug[0] === 'dashboard' && !isLocalPreviewMode())");
    expect(route.indexOf('<TenantDashboard')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });

  it('rejects malformed RPC payloads at the browser boundary', () => {
    expect(api).toContain('export const tenantDashboardSchema = z.object({');
    expect(api).toContain('organization_id: z.uuid()');
    expect(api).toContain('days: z.union([z.literal(7), z.literal(14), z.literal(30)])');
    expect(api).toContain('return tenantDashboardSchema.parse(data)');
    expect(api).toContain('lead_preview: z.array(leadPreviewSchema)');
    expect(api).not.toContain('fetchTenantDashboardLeadPreview');
  });

  it('uses the one dashboard response for the lead preview table', () => {
    expect(workspace).toContain('records={data.lead_preview}');
    expect(workspace).not.toContain('tenantDashboardLeadPreviewKey');
  });
});
