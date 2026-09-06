export type RoleKey =
  | 'telecaller'
  | 'sales-consultant'
  | 'team-manager'
  | 'showroom-manager'
  | 'gm-sales'
  | 'client-admin'
  | 'system-administrator'
  | 'business-owner'
  | 'super-admin'
  | 'inventory'
  | 'inventory-executive'
  | 'finance'
  | 'insurance'
  | 'rto'
  | 'exchange'
  | 'delivery'
  | 'customer-care'
  // Executive tiers. The access gate maps a manager role_key to a short route
  // ('finance_manager' -> 'finance') but falls through to a dashed role_key for
  // anything else, so these keys must match `replace(role_key, '_', '-')`.
  | 'finance-executive'
  | 'insurance-executive'
  | 'rto-executive'
  | 'exchange-executive'
  | 'delivery-executive'
  | 'customer-relationship-executive'
  | 'digital-marketing';

export type NavigationCapability = 'users.manage.delegated';

export type NavItem = {
  title: string;
  slug: string;
  icon: string;
  optional?: boolean;
  requiredCapability?: NavigationCapability;
};

export type RoleNavigation = {
  label: string;
  shortLabel: string;
  scope: string;
  group: 'Sales' | 'Administration' | 'Platform' | 'Operations';
  items: NavItem[];
};
