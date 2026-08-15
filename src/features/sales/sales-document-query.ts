export type SalesDocumentKind = 'quotations' | 'bookings';

export const salesPageSizes = [25, 50, 100] as const;
export type SalesPageSize = (typeof salesPageSizes)[number];

export const quotationStatusFilters = [
  'all',
  'draft',
  'pending-approval',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'converted',
] as const;

export const bookingStatusFilters = [
  'all',
  'confirmed',
  'awaiting-allocation',
  'allocated',
  'ready-for-delivery',
  'delivered',
  'cancelled',
] as const;

export type SalesStatusFilter =
  (typeof quotationStatusFilters)[number] | (typeof bookingStatusFilters)[number];

export const salesSorts = [
  'updated:desc',
  'updated:asc',
  'amount:desc',
  'amount:asc',
  'customer:asc',
  'customer:desc',
  'delivery:asc',
  'delivery:desc',
] as const;
export type SalesSort = (typeof salesSorts)[number];

export type SalesDocumentQuery = {
  page: number;
  pageSize: SalesPageSize;
  search: string;
  status: SalesStatusFilter;
  sort: SalesSort;
};

export function defaultSalesDocumentQuery(kind: SalesDocumentKind): SalesDocumentQuery {
  return {
    page: 1,
    pageSize: 25,
    search: '',
    status: 'all',
    sort: kind === 'bookings' ? 'delivery:asc' : 'updated:desc',
  };
}

export function parseSalesDocumentQuery(
  params: URLSearchParams,
  kind: SalesDocumentKind,
): SalesDocumentQuery {
  const fallback = defaultSalesDocumentQuery(kind);
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const sort = params.get('sort');
  const statusOptions = kind === 'quotations' ? quotationStatusFilters : bookingStatusFilters;
  const sortOptions =
    kind === 'quotations'
      ? salesSorts.filter((value) => !value.startsWith('delivery:'))
      : salesSorts;
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: salesPageSizes.includes(pageSize as SalesPageSize) ? (pageSize as SalesPageSize) : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: statusOptions.includes(status as never) ? (status as SalesStatusFilter) : 'all',
    sort: sortOptions.includes(sort as SalesSort) ? (sort as SalesSort) : fallback.sort,
  };
}

export function toSalesDocumentQueryString(query: SalesDocumentQuery, kind: SalesDocumentKind) {
  const defaults = defaultSalesDocumentQuery(kind);
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'all') params.set('status', query.status);
  if (query.sort !== defaults.sort) params.set('sort', query.sort);
  return params.toString();
}

export function salesStatusValue(value: SalesStatusFilter) {
  return value === 'all' ? 'ALL' : value.replaceAll('-', '_').toUpperCase();
}

export class SalesDocumentVersionConflictError extends Error {
  constructor(kind: 'quotation' | 'booking') {
    super(`${kind.toUpperCase()}_VERSION_CONFLICT`);
    this.name = 'SalesDocumentVersionConflictError';
  }
}

export function isSalesDocumentVersionConflict(error: unknown) {
  return (
    error instanceof SalesDocumentVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        /_(VERSION_CONFLICT)$/.test((error as { message?: string }).message ?? '')))
  );
}
