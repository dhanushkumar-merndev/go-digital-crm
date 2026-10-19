import { legacyOperationalCaseHref } from '../../features/operations/operational-case-query';
import type { RoleKey } from './types';

const gmAnalyticsViews = new Set([
  'showroom-comparison',
  'consultant-ranking',
  'model-performance',
]);

/**
 * Sidebar pages that became tabs of another page. Returns the tab's URL for an
 * old slug, or null when the slug is still a page of its own.
 */
export function legacyTabbedPageHref(role: RoleKey, slug: string) {
  if (role === 'gm-sales' && gmAnalyticsViews.has(slug))
    return `/gm-sales/sales-performance?view=${slug}`;
  return legacyOperationalCaseHref(role, slug);
}
