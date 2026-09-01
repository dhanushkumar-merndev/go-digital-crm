import type { RoleKey } from '@/config/navigation/types';

export const DEVELOPMENT_DEMO_ROLE_LOGIN_PATH = '/api/development/demo-role-login';

export const developmentDemoMfaRoles = new Set<RoleKey>([
  'super-admin',
  'business-owner',
  'client-admin',
  'system-administrator',
  'gm-sales',
]);

// The seed script creates exactly one account per role using these stable,
// non-production addresses. The shared demo password stays server-only.
export const developmentDemoRoleEmails: Record<RoleKey, string> = {
  telecaller: 'telecaller-bdc@demo.go-digital.invalid',
  'sales-consultant': 'sales-consultant@demo.go-digital.invalid',
  'team-manager': 'team-manager@demo.go-digital.invalid',
  'showroom-manager': 'showroom-manager@demo.go-digital.invalid',
  'gm-sales': 'gm-sales@demo.go-digital.invalid',
  'client-admin': 'client-admin@demo.go-digital.invalid',
  'system-administrator': 'system-administrator@demo.go-digital.invalid',
  'business-owner': 'business-owner@demo.go-digital.invalid',
  'super-admin': 'super-admin@demo.go-digital.invalid',
  inventory: 'inventory-manager@demo.go-digital.invalid',
  'inventory-executive': 'inventory-executive@demo.go-digital.invalid',
  finance: 'finance-manager@demo.go-digital.invalid',
  insurance: 'insurance-manager@demo.go-digital.invalid',
  rto: 'rto-manager@demo.go-digital.invalid',
  exchange: 'exchange-manager@demo.go-digital.invalid',
  delivery: 'delivery-manager@demo.go-digital.invalid',
  'customer-care': 'customer-relationship-manager@demo.go-digital.invalid',
  'digital-marketing': 'digital-marketing-manager@demo.go-digital.invalid',
};
