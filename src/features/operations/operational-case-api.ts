import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  isOperationalCaseVersionConflict,
  OperationalCaseVersionConflictError,
  type OperationalCaseDepartment,
  type OperationalCaseQuery,
} from './operational-case-query';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();

export const operationalCaseRecordSchema = z.object({
  department: z.enum(['FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY']),
  resource_type: z.enum([
    'finance_case',
    'insurance_case',
    'rto_case',
    'exchange_case',
    'delivery_case',
  ]),
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  booking_id: nullableUuid,
  customer_id: z.uuid(),
  assigned_user_id: nullableUuid,
  status: z.string(),
  version: z.coerce.number().int().positive(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  due_at: nullableString,
  created_at: z.string(),
  updated_at: z.string(),
  booking_number: nullableString,
  customer_name: z.string(),
  phone: nullableString,
  assigned_user_name: nullableString,
  details: z.record(z.string(), z.unknown()),
  document_count: z.coerce.number().int().nonnegative(),
});
export type OperationalCaseRecord = z.infer<typeof operationalCaseRecordSchema>;

const workspaceSchema = z.object({
  records: z.array(operationalCaseRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  organization_id: z.uuid(),
  department: z.enum(['FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY']),
  kpis: z.object({
    open: z.coerce.number().int().nonnegative(),
    pending_documents: z.coerce.number().int().nonnegative(),
    overdue: z.coerce.number().int().nonnegative(),
    due_today: z.coerce.number().int().nonnegative(),
    completed_this_month: z.coerce.number().int().nonnegative(),
  }),
});
export type OperationalCaseWorkspaceResult = z.infer<typeof workspaceSchema>;

export type OperationalCasePermissions = {
  organizationId: string;
  userId: string;
  scopeKey: string;
  canManage: boolean;
  canRequest: boolean;
  canUpload: boolean;
  canDownload: boolean;
};

function departmentPermission(department: OperationalCaseDepartment, action: 'view' | 'manage') {
  return `${department.toLowerCase()}.${action}`;
}

export async function fetchOperationalCasePermissions(
  department: OperationalCaseDepartment,
): Promise<OperationalCasePermissions> {
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
  const permissionKeys = [
    departmentPermission(department, 'view'),
    departmentPermission(department, 'manage'),
    department === 'EXCHANGE' ? 'exchange.request' : departmentPermission(department, 'manage'),
    'document.upload',
    'document.download',
  ];
  const responses = await Promise.all(
    permissionKeys.map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: context.organization_id,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  const failed = responses.find((response) => response.error);
  if (failed?.error) throw failed.error;
  if (!responses[0]?.data) throw new Error('OPERATIONAL_CASE_VIEW_PERMISSION_REQUIRED');
  return {
    organizationId: context.organization_id,
    userId: context.user_id,
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    canManage: Boolean(responses[1]?.data),
    canRequest: Boolean(responses[2]?.data),
    canUpload: Boolean(responses[3]?.data),
    canDownload: Boolean(responses[4]?.data),
  };
}

export async function fetchOperationalCaseWorkspace(
  department: OperationalCaseDepartment,
  query: OperationalCaseQuery,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_operational_case_workspace_page', {
    target_department: department,
    target_status: query.status,
    target_search: query.search,
    target_from_date: query.fromDate || null,
    target_to_date: query.toDate || null,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

const bookingOptionSchema = z.object({
  booking_id: z.uuid(),
  booking_number: z.string(),
  branch_id: z.uuid(),
  customer_id: z.uuid(),
  assigned_user_id: z.uuid(),
  customer_name: z.string(),
  phone: nullableString,
  expected_delivery_date: nullableString,
  updated_at: z.string(),
});
export type OperationalCaseBookingOption = z.infer<typeof bookingOptionSchema>;

export async function fetchOperationalCaseBookingOptions(
  department: OperationalCaseDepartment,
  search = '',
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_operational_case_booking_options', {
    target_department: department,
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(bookingOptionSchema).parse(data ?? []);
}

const mutationResultSchema = z.object({
  id: z.uuid(),
  department: z.enum(['FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY']),
  status: z.string(),
  version: z.coerce.number().int().positive(),
  assigned_user_id: z.uuid().optional(),
  replayed: z.boolean(),
});
export type OperationalCaseMutationResult = z.infer<typeof mutationResultSchema>;

async function mutation(request: PromiseLike<{ data: unknown; error: unknown }>) {
  const { data, error } = await request;
  if (error) {
    if (isOperationalCaseVersionConflict(error)) throw new OperationalCaseVersionConflictError();
    throw error;
  }
  return mutationResultSchema.parse(data);
}

export function createOperationalCase(input: {
  department: OperationalCaseDepartment;
  bookingId: string;
  vehicleId?: string;
  assignedUserId?: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  dueAt?: string;
  notes?: string;
  requestId: string;
}) {
  return mutation(
    createClient().rpc('create_operational_case', {
      target_department: input.department,
      target_booking_id: input.bookingId,
      target_vehicle_id: input.vehicleId || null,
      target_assigned_user_id: input.assignedUserId || null,
      target_priority: input.priority,
      target_due_at: input.dueAt || null,
      target_notes: input.notes || null,
      target_request_id: input.requestId,
    }),
  );
}

export function updateOperationalCase(input: {
  department: OperationalCaseDepartment;
  caseId: string;
  expectedVersion: number;
  status: string;
  patch: Record<string, unknown>;
  reason?: string;
  requestId: string;
}) {
  return mutation(
    createClient().rpc('update_operational_case', {
      target_department: input.department,
      target_case_id: input.caseId,
      expected_version: input.expectedVersion,
      target_status: input.status,
      target_patch: input.patch,
      target_reason: input.reason || null,
      target_request_id: input.requestId,
    }),
  );
}

const documentSchema = z.object({
  id: z.uuid(),
  file_name: z.string(),
  mime_type: z.string(),
  size_bytes: z.coerce.number().int().nonnegative(),
  created_at: z.string(),
});
export type OperationalCaseDocument = z.infer<typeof documentSchema>;
const checklistItemSchema = z.object({
  id: z.uuid(),
  category: z.string(),
  item: z.string(),
  completed: z.boolean(),
  completed_by: nullableUuid,
  completed_at: nullableString,
  version: z.coerce.number().int().positive(),
});
export type DeliveryChecklistItem = z.infer<typeof checklistItemSchema>;
const detailSchema = operationalCaseRecordSchema.extend({
  documents: z.array(documentSchema),
  checklist: z.array(checklistItemSchema),
});
export type OperationalCaseDetail = z.infer<typeof detailSchema>;

export async function fetchOperationalCaseDetail(
  department: OperationalCaseDepartment,
  caseId: string,
) {
  const { data, error } = await createClient().rpc('get_operational_case_detail', {
    target_department: department,
    target_case_id: caseId,
  });
  if (error) throw error;
  return detailSchema.parse(data);
}

export async function setDeliveryChecklistItem(input: {
  itemId: string;
  expectedVersion: number;
  completed: boolean;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('set_delivery_checklist_item', {
    target_item_id: input.itemId,
    expected_version: input.expectedVersion,
    target_completed: input.completed,
    target_request_id: input.requestId,
  });
  if (error) {
    if (isOperationalCaseVersionConflict(error)) throw new OperationalCaseVersionConflictError();
    throw error;
  }
  return z
    .object({
      id: z.uuid(),
      delivery_id: z.uuid(),
      completed: z.boolean(),
      version: z.coerce.number().int().positive(),
      case_version: z.coerce.number().int().positive(),
      case_status: z.string(),
      replayed: z.boolean(),
    })
    .parse(data);
}

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

async function sha256Base64(buffer: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function uploadOperationalCaseDocument(input: {
  organizationId: string;
  record: Pick<OperationalCaseRecord, 'id' | 'branch_id' | 'resource_type'>;
  file: File;
}) {
  const checksum = await sha256Base64(await input.file.arrayBuffer());
  const supabase = createClient();
  const { data: presign, error: presignError } = await supabase.functions.invoke<
    EdgeEnvelope<{
      upload_intent_id: string;
      upload_url: string;
      required_headers: Record<string, string>;
    }>
  >('presign-upload', {
    body: {
      organization_id: input.organizationId,
      branch_id: input.record.branch_id,
      resource_type: input.record.resource_type,
      resource_id: input.record.id,
      file_name: input.file.name,
      mime_type: input.file.type,
      size_bytes: input.file.size,
      checksum_sha256: checksum,
    },
  });
  if (presignError || !presign?.ok || !presign.data)
    throw presignError ?? new Error('DOCUMENT_UPLOAD_PRESIGN_FAILED');
  const uploaded = await fetch(presign.data.upload_url, {
    method: 'PUT',
    headers: presign.data.required_headers,
    body: input.file,
  });
  if (!uploaded.ok) throw new Error('DOCUMENT_UPLOAD_TRANSFER_FAILED');
  const { data: finalized, error: finalizeError } = await supabase.functions.invoke<
    EdgeEnvelope<{ object_file_id: string }>
  >('object-upload-finalize', {
    body: { upload_intent_id: presign.data.upload_intent_id },
  });
  if (finalizeError || !finalized?.ok || !finalized.data)
    throw finalizeError ?? new Error('DOCUMENT_UPLOAD_FINALIZE_FAILED');
  return finalized.data.object_file_id;
}

export async function downloadOperationalCaseDocument(objectFileId: string) {
  const { data, error } = await createClient().functions.invoke<
    EdgeEnvelope<{
      download_url: string;
      expires_at: string;
      file_name: string;
      mime_type: string;
      size_bytes: number;
    }>
  >('presign-download', { body: { object_file_id: objectFileId } });
  if (error || !data?.ok || !data.data) throw error ?? new Error('DOCUMENT_DOWNLOAD_FAILED');
  return data.data;
}
