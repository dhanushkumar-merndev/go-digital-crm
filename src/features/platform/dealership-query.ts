export const dealershipPageSizes = [25, 50, 100] as const;
export type DealershipPageSize = (typeof dealershipPageSizes)[number];

export const dealershipStatuses = [
  'all',
  'active',
  'onboarding',
  'under-review',
  'changes-required',
  'support-maintenance',
  'suspended',
  'rejected',
  'soft-deleted',
] as const;
export type DealershipStatus = (typeof dealershipStatuses)[number];

export const dealershipStatusValues = {
  active: 'ACTIVE',
  onboarding: 'ONBOARDING',
  'under-review': 'UNDER_REVIEW',
  'changes-required': 'CHANGES_REQUIRED',
  'support-maintenance': 'SUPPORT_MAINTENANCE',
  suspended: 'SUSPENDED',
  rejected: 'REJECTED',
  'soft-deleted': 'SOFT_DELETED',
} as const;

export const dealershipSortOptions = {
  'created:desc': { column: 'created_at', ascending: false },
  'created:asc': { column: 'created_at', ascending: true },
  'name:asc': { column: 'name', ascending: true },
  'name:desc': { column: 'name', ascending: false },
} as const;
export type DealershipSort = keyof typeof dealershipSortOptions;

export type DealershipQuery = {
  page: number;
  pageSize: DealershipPageSize;
  search: string;
  status: DealershipStatus;
  sort: DealershipSort;
};

export function parseDealershipQuery(params: URLSearchParams): DealershipQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const sort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: dealershipPageSizes.includes(pageSize as DealershipPageSize)
      ? (pageSize as DealershipPageSize)
      : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: dealershipStatuses.includes(status as DealershipStatus)
      ? (status as DealershipStatus)
      : 'all',
    sort: Object.hasOwn(dealershipSortOptions, sort ?? '')
      ? (sort as DealershipSort)
      : 'created:desc',
  };
}

export function toDealershipQueryString(query: DealershipQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'all') params.set('status', query.status);
  if (query.sort !== 'created:desc') params.set('sort', query.sort);
  return params.toString();
}

export function toDealershipSearchTerm(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim();
}

export function toOrganizationSlug(value: string) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}
