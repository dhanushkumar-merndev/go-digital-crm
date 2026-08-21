import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608210002_sales_consultant_activity_timeline.sql',
  'utf8',
);
const api = readFileSync('src/features/dashboards/sales-consultant-activity-api.ts', 'utf8');
const workspace = readFileSync(
  'src/features/dashboards/sales-consultant-activity-timeline.tsx',
  'utf8',
);
const route = readFileSync('src/app/[role]/[[...slug]]/page.tsx', 'utf8');

describe('sales consultant activity timeline contract', () => {
  it('keeps the activity feed server-paginated and limited to the consultant’s assigned leads', () => {
    expect(migration).toContain('get_sales_consultant_activity_timeline');
    expect(migration).toContain('lead_row.assigned_user_id = auth.uid()');
    expect(migration).toContain('app_private.can_access_lead');
    expect(migration).toContain(
      'limit target_page_size offset (target_page - 1) * target_page_size',
    );
    expect(migration).toContain("target_sort not in ('latest:desc', 'oldest:asc')");
  });

  it('returns only operational summaries and connects the UI to its RPC', () => {
    expect(migration).toContain("'upcoming_followups'");
    expect(migration).toContain("'recent_notes'");
    expect(migration).toContain("'summary', jsonb_build_object");
    expect(api).toContain("rpc('get_sales_consultant_activity_timeline'");
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).toContain('useTenantRealtimeInvalidation');
  });

  it('routes only Sales Consultant Tasks to the activity timeline instead of the generic task table', () => {
    expect(route).toContain("role === 'sales-consultant'");
    expect(route).toContain('<SalesConsultantActivityTimeline />');
  });
});
