export type DataScope =
  | 'OWN_RECORDS'
  | 'OWN_TEAM'
  | 'ONE_BRANCH'
  | 'SELECTED_BRANCHES'
  | 'ALL_BRANCHES'
  | 'ORGANIZATION'
  | 'PLATFORM';
export type LeadLifecycle =
  'New' | 'Contacted' | 'Qualified' | 'Appointment Scheduled' | 'Transferred to Sales' | 'Lost';
export type LeadWorkState = 'NEW_TODAY' | 'PENDING' | 'SLA_RISK';
export type TenantStatus =
  | 'ONBOARDING'
  | 'UNDER_REVIEW'
  | 'CHANGES_REQUIRED'
  | 'ACTIVE'
  | 'SUPPORT_MAINTENANCE'
  | 'SUSPENDED'
  | 'REJECTED'
  | 'SOFT_DELETED';

export type Metric = {
  label: string;
  value: string;
  change?: string;
  trend?: 'up' | 'down' | 'neutral';
  helper?: string;
};

export type PageColumn = {
  key: string;
  label: string;
  status?: boolean;
  numeric?: boolean;
};

export type ChartKind = 'line' | 'bar' | 'donut' | 'funnel';

export type PageSpec = {
  title: string;
  description: string;
  category: string;
  access: string;
  readOnly: boolean;
  primaryAction?: string;
  metrics: Metric[];
  columns: PageColumn[];
  chart?: { kind: ChartKind; title: string; description: string };
  attention?: Array<{ title: string; detail: string; severity: 'high' | 'medium' | 'low' }>;
};

export type PageRow = Record<string, string | number> & { id: string };

export type PageQuery = {
  page: number;
  pageSize: 25 | 50 | 100;
  search: string;
  status: string;
  sort: string;
};

export type PageResult = {
  rows: PageRow[];
  total: number;
  chart: Array<{ name: string; value: number; secondary?: number }>;
};
