import type { LeadWorkState } from '@/lib/domain';

export const leadPageSizes = [25, 50, 100] as const;
export type LeadPageSize = (typeof leadPageSizes)[number];

export const leadStatusFilters = [
  'all',
  'new',
  'contacted',
  'qualified',
  'appointment-scheduled',
  'transferred-to-sales',
  'lost',
  'new-today',
  'pending',
  'sla-risk',
] as const;
export type LeadStatusFilter = (typeof leadStatusFilters)[number];

export const leadSortOptions = {
  'updated:desc': { column: 'updated_at', ascending: false },
  'updated:asc': { column: 'updated_at', ascending: true },
  'created:desc': { column: 'created_at', ascending: false },
  'created:asc': { column: 'created_at', ascending: true },
  'customer:asc': { column: 'customer_name', ascending: true },
  'customer:desc': { column: 'customer_name', ascending: false },
} as const;
export type LeadSort = keyof typeof leadSortOptions;

export type LeadQuery = {
  page: number;
  pageSize: LeadPageSize;
  search: string;
  status: LeadStatusFilter;
  sort: LeadSort;
};

export const defaultLeadQuery: LeadQuery = {
  page: 1,
  pageSize: 25,
  search: '',
  status: 'all',
  sort: 'updated:desc',
};

const lifecycleFilters = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  'appointment-scheduled': 'Appointment Scheduled',
  'transferred-to-sales': 'Transferred to Sales',
  lost: 'Lost',
} as const;

const workStateFilters = {
  'new-today': 'NEW_TODAY',
  pending: 'PENDING',
  'sla-risk': 'SLA_RISK',
} as const satisfies Record<string, LeadWorkState>;

export function getLeadStatusConstraint(
  status: LeadStatusFilter,
):
  | { column: 'lifecycle_status'; value: (typeof lifecycleFilters)[keyof typeof lifecycleFilters] }
  | { column: 'work_state'; value: LeadWorkState }
  | undefined {
  if (status in lifecycleFilters)
    return {
      column: 'lifecycle_status',
      value: lifecycleFilters[status as keyof typeof lifecycleFilters],
    };
  if (status in workStateFilters)
    return {
      column: 'work_state',
      value: workStateFilters[status as keyof typeof workStateFilters],
    };
  return undefined;
}

export function parseLeadQuery(
  params: URLSearchParams,
  fallbackStatus: LeadStatusFilter = 'all',
): LeadQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const sort = params.get('sort');

  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: leadPageSizes.includes(pageSize as LeadPageSize) ? (pageSize as LeadPageSize) : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: leadStatusFilters.includes(status as LeadStatusFilter)
      ? (status as LeadStatusFilter)
      : fallbackStatus,
    sort: Object.hasOwn(leadSortOptions, sort ?? '') ? (sort as LeadSort) : 'updated:desc',
  };
}

export function getDefaultLeadStatus(slug: string): LeadStatusFilter {
  if (slug === 'new-leads') return 'new';
  if (slug === 'lost-leads') return 'lost';
  return 'all';
}

export function toLeadQueryString(query: LeadQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'all') params.set('status', query.status);
  if (query.sort !== 'updated:desc') params.set('sort', query.sort);
  return params.toString();
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class LeadVersionConflictError extends Error {
  constructor() {
    super('LEAD_VERSION_CONFLICT');
    this.name = 'LeadVersionConflictError';
  }
}

export function isLeadVersionConflict(error: unknown) {
  return (
    error instanceof LeadVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        (error as { message?: string }).message === 'LEAD_VERSION_CONFLICT'))
  );
}

export function toPostgrestSearchTerm(value: string) {
  // PostgREST's OR grammar treats punctuation as syntax. The supported lead search
  // keys (UUID, customer name and normalized phone) do not need those characters,
  // so remove them before a value reaches the filter expression.
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s+@-]/gu, '')
    .trim();
}
