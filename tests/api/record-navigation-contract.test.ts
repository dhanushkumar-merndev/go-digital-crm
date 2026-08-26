import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const helper = source('src/lib/navigation/record-links.ts');

/**
 * Workspaces whose rows are lead-scoped. Pressing one of these must open the
 * lead it belongs to, not the customer behind it: Customer 360 cannot say which
 * of a customer's leads the follow-up, call or quotation was for.
 */
const leadScopedWorkspaces = [
  'src/features/work/workspace.tsx',
  'src/features/work/appointment-workspace-view.tsx',
  'src/features/work/followup-calendar.tsx',
  'src/features/tasks/task-workspace.tsx',
  'src/features/test-drives/test-drive-workspace.tsx',
  'src/features/sales/sales-document-workspace.tsx',
  'src/features/calls/call-workspace.tsx',
];

describe('record navigation', () => {
  it('resolves the destination in one place', () => {
    expect(helper).toContain('export function recordDetailHref');
    expect(helper).toContain('export function customerDetailHref');
    expect(helper).toContain('export function leadDetailHref');
    // A lead wins over the customer, and a row with neither navigates nowhere
    // rather than to a broken path.
    expect(helper).toContain('if (record.lead_id) return');
    expect(helper).toContain('return null;');
  });

  it('sends lead-scoped rows to the lead page through the helper', () => {
    for (const path of leadScopedWorkspaces) {
      const workspace = source(path);
      expect(workspace, path).toContain('recordDetailHref');
      // No hand-rolled customer link left behind in a lead-scoped row.
      expect(workspace, path).not.toMatch(/href=\{`\/\$\{role\}\/customers\/\$\{row\.original\./);
    }
  });

  it('keeps the two identifiers pointing at their own pages', () => {
    const leads = source('src/features/leads/lead-workspace.tsx');
    // Lead ID opens the opportunity, the customer name opens the person.
    expect(leads).toContain('customerDetailHref(role, row.original.customer_id)');
    expect(leads).toContain('`/${role}/leads/${row.original.id}`');

    const customer360 = source('src/features/customers/customer-360-workspace.tsx');
    expect(customer360).toContain('leadDetailHref(role, data.current_opportunity.id)');
    expect(customer360).toContain("`/${role}/leads/${data.leads[rowIndex]?.id ?? ''}`");
  });

  it('opens a dashboard record by id rather than searching a filtered list', () => {
    const dashboard = source('src/features/dashboards/sales-consultant-dashboard.tsx');
    // Searching My Leads for a lead id made the destination depend on that
    // list's filters, pagination and visibility rules, so a lead the dashboard
    // had just shown could land on "no leads found".
    expect(dashboard).toContain('leadDetailHref(DASHBOARD_ROLE, item.lead_id)');
    expect(dashboard).toContain('leadDetailHref(DASHBOARD_ROLE, lead.id)');
    expect(dashboard).not.toContain('my-leads?q=${encodeURIComponent(item.lead_id)}');
    expect(dashboard).not.toContain('my-leads?q=${encodeURIComponent(lead.phone)}');
  });

  it('does not link to appointment filters the page rejects', () => {
    const dashboard = source('src/features/dashboards/sales-consultant-dashboard.tsx');
    const workQuery = source('src/features/work/workspace-query.ts');
    // Every appointment type the dashboard links to must still be a value the
    // Appointments filter accepts, or the link lands on an unfiltered list that
    // reads as missing data.
    for (const type of ['Showroom%20Visit', 'Video%20Call', 'Consultant%20Call']) {
      const decoded = decodeURIComponent(type);
      if (!dashboard.includes(`type=${type}`)) continue;
      expect(workQuery, decoded).toContain(`'${decoded}'`);
    }
    expect(dashboard).not.toContain('type=Test%20Drive');
  });

  it('never hardcodes a role into a detail link', () => {
    for (const path of [
      ...leadScopedWorkspaces,
      'src/features/operations/sales-exchange-workspace.tsx',
    ]) {
      expect(source(path), path).not.toContain('/sales-consultant/customers/');
    }
  });
});
