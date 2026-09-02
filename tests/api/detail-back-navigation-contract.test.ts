import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const hook = read('src/lib/navigation/use-return-to-list.ts');
const leadDetail = read('src/features/leads/lead-detail-workspace.tsx');
const customer360 = read('src/features/customers/customer-360-workspace.tsx');

describe('back navigation from a detail page', () => {
  it('goes back through history so the list keeps its tab, page and filters', () => {
    // A link to the bare list href reopens it at the default tab and page one,
    // which is the state the user had already navigated away from.
    expect(hook).toContain('router.back()');
    expect(hook).toContain('window.history.length > 1');
  });

  it('falls back only when there is no in-app entry to return to', () => {
    // Detail page opened in a fresh tab, from a bookmark, or a shared link.
    expect(hook).toContain('router.replace(fallbackHref)');
    // replace, not push: the dead-end detail entry must not sit between the
    // list and wherever the user goes next.
    expect(hook).not.toContain('router.push(fallbackHref)');
  });

  it('is server-render safe', () => {
    expect(hook).toContain("typeof window !== 'undefined'");
  });

  it('is one implementation, used by both detail pages', () => {
    for (const file of [leadDetail, customer360])
      expect(file).toContain("from '@/lib/navigation/use-return-to-list'");
    expect(leadDetail).toContain('useReturnToList(roleLeadListHref(role))');
    expect(customer360).toContain('useReturnToList(`/${role}/customers`)');
    // The copy this replaced must be gone, or the two drift apart again.
    expect(customer360).not.toContain('if (window.history.length > 1) {');
  });

  it('no longer renders Back to leads as a plain link to the list', () => {
    expect(leadDetail).toContain('onClick={returnToLeads}');
    expect(leadDetail).not.toContain('<Link href={roleLeadListHref(role)}>');
  });
});
