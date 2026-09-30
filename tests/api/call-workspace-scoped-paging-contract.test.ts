import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260928150000_call_workspace_scoped_paging.sql'),
  'utf8',
);
const finalMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260928170000_call_workspace_scoped_paging_final.sql'),
  'utf8',
);

function functionBody(text: string) {
  const start = text.indexOf('app_private.get_scoped_call_workspace_page(\n  target_search text,');
  return text.slice(start, text.indexOf('$function$;', start));
}

describe('scoped call workspace paging', () => {
  it('ships the same function body in the follow-up that replaced the early draft', () => {
    expect(functionBody(migration).length).toBeGreaterThan(10_000);
    expect(functionBody(finalMigration)).toBe(functionBody(migration));
    expect(finalMigration).toContain(
      'create or replace function app_private.get_scoped_call_workspace_page(',
    );
  });

  it('stays private and is reached only through the public wrapper', () => {
    expect(migration).toContain('create function app_private.get_scoped_call_workspace_page(');
    expect(migration).toContain('security definer');
    expect(migration).toContain(
      'revoke all on function app_private.get_scoped_call_workspace_page(\n  text, integer, integer, text, text, text, text, text\n) from public, anon, authenticated;',
    );
  });

  it('patches only the non-Sales-Consultant branch of the deployed wrapper', () => {
    expect(migration).toContain(
      "'public.get_call_workspace_page(text,integer,integer,text,text,text,text,text)'",
    );
    expect(migration).toContain('legacy branch anchors not found exactly once');
    expect(migration).toContain("position('get_call_workspace_page_legacy' in def) > 0");
    expect(migration).toContain(
      "position('app_private.get_sales_consultant_call_workspace_page(' in def) = 0",
    );
  });

  it('keeps the legacy permission and record-scope rules', () => {
    expect(migration).toContain("app_private.has_permission(current_organization_id, 'call.view')");
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'customer.view')",
    );
    expect(migration).toContain("app_private.has_permission(current_organization_id, 'lead.view')");
    expect(migration).toContain('where app_private.can_access_record(');
    expect(migration).toContain(
      'app_private.can_access_customer(current_organization_id, customer_row.id)',
    );
  });

  it('reads only the calls the viewer assignments can reach', () => {
    expect(migration).toContain("assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')");
    expect(migration).toContain('call_row.branch_id = any(scope_branch_ids)');
    expect(migration).toContain('(own_records and call_row.assigned_user_id = current_user_id)');
    expect(migration).toContain('call_row.team_id = any(scope_team_ids)');
    expect(migration).not.toContain('get_call_workspace_page_legacy(\n');
  });

  it('applies the tabs and counts days in Asia/Kolkata', () => {
    for (const view of ["'TODAY'", "'MISSED'", "'RECORDINGS'", "'AI'"])
      expect(migration).toContain(`normalized_view = ${view}`);
    expect(migration).toContain("pg_catalog.timezone('Asia/Kolkata', now())::date");
    expect(migration).not.toContain("date_trunc('day', now())");
  });

  it('checks scope once per distinct branch, team and owner, never per call', () => {
    expect(migration).toContain('), candidate_scopes as materialized (');
    expect(migration).toContain(
      'from candidate_scopes scope_row\n      where app_private.can_access_record(',
    );
    expect(migration).toContain('), visible_party_lead_scopes as materialized (');
  });

  it('pages org-wide viewers by walking the started index instead of reading their scope', () => {
    expect(migration).toContain(
      'create index if not exists calls_org_started_page_idx\n  on public.calls (organization_id, started_at desc, id);',
    );
    expect(migration).toContain(
      'create index if not exists calls_org_branch_filter_idx\n  on public.calls (organization_id, branch_id, status, outcome, call_source, started_at);',
    );
    expect(migration).toContain(
      "windowed := broad_scope and normalized_search = '' and target_sort = 'started:desc'",
    );
    expect(migration).toContain(
      'app_private.can_access_record(current_organization_id, branch_row.id, null, null)',
    );
    expect(migration).toContain('from unnest(page_id_list) with ordinality page_id(id, ord)');
  });

  it('resolves parties for the whole filtered set only when searching or sorting by customer', () => {
    expect(migration).toContain(
      "needs_parties := normalized_search <> '' or target_sort in ('customer:asc', 'customer:desc');",
    );
    expect(migration).toContain('where needs_parties');
  });
});
