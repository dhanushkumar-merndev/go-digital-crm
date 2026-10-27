import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202610240203_showroom_performance.sql');
const performanceApi = source('src/features/dashboards/team-manager-performance-api.ts');
const performance = source('src/features/dashboards/team-manager-performance.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');
const approvals = source('src/features/sales/manager-approvals-workspace.tsx');
const salesDocumentApi = source('src/features/sales/sales-document-api.ts');

function functionBody(header: string) {
  const start = migration.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  const next = migration.toLowerCase().indexOf('create or replace function', start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

const perf = functionBody('CREATE OR REPLACE FUNCTION public.get_team_manager_performance(');
const target = functionBody('CREATE OR REPLACE FUNCTION public.get_showroom_target_workspace(');
const summary = functionBody('create or replace function public.get_quotation_approval_summary(');

describe('showroom performance migration', () => {
  it('runs as one transaction and replaces the two-argument signature', () => {
    expect(migration).toContain('\nbegin;\n');
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
    expect(migration).toContain(
      'drop function public.get_team_manager_performance(integer, text);',
    );
    expect(migration).toContain(
      'revoke all on function public.get_team_manager_performance(integer, text, uuid) from public, anon;',
    );
  });

  it('serves a Sales Manager over the teams in branches they can open', () => {
    expect(perf).toContain("not in ('team-manager', 'showroom-manager')");
    expect(perf).toContain(
      'app_private.can_access_branch(current_organization_id, team_row.branch_id)',
    );
    // A Team Manager still reads only the teams they manage.
    expect(perf).toContain('else team_row.manager_id = current_user_id end');
    expect(perf).toContain('app_private.can_access_team(current_organization_id, team_row.id)');
  });

  it("checks a chosen branch against the caller's own teams", () => {
    expect(perf).toContain('target_branch_id uuid DEFAULT NULL::uuid');
    expect(perf).toContain("message = 'TEAM_PERFORMANCE_BRANCH_DENIED'");
    expect(perf).toContain('team_row.id = any(scoped_team_ids)');
    expect(perf).toContain("'branches', branch_options");
  });

  it("adds each member's team and the leads reaching qualification", () => {
    expect(perf).toContain("'team_name', member_row.team_name");
    expect(perf).toContain("'qualified', member_row.qualified");
    expect(perf).toContain("'qualified', total_row.qualified");
    expect(perf).toContain("history_row.to_status in ('Qualified', 'Transferred to Sales')");
  });

  it('lists only consultants against the showroom sales target', () => {
    expect(target).toContain("and member_row.member_type = 'SALES_CONSULTANT'");
    expect(target).not.toContain("member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')");
  });
});

describe('quotation approval summary', () => {
  it('is authenticated, permission-gated and scope-once', () => {
    expect(summary).toContain("message = 'AUTHENTICATION_REQUIRED'");
    expect(summary).toContain("message = 'QUOTATION_VIEW_PERMISSION_REQUIRED'");
    expect(summary).toContain("message = 'INVALID_TIMEZONE'");
    expect(summary).toContain('app_private.resolve_permission_record_scope(');
    expect(summary).not.toContain('can_access_record(');
    expect(summary).toContain(
      'revoke all on function public.get_quotation_approval_summary(text) from public, anon;',
    );
    expect(summary).toContain(
      'grant execute on function public.get_quotation_approval_summary(text) to authenticated;',
    );
  });

  it("counts the whole pending queue and today's decisions", () => {
    for (const key of [
      "'pending'",
      "'waiting_over_day'",
      "'approved_today'",
      "'rejected_today'",
      "'discount_requested'",
    ])
      expect(summary).toContain(key);
    expect(summary).toContain("scoped_row.status = 'PENDING_APPROVAL'");
  });
});

describe('client wiring', () => {
  it('routes Sales Manager Performance to the showroom preset', () => {
    expect(route).toContain(
      '<TeamManagerPerformance spec={spec} preset="SHOWROOM" showHandoffs />',
    );
    expect(performance).toContain('allLabel="All branches"');
    expect(performance).toContain('funnelNarrows(funnel)');
    expect(performanceApi).toContain('target_branch_id: branchId');
    expect(performanceApi).toContain('qualified: z.coerce.number().int().nonnegative().optional()');
  });

  it('reads the Approvals tiles from the summary, not the visible page', () => {
    expect(salesDocumentApi).toContain("rpc('get_quotation_approval_summary'");
    expect(approvals).toContain('fetchQuotationApprovalSummary');
    expect(approvals).not.toContain('Value on this page');
  });
});
