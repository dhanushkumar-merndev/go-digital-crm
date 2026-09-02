import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(path, 'utf8');
}

const customer = source('src/features/customers/customer-360-workspace.tsx');
const navigation = source('src/config/navigation/index.ts');
const leadList = source('src/features/leads/lead-workspace.tsx');
const leadDetail = source('src/features/leads/lead-detail-workspace.tsx');
const pageHeader = source('src/components/shared/page-header.tsx');
const report = source('src/features/reports/report-export-workspace.tsx');
const deliveryFeedback = source('src/features/delivery/delivery-feedback-workspace.tsx');
const sidebar = source('src/components/shared/app-sidebar.tsx');
const masterData = source('src/features/administration/master-data-workspace.tsx');
const notFound = source('src/app/not-found.tsx');

describe('production web action routing', () => {
  it('keeps Customer 360 header actions contextual instead of linking to absent role routes', () => {
    for (const tab of ['followups', 'test-drives', 'quotations', 'bookings']) {
      expect(customer).toContain(`selectCustomerTab('${tab}')`);
    }
    for (const slug of ['messages', 'follow-ups', 'test-drives', 'quotations', 'bookings']) {
      expect(customer).not.toContain(`<Link href={\`/\${role}/${slug}\`}`);
    }
    expect(customer).toContain('activeTab={activeTab}');
    expect(customer).toContain('onTabChange={selectCustomerTab}');
  });

  it('uses role-safe lead list and adjacent workspace links', () => {
    expect(navigation).toContain("'team-manager': 'team-leads'");
    expect(navigation).toContain("'showroom-manager': 'showroom-leads'");
    expect(navigation).toContain("'gm-sales': 'sales-leads'");
    // Back is history-driven now, so the role-safe list href is the fallback
    // passed to useReturnToList rather than a plain link target.
    expect(leadDetail).toContain('useReturnToList(roleLeadListHref(role))');
    expect(leadDetail).toContain("roleHasNavigationSlug(role, 'appointments')");
    expect(leadList).toContain("roleHasNavigationSlug(role, 'follow-ups')");
  });

  it('renders generic header actions only when a caller provides behavior', () => {
    expect(pageHeader).toContain('primaryActionHref?: string');
    expect(pageHeader).toContain('onPrimaryAction?: () => void');
    expect(pageHeader).toContain('spec.primaryAction && primaryActionHref');
    expect(report).toContain('primaryActionHref="#request-export"');
    expect(report).toContain('id="request-export"');
    expect(deliveryFeedback).toContain('primaryAction: undefined');
  });

  it('makes global help actionable and status labels non-interactive', () => {
    expect(sidebar).toContain('<DialogTrigger asChild>');
    expect(sidebar).toContain('<DialogTitle>Help & support</DialogTitle>');
    expect(masterData).toContain('<Badge variant="outline"');
    expect(masterData).not.toMatch(/<Button variant="outline">\s*<Filter \/> Server filtered/);
    expect(notFound).toContain('<Link href="/">Return to CRM</Link>');
  });
});
