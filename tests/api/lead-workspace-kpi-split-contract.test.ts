import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608250012_split_lead_workspace_kpis.sql',
  'utf8',
);
const api = readFileSync('src/features/leads/lead-workspace-api.ts', 'utf8');
const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');

describe('lead workspace counter split', () => {
  it('lets the caller ask for records and counters independently', () => {
    expect(migration).toContain('target_include_records boolean default true');
    expect(migration).toContain('target_include_kpis boolean default true');
  });

  it('drops the old signatures so the new defaults replace rather than overload', () => {
    // Widening a signature with trailing defaults registers a second function;
    // every existing call would then fail as ambiguous.
    expect(migration).toContain('drop function if exists public.get_lead_workspace_page_v2(');
    expect(migration).toContain(
      'drop function if exists app_private.get_sales_role_lead_workspace_page(',
    );
  });

  it('guards each scan with a constant so the planner skips it outright', () => {
    expect(migration).toContain('where target_include_records');
    expect(migration).toContain('where target_include_kpis');
    expect(migration).toContain("'kpis', case when target_include_kpis then");
  });

  it('keys the counters without the offset so paging reuses them', () => {
    expect(api).toContain('export type LeadMetaQuery = Omit<LeadQuery,');
    expect(api).toContain('export function toLeadMetaQuery');
    expect(workspace).toContain("queryKey: ['lead-workspace-meta', ...queryScope, metaQuery]");
    expect(workspace).toContain("queryKey: ['lead-workspace', ...queryScope, requestQuery]");
  });

  it('asks each half only for the part it owns', () => {
    expect(api).toContain('{ records: true, kpis: false }');
    expect(api).toContain('{ records: false, kpis: true }');
  });
});
