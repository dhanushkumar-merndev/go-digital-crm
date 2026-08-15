import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  SalesDocumentVersionConflictError,
  isSalesDocumentVersionConflict,
  salesStatusValue,
  type SalesDocumentKind,
  type SalesDocumentQuery,
} from './sales-document-query';

const nullableUuid = z.uuid().nullable();
const nullableString = z.string().nullable();

export const quotationItemSchema = z.object({
  item_type: z.string(),
  description: z.string(),
  quantity: z.coerce.number().positive(),
  unit_price: z.coerce.number().nonnegative(),
  adjustment: z.coerce.number(),
});
export type QuotationItem = z.infer<typeof quotationItemSchema>;

export const quotationRecordSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: nullableUuid,
  customer_id: z.uuid(),
  lead_id: nullableUuid,
  assigned_user_id: z.uuid(),
  quotation_number: z.string(),
  status: z.string(),
  current_version: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive(),
  total_amount: z.coerce.number().nonnegative(),
  approval_status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  customer_name: z.string(),
  phone: nullableString,
  branch_name: z.string(),
  team_name: nullableString,
  assigned_user_name: z.string(),
  interested_model: nullableString,
  items: z.array(quotationItemSchema),
});
export type QuotationRecord = z.infer<typeof quotationRecordSchema>;

export const bookingRecordSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: nullableUuid,
  customer_id: z.uuid(),
  lead_id: nullableUuid,
  quotation_id: nullableUuid,
  assigned_user_id: z.uuid(),
  booking_number: z.string(),
  quotation_number: nullableString,
  status: z.string(),
  booking_amount: z.coerce.number().positive(),
  total_value: z.coerce.number().nonnegative().nullable(),
  finance_required: z.boolean(),
  exchange_required: z.boolean(),
  expected_delivery_date: nullableString,
  version: z.coerce.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  customer_name: z.string(),
  phone: nullableString,
  branch_name: z.string(),
  team_name: nullableString,
  assigned_user_name: z.string(),
  interested_model: nullableString,
});
export type BookingRecord = z.infer<typeof bookingRecordSchema>;
export type SalesDocumentRecord = QuotationRecord | BookingRecord;

const quotationWorkspaceSchema = z.object({
  records: z.array(quotationRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    open: z.coerce.number().int().nonnegative(),
    sent: z.coerce.number().int().nonnegative(),
    approval_required: z.coerce.number().int().nonnegative(),
    converted: z.coerce.number().int().nonnegative(),
    pipeline_value: z.coerce.number().nonnegative(),
  }),
});

const bookingWorkspaceSchema = z.object({
  records: z.array(bookingRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    bookings: z.coerce.number().int().nonnegative(),
    booking_value: z.coerce.number().nonnegative(),
    awaiting_allocation: z.coerce.number().int().nonnegative(),
    delivery_this_week: z.coerce.number().int().nonnegative(),
    delivered: z.coerce.number().int().nonnegative(),
  }),
});

export type QuotationWorkspaceResult = z.infer<typeof quotationWorkspaceSchema>;
export type BookingWorkspaceResult = z.infer<typeof bookingWorkspaceSchema>;
export type SalesDocumentWorkspaceResult = QuotationWorkspaceResult | BookingWorkspaceResult;

export type SalesDocumentPermissions = {
  organizationId: string;
  scopeKey: string;
  canManage: boolean;
  canApprove: boolean;
};

export async function fetchSalesDocumentPermissions(
  kind: SalesDocumentKind,
): Promise<SalesDocumentPermissions> {
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
  const resource = kind === 'quotations' ? 'quotation' : 'booking';
  const [viewResponse, manageResponse, approvalResponse] = await Promise.all([
    supabase.rpc('authorize_action', {
      target_organization_id: context.organization_id,
      target_permission: `${resource}.view`,
      target_branch_id: null,
    }),
    supabase.rpc('authorize_action', {
      target_organization_id: context.organization_id,
      target_permission: `${resource}.manage`,
      target_branch_id: null,
    }),
    supabase.rpc('authorize_action', {
      target_organization_id: context.organization_id,
      target_permission: 'approval.decide',
      target_branch_id: null,
    }),
  ]);
  const failed = [viewResponse, manageResponse, approvalResponse].find(
    (response) => response.error,
  );
  if (failed?.error) throw failed.error;
  if (!viewResponse.data && !manageResponse.data)
    throw new Error(`${resource.toUpperCase()}_VIEW_PERMISSION_REQUIRED`);
  return {
    organizationId: context.organization_id,
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    canManage: Boolean(manageResponse.data),
    canApprove: kind === 'quotations' && Boolean(approvalResponse.data),
  };
}

export async function fetchSalesDocumentWorkspace(
  kind: SalesDocumentKind,
  query: SalesDocumentQuery,
  signal?: AbortSignal,
): Promise<SalesDocumentWorkspaceResult> {
  const request = createClient().rpc(
    kind === 'quotations' ? 'get_quotation_workspace_page' : 'get_booking_workspace_page',
    {
      target_search: query.search,
      target_status: salesStatusValue(query.status),
      target_page: query.page,
      target_page_size: query.pageSize,
      target_sort: query.sort,
    },
  );
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return kind === 'quotations'
    ? quotationWorkspaceSchema.parse(data)
    : bookingWorkspaceSchema.parse(data);
}

const quotationLeadOptionSchema = z.object({
  lead_id: z.uuid(),
  customer_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: nullableUuid,
  assigned_user_id: nullableUuid,
  customer_name: z.string(),
  phone: nullableString,
  interested_model: nullableString,
  branch_name: z.string(),
  lifecycle_status: z.string(),
  updated_at: z.string(),
});
export type QuotationLeadOption = z.infer<typeof quotationLeadOptionSchema>;

export async function fetchQuotationLeadOptions(search = '', signal?: AbortSignal) {
  const request = createClient().rpc('get_quotation_lead_options', {
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(quotationLeadOptionSchema).parse(data);
}

const bookingQuotationOptionSchema = z.object({
  quotation_id: z.uuid(),
  quotation_number: z.string(),
  customer_id: z.uuid(),
  lead_id: nullableUuid,
  branch_id: z.uuid(),
  team_id: nullableUuid,
  assigned_user_id: z.uuid(),
  version: z.coerce.number().int().positive(),
  total_amount: z.coerce.number().positive(),
  customer_name: z.string(),
  phone: nullableString,
  interested_model: nullableString,
  branch_name: z.string(),
  updated_at: z.string(),
});
export type BookingQuotationOption = z.infer<typeof bookingQuotationOptionSchema>;

export async function fetchBookingQuotationOptions(search = '', signal?: AbortSignal) {
  const request = createClient().rpc('get_booking_quotation_options', {
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(bookingQuotationOptionSchema).parse(data);
}

const mutationResultSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  status: z.string(),
  replayed: z.boolean(),
  approval_status: z.string().optional(),
  current_version: z.coerce.number().int().positive().optional(),
  total_amount: z.coerce.number().nonnegative().optional(),
  booking_number: z.string().optional(),
  quotation_id: z.uuid().optional(),
  expected_delivery_date: nullableString.optional(),
});

async function parseMutation<T>(request: PromiseLike<{ data: unknown; error: unknown }>, kind: T) {
  const { data, error } = await request;
  if (error) {
    if (isSalesDocumentVersionConflict(error))
      throw new SalesDocumentVersionConflictError(kind === 'quotation' ? 'quotation' : 'booking');
    throw error;
  }
  return mutationResultSchema.parse(data);
}

export type SaveQuotationInput = {
  quotationId: string | null;
  expectedVersion: number | null;
  leadId: string;
  items: QuotationItem[];
  requestId: string;
};

export async function saveQuotation(input: SaveQuotationInput) {
  return parseMutation(
    createClient().rpc('save_quotation', {
      target_quotation_id: input.quotationId,
      expected_version: input.expectedVersion,
      target_lead_id: input.leadId,
      target_items: input.items,
      target_request_id: input.requestId,
    }),
    'quotation',
  );
}

export async function transitionQuotation(input: {
  quotationId: string;
  expectedVersion: number;
  status: string;
  reason: string;
  requestId: string;
}) {
  return parseMutation(
    createClient().rpc('transition_quotation_status', {
      target_quotation_id: input.quotationId,
      expected_version: input.expectedVersion,
      target_status: input.status,
      change_reason: input.reason || null,
      target_request_id: input.requestId,
    }),
    'quotation',
  );
}

export async function decideQuotationApproval(input: {
  quotationId: string;
  expectedVersion: number;
  decision: 'APPROVED' | 'REJECTED';
  comment: string;
  requestId: string;
}) {
  return parseMutation(
    createClient().rpc('decide_quotation_approval', {
      target_quotation_id: input.quotationId,
      expected_version: input.expectedVersion,
      target_decision: input.decision,
      decision_comment: input.comment || null,
      target_request_id: input.requestId,
    }),
    'quotation',
  );
}

export async function createBooking(input: {
  quotationId: string;
  expectedQuotationVersion: number;
  bookingAmount: number;
  financeRequired: boolean;
  exchangeRequired: boolean;
  expectedDeliveryDate: string | null;
  requestId: string;
}) {
  return parseMutation(
    createClient().rpc('create_booking_from_quotation', {
      target_quotation_id: input.quotationId,
      expected_quotation_version: input.expectedQuotationVersion,
      target_booking_amount: input.bookingAmount,
      target_finance_required: input.financeRequired,
      target_exchange_required: input.exchangeRequired,
      target_expected_delivery_date: input.expectedDeliveryDate,
      target_request_id: input.requestId,
    }),
    'booking',
  );
}

export async function transitionBooking(input: {
  bookingId: string;
  expectedVersion: number;
  status: string;
  reason: string;
  expectedDeliveryDate: string | null;
  requestId: string;
}) {
  return parseMutation(
    createClient().rpc('transition_booking_status', {
      target_booking_id: input.bookingId,
      expected_version: input.expectedVersion,
      target_status: input.status,
      change_reason: input.reason || null,
      target_expected_delivery_date: input.expectedDeliveryDate,
      target_request_id: input.requestId,
    }),
    'booking',
  );
}
