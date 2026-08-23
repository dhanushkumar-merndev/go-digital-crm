import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220022_owner_ai_business_summary.sql');
const creditMigration = source(
  'supabase/migrations/202608220033_platform_ai_credit_allocations.sql',
);
const api = source('src/features/dashboards/owner-ai-business-summary-api.ts');
const workspace = source('src/features/dashboards/owner-ai-business-summary.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('owner AI business summary contract', () => {
  it('requires organization-wide owner credit viewing authority and accepts bounded periods', () => {
    expect(migration).toContain('create or replace function public.get_owner_ai_business_summary');
    expect(migration).toContain('target_days not in (7, 30, 90)');
    expect(migration).toContain('app_private.has_organization_wide_scope(current_organization_id)');
    expect(creditMigration).toContain(
      'create or replace function public.get_owner_ai_business_summary',
    );
    expect(creditMigration).toContain(
      "app_private.has_permission(current_organization_id, 'credit.view')",
    );
  });

  it('reports immutable recorded usage and summaries without synthesizing recommendations', () => {
    expect(migration).toContain("ledger_row.ledger_kind = 'AI'");
    expect(migration).toContain('public.ai_call_summaries');
    expect(migration).toContain('public.ai_extraction_runs');
    expect(migration).toContain('public.ai_field_reviews');
    expect(migration).not.toContain("'recommendations'");
  });

  it('validates RPC output, uses approved charts, and routes before the fallback', () => {
    expect(api).toContain("rpc('get_owner_ai_business_summary'");
    expect(api).toContain('const resultSchema');
    expect(workspace).toContain('kind="line"');
    expect(workspace).toContain('kind="donut"');
    expect(workspace).toContain('AI-credit viewing access');
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
    expect(route).toContain("role === 'business-owner' && slug[0] === 'ai-business-summary'");
    expect(route).toContain("role === 'client-admin' && slug[0] === 'ai-usage'");
    expect(route).toContain('<OwnerAiBusinessSummaryWorkspace audience="CLIENT_ADMIN" />');
    expect(workspace).toContain("audience?: 'OWNER' | 'CLIENT_ADMIN'");
    expect(workspace).toContain('AI Usage & Credits');
    expect(route.indexOf('return <OwnerAiBusinessSummaryWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
