import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  WorkVersionConflictError,
  type SchedulableAppointmentType,
  type WorkKind,
  type WorkQuery,
} from './workspace-query';

const nullableString = z.string().nullable();

const filterOptionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

const teamFilterOptionSchema = filterOptionSchema.extend({ branch_id: z.uuid() });

const filtersSchema = z.object({
  branches: z.array(filterOptionSchema),
  teams: z.array(teamFilterOptionSchema),
  owners: z.array(filterOptionSchema),
  models: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
});

export const followupRecordSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  lead_id: z.uuid().nullable(),
  customer_id: z.uuid().nullable(),
  customer_name: z.string(),
  phone: nullableString,
  interested_model: nullableString,
  reason: z.string(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  due_at: z.string(),
  display_status: z.string(),
  status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED', 'OVERDUE']),
  assigned_user_id: z.uuid(),
  assigned_user_name: z.string(),
  created_by: z.uuid().nullable(),
  created_by_name: nullableString,
  branch_id: z.uuid(),
  branch_name: z.string(),
  team_id: z.uuid().nullable(),
  team_name: nullableString,
  completed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  updated_at: z.string(),
});

export const appointmentRecordSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  lead_id: z.uuid().nullable(),
  customer_id: z.uuid(),
  customer_name: z.string(),
  phone: nullableString,
  interested_model: nullableString,
  // 'Test Drive' stays readable here and only here: the type can no longer be
  // chosen, but appointments booked with it before the split still exist and
  // must keep rendering rather than failing the whole page on a parse error.
  appointment_type: z.enum(['Showroom Visit', 'Video Call', 'Test Drive', 'Consultant Call']),
  scheduled_at: z.string(),
  status: z.enum(['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']),
  attendance_status: z.enum(['NOT_ARRIVED', 'ARRIVED', 'COMPLETED', 'NO_SHOW']),
  notes: nullableString,
  assigned_user_id: z.uuid(),
  assigned_user_name: z.string(),
  created_by: z.uuid().nullable(),
  created_by_name: nullableString,
  branch_id: z.uuid(),
  branch_name: z.string(),
  team_id: z.uuid().nullable(),
  team_name: nullableString,
  confirmed_at: z.string().nullable(),
  arrived_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  updated_at: z.string(),
});

export type FollowupRecord = z.infer<typeof followupRecordSchema>;
export type AppointmentRecord = z.infer<typeof appointmentRecordSchema>;
export type WorkRecord = FollowupRecord | AppointmentRecord;

/**
 * `kpis` is the consultant's standing workload and is deliberately blind to the
 * search box — it answers "how much do I owe", not "how much matches what I
 * typed". `status_counts` is the opposite: it is measured over the same scope
 * *and* search the table is showing, with the status filter left off, so the
 * six tab counts always sum to the unfiltered total of the current view.
 */
const followupWorkspaceSchema = z.object({
  records: z.array(followupRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    overdue: z.coerce.number().int().nonnegative(),
    today: z.coerce.number().int().nonnegative(),
    upcoming: z.coerce.number().int().nonnegative(),
    completed_today: z.coerce.number().int().nonnegative(),
  }),
  status_counts: z.object({
    all: z.coerce.number().int().nonnegative(),
    overdue: z.coerce.number().int().nonnegative(),
    today: z.coerce.number().int().nonnegative(),
    upcoming: z.coerce.number().int().nonnegative(),
    completed: z.coerce.number().int().nonnegative(),
    cancelled: z.coerce.number().int().nonnegative(),
  }),
  filters: filtersSchema,
  timezone: z.string(),
});

const appointmentWorkspaceSchema = z.object({
  records: z.array(appointmentRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    today: z.coerce.number().int().nonnegative(),
    upcoming: z.coerce.number().int().nonnegative(),
    confirmed: z.coerce.number().int().nonnegative(),
    completed: z.coerce.number().int().nonnegative(),
    no_show: z.coerce.number().int().nonnegative(),
    arrived: z.coerce.number().int().nonnegative(),
  }),
  filters: filtersSchema,
  timezone: z.string(),
});

export type FollowupWorkspaceResult = z.infer<typeof followupWorkspaceSchema>;
export type AppointmentWorkspaceResult = z.infer<typeof appointmentWorkspaceSchema>;
export type WorkWorkspaceResult = FollowupWorkspaceResult | AppointmentWorkspaceResult;

const followupCalendarSchema = z.object({
  month: z.string(),
  month_total: z.coerce.number().int().nonnegative(),
  status_counts: z.object({
    all: z.coerce.number().int().nonnegative(),
    overdue: z.coerce.number().int().nonnegative(),
    today: z.coerce.number().int().nonnegative(),
    upcoming: z.coerce.number().int().nonnegative(),
    completed: z.coerce.number().int().nonnegative(),
    cancelled: z.coerce.number().int().nonnegative(),
  }),
  days: z.array(
    z.object({
      date: z.string(),
      total: z.coerce.number().int().nonnegative(),
      items: z.array(followupRecordSchema),
    }),
  ),
  timezone: z.string(),
});

export type FollowupCalendarResult = z.infer<typeof followupCalendarSchema>;

const appointmentCalendarSchema = z.object({
  month: z.string(),
  month_total: z.coerce.number().int().nonnegative(),
  days: z.array(
    z.object({
      date: z.string(),
      total: z.coerce.number().int().nonnegative(),
      items: z.array(appointmentRecordSchema),
    }),
  ),
  timezone: z.string(),
});

export type AppointmentCalendarResult = z.infer<typeof appointmentCalendarSchema>;

export type WorkWorkspacePermissions = {
  organizationId: string;
  userId: string;
  scopeKey: string;
  /**
   * Raw `data_scope` for this session. Needed because the follow-up list now
   * includes rows owned by other users, and only an OWN_RECORDS viewer is
   * actually barred from writing to them — `scopeKey` cannot be parsed for
   * this, its shape differs between the bootstrap and legacy paths.
   */
  dataScope: string | null;
  canCreate: boolean;
  canUpdate: boolean;
  canComplete: boolean;
  canCancel: boolean;
  canAssign: boolean;
  canOverrideComplete: boolean;
};

function permissionKeys(kind: WorkKind) {
  const resource = kind === 'followups' ? 'followup' : 'appointment';
  if (kind === 'followups') {
    // Follow-ups are created from a lead context. The list is tracking-only,
    // so it does not need to request the create permission or load the create
    // dialog's customer/lead search endpoint.
    return [
      `${resource}.update`,
      `${resource}.complete`,
      `${resource}.cancel`,
      `${resource}.assign`,
      'followup.override_complete',
    ];
  }
  return [
    `${resource}.create`,
    `${resource}.update`,
    `${resource}.complete`,
    `${resource}.cancel`,
    `${resource}.assign`,
    `${resource}.complete`,
  ];
}

export async function fetchWorkWorkspacePermissions(
  kind: WorkKind,
): Promise<WorkWorkspacePermissions> {
  const supabase = createClient();
  const contextResponse = await supabase.rpc('get_access_context');
  if (contextResponse.error) throw contextResponse.error;
  const context = contextResponse.data as {
    destination?: string;
    organization_id?: string;
    user_id?: string;
    role_key?: string;
    data_scope?: string;
  } | null;
  if (context?.destination !== 'CRM' || !context.organization_id || !context.user_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');

  const keys = permissionKeys(kind);
  const permissionResults = await Promise.all(
    keys.map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: context.organization_id,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  const failed = permissionResults.find((response) => response.error);
  if (failed?.error) throw failed.error;
  const permissionOffset = kind === 'appointments' ? 1 : 0;
  return {
    organizationId: context.organization_id,
    userId: context.user_id,
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    dataScope: context.data_scope ?? null,
    canCreate: kind === 'appointments' && Boolean(permissionResults[0]?.data),
    canUpdate: Boolean(permissionResults[permissionOffset]?.data),
    canComplete: Boolean(permissionResults[permissionOffset + 1]?.data),
    canCancel: Boolean(permissionResults[permissionOffset + 2]?.data),
    canAssign: Boolean(permissionResults[permissionOffset + 3]?.data),
    canOverrideComplete: Boolean(permissionResults[permissionOffset + 4]?.data),
  };
}

function nullableFilter(value: string) {
  return value === 'all' ? null : value;
}

export async function fetchWorkWorkspace(
  kind: WorkKind,
  query: WorkQuery,
  timezone: string,
  signal?: AbortSignal,
): Promise<WorkWorkspaceResult> {
  const functionName =
    kind === 'followups'
      ? 'get_followup_workspace_filtered_page'
      : 'get_appointment_workspace_page';
  const parameters: Record<string, string | number | null> = {
    target_search:
      kind === 'appointments' && query.appointmentId ? query.appointmentId : query.search,
    target_status: query.status,
    target_branch_id: nullableFilter(query.branchId),
    target_team_id: nullableFilter(query.teamId),
    target_owner_id: nullableFilter(query.ownerId),
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: timezone,
  };
  if (kind === 'followups') {
    parameters.target_priority = query.priority;
    parameters.target_model = query.model;
    parameters.target_source = query.source;
    parameters.target_temperature = query.temperature;
    parameters.target_followup_from = query.followupFrom || null;
    parameters.target_followup_to = query.followupTo || null;
  } else parameters.target_appointment_type = query.appointmentType;
  const request = createClient().rpc(functionName, parameters);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return kind === 'followups'
    ? followupWorkspaceSchema.parse(data)
    : appointmentWorkspaceSchema.parse(data);
}

export async function fetchFollowupCalendar(
  input: {
    month: string;
    day?: string | null;
    query: WorkQuery;
    timezone: string;
  },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_followup_calendar', {
    target_month: input.month,
    target_day: input.day ?? null,
    target_search: input.query.search,
    target_status: input.query.status,
    target_priority: input.query.priority,
    target_branch_id: nullableFilter(input.query.branchId),
    target_team_id: nullableFilter(input.query.teamId),
    target_owner_id: nullableFilter(input.query.ownerId),
    target_timezone: input.timezone,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return followupCalendarSchema.parse(data);
}

export async function fetchAppointmentCalendar(
  input: {
    month: string;
    day?: string | null;
    query: WorkQuery;
    timezone: string;
  },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_appointment_calendar', {
    target_month: input.month,
    target_day: input.day ?? null,
    target_search: input.query.appointmentId || input.query.search,
    target_status: input.query.status,
    target_appointment_type: input.query.appointmentType,
    target_branch_id: nullableFilter(input.query.branchId),
    target_team_id: nullableFilter(input.query.teamId),
    target_owner_id: nullableFilter(input.query.ownerId),
    target_timezone: input.timezone,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return appointmentCalendarSchema.parse(data);
}

export async function fetchAppointmentTypeSummary(timezone: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_appointment_type_summary', {
    target_timezone: timezone,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z
    .object({
      showroom_visit: z.coerce.number().int().nonnegative(),
      video_call: z.coerce.number().int().nonnegative(),
      test_drive: z.coerce.number().int().nonnegative(),
      consultant_call: z.coerce.number().int().nonnegative(),
    })
    .parse(data);
}

const entityOptionSchema = z.object({
  lead_id: z.uuid().nullable(),
  customer_id: z.uuid().nullable(),
  customer_name: z.string(),
  phone: nullableString,
  interested_model: nullableString,
  branch_id: z.uuid(),
  branch_name: z.string(),
  team_id: z.uuid().nullable(),
  team_name: nullableString,
  default_assigned_user_id: z.uuid().nullable(),
});

const userOptionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  branch_id: z.uuid(),
  team_id: z.uuid().nullable(),
});

const workCreateOptionsSchema = z.object({
  entities: z.array(entityOptionSchema),
  users: z.array(userOptionSchema),
});

export type WorkCreateOptions = z.infer<typeof workCreateOptionsSchema>;
export type WorkEntityOption = z.infer<typeof entityOptionSchema>;
export type WorkUserOption = z.infer<typeof userOptionSchema>;

export async function fetchWorkCreateOptions(kind: WorkKind, search = '', signal?: AbortSignal) {
  const request = createClient().rpc('get_work_create_options', {
    target_kind: kind,
    target_search: search,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workCreateOptionsSchema.parse(data);
}

export type WorkMutationResult = {
  id: string;
  version: number;
  status: string;
  replayed: boolean;
};

const mutationResultSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  status: z.string(),
  replayed: z.boolean(),
});

function throwMutationError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  if (error.code === '40001' || error.message === 'WORK_VERSION_CONFLICT')
    throw new WorkVersionConflictError();
  throw error;
}

export async function createFollowup(input: {
  entity: WorkEntityOption;
  assignedUserId: string;
  reason: string;
  dueAt: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_followup', {
    target_lead_id: input.entity.lead_id,
    target_customer_id: input.entity.customer_id,
    target_branch_id: input.entity.branch_id,
    target_team_id: input.entity.team_id,
    target_assigned_user_id: input.assignedUserId,
    followup_reason: input.reason,
    followup_due_at: input.dueAt,
    followup_priority: input.priority,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return mutationResultSchema.parse(data);
}

export async function createAppointment(input: {
  entity: WorkEntityOption;
  assignedUserId: string;
  appointmentType: SchedulableAppointmentType;
  scheduledAt: string;
  notes: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_appointment', {
    target_lead_id: input.entity.lead_id,
    target_customer_id: input.entity.customer_id,
    target_branch_id: input.entity.branch_id,
    target_team_id: input.entity.team_id,
    target_assigned_user_id: input.assignedUserId,
    target_appointment_type: input.appointmentType,
    target_scheduled_at: input.scheduledAt,
    target_notes: input.notes || null,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return mutationResultSchema.parse(data);
}

export async function updateFollowup(input: {
  id: string;
  expectedVersion: number;
  patch: {
    reason?: string;
    due_at?: string;
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    assigned_user_id?: string;
  };
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('update_followup', {
    target_followup_id: input.id,
    expected_version: input.expectedVersion,
    followup_patch: input.patch,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return mutationResultSchema.parse(data);
}

export async function updateAppointment(input: {
  id: string;
  expectedVersion: number;
  patch: {
    appointment_type?: SchedulableAppointmentType;
    scheduled_at?: string;
    notes?: string;
    assigned_user_id?: string;
    status?: 'SCHEDULED' | 'CONFIRMED' | 'RESCHEDULED' | 'NO_SHOW';
    attendance_status?: 'NOT_ARRIVED' | 'ARRIVED' | 'NO_SHOW';
  };
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('update_appointment', {
    target_appointment_id: input.id,
    expected_version: input.expectedVersion,
    appointment_patch: input.patch,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return mutationResultSchema.parse(data);
}

/**
 * What the consultant committed to when closing a follow-up. Completing one is
 * the moment the lead becomes advanceable — the Leads workspace blocks stage
 * changes while a follow-up is open — so the answer is captured rather than
 * left to a free-text note nothing can query.
 */
export const followupOutcomes = ['FOLLOW_UP', 'APPOINTMENT', 'LOST'] as const;
export type FollowupOutcome = (typeof followupOutcomes)[number];

export async function completeWork(input: {
  kind: WorkKind;
  id: string;
  expectedVersion: number;
  note: string;
  requestId: string;
  outcome?: FollowupOutcome;
}) {
  const functionName = input.kind === 'followups' ? 'complete_followup' : 'complete_appointment';
  const idKey = input.kind === 'followups' ? 'target_followup_id' : 'target_appointment_id';
  const parameters: Record<string, string | number | null> = {
    [idKey]: input.id,
    expected_version: input.expectedVersion,
    completion_note: input.note || null,
    target_request_id: input.requestId,
  };
  if (input.kind === 'followups') parameters.followup_outcome = input.outcome ?? null;
  const { data, error } = await createClient().rpc(functionName, parameters);
  throwMutationError(error);
  return mutationResultSchema.parse(data);
}

/**
 * The lead's current `updated_at`, needed as the optimistic-concurrency token
 * for `update_lead`. A follow-up row does not carry it, and marking the lead
 * Lost from the completion dialog must not clobber an edit someone made in
 * between.
 */
export async function fetchLeadUpdatedAt(leadId: string) {
  const { data, error } = await createClient()
    .from('leads')
    .select('updated_at')
    .eq('id', leadId)
    .single();
  if (error) throw error;
  return z.object({ updated_at: z.string() }).parse(data).updated_at;
}

export async function cancelWork(input: {
  kind: WorkKind;
  id: string;
  expectedVersion: number;
  reason: string;
  requestId: string;
}) {
  const functionName = input.kind === 'followups' ? 'cancel_followup' : 'cancel_appointment';
  const idKey = input.kind === 'followups' ? 'target_followup_id' : 'target_appointment_id';
  const { data, error } = await createClient().rpc(functionName, {
    [idKey]: input.id,
    expected_version: input.expectedVersion,
    cancellation_reason: input.reason,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return mutationResultSchema.parse(data);
}
