export const salesEscalationStatuses = ['ALL', 'OPEN', 'RESOLVED'] as const;
export type SalesEscalationStatus = (typeof salesEscalationStatuses)[number];

export const salesEscalationSeverities = ['ALL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type SalesEscalationSeverity = (typeof salesEscalationSeverities)[number];

export const salesEscalationPageSizes = [25, 50, 100] as const;
export type SalesEscalationPageSize = (typeof salesEscalationPageSizes)[number];

export const salesEscalationSorts = ['updated:desc', 'created:desc', 'severity:desc'] as const;
export type SalesEscalationSort = (typeof salesEscalationSorts)[number];

export type SalesEscalationQuery = {
  page: number;
  pageSize: SalesEscalationPageSize;
  search: string;
  status: SalesEscalationStatus;
  severity: SalesEscalationSeverity;
  sort: SalesEscalationSort;
};

export const defaultSalesEscalationQuery: SalesEscalationQuery = {
  page: 1,
  pageSize: 25,
  search: '',
  status: 'OPEN',
  severity: 'ALL',
  sort: 'updated:desc',
};

export function parseSalesEscalationQuery(params: URLSearchParams): SalesEscalationQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = (params.get('status') ?? defaultSalesEscalationQuery.status).toUpperCase();
  const severity = (params.get('severity') ?? defaultSalesEscalationQuery.severity).toUpperCase();
  const sort = params.get('sort') ?? defaultSalesEscalationQuery.sort;
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: salesEscalationPageSizes.includes(pageSize as SalesEscalationPageSize)
      ? (pageSize as SalesEscalationPageSize)
      : defaultSalesEscalationQuery.pageSize,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: salesEscalationStatuses.includes(status as SalesEscalationStatus)
      ? (status as SalesEscalationStatus)
      : defaultSalesEscalationQuery.status,
    severity: salesEscalationSeverities.includes(severity as SalesEscalationSeverity)
      ? (severity as SalesEscalationSeverity)
      : defaultSalesEscalationQuery.severity,
    sort: salesEscalationSorts.includes(sort as SalesEscalationSort)
      ? (sort as SalesEscalationSort)
      : defaultSalesEscalationQuery.sort,
  };
}

export function toSalesEscalationQueryString(query: SalesEscalationQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== defaultSalesEscalationQuery.pageSize)
    params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== defaultSalesEscalationQuery.status) params.set('status', query.status);
  if (query.severity !== defaultSalesEscalationQuery.severity)
    params.set('severity', query.severity);
  if (query.sort !== defaultSalesEscalationQuery.sort) params.set('sort', query.sort);
  return params.toString();
}

export function isSalesEscalationVersionConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: string }).code === '40001' ||
      (error as { message?: string }).message === 'SALES_ESCALATION_VERSION_CONFLICT')
  );
}
