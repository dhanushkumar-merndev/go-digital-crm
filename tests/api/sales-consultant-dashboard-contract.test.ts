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
    expect(dashboardHandler).toContain("client.rpc('get_sales_consultant_top_models'");
    expect(workspace).toContain('models.slice(0, 5)');
  });

  it('enforces the existing server-side manual refresh budget without caching customer PII', () => {
    expect(cache).toContain("'sales-consultant-dashboard'");
    expect(dashboardHandler).toContain('enforceManualRefresh');
    expect(dashboardHandler).toContain("'MANUAL_REFRESH_LIMITED'");
    expect(dashboardHandler).not.toContain('readWorkspaceCache');
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
