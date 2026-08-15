import { describe, expect, it } from 'vitest';
import {
  filterNavigationItems,
  NAVIGATION_CAPABILITIES,
  roleNavigation,
} from '../../src/config/navigation';

describe('navigation capability filtering', () => {
  it.each(['showroom-manager', 'gm-sales'] as const)(
    'hides optional Users navigation for %s by default',
    (role) => {
      expect(
        filterNavigationItems(roleNavigation[role].items).map((item) => item.slug),
      ).not.toContain('users');
    },
  );

  it.each(['showroom-manager', 'gm-sales'] as const)(
    'shows optional Users navigation for %s with delegated-user capability',
    (role) => {
      expect(
        filterNavigationItems(roleNavigation[role].items, {
          capabilities: [NAVIGATION_CAPABILITIES.MANAGE_DELEGATED_USERS],
        }).map((item) => item.slug),
      ).toContain('users');
    },
  );

  it('does not hide ordinary navigation items', () => {
    expect(filterNavigationItems(roleNavigation.telecaller.items)).toHaveLength(
      roleNavigation.telecaller.items.length,
    );
    expect(
      filterNavigationItems(roleNavigation['client-admin'].items).map((item) => item.slug),
    ).toContain('users');
  });
});
