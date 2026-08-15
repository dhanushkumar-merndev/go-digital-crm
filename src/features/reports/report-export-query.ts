export const reportPageSizes = [25, 50, 100] as const;
export type ReportPageSize = (typeof reportPageSizes)[number];

export type ReportExportQuery = { page: number; pageSize: ReportPageSize; search: string };

export function parseReportExportQuery(params: URLSearchParams): ReportExportQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: reportPageSizes.includes(pageSize as ReportPageSize)
      ? (pageSize as ReportPageSize)
      : 25,
    search: (params.get('q') ?? '').trim().slice(0, 80),
  };
}

export function toReportExportQueryString(query: ReportExportQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  return params.toString();
}

export const reportKinds = [
  'LEADS',
  'CALLS',
  'APPOINTMENTS',
  'SALES',
  'INVENTORY',
  'MARKETING',
] as const;
export type ReportKind = (typeof reportKinds)[number];

export function reportLabel(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
