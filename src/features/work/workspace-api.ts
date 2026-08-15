import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { WorkVersionConflictError, type WorkKind, type WorkQuery } from './workspace-query';

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
  appointment_type: z.enum(['Showroom Visit', 'Test Drive']),
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

const followupWorkspaceSchema = z.object({
  records: z.array(followupRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    overdue: z.coerce.number().int().nonnegative(),
    today: z.coerce.number().int().nonnegative(),
    upcoming: z.coerce.number().int().nonnegative(),
    completed_today: z.coerce.number().int().nonnegative(),
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

export type WorkWorkspacePermissions = {
  organizationId: string;
  userId: string;
  scopeKey: string;
  canCreate: boolean;
  canUpdate: boolean;
  canComplete: boolean;
  canCancel: boolean;
  canAssign: boolean;
  canOverrideComplete: boolean;
};

function permissionKeys(kind: WorkKind) {
  const resource = kind === 'followups' ? 'followup' : 'appointment';
  return [
    `${resource}.create`,
    `${resource}.update`,
    `${resource}.complete`,
    `${resource}.cancel`,
    `${resource}.assign`,
    kind === 'followups' ? 'followup.override_complete' : `${resource}.complete`,
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
  return {
    organizationId: context.organization_id,
    userId: context.user_id,
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    canCreate: Boolean(permissionResults[0]?.data),
    canUpdate: Boolean(permissionResults[1]?.data),
    canComplete: Boolean(permissionResults[2]?.data),
    canCancel: Boolean(permissionResults[3]?.data),
    canAssign: Boolean(permissionResults[4]?.data),
    canOverrideComplete: Boolean(permissionResults[5]?.data),
  };
}

function nullableFilter(value: string) {
  return value === 'all' ? null : value;
}

export async function fetchWorkWorkspace(
  kind: WorkKind,
  query: WorkQuery,
  timezone: string,
): Promise<WorkWorkspaceResult> {
  const functionName =
    kind === 'followups' ? 'get_followup_workspace_page' : 'get_appointment_workspace_page';
  const parameters: Record<string, string | number | null> = {
    target_search: query.search,
    target_status: query.status,
    target_branch_id: nullableFilter(query.branchId),
    target_team_id: nullableFilter(query.teamId),
    target_owner_id: nullableFilter(query.ownerId),
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: timezone,
  };
  if (kind === 'followups') parameters.target_priority = query.priority;
  else parameters.target_appointment_type = query.appointmentType;
  const { data, error } = await createClient().rpc(functionName, parameters);
  if (error) throw error;
  return kind === 'followups'
    ? followupWorkspaceSchema.parse(data)
    : appointmentWorkspaceSchema.parse(data);
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

export async function fetchWorkCreateOptions(kind: WorkKind, search = '') {
  const { data, error } = await createClient().rpc('get_work_create_options', {
    target_kind: kind,
    target_search: search,
  });
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
  appointmentType: 'Showroom Visit' | 'Test Drive';
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
    appointment_type?: 'Showroom Visit' | 'Test Drive';
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

export async function completeWork(input: {
  kind: WorkKind;
  id: string;
  expectedVersion: number;
  note: string;
  requestId: string;
}) {
  const functionName = input.kind === 'followups' ? 'complete_followup' : 'complete_appointment';
  const idKey = input.kind === 'followups' ? 'target_followup_id' : 'target_appointment_id';
  const { data, error } = await createClient().rpc(functionName, {
    [idKey]: input.id,
    expected_version: input.expectedVersion,
    completion_note: input.note || null,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return mutationResultSchema.parse(data);
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
