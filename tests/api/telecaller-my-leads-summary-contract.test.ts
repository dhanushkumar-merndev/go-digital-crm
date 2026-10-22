import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leadStatusFilters } from '../../src/features/leads/lead-workspace-query';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');

const cards = workspace.slice(
  workspace.indexOf('function leadMetricCards'),
  workspace.indexOf('function SalesLeadMetricCard'),
);

describe('My Leads summary cards (canonical Leads set)', () => {
  it('builds every role from one card factory and one card component', () => {
    // One factory and one card: separate per-role copies are how the labels
    // drifted to "Total my leads" / "Pending action" / "New leads".
    expect(workspace).toContain('<SalesLeadMetricCard');
    expect(cards).toContain('): SalesLeadMetricCard[] {');
    expect(workspace).not.toContain('function telecallerLeadMetricCards');
    expect(workspace).not.toContain('function salesLeadMetricCards');
    expect(workspace).not.toContain('function managerLeadMetricCards');
    expect(workspace).toContain('leadMetricCards(role, workspace.data.kpis)');
    expect(workspace).toContain('kpiGridColumns(6)');
  });

  it('shows the six canonical tiles in order with sentence-case labels', () => {
    const labels = [...cards.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels).toEqual([
      'Total leads',
      'New today',
      'Pending',
      'SLA risk',
      'Hot leads',
      'Follow-up',
    ]);
  });

  it('maps every tile onto a status the server filters by', () => {
    const statuses = [...cards.matchAll(/'([a-z-]+)'/g)]
      .map((m) => m[1]!)
      .filter((value) => (leadStatusFilters as readonly string[]).includes(value));
    for (const status of [
      'all',
      'new-today',
      'sales-new',
      'pending',
      'sales-pending',
      'sla-risk',
      'hot',
      'follow-up',
    ])
      expect(statuses).toContain(status);
  });

  it("measures a consultant's new and pending from the handoff, a telecaller's from the enquiry", () => {
    expect(cards).toContain('const newToday = sales ? kpis.sales_new_today : kpis.new_today;');
    expect(cards).toContain('const pending = sales ? kpis.sales_pending : kpis.pending;');
  });

  it('treats empty overdue queues as the good state', () => {
    expect(cards).toContain('good: pending === 0');
    expect(cards).toContain('good: kpis.sla_risk === 0');
  });

  it('gives a tile-only filter a tab while it is applied', () => {
    // A tile filtering to a queue with no permanent tab must not leave the
    // strip looking unfiltered while the table is filtered.
    const tabs = workspace.slice(
      workspace.indexOf('function transientLeadTabs'),
      workspace.indexOf('function leadCreateMessage'),
    );
    expect(tabs).toContain("{ label: 'SLA risk', value: 'sla-risk', count: kpis.sla_risk }");
    expect(tabs).toContain("{ label: 'Hot', value: 'hot', count: kpis.hot }");
    expect(tabs).toContain('tab.value === query.status && !roleTabs.some(');
  });

  it('gates the strip to the two roles whose My Leads is a personal queue', () => {
    expect(workspace).toContain(
      "(role === 'sales-consultant' || role === 'telecaller') && slug === 'my-leads'",
    );
    expect(workspace).toContain('id="my-leads-summary-kpis"');
  });
});
