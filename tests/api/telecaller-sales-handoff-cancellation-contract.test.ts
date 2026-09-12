import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202609120001_cancel_telecaller_sales_handoff.sql',
  'utf8',
);
const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const workspaceApi = readFileSync('src/features/leads/lead-workspace-api.ts', 'utf8');
const dashboard = readFileSync('src/features/dashboards/telecaller-dashboard.tsx', 'utf8');

describe('Telecaller dashboard queue consistency', () => {
  it('routes the New dashboard card and My Leads tab to the same fresh queue', () => {
    expect(dashboard).toContain('href: `${leads}?status=new-today`');
    expect(workspace).toContain("{ label: 'New', value: 'new-today', count: data.kpis.new_today }");
    expect(workspace).toContain("status: 'new-today'");
  });

  it('uses the My Leads KPI source for dashboard totals and Contacted counts', () => {
    expect(dashboard).toContain('fetchLeadWorkspaceMeta');
    expect(dashboard).toContain('leadKpis?.total');
    expect(dashboard).toContain('leadKpis?.contacted_count');
  });

  it('uses the Follow-ups workspace KPI for overdue and due-today values', () => {
    expect(dashboard).toContain('fetchWorkWorkspace(');
    expect(dashboard).toContain("'followups'");
    expect(dashboard).toContain('followupKpis?.overdue');
    expect(dashboard).toContain('followupKpis?.today');
  });
});

describe('Telecaller sales handoff cancellation', () => {
  it('returns only the original Telecaller’s active transferred lead to Contacted', () => {
    expect(migration).toContain('create or replace function public.cancel_sales_handoff(');
    expect(migration).toContain("target_lead.lifecycle_status <> 'Transferred to Sales'");
    expect(migration).toContain('history_row.previous_owner_id = auth.uid()');
    expect(migration).toContain("set lifecycle_status = 'Contacted'");
    expect(migration).toContain("set_config('app.assign_lead_rpc', 'on', true)");
  });

  it('closes the Sales assignment and writes stage, assignment, activity, and audit history', () => {
    expect(migration).toContain('set active = false');
    expect(migration).toContain('insert into public.lead_assignments');
    expect(migration).toContain('insert into public.lead_assignment_history');
    expect(migration).toContain('insert into public.lead_stage_history');
    expect(migration).toContain("'SALES_HANDOFF_CANCELLED'");
    expect(migration).toContain("'lead.sales_handoff_cancelled'");
  });

  it('exposes a reasoned cancellation control only for a transferred read-only handoff', () => {
    expect(workspaceApi).toContain("rpc('cancel_sales_handoff'");
    expect(workspace).toContain('function SalesHandoffCancellationDialog');
    expect(workspace).toContain("row.original.lifecycle_status === 'Transferred to Sales'");
    expect(workspace).toContain('Cancel transfer');
  });
});
