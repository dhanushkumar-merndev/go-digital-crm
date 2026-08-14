import type { PageColumn, PageSpec } from '@/lib/domain';
import { roleNavigation } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';

const columns = (...definitions: Array<[string, string, boolean?]>): PageColumn[] =>
  definitions.map(([key, label, status]) => ({ key, label, status }));

const salesMetrics = [
  {
    label: 'Active leads',
    value: '248',
    change: '+12.4%',
    trend: 'up' as const,
    helper: 'vs last period',
  },
  {
    label: 'Qualified',
    value: '86',
    change: '+8.2%',
    trend: 'up' as const,
    helper: '34.7% conversion',
  },
  {
    label: 'Test drives',
    value: '42',
    change: '+5.0%',
    trend: 'up' as const,
    helper: '8 scheduled today',
  },
  {
    label: 'Bookings',
    value: '27',
    change: '+3.6%',
    trend: 'up' as const,
    helper: '₹2.18 Cr value',
  },
];

const pageFamily = (slug: string) => {
  if (slug === 'dashboard' || slug.endsWith('-overview')) return 'dashboard';
  if (slug.includes('lead') && !slug.includes('source') && !slug.includes('assignment'))
    return 'leads';
  if (slug.includes('assignment')) return 'assignment';
  if (slug.includes('follow-up')) return 'followups';
  if (slug.includes('call')) return 'calls';
  if (slug.includes('appointment')) return 'appointments';
  if (slug.includes('test-drive')) return 'test-drives';
  if (slug.includes('quotation')) return 'quotations';
  if (slug.includes('booking') || slug.includes('deliver')) return 'bookings';
  if (slug.includes('performance') || slug.includes('ranking') || slug.includes('comparison'))
    return 'performance';
  if (slug.includes('report')) return 'reports';
  if (slug.includes('user') || slug.includes('owner') || slug.includes('client-admin'))
    return 'users';
  if (slug.includes('role') || slug.includes('access') || slug === 'security') return 'access';
  if (slug.includes('integration') || slug.includes('provider')) return 'integrations';
  if (slug.includes('audit')) return 'audit';
  if (slug.includes('target') || slug.includes('approval')) return 'approvals';
  if (slug.includes('branch') || slug.includes('dealership')) return 'branches';
  if (slug.includes('team')) return 'teams';
  if (slug.includes('stock') || slug.includes('vehicle-inventory')) return 'stock';
  if (slug.includes('case') || slug.includes('application') || slug.includes('document'))
    return 'cases';
  if (slug.includes('credit') || slug.includes('ai-usage')) return 'credits';
  if (slug.includes('support') || slug.includes('maintenance')) return 'support';
  if (slug.includes('health')) return 'health';
  if (slug.includes('campaign') || slug.includes('social') || slug.includes('source'))
    return 'marketing';
  return 'configuration';
};

const familyConfig: Record<
  string,
  Pick<PageSpec, 'description' | 'columns' | 'metrics' | 'chart' | 'primaryAction'>
> = {
  dashboard: {
    description: 'Monitor priorities, pipeline movement and the work that needs attention today.',
    columns: columns(
      ['customer', 'Customer'],
      ['reference', 'Lead / Case'],
      ['owner', 'Owner'],
      ['stage', 'Stage', true],
      ['nextAction', 'Next action'],
      ['updated', 'Updated'],
    ),
    metrics: salesMetrics,
    chart: {
      kind: 'funnel',
      title: 'Sales pipeline',
      description: 'Lead conversion across the active lifecycle',
    },
  },
  leads: {
    description: 'Review and progress customer opportunities within your authorized data scope.',
    columns: columns(
      ['reference', 'Lead ID'],
      ['customer', 'Customer'],
      ['phone', 'Phone'],
      ['source', 'Source'],
      ['model', 'Interested model'],
      ['owner', 'Assigned to'],
      ['workState', 'Work state', true],
      ['stage', 'Lifecycle', true],
      ['updated', 'Last activity'],
    ),
    metrics: [
      { label: 'New today', value: '38', change: '+6', trend: 'up' },
      { label: 'Pending', value: '21', helper: 'Uncontacted ≥24h' },
      { label: 'SLA risk', value: '7', trend: 'down', helper: 'Needs immediate action' },
      { label: 'Qualified', value: '86', change: '34.7%', trend: 'up' },
    ],
    chart: {
      kind: 'funnel',
      title: 'Lead lifecycle',
      description: 'Current in-scope opportunity distribution',
    },
    primaryAction: 'Add lead',
  },
  assignment: {
    description: 'Route fresh and qualified leads using the configured team assignment mode.',
    columns: columns(
      ['reference', 'Lead ID'],
      ['customer', 'Customer'],
      ['queue', 'Queue'],
      ['branch', 'Branch'],
      ['team', 'Team'],
      ['owner', 'Assigned to'],
      ['method', 'Method', true],
      ['updated', 'Assigned at'],
    ),
    metrics: [
      { label: 'Unassigned', value: '16' },
      { label: 'Fresh queue', value: '9' },
      { label: 'Qualified queue', value: '7' },
      { label: 'Assigned today', value: '43', change: '+11%', trend: 'up' },
    ],
    chart: {
      kind: 'bar',
      title: 'Team workload',
      description: 'Open leads by eligible team member',
    },
    primaryAction: 'Assign leads',
  },
  followups: {
    description: 'Keep every promised customer follow-up visible and on time.',
    columns: columns(
      ['customer', 'Customer'],
      ['reference', 'Lead ID'],
      ['reason', 'Reason'],
      ['scheduled', 'Scheduled'],
      ['owner', 'Owner'],
      ['priority', 'Priority', true],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Due today', value: '18' },
      { label: 'Overdue', value: '6', trend: 'down' },
      { label: 'Upcoming', value: '27' },
      { label: 'Completed today', value: '31', change: '+14%', trend: 'up' },
    ],
    primaryAction: 'Schedule follow-up',
  },
  calls: {
    description: 'Track call outcomes, recording availability and customer contact performance.',
    columns: columns(
      ['customer', 'Customer'],
      ['phone', 'Phone'],
      ['direction', 'Direction', true],
      ['duration', 'Duration'],
      ['outcome', 'Outcome', true],
      ['owner', 'Agent'],
      ['recording', 'Recording', true],
      ['updated', 'Called at'],
    ),
    metrics: [
      { label: 'Calls today', value: '124', change: '+18%', trend: 'up' },
      { label: 'Connected', value: '76' },
      { label: 'Avg. duration', value: '03:42' },
      { label: 'Recordings synced', value: '68', helper: '8 pending' },
    ],
    chart: {
      kind: 'line',
      title: 'Call activity',
      description: 'Connected and attempted calls over seven days',
    },
    primaryAction: 'Log call',
  },
  appointments: {
    description: 'Coordinate customer visits and keep attendance outcomes current.',
    columns: columns(
      ['customer', 'Customer'],
      ['reference', 'Lead ID'],
      ['appointmentType', 'Type'],
      ['scheduled', 'Date & time'],
      ['branch', 'Branch'],
      ['owner', 'Owner'],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Today', value: '12' },
      { label: 'Upcoming', value: '28' },
      { label: 'Awaiting confirmation', value: '5' },
      { label: 'Attendance', value: '78%', change: '+4%', trend: 'up' },
    ],
    primaryAction: 'New appointment',
  },
  'test-drives': {
    description:
      'Schedule test drives, monitor active sessions and review completed route summaries.',
    columns: columns(
      ['customer', 'Customer'],
      ['model', 'Vehicle'],
      ['registration', 'Registration'],
      ['scheduled', 'Scheduled'],
      ['owner', 'Consultant'],
      ['route', 'Route'],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Scheduled', value: '18' },
      { label: 'Active now', value: '3' },
      { label: 'Completed', value: '42' },
      { label: 'Feedback received', value: '36' },
    ],
    chart: {
      kind: 'bar',
      title: 'Test-drive outcomes',
      description: 'Completed drives and booking conversions',
    },
    primaryAction: 'Create test drive',
  },
  quotations: {
    description: 'Prepare and progress versioned quotations with controlled approvals.',
    columns: columns(
      ['reference', 'Quotation'],
      ['customer', 'Customer'],
      ['model', 'Vehicle'],
      ['amount', 'Amount'],
      ['version', 'Version'],
      ['owner', 'Consultant'],
      ['stage', 'Status', true],
      ['updated', 'Updated'],
    ),
    metrics: [
      { label: 'Open', value: '31' },
      { label: 'Sent', value: '24' },
      { label: 'Approval required', value: '6' },
      { label: 'Converted', value: '18', change: '+9%', trend: 'up' },
    ],
    primaryAction: 'Create quotation',
  },
  bookings: {
    description: 'Track confirmed business and the customer handoff through delivery.',
    columns: columns(
      ['reference', 'Booking ID'],
      ['customer', 'Customer'],
      ['model', 'Vehicle'],
      ['amount', 'Booking value'],
      ['branch', 'Branch'],
      ['owner', 'Consultant'],
      ['stage', 'Status', true],
      ['scheduled', 'Expected date'],
    ),
    metrics: [
      { label: 'Bookings', value: '27' },
      { label: 'Value', value: '₹2.18 Cr', change: '+12%', trend: 'up' },
      { label: 'Awaiting allocation', value: '8' },
      { label: 'Delivery this week', value: '14' },
    ],
    chart: {
      kind: 'line',
      title: 'Booking trend',
      description: 'Confirmed bookings over the selected period',
    },
  },
  performance: {
    description: 'Compare activity, conversion and target attainment for the selected scope.',
    columns: columns(
      ['owner', 'Team member / branch'],
      ['leads', 'Leads'],
      ['qualified', 'Qualified'],
      ['testDrives', 'Test drives'],
      ['bookings', 'Bookings'],
      ['conversion', 'Conversion'],
      ['target', 'Target', true],
    ),
    metrics: salesMetrics,
    chart: {
      kind: 'bar',
      title: 'Target vs actual',
      description: 'Performance against the current target period',
    },
  },
  reports: {
    description: 'Run scope-aware business reports and request auditable private exports.',
    columns: columns(
      ['report', 'Report'],
      ['category', 'Category'],
      ['period', 'Period'],
      ['owner', 'Requested by'],
      ['updated', 'Generated'],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Saved reports', value: '14' },
      { label: 'Generated this month', value: '38' },
      { label: 'Scheduled', value: '6' },
      { label: 'Processing', value: '2' },
    ],
    chart: {
      kind: 'line',
      title: 'Business trend',
      description: 'Selected report metric across the period',
    },
    primaryAction: 'Generate report',
  },
  users: {
    description: 'Manage users only within the role and data-scope delegation ceiling.',
    columns: columns(
      ['owner', 'User'],
      ['email', 'Email'],
      ['employeeId', 'Employee ID'],
      ['role', 'Role'],
      ['branch', 'Branch scope'],
      ['mfa', 'MFA', true],
      ['stage', 'Status', true],
      ['updated', 'Last active'],
    ),
    metrics: [
      { label: 'Active users', value: '126' },
      { label: 'Invited', value: '8' },
      { label: 'MFA enabled', value: '54' },
      { label: 'Suspended', value: '3' },
    ],
    primaryAction: 'Create user',
  },
  access: {
    description:
      'Configure role permissions independently from branch and record-level data scope.',
    columns: columns(
      ['role', 'Role'],
      ['module', 'Module'],
      ['permissions', 'Permissions'],
      ['scope', 'Maximum scope'],
      ['members', 'Users'],
      ['updated', 'Updated'],
    ),
    metrics: [
      { label: 'Roles', value: '18' },
      { label: 'Permissions', value: '94' },
      { label: 'Custom roles', value: '4' },
      { label: 'Policy warnings', value: '2' },
    ],
    primaryAction: 'Create role',
  },
  integrations: {
    description: 'Manage tenant-isolated provider connections, health and branch mappings.',
    columns: columns(
      ['provider', 'Provider'],
      ['connection', 'Connection'],
      ['scope', 'Branch scope'],
      ['lastSync', 'Last sync'],
      ['records', 'Records'],
      ['health', 'Health', true],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Connected', value: '9' },
      { label: 'Healthy', value: '7' },
      { label: 'Needs attention', value: '2' },
      { label: 'Events today', value: '1,482' },
    ],
    chart: {
      kind: 'line',
      title: 'Integration health',
      description: 'Successful and failed provider events',
    },
    primaryAction: 'Connect provider',
  },
  audit: {
    description: 'Review immutable privileged and business-critical activity within scope.',
    columns: columns(
      ['updated', 'Timestamp'],
      ['owner', 'Actor'],
      ['action', 'Action'],
      ['resource', 'Resource'],
      ['branch', 'Scope'],
      ['reference', 'Reference'],
      ['stage', 'Result', true],
    ),
    metrics: [
      { label: 'Events today', value: '1,286' },
      { label: 'Privileged actions', value: '43' },
      { label: 'Security events', value: '8' },
      { label: 'Failed actions', value: '3' },
    ],
  },
  approvals: {
    description: 'Manage configurable targets and approval requests within your authority limit.',
    columns: columns(
      ['reference', 'Request'],
      ['category', 'Type'],
      ['customer', 'Resource'],
      ['owner', 'Requested by'],
      ['amount', 'Requested value'],
      ['approver', 'Current approver'],
      ['stage', 'Status', true],
      ['updated', 'Submitted'],
    ),
    metrics: [
      { label: 'Pending', value: '12' },
      { label: 'Due today', value: '5' },
      { label: 'Approved this month', value: '47' },
      { label: 'Avg. turnaround', value: '3.2h' },
    ],
  },
  branches: {
    description:
      'Review organization structure, branch status and authorized operational coverage.',
    columns: columns(
      ['branch', 'Branch / Dealership'],
      ['code', 'Code'],
      ['location', 'Location'],
      ['owner', 'Manager / Owner'],
      ['teams', 'Teams'],
      ['members', 'Users'],
      ['stage', 'Status', true],
      ['updated', 'Updated'],
    ),
    metrics: [
      { label: 'Active', value: '6' },
      { label: 'Teams', value: '18' },
      { label: 'Users', value: '126' },
      { label: 'Needs attention', value: '2' },
    ],
    primaryAction: 'Create branch',
  },
  teams: {
    description: 'Manage team membership, assignment mode and workload within branch scope.',
    columns: columns(
      ['team', 'Team'],
      ['branch', 'Branch'],
      ['owner', 'Team manager'],
      ['members', 'Members'],
      ['method', 'Assignment mode', true],
      ['workload', 'Open workload'],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Active teams', value: '18' },
      { label: 'Telecallers', value: '32' },
      { label: 'Consultants', value: '48' },
      { label: 'Unassigned seats', value: '4' },
    ],
    primaryAction: 'Create team',
  },
  stock: {
    description: 'Control physical vehicle stock, allocations, ageing and branch movements.',
    columns: columns(
      ['vin', 'VIN / Chassis'],
      ['model', 'Model & variant'],
      ['color', 'Color'],
      ['branch', 'Branch'],
      ['age', 'Age'],
      ['allocation', 'Allocation'],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'In stock', value: '184' },
      { label: 'Available', value: '121' },
      { label: 'Allocated', value: '48' },
      { label: 'Ageing >60 days', value: '15' },
    ],
    chart: { kind: 'bar', title: 'Stock by model', description: 'Available and allocated units' },
    primaryAction: 'Add stock unit',
  },
  cases: {
    description: 'Progress department cases using the shared booking-linked workflow.',
    columns: columns(
      ['reference', 'Case ID'],
      ['booking', 'Booking ID'],
      ['customer', 'Customer'],
      ['model', 'Vehicle'],
      ['owner', 'Assigned to'],
      ['documents', 'Documents'],
      ['stage', 'Status', true],
      ['updated', 'Updated'],
    ),
    metrics: [
      { label: 'Open cases', value: '42' },
      { label: 'Pending documents', value: '11' },
      { label: 'Due today', value: '8' },
      { label: 'Completed this month', value: '76' },
    ],
    primaryAction: 'Create case',
  },
  credits: {
    description: 'Monitor append-only AI and tracking credit allocations and consumption.',
    columns: columns(
      ['updated', 'Timestamp'],
      ['category', 'Ledger'],
      ['action', 'Transaction'],
      ['amount', 'Amount'],
      ['feature', 'Feature'],
      ['owner', 'Actor'],
      ['reference', 'Reference'],
    ),
    metrics: [
      { label: 'AI balance', value: '18,450' },
      { label: 'Tracking balance', value: '4,820' },
      { label: 'Used this month', value: '2,684' },
      { label: 'Forecast', value: '72 days' },
    ],
    chart: {
      kind: 'donut',
      title: 'Usage by feature',
      description: 'Credit consumption composition',
    },
  },
  support: {
    description: 'Request and control explicit, time-limited, fully audited support access.',
    columns: columns(
      ['reference', 'Session'],
      ['branch', 'Dealership'],
      ['owner', 'Requested by'],
      ['approver', 'Approved by'],
      ['purpose', 'Purpose'],
      ['expires', 'Expires'],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Active sessions', value: '1' },
      { label: 'Pending requests', value: '3' },
      { label: 'Expiring soon', value: '1' },
      { label: 'Sessions this month', value: '14' },
    ],
    primaryAction: 'Request support',
  },
  health: {
    description:
      'Monitor service, background job and provider health without exposing sensitive payloads.',
    columns: columns(
      ['service', 'Service'],
      ['health', 'Health', true],
      ['latency', 'Latency'],
      ['errors', 'Errors'],
      ['lastCheck', 'Last check'],
      ['reference', 'Reference'],
    ),
    metrics: [
      { label: 'Services healthy', value: '12 / 13' },
      { label: 'Success rate', value: '99.94%' },
      { label: 'Queued jobs', value: '18' },
      { label: 'Open incidents', value: '1' },
    ],
    chart: {
      kind: 'line',
      title: 'Platform reliability',
      description: 'Success rate and latency trend',
    },
  },
  marketing: {
    description: 'Measure canonical lead sources and campaign outcomes within authorized scope.',
    columns: columns(
      ['campaign', 'Source / Campaign'],
      ['provider', 'Provider'],
      ['branch', 'Branch scope'],
      ['leads', 'Leads'],
      ['qualified', 'Qualified'],
      ['bookings', 'Bookings'],
      ['spend', 'Spend'],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Active campaigns', value: '14' },
      { label: 'Leads', value: '684' },
      { label: 'Cost / lead', value: '₹842' },
      { label: 'Bookings', value: '52' },
    ],
    chart: {
      kind: 'bar',
      title: 'Source performance',
      description: 'Leads and bookings by canonical source',
    },
    primaryAction: 'Create campaign',
  },
  configuration: {
    description: 'Configure this CRM capability using tenant-safe, auditable settings.',
    columns: columns(
      ['category', 'Configuration'],
      ['name', 'Name'],
      ['scope', 'Scope'],
      ['value', 'Current value'],
      ['owner', 'Updated by'],
      ['updated', 'Updated'],
      ['stage', 'Status', true],
    ),
    metrics: [
      { label: 'Active', value: '24' },
      { label: 'Draft', value: '3' },
      { label: 'Needs review', value: '2' },
      { label: 'Updated this month', value: '11' },
    ],
    primaryAction: 'Add configuration',
  },
};

const readOnlyRoles: RoleKey[] = ['gm-sales', 'business-owner'];

export function getPageSpec(role: RoleKey, slug: string): PageSpec | null {
  const item = roleNavigation[role].items.find((candidate) => candidate.slug === slug);
  if (!item) return null;
  const category = pageFamily(slug);
  const config = familyConfig[category];
  const readOnly =
    readOnlyRoles.includes(role) &&
    !['approvals', 'targets', 'client-admins', 'support-maintenance'].includes(slug);
  const attention =
    slug === 'dashboard'
      ? [
          {
            title: '7 leads are at SLA risk',
            detail: 'Uncontacted leads beyond the configured response SLA',
            severity: 'high' as const,
          },
          {
            title: '5 follow-ups are overdue',
            detail: 'Customer commitments that need action today',
            severity: 'medium' as const,
          },
          {
            title: '2 provider connections need attention',
            detail: 'Review sanitized integration error references',
            severity: 'low' as const,
          },
        ]
      : undefined;
  return {
    ...config,
    title: item.title,
    category,
    access: `${roleNavigation[role].label} · ${roleNavigation[role].scope}`,
    readOnly,
    primaryAction: readOnly ? undefined : config.primaryAction,
    attention,
  };
}
