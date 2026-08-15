import type { NavItem, NavigationCapability } from './types';

export const NAVIGATION_CAPABILITIES = {
  MANAGE_DELEGATED_USERS: 'users.manage.delegated',
} as const satisfies Record<string, NavigationCapability>;

export type NavigationAccess = {
  capabilities: readonly NavigationCapability[];
};

export const EMPTY_NAVIGATION_ACCESS: NavigationAccess = { capabilities: [] };

export function filterNavigationItems(
  items: readonly NavItem[],
  access: NavigationAccess = EMPTY_NAVIGATION_ACCESS,
) {
  const capabilities = new Set(access.capabilities);
  return items.filter(
    (item) => !item.requiredCapability || capabilities.has(item.requiredCapability),
  );
}
