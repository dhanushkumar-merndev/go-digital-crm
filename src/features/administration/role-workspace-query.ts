export const roleFilterValues = ['all', 'system', 'custom', 'mfa'] as const;
export type RoleFilter = (typeof roleFilterValues)[number];

export const roleSortValues = ['authority_desc', 'name_asc', 'created_desc'] as const;
export type RoleSort = (typeof roleSortValues)[number];

export type RoleWorkspaceQuery = {
  page: number;
  pageSize: 25 | 50 | 100;
  search: string;
  filter: RoleFilter;
  sort: RoleSort;
};

const positiveInteger = (value: string | null, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function normalizeRoleSearch(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s_\/-]/gu, '')
    .trim()
    .slice(0, 100);
}

export function toCustomRoleKey(value: string) {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 54);
  return `custom_${normalized || 'role'}`;
}

export function parseRoleWorkspaceQuery(parameters: URLSearchParams): RoleWorkspaceQuery {
  const rawPageSize = positiveInteger(parameters.get('pageSize'), 25);
  const pageSize = ([25, 50, 100] as const).includes(rawPageSize as 25 | 50 | 100)
    ? (rawPageSize as 25 | 50 | 100)
    : 25;
  const rawFilter = parameters.get('filter');
  const rawSort = parameters.get('sort');
  return {
    page: positiveInteger(parameters.get('page'), 1),
    pageSize,
    search: normalizeRoleSearch(parameters.get('q') ?? ''),
    filter: roleFilterValues.includes(rawFilter as RoleFilter) ? (rawFilter as RoleFilter) : 'all',
    sort: roleSortValues.includes(rawSort as RoleSort) ? (rawSort as RoleSort) : 'authority_desc',
  };
}

export function toRoleWorkspaceQueryString(query: RoleWorkspaceQuery) {
  const parameters = new URLSearchParams();
  if (query.page > 1) parameters.set('page', String(query.page));
  if (query.pageSize !== 25) parameters.set('pageSize', String(query.pageSize));
  if (query.search) parameters.set('q', normalizeRoleSearch(query.search));
  if (query.filter !== 'all') parameters.set('filter', query.filter);
  if (query.sort !== 'authority_desc') parameters.set('sort', query.sort);
  return parameters.toString();
}
