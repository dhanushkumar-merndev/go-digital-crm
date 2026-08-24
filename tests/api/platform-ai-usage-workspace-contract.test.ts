import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220017_platform_ai_usage_workspace.sql');
const activeDealershipFix = source(
  'supabase/migrations/202608240003_fix_platform_ai_credit_eligibility.sql',
);
const api = source('src/features/platform/platform-ai-usage-workspace-api.ts');
const workspace = source('src/features/platform/platform-ai-usage-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('platform AI usage workspace backend contract', () => {
  it('requires a Super Admin MFA session and validates bounded period/page inputs', () => {
    expect(migration).toContain(
      'create or replace function public.get_platform_ai_usage_workspace(',
    );
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain('target_days not in (7, 14, 30)');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
  });

  it('aggregates immutable AI credit-ledger entries without inventing a rate card', () => {
    expect(migration).toContain("ledger_row.ledger_kind = 'AI'");
    expect(migration).toContain("'used_period'");
    expect(migration).toContain("'remaining'");
    expect(migration).toContain("'allocated'");
    expect(migration).toContain("'average_daily_usage'");
    expect(migration).toContain("'features'");
    expect(migration).toContain("'organizations'");
    expect(migration).not.toContain('cost_per_credit');
  });

  it('uses a credit-ledger index and only grants authenticated execution', () => {
    expect(migration).toContain('credit_ledger_ai_created_org_idx');
    expect(migration).toContain(
      'revoke all on function public.get_platform_ai_usage_workspace(integer, integer, integer, text) from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.get_platform_ai_usage_workspace(integer, integer, integer, text) to authenticated',
    );
  });

  it('exposes lifecycle eligibility without hiding immutable dealership ledger history', () => {
    expect(activeDealershipFix).toContain(
      'create or replace function public.get_platform_ai_usage_workspace(',
    );
    expect(activeDealershipFix).toContain("'status', organization_row.status");
    expect(activeDealershipFix).toContain(
      "'credit_allocation_allowed', organization_row.status in ('ACTIVE', 'SUPPORT_MAINTENANCE')",
    );
    expect(activeDealershipFix).toContain('app_private.mfa_policy_satisfied(null)');
    expect(activeDealershipFix).toContain(
      'grant execute on function public.get_platform_ai_usage_workspace',
    );
  });
});

describe('platform AI usage workspace web contract', () => {
  it('validates the RPC response and scopes each query to period, page, and search', () => {
    expect(api).toContain('const resultSchema = z.object({');
    expect(api).toContain("rpc('get_platform_ai_usage_workspace'");
    expect(workspace).toContain('useDebouncedValue(searchInput, 300)');
    expect(workspace).toContain("['platform-ai-usage-workspace', days, page, search]");
    expect(api).toContain('credit_allocation_allowed: z.boolean()');
    expect(workspace).toContain('disabled={!organization.credit_allocation_allowed}');
  });

  it('uses approved ECharts and clearly avoids unrecorded cost estimates', () => {
    expect(workspace).toContain("from '@/components/charts/e-chart'");
    expect(workspace).toContain('kind="line"');
    expect(workspace).toContain('kind="donut"');
    expect(workspace).toMatch(/estimated\s+because no rate card is stored\./);
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
  });

  it('routes the real platform credit workspace before the unavailable fallback', () => {
    expect(route).toContain("role === 'super-admin' && slug[0] === 'credits-usage'");
    expect(route.indexOf('<PlatformAiUsageWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
