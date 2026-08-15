import type { RoleKey } from '@/config/navigation/types';

export const operationalCaseDepartments = [
  'FINANCE',
  'INSURANCE',
  'RTO',
  'EXCHANGE',
  'DELIVERY',
] as const;
export type OperationalCaseDepartment = (typeof operationalCaseDepartments)[number];

export const operationalCaseStatuses: Record<OperationalCaseDepartment, readonly string[]> = {
  FINANCE: [
    'DOCUMENTS_PENDING',
    'APPLICATION_SUBMITTED',
    'UNDER_REVIEW',
    'APPROVED',
    'DISBURSED',
    'REJECTED',
    'CANCELLED',
  ],
  INSURANCE: ['QUOTE_PENDING', 'QUOTE_SHARED', 'CUSTOMER_ACCEPTED', 'POLICY_ISSUED', 'CANCELLED'],
  RTO: ['NEW', 'DOCUMENTS_PENDING', 'SUBMITTED', 'IN_PROCESS', 'REGISTERED', 'CANCELLED'],
  EXCHANGE: [
    'REQUESTED',
    'INSPECTION_SCHEDULED',
    'EVALUATED',
    'OFFERED',
    'ACCEPTED',
    'REJECTED',
    'CANCELLED',
  ],
  DELIVERY: ['PLANNING', 'CHECKLIST_PENDING', 'READY', 'SCHEDULED', 'DELIVERED', 'CANCELLED'],
};

const nextStatusMap: Record<OperationalCaseDepartment, Record<string, readonly string[]>> = {
  FINANCE: {
    DOCUMENTS_PENDING: ['APPLICATION_SUBMITTED', 'REJECTED', 'CANCELLED'],
    APPLICATION_SUBMITTED: ['UNDER_REVIEW', 'REJECTED', 'CANCELLED'],
    UNDER_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['DISBURSED', 'CANCELLED'],
  },
  INSURANCE: {
    QUOTE_PENDING: ['QUOTE_SHARED', 'CANCELLED'],
    QUOTE_SHARED: ['CUSTOMER_ACCEPTED', 'CANCELLED'],
    CUSTOMER_ACCEPTED: ['POLICY_ISSUED', 'CANCELLED'],
  },
  RTO: {
    NEW: ['DOCUMENTS_PENDING', 'CANCELLED'],
    DOCUMENTS_PENDING: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['IN_PROCESS', 'CANCELLED'],
    IN_PROCESS: ['REGISTERED', 'CANCELLED'],
  },
  EXCHANGE: {
    REQUESTED: ['INSPECTION_SCHEDULED', 'REJECTED', 'CANCELLED'],
    INSPECTION_SCHEDULED: ['EVALUATED', 'REJECTED', 'CANCELLED'],
    EVALUATED: ['OFFERED', 'REJECTED'],
    OFFERED: ['ACCEPTED', 'REJECTED'],
  },
  DELIVERY: {
    PLANNING: ['CHECKLIST_PENDING', 'CANCELLED'],
    CHECKLIST_PENDING: ['READY', 'CANCELLED'],
    READY: ['SCHEDULED', 'CANCELLED'],
    SCHEDULED: ['DELIVERED', 'CANCELLED'],
  },
};

export function operationalCaseNextStatuses(
  department: OperationalCaseDepartment,
  currentStatus: string,
) {
  return nextStatusMap[department][currentStatus] ?? [];
}

export function operationalCaseStatusLabel(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export const operationalCasePageSizes = [25, 50, 100] as const;
export type OperationalCasePageSize = (typeof operationalCasePageSizes)[number];
export const operationalCaseSorts = [
  'updated:desc',
  'updated:asc',
  'due:asc',
  'customer:asc',
  'priority:desc',
] as const;
export type OperationalCaseSort = (typeof operationalCaseSorts)[number];

const operationalCaseViews = ['ALL', 'OPEN', 'DOCUMENTS', 'ACTION_DUE', 'COMPLETED'] as const;
const allowedOperationalCaseStatuses = new Set<string>([
  ...operationalCaseViews,
  ...Object.values(operationalCaseStatuses).flat(),
]);

export type OperationalCaseRoute = {
  department: OperationalCaseDepartment;
  initialStatus: string;
  canOriginateRequest: boolean;
};

const routeMap: Partial<Record<RoleKey, Record<string, OperationalCaseRoute>>> = {
  finance: {
    'finance-cases': { department: 'FINANCE', initialStatus: 'OPEN', canOriginateRequest: false },
    'pending-documents': {
      department: 'FINANCE',
      initialStatus: 'DOCUMENTS',
      canOriginateRequest: false,
    },
    applications: {
      department: 'FINANCE',
      initialStatus: 'APPLICATION_SUBMITTED',
      canOriginateRequest: false,
    },
    disbursement: {
      department: 'FINANCE',
      initialStatus: 'APPROVED',
      canOriginateRequest: false,
    },
  },
  insurance: {
    'insurance-cases': {
      department: 'INSURANCE',
      initialStatus: 'OPEN',
      canOriginateRequest: false,
    },
  },
  rto: {
    'rto-cases': { department: 'RTO', initialStatus: 'OPEN', canOriginateRequest: false },
  },
  exchange: {
    'exchange-requests': {
      department: 'EXCHANGE',
      initialStatus: 'OPEN',
      canOriginateRequest: true,
    },
    evaluations: {
      department: 'EXCHANGE',
      initialStatus: 'INSPECTION_SCHEDULED',
      canOriginateRequest: false,
    },
    'accepted-exchanges': {
      department: 'EXCHANGE',
      initialStatus: 'ACCEPTED',
      canOriginateRequest: false,
    },
  },
  delivery: {
    'upcoming-deliveries': {
      department: 'DELIVERY',
      initialStatus: 'OPEN',
      canOriginateRequest: false,
    },
    'delivery-planner': {
      department: 'DELIVERY',
      initialStatus: 'SCHEDULED',
      canOriginateRequest: false,
    },
    'pending-checklist': {
      department: 'DELIVERY',
      initialStatus: 'CHECKLIST_PENDING',
      canOriginateRequest: false,
    },
    'ready-for-delivery': {
      department: 'DELIVERY',
      initialStatus: 'READY',
      canOriginateRequest: false,
    },
    delivered: {
      department: 'DELIVERY',
      initialStatus: 'DELIVERED',
      canOriginateRequest: false,
    },
    'delivery-photos': {
      department: 'DELIVERY',
      initialStatus: 'DELIVERED',
      canOriginateRequest: false,
    },
  },
  'sales-consultant': {
    exchange: { department: 'EXCHANGE', initialStatus: 'OPEN', canOriginateRequest: true },
  },
};

export function operationalCaseRoute(role: RoleKey, slug: string) {
  return routeMap[role]?.[slug] ?? null;
}

export type OperationalCaseQuery = {
  page: number;
  pageSize: OperationalCasePageSize;
  status: string;
  search: string;
  fromDate: string;
  toDate: string;
  sort: OperationalCaseSort;
};

function boundedDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? '' : value;
}

export function parseOperationalCaseQuery(
  params: URLSearchParams,
  initialStatus = 'OPEN',
): OperationalCaseQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const sort = params.get('sort');
  const fromDate = boundedDate(params.get('from'));
  const parsedToDate = boundedDate(params.get('to'));
  const requestedStatus = (params.get('status') ?? initialStatus).trim().toUpperCase();
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: operationalCasePageSizes.includes(pageSize as OperationalCasePageSize)
      ? (pageSize as OperationalCasePageSize)
      : 25,
    status: allowedOperationalCaseStatuses.has(requestedStatus) ? requestedStatus : initialStatus,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    fromDate,
    toDate: fromDate && parsedToDate && parsedToDate < fromDate ? '' : parsedToDate,
    sort: operationalCaseSorts.includes(sort as OperationalCaseSort)
      ? (sort as OperationalCaseSort)
      : 'updated:desc',
  };
}

export function toOperationalCaseQueryString(query: OperationalCaseQuery, initialStatus = 'OPEN') {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.status !== initialStatus) params.set('status', query.status);
  if (query.search) params.set('q', query.search);
  if (query.fromDate) params.set('from', query.fromDate);
  if (query.toDate) params.set('to', query.toDate);
  if (query.sort !== 'updated:desc') params.set('sort', query.sort);
  return params.toString();
}

export class OperationalCaseVersionConflictError extends Error {
  constructor() {
    super('OPERATIONAL_CASE_VERSION_CONFLICT');
    this.name = 'OperationalCaseVersionConflictError';
  }
}

export function isOperationalCaseVersionConflict(error: unknown) {
  return (
    error instanceof OperationalCaseVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        ['OPERATIONAL_CASE_VERSION_CONFLICT', 'DELIVERY_CHECKLIST_VERSION_CONFLICT'].includes(
          (error as { message?: string }).message ?? '',
        )))
  );
}
