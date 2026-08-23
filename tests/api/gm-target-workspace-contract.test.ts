import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220041_gm_target_workspace.sql');
const api = source('src/features/dashboards/gm-target-api.ts');
const workspace = source('src/features/dashboards/gm-target-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('GM target workspace contract', () => {
  it('restricts a bounded monthly target view to the GM Sales Executive CRM context', () => {
    expect(migration).toContain('create or replace function public.get_gm_target_workspace(');
    expect(migration).toContain("access_context->>'role_key' <> 'gm-sales'");
    expect(migration).toContain("message = 'GM_TARGET_ACCESS_REQUIRED'");
    expect(migration).toContain("message = 'INVALID_GM_TARGET_MONTH'");
    expect(migration).toContain("target_timezone not in ('Asia/Kolkata', 'UTC')");
  });

  it('uses branch and record scope when reading live booking and test-drive outcomes', () => {
    expect(migration).toContain('accessible_branches as materialized');
    expect(migration).toContain('branch_targets as materialized');
    expect(migration).toContain('branch_bookings as materialized');
    expect(migration).toContain('branch_drives as materialized');
    expect(migration).toContain('app_private.can_access_branch(');
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain("'branches', coalesce(");
    expect(migration).toContain(
      'grant execute on function public.get_gm_target_workspace(date, text) to authenticated',
    );
  });

  it('validates the compact RPC result and renders with TanStack Query, shadcn, and ECharts', () => {
    expect(api).toContain("rpc('get_gm_target_workspace'");
    expect(api).toContain('return gmTargetSchema.parse(data)');
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@/components/charts/e-chart'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain('kind="bar"');
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
  });

  it('routes GM targets before the unavailable fallback', () => {
    expect(route).toContain("role === 'gm-sales' && slug[0] === 'targets'");
    expect(route.indexOf('<GmTargetWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
