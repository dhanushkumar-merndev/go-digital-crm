export const workPageSizes = [25, 50, 100] as const;
export type WorkPageSize = (typeof workPageSizes)[number];

export type WorkKind = 'followups' | 'appointments';

export const followupFilters = [
  'all',
  'overdue',
  'today',
  'upcoming',
  'completed',
  'cancelled',
] as const;

export const appointmentFilters = [
  'all',
  'today',
  'upcoming',
  'confirmed',
  'arrived',
  'completed',
  'no-show',
  'rescheduled',
  'cancelled',
] as const;

export type WorkStatusFilter =
  (typeof followupFilters)[number] | (typeof appointmentFilters)[number];

export const workSorts = [
  'scheduled:asc',
  'scheduled:desc',
  'updated:desc',
  'updated:asc',
  'customer:asc',
  'customer:desc',
] as const;

export type WorkSort = (typeof workSorts)[number];
export type WorkPriorityFilter = 'all' | 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type WorkLeadTemperatureFilter = 'all' | 'HOT' | 'WARM' | 'COLD';
/**
 * The appointment types a consultant can book from the Appointments module.
 * Shared by the filter, the create/edit dialogs, and the mutation contracts so
 * the three cannot drift apart again.
 */
export const schedulableAppointmentTypes = [
  'Showroom Visit',
  'Video Call',
  'Consultant Call',
] as const;
export type SchedulableAppointmentType = (typeof schedulableAppointmentTypes)[number];

/**
 * Test drives are deliberately absent. They live in their own module, on their
 * own `test_drive_appointments` table, and an appointment typed "Test Drive"
 * was never connected to any of it: no vehicle, no registration, no route, no
 * feedback, and invisible to the Test Drives page. Scheduling one through
 * Appointments produced a record that looked booked and was not.
 */
export type AppointmentTypeFilter = 'all' | 'Showroom Visit' | 'Video Call' | 'Consultant Call';

export type WorkQuery = {
  page: number;
  pageSize: WorkPageSize;
  search: string;
  /** Exact appointment selected from a dashboard card; intentionally not shown as search text. */
  appointmentId: string;
  status: WorkStatusFilter;
  priority: WorkPriorityFilter;
  appointmentType: AppointmentTypeFilter;
  branchId: string;
  teamId: string;
  ownerId: string;
  model: string;
  source: string;
  temperature: WorkLeadTemperatureFilter;
  followupFrom: string;
  followupTo: string;
  sort: WorkSort;
};

export const defaultWorkQuery: WorkQuery = {
  page: 1,
  pageSize: 25,
  search: '',
  appointmentId: '',
  status: 'all',
  priority: 'all',
  appointmentType: 'all',
  branchId: 'all',
  teamId: 'all',
  ownerId: 'all',
  model: '',
  source: '',
  temperature: 'all',
  followupFrom: '',
  followupTo: '',
  sort: 'scheduled:asc',
};

function allowedFilters(kind: WorkKind) {
  return kind === 'followups' ? followupFilters : appointmentFilters;
}

/**
 * Follow-ups open on Today — the consultant's actual shift — while appointments
 * open on the full list.
 *
 * Parsing and serialising must agree on this. They did not: the serialiser
 * dropped `status` whenever it was 'all', so choosing the All tab produced a URL
 * with no status, which parsed straight back to Today. The tab worked until you
 * reloaded or shared the link.
 */
export function defaultWorkStatus(kind: WorkKind): WorkStatusFilter {
  return kind === 'followups' ? 'today' : 'all';
}

export function parseWorkQuery(params: URLSearchParams, kind: WorkKind): WorkQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const status = params.get('status');
  const sort = params.get('sort');
  const filters = allowedFilters(kind);
  const priority = params.get('priority');
  const appointmentType = params.get('type');
  const appointmentId = params.get('appointment') ?? '';

  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: workPageSizes.includes(pageSize as WorkPageSize) ? (pageSize as WorkPageSize) : 25,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    appointmentId: kind === 'appointments' && isUuid(appointmentId) ? appointmentId : '',
    status: filters.includes(status as never)
      ? (status as WorkStatusFilter)
      : defaultWorkStatus(kind),
    priority: ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority ?? '')
      ? (priority as WorkPriorityFilter)
      : 'all',
    appointmentType: ['Showroom Visit', 'Video Call', 'Consultant Call'].includes(
      appointmentType ?? '',
    )
      ? (appointmentType as AppointmentTypeFilter)
      : 'all',
    branchId: isUuid(params.get('branch') ?? '') ? (params.get('branch') as string) : 'all',
    teamId: isUuid(params.get('team') ?? '') ? (params.get('team') as string) : 'all',
    ownerId: isUuid(params.get('owner') ?? '') ? (params.get('owner') as string) : 'all',
    model: (params.get('model') ?? '').trim().slice(0, 160),
    source: (params.get('source') ?? '').trim().slice(0, 100),
    temperature: ['HOT', 'WARM', 'COLD'].includes(params.get('temperature') ?? '')
      ? (params.get('temperature') as WorkLeadTemperatureFilter)
      : 'all',
    followupFrom: (params.get('followupFrom') ?? '').slice(0, 10),
    followupTo: (params.get('followupTo') ?? '').slice(0, 10),
    sort: workSorts.includes(sort as WorkSort) ? (sort as WorkSort) : 'scheduled:asc',
  };
}

export function toWorkQueryString(query: WorkQuery, kind?: WorkKind) {
  // Without a kind the plain 'all' default applies, which keeps the existing
  // single-argument callers behaving exactly as before.
  const defaultStatus = kind ? defaultWorkStatus(kind) : 'all';
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.appointmentId) params.set('appointment', query.appointmentId);
  if (query.status !== defaultStatus) params.set('status', query.status);
  if (query.priority && query.priority !== 'all') params.set('priority', query.priority);
  if (query.appointmentType && query.appointmentType !== 'all')
    params.set('type', query.appointmentType);
  if (query.branchId !== 'all') params.set('branch', query.branchId);
  if (query.teamId !== 'all') params.set('team', query.teamId);
  if (query.ownerId !== 'all') params.set('owner', query.ownerId);
  if (query.model) params.set('model', query.model);
  if (query.source) params.set('source', query.source);
  if (query.temperature !== 'all') params.set('temperature', query.temperature);
  if (query.followupFrom) params.set('followupFrom', query.followupFrom);
  if (query.followupTo) params.set('followupTo', query.followupTo);
  if (query.sort !== 'scheduled:asc') params.set('sort', query.sort);
  return params.toString();
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class WorkVersionConflictError extends Error {
  constructor() {
    super('WORK_VERSION_CONFLICT');
    this.name = 'WorkVersionConflictError';
  }
}

export function isWorkVersionConflict(error: unknown) {
  return (
    error instanceof WorkVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        (error as { message?: string }).message === 'WORK_VERSION_CONFLICT'))
  );
}
