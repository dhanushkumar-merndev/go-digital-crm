export const supportStatusValues = [
  'all',
  'pending',
  'active',
  'rejected',
  'ended',
  'expired',
] as const;
export type SupportStatusFilter = (typeof supportStatusValues)[number];

export const supportSortValues = [
  'created_desc',
  'created_asc',
  'tenant_asc',
  'expires_asc',
] as const;
export type SupportSort = (typeof supportSortValues)[number];

export type SupportWorkspaceQuery = {
  page: number;
  pageSize: 25 | 50 | 100;
  search: string;
  status: SupportStatusFilter;
  sort: SupportSort;
};

const positiveInteger = (value: string | null, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function toSupportSearchTerm(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s.@_\/-]/gu, '')
    .trim()
    .slice(0, 120);
}

export function parseSupportWorkspaceQuery(parameters: URLSearchParams): SupportWorkspaceQuery {
  const rawPageSize = positiveInteger(parameters.get('pageSize'), 25);
  const pageSize = ([25, 50, 100] as const).includes(rawPageSize as 25 | 50 | 100)
    ? (rawPageSize as 25 | 50 | 100)
    : 25;
  const rawStatus = parameters.get('status');
  const rawSort = parameters.get('sort');
  return {
    page: positiveInteger(parameters.get('page'), 1),
    pageSize,
    search: toSupportSearchTerm(parameters.get('q') ?? ''),
    status: supportStatusValues.includes(rawStatus as SupportStatusFilter)
      ? (rawStatus as SupportStatusFilter)
      : 'all',
    sort: supportSortValues.includes(rawSort as SupportSort)
      ? (rawSort as SupportSort)
      : 'created_desc',
  };
}

export function toSupportWorkspaceQueryString(query: SupportWorkspaceQuery) {
  const parameters = new URLSearchParams();
  if (query.page > 1) parameters.set('page', String(query.page));
  if (query.pageSize !== 25) parameters.set('pageSize', String(query.pageSize));
  if (query.search) parameters.set('q', toSupportSearchTerm(query.search));
  if (query.status !== 'all') parameters.set('status', query.status);
  if (query.sort !== 'created_desc') parameters.set('sort', query.sort);
  return parameters.toString();
}
