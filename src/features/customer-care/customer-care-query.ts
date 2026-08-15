export const customerCareViews = [
  'ALL',
  'OPEN',
  'SLA_RISK',
  'FEEDBACK',
  'REVIEW_REQUEST',
  'COMPLAINT',
  'ESCALATED',
  'RESOLVED',
  'CLOSED',
] as const;
export type CustomerCareView = (typeof customerCareViews)[number];

export const customerCarePageSizes = [25, 50, 100] as const;
export type CustomerCarePageSize = (typeof customerCarePageSizes)[number];
export const customerCareSorts = [
  'updated:desc',
  'sla:asc',
  'created:desc',
  'priority:desc',
] as const;
export type CustomerCareSort = (typeof customerCareSorts)[number];

export const customerCareTypes = [
  'DELIVERY_FOLLOWUP',
  'COMPLAINT',
  'FEEDBACK',
  'DOCUMENTATION_QUERY',
  'REVIEW_REQUEST',
  'SALES_EXPERIENCE',
  'OTHER',
] as const;
export type CustomerCareType = (typeof customerCareTypes)[number];

export const customerCareStatuses = [
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'CUSTOMER_CONTACTED',
  'RESOLVED',
  'CLOSED',
] as const;

const nextStatuses: Record<string, readonly string[]> = {
  NEW: ['ASSIGNED', 'IN_PROGRESS'],
  ASSIGNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['CUSTOMER_CONTACTED', 'RESOLVED'],
  CUSTOMER_CONTACTED: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED'],
};

export function customerCareNextStatuses(status: string) {
  return nextStatuses[status] ?? [];
}

export function customerCareLabel(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function customerCareInitialView(slug: string): CustomerCareView | null {
  if (slug === 'dashboard') return 'OPEN';
  if (slug === 'customer-cases') return 'OPEN';
  if (slug === 'feedback') return 'FEEDBACK';
  if (slug === 'reviews') return 'REVIEW_REQUEST';
  if (slug === 'complaints-escalations') return 'COMPLAINT';
  return null;
}

export type CustomerCareQuery = {
  page: number;
  pageSize: CustomerCarePageSize;
  view: CustomerCareView;
  search: string;
  sort: CustomerCareSort;
};

export function parseCustomerCareQuery(
  params: URLSearchParams,
  initialView: CustomerCareView,
): CustomerCareQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const requestedView = (params.get('view') ?? initialView).trim().toUpperCase();
  const requestedSort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: customerCarePageSizes.includes(pageSize as CustomerCarePageSize)
      ? (pageSize as CustomerCarePageSize)
      : 25,
    view: customerCareViews.includes(requestedView as CustomerCareView)
      ? (requestedView as CustomerCareView)
      : initialView,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    sort: customerCareSorts.includes(requestedSort as CustomerCareSort)
      ? (requestedSort as CustomerCareSort)
      : 'updated:desc',
  };
}

export function toCustomerCareQueryString(query: CustomerCareQuery, initialView: CustomerCareView) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.view !== initialView) params.set('view', query.view);
  if (query.search) params.set('q', query.search);
  if (query.sort !== 'updated:desc') params.set('sort', query.sort);
  return params.toString();
}

export function isCustomerCareVersionConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: string }).code === '40001' ||
      (error as { message?: string }).message === 'CUSTOMER_CARE_VERSION_CONFLICT')
  );
}
