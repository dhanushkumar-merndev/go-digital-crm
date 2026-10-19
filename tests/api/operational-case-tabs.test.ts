import { describe, expect, it } from 'vitest';
import { roleHasNavigationSlug, roleKeys } from '../../src/config/navigation';
import { legacyTabbedPageHref } from '../../src/config/navigation/legacy-redirects';
import {
  operationalCaseRoute,
  operationalCaseTabs,
} from '../../src/features/operations/operational-case-query';

const retired: Array<[string, string, string]> = [
  ['finance', 'pending-documents', '/finance/finance-cases?status=DOCUMENTS'],
  ['finance', 'applications', '/finance/finance-cases?status=APPLICATION_SUBMITTED'],
  ['finance', 'disbursement', '/finance/finance-cases?status=APPROVED'],
  [
    'finance-executive',
    'applications',
    '/finance-executive/finance-cases?status=APPLICATION_SUBMITTED',
  ],
  ['exchange', 'evaluations', '/exchange/exchange-requests?status=INSPECTION_SCHEDULED'],
  ['exchange', 'accepted-exchanges', '/exchange/exchange-requests?status=ACCEPTED'],
  [
    'exchange-executive',
    'evaluations',
    '/exchange-executive/exchange-requests?status=INSPECTION_SCHEDULED',
  ],
  ['delivery', 'delivery-planner', '/delivery/upcoming-deliveries?status=SCHEDULED'],
  ['delivery', 'pending-checklist', '/delivery/upcoming-deliveries?status=CHECKLIST_PENDING'],
  ['delivery', 'ready-for-delivery', '/delivery/upcoming-deliveries?status=READY'],
  ['delivery', 'delivered', '/delivery/upcoming-deliveries?status=DELIVERED'],
  ['delivery', 'delivery-photos', '/delivery/upcoming-deliveries?status=DELIVERED'],
  [
    'delivery-executive',
    'ready-for-delivery',
    '/delivery-executive/upcoming-deliveries?status=READY',
  ],
];

describe('operational desk queues are tabs of one case list', () => {
  it('redirects every retired queue page to its tab and drops it from the sidebar', () => {
    for (const [role, slug, href] of retired) {
      expect(legacyTabbedPageHref(role as never, slug)).toBe(href);
      expect(roleHasNavigationSlug(role, slug)).toBe(false);
    }
  });

  it('leaves live pages alone', () => {
    for (const [role, slug] of [
      ['finance', 'finance-cases'],
      ['finance', 'my-performance'],
      ['delivery', 'upcoming-deliveries'],
      ['sales-consultant', 'exchange'],
      ['delivery', 'feedback'],
    ])
      expect(legacyTabbedPageHref(role as never, slug)).toBeNull();
  });

  it('redirects only to a page that is still in the sidebar, with a status the desk has a tab for', () => {
    for (const role of roleKeys)
      for (const slug of ['pending-documents', 'evaluations', 'delivery-planner', 'delivered']) {
        const href = legacyTabbedPageHref(role, slug);
        if (!href) continue;
        const [path, search] = href.split('?');
        const target = path.split('/')[2];
        expect(roleHasNavigationSlug(role, target)).toBe(true);
        const route = operationalCaseRoute(role, target);
        const status = new URLSearchParams(search).get('status');
        expect(operationalCaseTabs[route!.department].map((tab) => tab.status)).toContain(status);
      }
  });
});
