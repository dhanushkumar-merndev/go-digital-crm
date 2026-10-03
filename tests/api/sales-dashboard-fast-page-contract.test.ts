import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610030003_sales_dashboard_fast_page.sql',
  'utf8',
);
const api = readFileSync('src/features/dashboards/sales-consultant-dashboard-api.ts', 'utf8');

describe('Sales Consultant dashboard fast read', () => {
  it('bundles the scoped summary, live rows and task count in one authenticated RPC', () => {
    expect(migration).toContain('get_sales_consultant_dashboard_summary(target_timezone)');
    expect(migration).toContain('get_sales_consultant_dashboard_live(target_timezone)');
    expect(migration).toContain('get_sales_consultant_task_due_count(target_timezone)');
    expect(migration).toContain("'TASKS_DUE'");
    expect(migration).toContain('security invoker');
    expect(migration).toContain('to authenticated');
  });

  it('uses PostgREST for ordinary reads and reserves Edge for explicit refresh', () => {
    expect(api).toContain("rpc('get_sales_consultant_dashboard_page'");
    expect(api).toContain('if (!options.manualRefresh)');
    expect(api).toContain("functions.invoke('sales-consultant-dashboard'");
    expect(api).toContain('body: { manual_refresh: true, response_version: 2 }');
  });
});
