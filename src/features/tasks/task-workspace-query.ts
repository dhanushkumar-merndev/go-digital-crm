export const taskPageSizes = [25, 50, 100] as const;
export type TaskPageSize = (typeof taskPageSizes)[number];

export const taskStatusFilters = [
  'all',
  'open',
  'in-progress',
  'overdue',
  'today',
  'upcoming',
  'completed',
  'cancelled',
] as const;
export type TaskStatusFilter = (typeof taskStatusFilters)[number];

export const taskPriorityFilters = ['all', 'LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TaskPriorityFilter = (typeof taskPriorityFilters)[number];

export const taskSorts = ['due:asc', 'due:desc', 'updated:desc', 'priority:desc', 'customer:asc'] as const;
export type TaskSort = (typeof taskSorts)[number];

export type TaskQuery = {
  page: number;
  pageSize: TaskPageSize;
  search: string;
  status: TaskStatusFilter;
  priority: TaskPriorityFilter;
  sort: TaskSort;
};

export const defaultTaskQuery: TaskQuery = {
  page: 1,
  pageSize: 25,
  search: '',
  status: 'all',
  priority: 'all',
  sort: 'due:asc',
};

export function parseTaskQuery(params: URLSearchParams): TaskQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const priority = params.get('priority');
  const sort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: taskPageSizes.includes(pageSize as TaskPageSize) ? (pageSize as TaskPageSize) : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    status: (taskStatusFilters as readonly string[]).includes(status ?? '')
      ? (status as TaskStatusFilter)
      : 'all',
    priority: (taskPriorityFilters as readonly string[]).includes(priority ?? '')
      ? (priority as TaskPriorityFilter)
      : 'all',
    sort: taskSorts.includes(sort as TaskSort) ? (sort as TaskSort) : 'due:asc',
  };
}

export function toTaskQueryString(query: TaskQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'all') params.set('status', query.status);
  if (query.priority !== 'all') params.set('priority', query.priority);
  if (query.sort !== 'due:asc') params.set('sort', query.sort);
  return params.toString();
}

export function taskStatusValue(value: TaskStatusFilter) {
  return value === 'all' ? 'ALL' : value.replaceAll('-', '_').toUpperCase();
}

export class TaskVersionConflictError extends Error {
  constructor() {
    super('TASK_VERSION_CONFLICT');
    this.name = 'TaskVersionConflictError';
  }
}

export function isTaskVersionConflict(error: unknown) {
  return (
    error instanceof TaskVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        (error as { message?: string }).message === 'TASK_VERSION_CONFLICT'))
  );
}
