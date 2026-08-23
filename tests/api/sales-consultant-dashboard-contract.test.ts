import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608200001_sales_consultant_dashboard.sql',
  'utf8',
);
const topModelsMigration = readFileSync(
  'supabase/migrations/202608200002_sales_consultant_top_models.sql',
  'utf8',
);
const topFiveModelsMigration = readFileSync(
  'supabase/migrations/202608200003_sales_consultant_top_five_models.sql',
  'utf8',
);
const hotPathMigration = readFileSync(
  'supabase/migrations/202608220002_sales_consultant_hot_path_rpcs.sql',
  'utf8',
);
const api = readFileSync('src/features/dashboards/sales-consultant-dashboard-api.ts', 'utf8');
const workspace = readFileSync('src/features/dashboards/sales-consultant-dashboard.tsx', 'utf8');
const dashboardHandler = readFileSync(
  'supabase/functions/sales-consultant-dashboard/index.ts',
  'utf8',
);
const cache = readFileSync('supabase/functions/_shared/workspace-cache.ts', 'utf8');
const config = readFileSync('supabase/config.toml', 'utf8');

describe('sales consultant dashboard contract', () => {
  it('returns one tenant-scoped dashboard bundle for the current Sales Consultant', () => {
    expect(migration).toContain('get_sales_consultant_dashboard');
    expect(migration).toContain("access_context->>'role_key' <> 'sales-consultant'");
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain("'metrics', jsonb_build_object");
    expect(migration).toContain("'schedule'");
    expect(migration).toContain("'pipeline'");
    expect(migration).toContain("'recent_leads'");
  });

  it('derives today from the dealership timezone and never hard-codes a calendar date', () => {
    expect(migration).toContain("target_timezone text default 'Asia/Kolkata'");
    expect(migration).toContain('local_today := timezone(target_timezone, now())::date');
    expect(api).toContain('local_date: z.string()');
    expect(workspace).not.toMatch(/23 May 2025/);
  });

  it('connects model thumbnails to private Tigris inventory files in the dashboard boundary', () => {
    expect(migration).toContain("file_row.resource_type = 'stock_unit'");
    expect(migration).toContain('image_object_file_id');
    expect(api).toContain("functions.invoke('sales-consultant-dashboard'");
    expect(dashboardHandler).toContain('.max(5)');
    expect(dashboardHandler).toContain(".from('object_files')");
    expect(dashboardHandler).toContain('tigrisClient()');
    expect(config).toContain('[functions.sales-consultant-dashboard]\nverify_jwt = true');
  });

  it('returns up to five live top models using scoped bookings, leads and inventory', () => {
    expect(topModelsMigration).toContain('get_sales_consultant_top_models');
    expect(topModelsMigration).toContain('app_private.can_access_record');
    expect(topModelsMigration).toContain('interest_counts');
    expect(topModelsMigration).toContain('current_bookings');
    expect(topModelsMigration).toContain('public.vehicle_models');
    expect(topModelsMigration).toContain('limit 3');
    expect(topFiveModelsMigration).toContain("E'\\n      limit 5\\n'");
    expect(dashboardHandler).not.toContain("client.rpc('get_sales_consultant_top_models'");
    expect(dashboardHandler).toContain("client.rpc('get_sales_consultant_dashboard_summary'");
    expect(dashboardHandler).toContain("client.rpc('get_sales_consultant_dashboard_live'");
    expect(workspace).toContain('models.slice(0, 5)');
  });

  it('caches only the scoped aggregate summary for 60 seconds', () => {
    const summaryFunction = hotPathMigration.slice(
      hotPathMigration.indexOf(
        'create or replace function public.get_sales_consultant_dashboard_summary',
      ),
      hotPathMigration.indexOf(
        'revoke all on function public.get_sales_consultant_dashboard_summary',
      ),
    );
    const summaryShape = dashboardHandler.slice(
      dashboardHandler.indexOf('const dashboardSummaryShape'),
      dashboardHandler.indexOf('const dashboardLiveShape'),
    );
    expect(cache).toContain("'sales-consultant-dashboard'");
    expect(dashboardHandler).toContain('enforceManualRefresh');
    expect(dashboardHandler).toContain("'MANUAL_REFRESH_LIMITED'");
    expect(dashboardHandler).toContain('readWorkspaceCache');
    expect(dashboardHandler).toContain('cache: cachedSummary.diagnostic');
    expect(api).toContain('cacheDiagnosticSchema');
    expect(api).toContain('cache: envelope.data.cache');
    expect(dashboardHandler).toContain('ttlSeconds: SALES_DASHBOARD_CACHE_TTL_SECONDS');
    expect(dashboardHandler).toContain('client.auth.getClaims(accessToken)');
    expect(dashboardHandler).toContain("client.rpc('get_workspace_bootstrap')");
    expect(dashboardHandler).toContain('user_id: userId');
    expect(dashboardHandler).toContain('organization_id: context.organization_id');
    expect(dashboardHandler).toContain('scope_key: context.scope_key');
    expect(dashboardHandler).not.toContain("target_resource_key: 'tenant-dashboard'");
    expect(summaryShape).not.toContain('schedule');
    expect(summaryShape).not.toContain('recent_leads');
    expect(summaryFunction).not.toContain("'schedule'");
    expect(summaryFunction).not.toContain("'recent_leads'");
    expect(summaryFunction).not.toContain('customer_name');
    expect(summaryFunction).not.toContain('lead_row.phone');
    expect(dashboardHandler.indexOf('const cachedSummary')).toBeLessThan(
      dashboardHandler.indexOf('const result = await attachInventoryImages'),
    );
  });

  it('keeps dashboard actions connected to the existing CRM workspaces', () => {
    for (const destination of [
      '/sales-consultant/my-leads',
      '/sales-consultant/follow-ups',
      '/sales-consultant/appointments',
      '/sales-consultant/test-drives',
      '/sales-consultant/quotations',
      '/sales-consultant/stock-check',
      '/sales-consultant/bookings',
      '/sales-consultant/tasks',
    ]) {
      expect(workspace).toContain(destination);
    }
  });
});
