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
  | 'finance'
  | 'insurance'
  | 'rto'
  | 'exchange'
  | 'delivery'
  | 'customer-care'
  | 'digital-marketing';

export type NavItem = {
  title: string;
  slug: string;
  icon: string;
  optional?: boolean;
};

export type RoleNavigation = {
  label: string;
  shortLabel: string;
  scope: string;
  group: 'Sales' | 'Administration' | 'Platform' | 'Operations';
  items: NavItem[];
};
