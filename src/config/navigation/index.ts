import { NAVIGATION_CAPABILITIES } from './access';
import type { NavItem, NavigationCapability, RoleKey, RoleNavigation } from './types';

type ItemDefinition = [string, string, string, NavigationCapability?];

const items = (definitions: Array<ItemDefinition | NavItem[]>) =>
  definitions.flatMap((definition): NavItem[] => {
    if (!isItemDefinition(definition)) return definition;
    const [title, slug, icon, requiredCapability] = definition;
    return [{ title, slug, icon, optional: Boolean(requiredCapability), requiredCapability }];
  });

function isItemDefinition(value: ItemDefinition | NavItem[]): value is ItemDefinition {
  return typeof value[0] === 'string';
}

// Consecutive items folded under one collapsible sidebar parent.
const group = (title: string, icon: string, definitions: ItemDefinition[]): NavItem[][] => [
  items(definitions).map((item) => ({ ...item, group: { title, icon } })),
];

export const roleNavigation: Record<RoleKey, RoleNavigation> = {
  telecaller: {
    label: 'Telecaller / BDC Executive',
    shortLabel: 'Telecaller',
    scope: 'Own records',
    group: 'Sales',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['My Leads', 'my-leads', 'Users'],
      ['Follow-ups', 'follow-ups', 'CalendarClock'],
      ['Tasks', 'tasks', 'ListTodo'],
      ['Activity Timeline', 'activity-timeline', 'History'],
      ['Calls', 'calls', 'Phone'],
      ['Inbox', 'messages', 'MessageCircleMore'],
      ['Reviews', 'reviews', 'Star'],
      ['Performance', 'performance', 'ChartNoAxesCombined'],
    ]),
  },
  'sales-consultant': {
    label: 'Sales Consultant',
    shortLabel: 'Sales Consultant',
    scope: 'Own records',
    group: 'Sales',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['My Leads', 'my-leads', 'Users'],
      ['Follow-ups', 'follow-ups', 'CalendarClock'],
      ['Tasks', 'tasks', 'ListTodo'],
      ['Activity Timeline', 'activity-timeline', 'History'],
      ['Calls', 'calls', 'Phone'],
      ['Inbox', 'messages', 'MessageCircleMore'],
      ['Appointments', 'appointments', 'CalendarDays'],
      ['Test Drives', 'test-drives', 'Route'],
      ['Competitor Compare', 'competitor-compare', 'GitCompareArrows'],
      ['Quotations', 'quotations', 'FileText'],
      ['Stock Check', 'stock-check', 'CarFront'],
      ['Exchange', 'exchange', 'Repeat2'],
      ['Bookings', 'bookings', 'BadgeIndianRupee'],
      ['Reviews', 'reviews', 'Star'],
      ['Performance', 'performance', 'ChartNoAxesCombined'],
    ]),
  },
  'team-manager': {
    label: 'Team Manager',
    shortLabel: 'Team Manager',
    scope: 'Own team',
    group: 'Sales',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ...group('Leads', 'Users', [
        ['Team Leads', 'team-leads', 'Users'],
        ['Duplicate Approvals', 'duplicate-leads', 'BadgeCheck'],
        ['Lead Assignment', 'lead-assignment', 'UserRoundCheck'],
        ['Lost Leads', 'lost-leads', 'CircleOff'],
      ]),
      ...group('Activity', 'CalendarClock', [
        ['Follow-ups', 'follow-ups', 'CalendarClock'],
        ['Team Calls', 'team-calls', 'PhoneCall'],
        ['Team Activity', 'team-activity', 'History'],
        ['Appointments', 'appointments', 'CalendarDays'],
        ['Test Drives', 'test-drives', 'Route'],
      ]),
      ...group('Sales', 'BadgeIndianRupee', [
        ['Quotations', 'quotations', 'FileText'],
        ['Bookings', 'bookings', 'BadgeIndianRupee'],
      ]),
      ['Team Performance', 'team-performance', 'ChartNoAxesCombined'],
      ['Escalations', 'escalations', 'TriangleAlert'],
      ['Reports', 'reports', 'FileChartColumn'],
    ]),
  },
  'showroom-manager': {
    label: 'Sales Manager',
    shortLabel: 'Sales Manager',
    scope: 'MG Road Branch',
    group: 'Sales',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ...group('Leads', 'Users', [
        ['Showroom Leads', 'showroom-leads', 'Users'],
        ['Lead Assignment', 'lead-assignment', 'UserRoundCheck'],
        ['Lost Leads', 'lost-leads', 'CircleOff'],
      ]),
      ...group('Activity', 'CalendarClock', [
        ['Follow-ups', 'follow-ups', 'CalendarClock'],
        ['Team Calls', 'team-calls', 'PhoneCall'],
        ['Appointments', 'appointments', 'CalendarDays'],
        ['Test Drives', 'test-drives', 'Route'],
      ]),
      ...group('Sales', 'BadgeIndianRupee', [
        ['Quotations', 'quotations', 'FileText'],
        ['Bookings', 'bookings', 'BadgeIndianRupee'],
        ['Approvals', 'approvals', 'BadgeCheck'],
      ]),
      ...group('Team', 'UsersRound', [
        ['Sales Teams', 'sales-teams', 'UsersRound'],
        ['Showroom Targets', 'showroom-targets', 'Goal'],
        ['Performance', 'performance', 'ChartNoAxesCombined'],
      ]),
      ['Escalations', 'escalations', 'TriangleAlert'],
      ['Reports', 'reports', 'FileChartColumn'],
      ['Users', 'users', 'UserCog', NAVIGATION_CAPABILITIES.MANAGE_DELEGATED_USERS],
    ]),
  },
  'gm-sales': {
    label: 'GM Sales Executive',
    shortLabel: 'GM Sales',
    scope: 'All branches',
    group: 'Sales',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ...group('Analytics', 'ChartNoAxesCombined', [
        ['Sales Analytics', 'sales-performance', 'ChartNoAxesCombined'],
        ['Lead Source Performance', 'lead-source-performance', 'Waypoints'],
      ]),
      ...group('Sales', 'BadgeIndianRupee', [
        ['Sales Leads', 'sales-leads', 'Users'],
        ['Bookings Overview', 'bookings-overview', 'BadgeIndianRupee'],
        ['Lost Leads', 'lost-leads', 'CircleOff'],
      ]),
      ...group('Management', 'Goal', [
        ['Targets', 'targets', 'Goal'],
        ['Approvals', 'approvals', 'BadgeCheck'],
        ['Escalations', 'escalations', 'TriangleAlert'],
      ]),
      ['Reports', 'reports', 'FileChartColumn'],
      ['Users', 'users', 'UserCog', NAVIGATION_CAPABILITIES.MANAGE_DELEGATED_USERS],
    ]),
  },
  'client-admin': {
    label: 'Client Admin',
    shortLabel: 'Client Admin',
    scope: 'Organization',
    group: 'Administration',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Branch Performance', 'branch-performance', 'ChartNoAxesCombined'],
      ...group('Organization', 'Building2', [
        ['Branches', 'branches', 'Building2'],
        ['Teams', 'teams', 'UsersRound'],
        ['Users', 'users', 'UserCog'],
        ['Roles & Permissions', 'roles-permissions', 'ShieldCheck'],
      ]),
      ...group('Sales Setup', 'SlidersHorizontal', [
        ['Lead & Assignment Settings', 'lead-assignment-settings', 'SlidersHorizontal'],
        ['Targets & Approval Rules', 'targets-approval-rules', 'Goal'],
        ['CRM Configuration', 'crm-configuration', 'Settings2'],
        ['Custom Fields', 'custom-fields', 'Rows3'],
      ]),
      ...group('Competitors', 'GitCompareArrows', [
        ['Competitor Catalog', 'competitor-catalog', 'GitCompareArrows'],
        ['Competitor Compare', 'competitor-compare', 'GitCompareArrows'],
      ]),
      ...group('Platform', 'Cable', [
        ['Integrations', 'integrations', 'Cable'],
        ['Modules & Access', 'modules-access', 'Blocks'],
        ['AI & Usage', 'ai-usage', 'BrainCircuit'],
      ]),
      ...group('Governance', 'ScrollText', [
        ['Company & Compliance', 'company-compliance', 'Landmark'],
        ['Audit Logs', 'audit-logs', 'ScrollText'],
      ]),
      ['Reports', 'reports', 'FileChartColumn'],
    ]),
  },
  'system-administrator': {
    label: 'System Administrator',
    shortLabel: 'System Admin',
    scope: 'Selected branches',
    group: 'Administration',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ...group('Access', 'ShieldCheck', [
        ['Users', 'users', 'UserCog'],
        ['Roles & Permissions', 'roles-permissions', 'ShieldCheck'],
        ['Branches & Access', 'branches-access', 'Building2'],
        ['Security', 'security', 'LockKeyhole'],
      ]),
      ...group('Configuration', 'Settings2', [
        ['Master Data', 'master-data', 'Database'],
        ['Templates', 'templates', 'PanelsTopLeft'],
        ['Automation Rules', 'automation-rules', 'Workflow'],
        ['Alerts & Notifications', 'alerts-notifications', 'BellRing'],
      ]),
      ['Integrations', 'integrations', 'Cable'],
      ...group('Monitoring', 'Activity', [
        ['System Health', 'system-health', 'Activity'],
        ['Audit Logs', 'audit-logs', 'ScrollText'],
        ['Backup & Data Management', 'backup-data', 'ArchiveRestore'],
      ]),
      ['Reports', 'reports', 'FileChartColumn'],
    ]),
  },
  'business-owner': {
    label: 'Business Owner',
    shortLabel: 'Business Owner',
    scope: 'Organization',
    group: 'Administration',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ...group('Performance', 'ChartNoAxesCombined', [
        ['Sales Overview', 'sales-overview', 'ChartNoAxesCombined'],
        ['Showroom Performance', 'showroom-performance', 'Building2'],
        ['Operations Overview', 'operations-overview', 'PanelsTopLeft'],
        ['Bookings & Delivery', 'bookings-delivery', 'BadgeIndianRupee'],
      ]),
      ...group('Insights', 'Sparkles', [
        ['AI Business Summary', 'ai-business-summary', 'BrainCircuit'],
        ['Competitor Compare', 'competitor-compare', 'GitCompareArrows'],
      ]),
      ...group('Administration', 'UserCog', [
        ['Client Admins', 'client-admins', 'UserCog'],
        ['Company & Compliance', 'company-compliance', 'Landmark'],
        ['Credits & Usage', 'credits-usage', 'Coins'],
        ['Support & Maintenance', 'support-maintenance', 'LifeBuoy'],
        ['Security & Access', 'security-access', 'LockKeyhole'],
      ]),
      ['Reports', 'reports', 'FileChartColumn'],
    ]),
  },
  'super-admin': {
    label: 'Super Admin',
    shortLabel: 'Super Admin',
    scope: 'Platform',
    group: 'Platform',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ...group('Tenants', 'Building2', [
        ['Dealerships', 'dealerships', 'Building2'],
        ['Onboarding Reviews', 'onboarding-reviews', 'ClipboardCheck'],
        ['Business Owners', 'business-owners', 'UserRoundCheck'],
      ]),
      ...group('Commercial', 'Coins', [
        ['Plans & Features', 'plans-features', 'PanelsTopLeft'],
        ['Modules & Entitlements', 'modules-entitlements', 'Blocks'],
        ['Credits & Usage', 'credits-usage', 'Coins'],
      ]),
      ...group('Operations', 'LifeBuoy', [
        ['Integrations & Providers', 'integrations-providers', 'Cable'],
        ['Support Sessions', 'support-sessions', 'LifeBuoy'],
        ['Platform Health', 'platform-health', 'Activity'],
      ]),
      ...group('Governance', 'LockKeyhole', [
        ['Users & Access', 'users-access', 'UserCog'],
        ['Security', 'security', 'LockKeyhole'],
        ['Audit Logs', 'audit-logs', 'ScrollText'],
        ['Data Retention & Deletion', 'data-retention', 'ArchiveX'],
      ]),
      ['Reports', 'reports', 'FileChartColumn'],
    ]),
  },
  inventory: {
    label: 'Inventory Manager',
    shortLabel: 'Inventory',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Vehicle Inventory', 'vehicle-inventory', 'CarFront'],
      ['Stock Allocation', 'stock-allocation', 'PackageCheck'],
      ['Stock Ageing', 'stock-ageing', 'History'],
      ['Stock Transfer', 'stock-transfer', 'ArrowLeftRight'],
      ['Accessories', 'accessories', 'Package'],
      ['Reports', 'reports', 'FileChartColumn'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'inventory-executive': {
    label: 'Inventory Executive',
    shortLabel: 'Inventory Executive',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Vehicle Inventory', 'vehicle-inventory', 'CarFront'],
      ['Stock Allocation', 'stock-allocation', 'PackageCheck'],
      ['Stock Ageing', 'stock-ageing', 'History'],
      ['Stock Movement', 'stock-transfer', 'ArrowLeftRight'],
      ['Accessories', 'accessories', 'Package'],
    ]),
  },
  finance: {
    label: 'Finance Manager',
    shortLabel: 'Finance',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Finance Cases', 'finance-cases', 'Landmark'],
      ['Reports', 'reports', 'FileChartColumn'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  insurance: {
    label: 'Insurance Manager',
    shortLabel: 'Insurance',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Insurance Cases', 'insurance-cases', 'ShieldCheck'],
      ['Reports', 'reports', 'FileChartColumn'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  rto: {
    label: 'RTO Manager',
    shortLabel: 'RTO',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['RTO Cases', 'rto-cases', 'Stamp'],
      ['Reports', 'reports', 'FileChartColumn'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  exchange: {
    label: 'Used Car / Exchange Manager',
    shortLabel: 'Exchange',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Exchange Requests', 'exchange-requests', 'Repeat2'],
      ['Reports', 'reports', 'FileChartColumn'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  delivery: {
    label: 'Delivery Manager',
    shortLabel: 'Delivery',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Deliveries', 'upcoming-deliveries', 'CalendarDays'],
      ['Feedback', 'feedback', 'MessageSquareMore'],
      ['Reports', 'reports', 'FileChartColumn'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'finance-executive': {
    label: 'Finance Executive',
    shortLabel: 'Finance Exec',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Finance Cases', 'finance-cases', 'Banknote'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'insurance-executive': {
    label: 'Insurance Executive',
    shortLabel: 'Insurance Exec',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Insurance Cases', 'insurance-cases', 'ShieldCheck'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'rto-executive': {
    label: 'RTO Executive',
    shortLabel: 'RTO Exec',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['RTO Cases', 'rto-cases', 'FileBadge'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'exchange-executive': {
    label: 'Used Car / Exchange Executive',
    shortLabel: 'Exchange Exec',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Exchange Requests', 'exchange-requests', 'ArrowLeftRight'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'delivery-executive': {
    label: 'Delivery Executive',
    shortLabel: 'Delivery Exec',
    scope: 'MG Road Branch',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Deliveries', 'upcoming-deliveries', 'CalendarDays'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'customer-relationship-executive': {
    label: 'Customer Relationship Executive',
    shortLabel: 'CRE',
    scope: 'Selected branches',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Customer Cases', 'customer-cases', 'MessagesSquare'],
      ['Follow-ups', 'follow-ups', 'CalendarClock'],
      ['Feedback', 'feedback', 'MessageSquareMore'],
      ['Complaints & Escalations', 'complaints-escalations', 'TriangleAlert'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'customer-care': {
    label: 'Customer Relationship Manager',
    shortLabel: 'Customer Care',
    scope: 'Selected branches',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Customer Cases', 'customer-cases', 'MessagesSquare'],
      ['Follow-ups', 'follow-ups', 'CalendarClock'],
      ['Feedback', 'feedback', 'MessageSquareMore'],
      ['Reviews', 'reviews', 'Star'],
      ['Complaints & Escalations', 'complaints-escalations', 'TriangleAlert'],
      ['Reports', 'reports', 'FileChartColumn'],
      ['My Performance', 'my-performance', 'ChartNoAxesCombined'],
    ]),
  },
  'digital-marketing': {
    label: 'Digital Marketing Manager',
    shortLabel: 'Marketing',
    scope: 'Organization',
    group: 'Operations',
    items: items([
      ['Dashboard', 'dashboard', 'LayoutDashboard'],
      ['Lead Sources', 'lead-sources', 'Waypoints'],
      ...group('Campaigns', 'Megaphone', [
        ['Meta / Ad Campaigns', 'campaigns', 'Megaphone'],
        ['Drip Campaigns', 'drip-campaigns', 'ListRestart'],
        ['Automations', 'automations', 'Workflow'],
      ]),
      ['Social Posts', 'social-posts', 'Send'],
      ['Bulk Campaigns', 'bulk-campaigns', 'Megaphone'],
      ['Asset Library', 'asset-library', 'Images'],
      ['Reviews', 'reviews', 'Star'],
      ['AI Content / Image', 'ai-content-image', 'BrainCircuit'],
      ['Performance', 'performance', 'ChartNoAxesCombined'],
      ['Reports', 'reports', 'FileChartColumn'],
    ]),
  },
};

export const roleKeys = Object.keys(roleNavigation) as RoleKey[];

const leadListSlugs: Partial<Record<RoleKey, string>> = {
  telecaller: 'my-leads',
  'sales-consultant': 'my-leads',
  'team-manager': 'team-leads',
  'showroom-manager': 'showroom-leads',
  'gm-sales': 'sales-leads',
};

export function isRoleKey(value: string): value is RoleKey {
  return value in roleNavigation;
}

export function roleHasNavigationSlug(role: string, slug: string) {
  return isRoleKey(role) && roleNavigation[role].items.some((item) => item.slug === slug);
}

export function roleLeadListHref(role: string) {
  if (!isRoleKey(role)) return '/';
  const slug = leadListSlugs[role];
  return slug ? `/${role}/${slug}` : `/${role}/dashboard`;
}

export { EMPTY_NAVIGATION_ACCESS, filterNavigationItems, NAVIGATION_CAPABILITIES } from './access';
export type { NavigationAccess } from './access';
export type { NavigationCapability } from './types';
