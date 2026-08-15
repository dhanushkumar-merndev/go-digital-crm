import type { RoleKey } from '@/config/navigation/types';

const mobileLinkRoles: readonly RoleKey[] = ['telecaller', 'sales-consultant'];

export function canLinkMobileApp(role: RoleKey) {
  return mobileLinkRoles.includes(role);
}
