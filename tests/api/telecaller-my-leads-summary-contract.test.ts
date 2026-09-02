import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leadStatusFilters } from '../../src/features/leads/lead-workspace-query';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');

const cards = workspace.slice(
  workspace.indexOf('function telecallerLeadMetricCards'),
  workspace.indexOf('function salesLeadMetricCards'),
);

describe('Telecaller My Leads summary cards', () => {
  it('reuses the Sales Consultant and Follow-ups card, rather than a second design', () => {
    // One card component across the three surfaces: a divergent copy is how the
    // three drift into looking like three different products.
    expect(workspace).toContain('<SalesLeadMetricCard');
    expect(cards).toContain('): SalesLeadMetricCard[] {');
  });

  it('shows the telecaller funnel and nothing borrowed from the sales queues', () => {
    for (const label of ['Total my leads', 'New', 'Pending', 'Contacted', 'Transferred to Sales'])
      expect(cards).toContain(`label: '${label}'`);
    // sales_new_today / sales_pending / sales_contacted are the consultant's
    // post-handoff queues and mean nothing on a telecaller's own list.
    for (const borrowed of ['sales_new_today', 'sales_pending', 'sales_contacted'])
      expect(cards).not.toContain(borrowed);
  });

  it('maps every card onto a status the telecaller tab strip actually has', () => {
    // A card filtering to a status with no matching tab leaves the strip with
    // nothing selected, so the page looks unfiltered while the table is not.
    const telecallerTabs = workspace.slice(
      workspace.indexOf('const telecallerTabs'),
      workspace.indexOf('const tabs ='),
    );
    const statuses = [...cards.matchAll(/status: '([a-z-]+)'/g)].map((m) => m[1]!);
    expect(statuses.length).toBe(5);
    for (const status of statuses) {
      expect(leadStatusFilters).toContain(status);
      expect(telecallerTabs).toContain(`value: '${status}'`);
    }
  });

  it('treats an empty Pending queue as the good state', () => {
    // Every other card reads "more is better"; Pending is uncalled work.
    expect(cards).toContain('good: kpis.pending === 0');
  });

  it('gates the strip to the two roles whose My Leads is a personal queue', () => {
    expect(workspace).toContain(
      "(role === 'sales-consultant' || role === 'telecaller') && slug === 'my-leads'",
    );
    // The region id is shared by both roles now, so it must not claim otherwise.
    expect(workspace).toContain('id="my-leads-summary-kpis"');
    expect(workspace).not.toContain('sales-consultant-lead-kpis');
  });
});
