import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const migration = source('supabase/migrations/202608220037_telecaller_activity_timeline.sql');
const api = source('src/features/dashboards/sales-consultant-activity-api.ts');
const timeline = source('src/features/dashboards/sales-consultant-activity-timeline.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('telecaller activity timeline contract', () => {
  it('uses a dedicated Telecaller role gate and remains strictly own-record scoped', () => {
    expect(migration).toContain('app_private.telecaller_activity_organization');
    expect(migration).toContain("access_context->>'role_key' <> 'telecaller'");
    expect(migration).toContain("role_row.role_key = 'telecaller_bdc'");
    expect(migration).toContain('lead_row.assigned_user_id = current_user_id');
    expect(migration).toContain('lead_row.branch_id = any(allowed_branch_ids)');
    expect(migration).toContain("when 'FOLLOW_UP' then 'followup.view' = any(permission_keys)");
    expect(migration).toContain("if 'followup.view' = any(permission_keys) then");
    expect(migration).toContain('and note_row.created_by = current_user_id');
    expect(migration).not.toContain('activities_telecaller_timeline_idx');
    expect(migration).toContain('target_page not between 1 and 100');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('revoke all on function public.get_telecaller_activity_timeline');
    expect(migration).toContain(
      'grant execute on function public.get_telecaller_activity_timeline',
    );
  });

  it('selects the role-specific RPC and preserves server-driven search and pagination', () => {
    expect(api).toContain("'get_telecaller_activity_timeline'");
    expect(api).toContain("type ActivityTimelineRole = 'sales-consultant' | 'telecaller'");
    expect(timeline).toContain('useDebouncedValue(query.search, 300)');
    expect(timeline).toContain('fetchSalesConsultantActivityTimeline(requestQuery, role, signal)');
    expect(timeline).toContain('const rolePath = `/${role}`');
  });

  it('exposes the real timeline only for sales consultants and Telecallers', () => {
    expect(route).toContain("(role === 'sales-consultant' || role === 'telecaller')");
    expect(route).toContain('<SalesConsultantActivityTimeline role={role} />');
  });
});
