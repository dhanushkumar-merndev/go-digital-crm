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
  'finance-executive': 'finance-executive@demo.go-digital.invalid',
  'insurance-executive': 'insurance-executive@demo.go-digital.invalid',
  'rto-executive': 'rto-executive@demo.go-digital.invalid',
  'exchange-executive': 'exchange-executive@demo.go-digital.invalid',
  'delivery-executive': 'delivery-executive@demo.go-digital.invalid',
  'customer-relationship-executive': 'customer-relationship-executive@demo.go-digital.invalid',
  'digital-marketing': 'digital-marketing-manager@demo.go-digital.invalid',
};

/**
 * The seeded demo dealerships (scripts/seed-demo-organizations.mjs). Every one
 * uses the same per-role address under its own domain; Super Admin is a single
 * platform account, so it always signs in with the Demo-org address.
 */
export const developmentDemoOrganizations = [
  {
    key: 'demo',
    label: 'Demo Motors',
    domain: 'demo.go-digital.invalid',
    state: 'Active · 4 showrooms',
  },
  {
    key: 'sapphire',
    label: 'Sapphire Hyundai',
    domain: 'sapphire.demo.go-digital.invalid',
    state: 'Active · 2 showrooms',
  },
  {
    key: 'pioneer',
    label: 'Pioneer Tata',
    domain: 'pioneer.demo.go-digital.invalid',
    state: 'Active · 1 showroom, small',
  },
  {
    key: 'royal',
    label: 'Royal Kia',
    domain: 'royal.demo.go-digital.invalid',
    state: 'Suspended',
  },
  {
    key: 'metro',
    label: 'Metro Mahindra',
    domain: 'metro.demo.go-digital.invalid',
    state: 'Onboarding under review',
    // Only the owner exists until Super Admin approves the dealership.
    roles: ['super-admin', 'business-owner'] as RoleKey[],
  },
] as const satisfies readonly {
  key: string;
  label: string;
  domain: string;
  state: string;
  roles?: RoleKey[];
}[];

export type DevelopmentDemoOrganizationKey = (typeof developmentDemoOrganizations)[number]['key'];

export const developmentDemoOrganizationKeys = developmentDemoOrganizations.map(
  (organization) => organization.key,
) as [DevelopmentDemoOrganizationKey, ...DevelopmentDemoOrganizationKey[]];

export function developmentDemoRoleEmail(
  role: RoleKey,
  organizationKey: DevelopmentDemoOrganizationKey = 'demo',
) {
  const email = developmentDemoRoleEmails[role];
  if (role === 'super-admin') return email;
  const organization = developmentDemoOrganizations.find((row) => row.key === organizationKey);
  return email.replace(
    '@demo.go-digital.invalid',
    `@${organization?.domain ?? 'demo.go-digital.invalid'}`,
  );
}
