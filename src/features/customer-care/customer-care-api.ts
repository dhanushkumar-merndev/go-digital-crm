import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  isCustomerCareVersionConflict,
  type CustomerCareQuery,
  type CustomerCareType,
} from './customer-care-query';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();

export const customerCareRecordSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  customer_id: z.uuid(),
  booking_id: nullableUuid,
  vehicle_id: nullableUuid,
  case_number: z.string(),
  case_type: z.string(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  status: z.string(),
  assigned_user_id: nullableUuid,
  subject: z.string(),
  description: z.string(),
  resolution: nullableString,
  sla_due_at: z.string(),
  first_contacted_at: nullableString,
  resolved_at: nullableString,
  closed_at: nullableString,
  version: z.coerce.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  customer_name: z.string(),
  phone: nullableString,
  booking_number: nullableString,
  vehicle: nullableString,
  assigned_user_name: nullableString,
  escalated: z.boolean(),
});
export type CustomerCareRecord = z.infer<typeof customerCareRecordSchema>;

const chartDatumSchema = z.object({
  name: z.string(),
  value: z.coerce.number().nonnegative(),
  secondary: z.coerce.number().nonnegative().optional(),
});
const workspaceSchema = z.object({
  organization_id: z.uuid(),
  records: z.array(customerCareRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    open: z.coerce.number().int().nonnegative(),
    followups_due: z.coerce.number().int().nonnegative(),
    feedback_pending: z.coerce.number().int().nonnegative(),
    review_pending: z.coerce.number().int().nonnegative(),
    complaints_open: z.coerce.number().int().nonnegative(),
    sla_risk: z.coerce.number().int().nonnegative(),
    resolved_today: z.coerce.number().int().nonnegative(),
    average_resolution_hours: z.coerce.number().nonnegative(),
  }),
  status_chart: z.array(chartDatumSchema),
  activity_chart: z.array(chartDatumSchema),
});
export type CustomerCareWorkspaceResult = z.infer<typeof workspaceSchema>;

export async function fetchCustomerCareWorkspace(query: CustomerCareQuery, signal?: AbortSignal) {
  const request = createClient().rpc('get_customer_care_workspace_page', {
    target_view: query.view,
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export async function fetchCustomerCarePermissions() {
  const supabase = createClient();
  const { data: context, error: contextError } = await supabase.rpc('get_access_context');
  if (contextError) throw contextError;
  const access = context as {
    destination?: string;
    organization_id?: string;
    user_id?: string;
  } | null;
  if (access?.destination !== 'CRM' || !access.organization_id || !access.user_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  const [manage, escalate] = await Promise.all(
    ['customer_care.manage', 'customer_care.escalate'].map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: access.organization_id,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  if (manage.error) throw manage.error;
  if (escalate.error) throw escalate.error;
  return {
    organizationId: access.organization_id,
    userId: access.user_id,
    canManage: Boolean(manage.data),
    canEscalate: Boolean(escalate.data),
  };
}

const customerOptionSchema = z.object({
  customer_id: z.uuid(),
  customer_name: z.string(),
  phone: nullableString,
  booking_id: z.uuid(),
  booking_number: z.string(),
  branch_id: z.uuid(),
  vehicle_id: nullableUuid,
  vehicle: nullableString,
  updated_at: z.string(),
});
export type CustomerCareCustomerOption = z.infer<typeof customerOptionSchema>;

export async function fetchCustomerCareCustomerOptions(search: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_customer_care_customer_options', {
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(customerOptionSchema).parse(data ?? []);
}

const mutationResultSchema = z.object({
  id: z.uuid(),
  case_number: z.string(),
  status: z.string(),
  version: z.coerce.number().int().positive(),
  replayed: z.boolean(),
});

export async function createCustomerCareCase(input: {
  customerId: string;
  bookingId: string;
  vehicleId?: string;
  caseType: CustomerCareType;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  subject: string;
  description: string;
  assignedUserId?: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_customer_care_case', {
    target_customer_id: input.customerId,
    target_booking_id: input.bookingId,
    target_vehicle_id: input.vehicleId || null,
    target_case_type: input.caseType,
    target_priority: input.priority,
    target_subject: input.subject,
    target_description: input.description,
    target_assigned_user_id: input.assignedUserId || null,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

export async function updateCustomerCareCase(input: {
  caseId: string;
  expectedVersion: number;
  status: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  resolution?: string;
  feedbackRating?: number;
  feedbackComments?: string;
  escalationReason?: string;
  escalationSeverity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reason: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('update_customer_care_case', {
    target_case_id: input.caseId,
    expected_version: input.expectedVersion,
    target_status: input.status,
    target_priority: input.priority,
    target_resolution: input.resolution || null,
    target_feedback_rating: input.feedbackRating ?? null,
    target_feedback_comments: input.feedbackComments || null,
    target_escalation_reason: input.escalationReason || null,
    target_escalation_severity: input.escalationSeverity || null,
    target_reason: input.reason || null,
    target_request_id: input.requestId,
  });
  if (error) {
    if (isCustomerCareVersionConflict(error)) throw new Error('CUSTOMER_CARE_VERSION_CONFLICT');
    throw error;
  }
  return mutationResultSchema.parse(data);
}
