export const testDrivePageSizes = [25, 50, 100] as const;
export type TestDrivePageSize = (typeof testDrivePageSizes)[number];

export const testDriveViews = ['today', 'upcoming', 'active', 'completed', 'cancelled'] as const;
export type TestDriveView = (typeof testDriveViews)[number];

export const testDriveSorts = [
  'scheduled:asc',
  'scheduled:desc',
  'updated:desc',
  'customer:asc',
] as const;
export type TestDriveSort = (typeof testDriveSorts)[number];

export type TestDriveQuery = {
  page: number;
  pageSize: TestDrivePageSize;
  view: TestDriveView;
  search: string;
  model: string;
  fromDate: string;
  toDate: string;
  sort: TestDriveSort;
};

export const defaultTestDriveQuery: TestDriveQuery = {
  page: 1,
  pageSize: 25,
  view: 'today',
  search: '',
  model: '',
  fromDate: '',
  toDate: '',
  sort: 'scheduled:asc',
};

function boundedDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? '' : value;
}

export function parseTestDriveQuery(params: URLSearchParams): TestDriveQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const view = params.get('view');
  const sort = params.get('sort');
  const fromDate = boundedDate(params.get('from'));
  const parsedToDate = boundedDate(params.get('to'));
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: testDrivePageSizes.includes(pageSize as TestDrivePageSize)
      ? (pageSize as TestDrivePageSize)
      : 25,
    view: testDriveViews.includes(view as TestDriveView) ? (view as TestDriveView) : 'today',
    search: (params.get('q') ?? '').trim().slice(0, 160),
    model: (params.get('model') ?? '').trim().slice(0, 120),
    fromDate,
    toDate: fromDate && parsedToDate && parsedToDate < fromDate ? '' : parsedToDate,
    sort: testDriveSorts.includes(sort as TestDriveSort)
      ? (sort as TestDriveSort)
      : 'scheduled:asc',
  };
}

export function toTestDriveQueryString(query: TestDriveQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.view !== 'today') params.set('view', query.view);
  if (query.search) params.set('q', query.search);
  if (query.model) params.set('model', query.model);
  if (query.fromDate) params.set('from', query.fromDate);
  if (query.toDate) params.set('to', query.toDate);
  if (query.sort !== 'scheduled:asc') params.set('sort', query.sort);
  return params.toString();
}

export function testDriveViewValue(value: TestDriveView) {
  return value.toUpperCase();
}

export class TestDriveVersionConflictError extends Error {
  constructor() {
    super('TEST_DRIVE_VERSION_CONFLICT');
    this.name = 'TestDriveVersionConflictError';
  }
}

export function isTestDriveVersionConflict(error: unknown) {
  return (
    error instanceof TestDriveVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        (error as { message?: string }).message === 'TEST_DRIVE_VERSION_CONFLICT'))
  );
}
