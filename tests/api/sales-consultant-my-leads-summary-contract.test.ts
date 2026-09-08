import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
// The chevron itself now lives in one shared control, reused by Follow-ups,
// Tasks and every other list page, so the button markup is asserted there and
// the wiring is asserted here.
const toggle = readFileSync('src/components/domain/summary-toggle.tsx', 'utf8');

describe('Sales Consultant My Leads summary cards', () => {
  it('renders exactly five scoped lead metrics on My Leads', () => {
    const cardFactory = workspace.slice(
      workspace.indexOf('function salesLeadMetricCards'),
      workspace.indexOf('function SalesLeadMetricCard'),
    );
    for (const label of [
      'Total my leads',
      'New today',
      'Pending action',
      'Contacted',
      'Hot leads',
    ]) {
      expect(cardFactory).toContain(`label: '${label}'`);
    }
    expect(cardFactory.match(/status: '/g)).toHaveLength(5);
    expect(workspace).toContain("role === 'sales-consultant' && slug === 'my-leads'");
    expect(workspace).toContain('xl:grid-cols-5');
  });

  it('uses the existing server-scoped KPI bundle without another query', () => {
    expect(workspace).toContain('salesLeadMetricCards(workspace.data.kpis)');
    expect(workspace).toContain('value: kpis.sales_new_today');
    expect(workspace).toContain('value: kpis.sales_pending');
    expect(workspace).toContain('value: kpis.sales_contacted');
    expect(workspace).toContain('value: kpis.hot');
  });

  it('lets every card apply its matching server-side lead filter', () => {
    expect(workspace).toContain('onSelect={() => onStatusChange(card.status)}');
    expect(workspace).toContain("status: 'sales-new'");
    expect(workspace).toContain("status: 'sales-pending'");
    expect(workspace).toContain("status: 'sales-contacted'");
    expect(workspace).toContain("status: 'hot'");
  });

  it('can collapse and restore the KPI row to make more room for the lead table', () => {
    expect(workspace).toContain(
      'const [salesLeadMetricsOpen, setSalesLeadMetricsOpen] = useState(true);',
    );
    expect(workspace).toContain('setSalesLeadMetricsOpen((open) => !open)');
    // The grid is hidden with the `hidden` attribute, not a display class, so
    // it leaves the accessibility tree and tab order with the layout.
    expect(workspace).toContain('id="my-leads-summary-kpis"');
    expect(workspace).toContain('hidden={!salesLeadMetricsOpen}');
    expect(workspace).toContain('controls="my-leads-summary-kpis"');
    expect(toggle).toContain('aria-expanded={open}');
    expect(toggle).toContain('aria-controls={controls}');
    expect(toggle).toContain('<ChevronUp className="size-4" />');
    expect(toggle).toContain('<ChevronDown className="size-4" />');
  });

  it('places the summary chevron at the far-right of the lead status tabs row', () => {
    const statusTabs = workspace.slice(
      workspace.indexOf('function LeadStatusTabs'),
      workspace.indexOf('function leadCreateMessage'),
    );
    expect(statusTabs).toContain('className="flex h-10 border-b"');
    expect(statusTabs).toContain('<SummaryToggle');
    expect(statusTabs).toContain('onToggle={onSummaryToggle}');
    // Pushed to the right by the tablist taking the remaining width.
    expect(statusTabs).toContain('className="flex min-w-0 flex-1 gap-2 overflow-x-auto"');
    expect(toggle).toContain('className="flex shrink-0 items-center pl-2"');
    expect(toggle).toContain('className="size-7 rounded-full bg-background shadow-none"');
    expect(workspace).not.toContain('className="flex h-7 justify-end"');
  });
});
