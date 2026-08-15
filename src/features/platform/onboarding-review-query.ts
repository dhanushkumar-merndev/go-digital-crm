export const onboardingReviewPageSizes = [25, 50, 100] as const;
export type OnboardingReviewPageSize = (typeof onboardingReviewPageSizes)[number];

export const onboardingReviewStatuses = [
  'all',
  'submitted',
  'changes-required',
  'approved',
  'rejected',
] as const;
export type OnboardingReviewStatus = (typeof onboardingReviewStatuses)[number];

export const onboardingReviewSortOptions = {
  'submitted:desc': { column: 'submitted_at', ascending: false },
  'submitted:asc': { column: 'submitted_at', ascending: true },
  'dealership:asc': { column: 'organization_name', ascending: true },
  'dealership:desc': { column: 'organization_name', ascending: false },
} as const;
export type OnboardingReviewSort = keyof typeof onboardingReviewSortOptions;

export type OnboardingReviewQuery = {
  page: number;
  pageSize: OnboardingReviewPageSize;
  search: string;
  status: OnboardingReviewStatus;
  sort: OnboardingReviewSort;
};

export const defaultOnboardingReviewQuery: OnboardingReviewQuery = {
  page: 1,
  pageSize: 25,
  search: '',
  status: 'submitted',
  sort: 'submitted:desc',
};

export const onboardingReviewStatusValues = {
  submitted: 'SUBMITTED',
  'changes-required': 'CHANGES_REQUIRED',
  approved: 'APPROVED',
  rejected: 'REJECTED',
} as const;

export function parseOnboardingReviewQuery(params: URLSearchParams): OnboardingReviewQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const sort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: onboardingReviewPageSizes.includes(pageSize as OnboardingReviewPageSize)
      ? (pageSize as OnboardingReviewPageSize)
      : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: onboardingReviewStatuses.includes(status as OnboardingReviewStatus)
      ? (status as OnboardingReviewStatus)
      : 'submitted',
    sort: Object.hasOwn(onboardingReviewSortOptions, sort ?? '')
      ? (sort as OnboardingReviewSort)
      : 'submitted:desc',
  };
}

export function toOnboardingReviewQueryString(query: OnboardingReviewQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'submitted') params.set('status', query.status);
  if (query.sort !== 'submitted:desc') params.set('sort', query.sort);
  return params.toString();
}

export function toOnboardingSearchTerm(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim();
}
