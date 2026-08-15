import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  isTaskVersionConflict,
  TaskVersionConflictError,
  taskStatusValue,
  type TaskQuery,
} from './task-workspace-query';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();

export const taskRecordSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: nullableUuid,
  lead_id: nullableUuid,
  customer_id: nullableUuid,
  assigned_user_id: nullableUuid,
  title: z.string(),
  description: nullableString,
  priority: z.string(),
  status: z.string(),
  due_at: nullableString,
  completed_at: nullableString,
  completion_note: nullableString,
  version: z.coerce.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  branch_name: z.string(),
  team_name: nullableString,
  assigned_user_name: nullableString,
  customer_name: nullableString,
  phone: nullableString,
  interested_model: nullableString,
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;

const taskWorkspaceSchema = z.object({
  records: z.array(taskRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    overdue: z.coerce.number().int().nonnegative(),
    today: z.coerce.number().int().nonnegative(),
    upcoming: z.coerce.number().int().nonnegative(),
    completed_today: z.coerce.number().int().nonnegative(),
  }),
});
export type TaskWorkspaceResult = z.infer<typeof taskWorkspaceSchema>;

export type TaskPermissions = {
  organizationId: string;
  scopeKey: string;
  canCreate: boolean;
  canUpdate: boolean;
  canComplete: boolean;
  canCancel: boolean;
};

export async function fetchTaskPermissions(): Promise<TaskPermissions> {
  const supabase = createClient();
  const contextResponse = await supabase.rpc('get_access_context');
  if (contextResponse.error) throw contextResponse.error;
  const context = contextResponse.data as {
    destination?: string;
    organization_id?: string;
    role_key?: string;
    data_scope?: string;
  } | null;
  if (context?.destination !== 'CRM' || !context.organization_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  const responses = await Promise.all(
    ['task.view', 'task.create', 'task.update', 'task.complete', 'task.cancel'].map(
      (target_permission) =>
        supabase.rpc('authorize_action', {
          target_organization_id: context.organization_id,
          target_permission,
          target_branch_id: null,
        }),
    ),
  );
  const failed = responses.find((response) => response.error);
  if (failed?.error) throw failed.error;
  if (!responses[0]?.data) throw new Error('TASK_VIEW_PERMISSION_REQUIRED');
  return {
    organizationId: context.organization_id,
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    canCreate: Boolean(responses[1]?.data),
    canUpdate: Boolean(responses[2]?.data),
    canComplete: Boolean(responses[3]?.data),
    canCancel: Boolean(responses[4]?.data),
  };
}

export async function fetchTaskWorkspace(
  query: TaskQuery,
  timezone: string,
  signal?: AbortSignal,
): Promise<TaskWorkspaceResult> {
  const request = createClient().rpc('get_task_workspace_page', {
    target_search: query.search,
    target_status: taskStatusValue(query.status),
    target_priority: query.priority === 'all' ? 'ALL' : query.priority,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: timezone,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return taskWorkspaceSchema.parse(data);
}

const taskLeadOptionSchema = z.object({
  lead_id: z.uuid(),
  customer_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: nullableUuid,
  customer_name: z.string(),
  phone: nullableString,
  interested_model: nullableString,
  branch_name: z.string(),
  updated_at: z.string(),
});
export type TaskLeadOption = z.infer<typeof taskLeadOptionSchema>;

export async function fetchTaskLeadOptions(search: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_task_lead_options', {
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(taskLeadOptionSchema).parse(data);
}

const mutationResultSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  status: z.string(),
  replayed: z.boolean(),
});

async function taskMutation(request: PromiseLike<{ data: unknown; error: unknown }>) {
  const { data, error } = await request;
  if (error) {
    if (isTaskVersionConflict(error)) throw new TaskVersionConflictError();
    throw error;
  }
  return mutationResultSchema.parse(data);
}

export async function createTask(input: {
  leadId: string;
  title: string;
  description: string;
  priority: string;
  dueAt: string;
  requestId: string;
}) {
  return taskMutation(
    createClient().rpc('create_task', {
      target_lead_id: input.leadId,
      task_title: input.title,
      task_description: input.description || null,
      task_priority: input.priority,
      task_due_at: input.dueAt,
      target_request_id: input.requestId,
    }),
  );
}

export async function updateTask(input: {
  taskId: string;
  expectedVersion: number;
  patch: Record<string, unknown>;
  requestId: string;
}) {
  return taskMutation(
    createClient().rpc('update_task', {
      target_task_id: input.taskId,
      expected_version: input.expectedVersion,
      task_patch: input.patch,
      target_request_id: input.requestId,
    }),
  );
}

export async function completeTask(input: {
  taskId: string;
  expectedVersion: number;
  note: string;
  requestId: string;
}) {
  return taskMutation(
    createClient().rpc('complete_task', {
      target_task_id: input.taskId,
      expected_version: input.expectedVersion,
      completion_note: input.note || null,
      target_request_id: input.requestId,
    }),
  );
}

export async function cancelTask(input: {
  taskId: string;
  expectedVersion: number;
  reason: string;
  requestId: string;
}) {
  return taskMutation(
    createClient().rpc('cancel_task', {
      target_task_id: input.taskId,
      expected_version: input.expectedVersion,
      cancellation_reason: input.reason,
      target_request_id: input.requestId,
    }),
  );
}
