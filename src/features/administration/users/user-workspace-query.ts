export const userPageSizes = [25, 50, 100] as const;
export type UserPageSize = (typeof userPageSizes)[number];

export const userStatuses = ['all', 'active', 'inactive', 'mfa-required'] as const;
export type UserStatusFilter = (typeof userStatuses)[number];

export const userSorts = ['created-desc', 'updated-desc', 'name-asc', 'role-asc'] as const;
export type UserSort = (typeof userSorts)[number];

export type UserWorkspaceQuery = {
  page: number;
  pageSize: UserPageSize;
  search: string;
  status: UserStatusFilter;
  roleId: string;
  branchId: string;
  sort: UserSort;
};

export const userStatusValues: Record<UserStatusFilter, string> = {
  all: 'ALL',
  active: 'ACTIVE',
  inactive: 'INACTIVE',
  'mfa-required': 'MFA_REQUIRED',
};

export const userSortValues: Record<UserSort, string> = {
  'created-desc': 'CREATED_DESC',
  'updated-desc': 'UPDATED_DESC',
  'name-asc': 'NAME_ASC',
  'role-asc': 'ROLE_ASC',
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeUserSearch(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 160);
}

export function parseUserWorkspaceQuery(parameters: URLSearchParams): UserWorkspaceQuery {
  const rawPage = Number.parseInt(parameters.get('page') ?? '', 10);
  const rawPageSize = Number.parseInt(parameters.get('pageSize') ?? '', 10);
  const rawStatus = parameters.get('status');
  const rawSort = parameters.get('sort');
  const rawRoleId = parameters.get('role') ?? '';
  const rawBranchId = parameters.get('branch') ?? '';
  return {
    page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
    pageSize: userPageSizes.includes(rawPageSize as UserPageSize)
      ? (rawPageSize as UserPageSize)
      : 25,
    search: normalizeUserSearch(parameters.get('q') ?? ''),
    status: userStatuses.includes(rawStatus as UserStatusFilter)
      ? (rawStatus as UserStatusFilter)
      : 'all',
    roleId: uuidPattern.test(rawRoleId) ? rawRoleId : '',
    branchId: uuidPattern.test(rawBranchId) ? rawBranchId : '',
    sort: userSorts.includes(rawSort as UserSort) ? (rawSort as UserSort) : 'created-desc',
  };
}

export function toUserWorkspaceQueryString(query: UserWorkspaceQuery) {
  const parameters = new URLSearchParams();
  if (query.page > 1) parameters.set('page', String(query.page));
  if (query.pageSize !== 25) parameters.set('pageSize', String(query.pageSize));
  if (query.search) parameters.set('q', normalizeUserSearch(query.search));
  if (query.status !== 'all') parameters.set('status', query.status);
  if (query.roleId) parameters.set('role', query.roleId);
  if (query.branchId) parameters.set('branch', query.branchId);
  if (query.sort !== 'created-desc') parameters.set('sort', query.sort);
  return parameters.toString();
}
