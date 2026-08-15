export const retentionPageSizes = [25, 50, 100] as const;
export type RetentionPageSize = (typeof retentionPageSizes)[number];

export const retentionStatuses = [
  'open',
  'all',
  'pending-approval',
  'approved',
  'legal-hold',
  'purging',
  'failed',
  'restored',
  'rejected',
  'purged',
] as const;
export type RetentionStatusFilter = (typeof retentionStatuses)[number];

export const retentionStatusValues: Record<RetentionStatusFilter, string> = {
  open: 'OPEN',
  all: 'ALL',
  'pending-approval': 'PENDING_APPROVAL',
  approved: 'APPROVED',
  'legal-hold': 'LEGAL_HOLD',
  purging: 'PURGING',
  failed: 'FAILED',
  restored: 'RESTORED',
  rejected: 'REJECTED',
  purged: 'PURGED',
};

export const retentionSortValues = {
  'purge:asc': 'PURGE_ASC',
  'purge:desc': 'PURGE_DESC',
  'deleted:desc': 'DELETED_DESC',
  'dealership:asc': 'DEALERSHIP_ASC',
} as const;
export type RetentionSort = keyof typeof retentionSortValues;

export type RetentionQuery = {
  page: number;
  pageSize: RetentionPageSize;
  search: string;
  status: RetentionStatusFilter;
  sort: RetentionSort;
};

export function parseRetentionQuery(params: URLSearchParams): RetentionQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const sort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: retentionPageSizes.includes(pageSize as RetentionPageSize)
      ? (pageSize as RetentionPageSize)
      : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: retentionStatuses.includes(status as RetentionStatusFilter)
      ? (status as RetentionStatusFilter)
      : 'open',
    sort: Object.hasOwn(retentionSortValues, sort ?? '') ? (sort as RetentionSort) : 'purge:asc',
  };
}

export function toRetentionQueryString(query: RetentionQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'open') params.set('status', query.status);
  if (query.sort !== 'purge:asc') params.set('sort', query.sort);
  return params.toString();
}

export function normalizeRetentionSearch(value: string) {
  return value.normalize('NFKC').trim().slice(0, 160);
}
