export const administrationPageSizes = [25, 50, 100] as const;
export type AdministrationPageSize = (typeof administrationPageSizes)[number];

export type AdministrationKind = 'branches' | 'teams';
export type BranchWorkspacePreset = 'MANAGE' | 'ACCESS';
export type AdministrationStatus = 'ALL' | 'ACTIVE' | 'INACTIVE';
export type AdministrationSort =
  | 'updated:desc'
  | 'updated:asc'
  | 'name:asc'
  | 'name:desc'
  | 'created:desc'
  | 'teams:desc'
  | 'users:desc'
  | 'members:desc'
  | 'leads:desc';

export type AdministrationQuery = {
  page: number;
  pageSize: AdministrationPageSize;
  search: string;
  status: AdministrationStatus;
  branchId: string;
  sort: AdministrationSort;
};

const branchSorts: AdministrationSort[] = [
  'updated:desc',
  'updated:asc',
  'name:asc',
  'name:desc',
  'created:desc',
  'teams:desc',
  'users:desc',
];

const teamSorts: AdministrationSort[] = [
  'updated:desc',
  'updated:asc',
  'name:asc',
  'name:desc',
  'members:desc',
  'leads:desc',
];

export function parseAdministrationQuery(
  params: URLSearchParams,
  kind: AdministrationKind,
): AdministrationQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const sort = params.get('sort');
  const allowedSorts = kind === 'branches' ? branchSorts : teamSorts;
  const branch = params.get('branch') ?? '';
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: administrationPageSizes.includes(pageSize as AdministrationPageSize)
      ? (pageSize as AdministrationPageSize)
      : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: status === 'ACTIVE' || status === 'INACTIVE' ? status : ('ALL' as AdministrationStatus),
    branchId: isUuid(branch) ? branch : 'all',
    sort: allowedSorts.includes(sort as AdministrationSort)
      ? (sort as AdministrationSort)
      : 'updated:desc',
  };
}

export function toAdministrationQueryString(query: AdministrationQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'ALL') params.set('status', query.status);
  if (query.branchId !== 'all') params.set('branch', query.branchId);
  if (query.sort !== 'updated:desc') params.set('sort', query.sort);
  return params.toString();
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class AdministrationVersionConflictError extends Error {
  constructor() {
    super('ADMINISTRATION_VERSION_CONFLICT');
    this.name = 'AdministrationVersionConflictError';
  }
}

export function isAdministrationVersionConflict(error: unknown) {
  return (
    error instanceof AdministrationVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        (error as { message?: string }).message?.includes('VERSION_CONFLICT')))
  );
}
