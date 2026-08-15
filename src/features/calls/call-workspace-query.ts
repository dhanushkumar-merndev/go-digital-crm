export const callPageSizes = [25, 50, 100] as const;
export type CallPageSize = (typeof callPageSizes)[number];

export const callStatusFilters = ['all', 'pending', 'completed', 'failed', 'cancelled'] as const;
export type CallStatusFilter = (typeof callStatusFilters)[number];

export const callOutcomeFilters = [
  'all',
  'connected',
  'no-answer',
  'busy',
  'switched-off',
  'callback-required',
  'wrong-number',
  'other',
] as const;
export type CallOutcomeFilter = (typeof callOutcomeFilters)[number];

export const callSourceFilters = ['all', 'provider', 'personal-manual'] as const;
export type CallSourceFilter = (typeof callSourceFilters)[number];

export const callSorts = [
  'started:desc',
  'started:asc',
  'duration:desc',
  'duration:asc',
  'customer:asc',
  'customer:desc',
] as const;
export type CallSort = (typeof callSorts)[number];

export type CallQuery = {
  page: number;
  pageSize: CallPageSize;
  search: string;
  status: CallStatusFilter;
  outcome: CallOutcomeFilter;
  source: CallSourceFilter;
  sort: CallSort;
};

export const defaultCallQuery: CallQuery = {
  page: 1,
  pageSize: 25,
  search: '',
  status: 'all',
  outcome: 'all',
  source: 'all',
  sort: 'started:desc',
};

export const callStatusValues: Record<CallStatusFilter, string> = {
  all: 'ALL',
  pending: 'PENDING',
  completed: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};

export const callOutcomeValues: Record<CallOutcomeFilter, string> = {
  all: 'ALL',
  connected: 'CONNECTED',
  'no-answer': 'NO_ANSWER',
  busy: 'BUSY',
  'switched-off': 'SWITCHED_OFF',
  'callback-required': 'CALLBACK_REQUIRED',
  'wrong-number': 'WRONG_NUMBER',
  other: 'OTHER',
};

export const callSourceValues: Record<CallSourceFilter, string> = {
  all: 'ALL',
  provider: 'PROVIDER',
  'personal-manual': 'PERSONAL_MANUAL',
};

export function parseCallQuery(params: URLSearchParams): CallQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const outcome = params.get('outcome');
  const source = params.get('source');
  const sort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: callPageSizes.includes(pageSize as CallPageSize) ? (pageSize as CallPageSize) : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: callStatusFilters.includes(status as CallStatusFilter)
      ? (status as CallStatusFilter)
      : 'all',
    outcome: callOutcomeFilters.includes(outcome as CallOutcomeFilter)
      ? (outcome as CallOutcomeFilter)
      : 'all',
    source: callSourceFilters.includes(source as CallSourceFilter)
      ? (source as CallSourceFilter)
      : 'all',
    sort: callSorts.includes(sort as CallSort) ? (sort as CallSort) : 'started:desc',
  };
}

export function toCallQueryString(query: CallQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'all') params.set('status', query.status);
  if (query.outcome !== 'all') params.set('outcome', query.outcome);
  if (query.source !== 'all') params.set('source', query.source);
  if (query.sort !== 'started:desc') params.set('sort', query.sort);
  return params.toString();
}

export class CallVersionConflictError extends Error {
  constructor() {
    super('CALL_VERSION_CONFLICT');
    this.name = 'CallVersionConflictError';
  }
}

export function isCallVersionConflict(error: unknown) {
  return (
    error instanceof CallVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        (error as { message?: string }).message === 'CALL_VERSION_CONFLICT'))
  );
}
