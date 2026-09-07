import { describe, expect, it } from 'vitest';
import { roleNavigation } from '../../src/config/navigation';
import { operationalCaseRoute } from '../../src/features/operations/operational-case-query';
import type { RoleKey } from '../../src/config/navigation/types';

/*
 * 202609060016 created six operations executives and gave each a navigation
 * menu, but the catch-all route knew nothing about them: every operational item
 * fell through to `ProductionDataUnavailable`, so the menu was a set of dead
 * ends. An executive works the same desk as its manager, so each of its menu
 * entries has to resolve to that manager's department.
 */

const executiveDesks: Array<[RoleKey, RoleKey]> = [
  ['finance-executive', 'finance'],
  ['insurance-executive', 'insurance'],
  ['rto-executive', 'rto'],
  ['exchange-executive', 'exchange'],
  ['delivery-executive', 'delivery'],
];

describe('operations executive routing', () => {
  it.each(executiveDesks)('%s reaches every page its menu offers', (executive) => {
    const items = roleNavigation[executive].items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(
        operationalCaseRoute(executive, item.slug),
        `${executive}/${item.slug}`,
      ).not.toBeNull();
    }
  });

  it.each(executiveDesks)('%s resolves the same desk as its manager', (executive, manager) => {
    for (const item of roleNavigation[executive].items) {
      expect(operationalCaseRoute(executive, item.slug)).toEqual(
        operationalCaseRoute(manager, item.slug),
      );
    }
  });

  it('does not widen any other role into an operational desk', () => {
    expect(operationalCaseRoute('telecaller', 'finance-cases')).toBeNull();
    expect(operationalCaseRoute('sales-consultant', 'disbursement')).toBeNull();
    expect(operationalCaseRoute('customer-relationship-executive', 'customer-cases')).toBeNull();
  });
});
