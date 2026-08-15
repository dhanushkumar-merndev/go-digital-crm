export const integrationStatusValues = ['all', 'connected', 'attention', 'authorizing'] as const;
export type IntegrationStatusFilter = (typeof integrationStatusValues)[number];

export const integrationSortOptions = {
  'updated:desc': { column: 'updated_at', ascending: false },
  'updated:asc': { column: 'updated_at', ascending: true },
  'name:asc': { column: 'display_name', ascending: true },
  'provider:asc': { column: 'provider_key', ascending: true },
} as const;
export type IntegrationSort = keyof typeof integrationSortOptions;

export type IntegrationQuery = {
  page: number;
  pageSize: 25 | 50 | 100;
  status: IntegrationStatusFilter;
  sort: IntegrationSort;
  search: string;
};

const positiveInteger = (value: string | null, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function toIntegrationSearchTerm(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s._-]/gu, '')
    .trim()
    .slice(0, 80);
}

export function parseIntegrationQuery(parameters: URLSearchParams): IntegrationQuery {
  const rawPageSize = positiveInteger(parameters.get('pageSize'), 25);
  const pageSize = ([25, 50, 100] as const).includes(rawPageSize as 25 | 50 | 100)
    ? (rawPageSize as 25 | 50 | 100)
    : 25;
  const statusValue = parameters.get('status');
  const status = integrationStatusValues.includes(statusValue as IntegrationStatusFilter)
    ? (statusValue as IntegrationStatusFilter)
    : 'all';
  const sortValue = parameters.get('sort');
  const sort =
    sortValue && sortValue in integrationSortOptions
      ? (sortValue as IntegrationSort)
      : 'updated:desc';
  return {
    page: positiveInteger(parameters.get('page'), 1),
    pageSize,
    status,
    sort,
    search: toIntegrationSearchTerm(parameters.get('q') ?? ''),
  };
}

export function toIntegrationQueryString(query: IntegrationQuery) {
  const parameters = new URLSearchParams();
  if (query.page > 1) parameters.set('page', String(query.page));
  if (query.pageSize !== 25) parameters.set('pageSize', String(query.pageSize));
  if (query.status !== 'all') parameters.set('status', query.status);
  if (query.sort !== 'updated:desc') parameters.set('sort', query.sort);
  const search = toIntegrationSearchTerm(query.search);
  if (search) parameters.set('q', search);
  return parameters.toString();
}

export function isTrustedProviderAuthorizationUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      ['www.facebook.com', 'accounts.google.com'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
