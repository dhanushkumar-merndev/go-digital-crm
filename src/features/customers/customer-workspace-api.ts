import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { CustomerQuery } from './customer-workspace-query';

const nullableString = z.string().nullable();

export const customerRecordSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  primary_phone: nullableString,
  primary_email: nullableString,
  created_at: z.string(),
  last_activity_at: z.string(),
  current_lead_id: z.uuid().nullable(),
  current_lead_status: nullableString,
  interested_model: nullableString,
  branch_name: nullableString,
  assigned_user_name: nullableString,
  lead_count: z.coerce.number().int().nonnegative(),
  booking_count: z.coerce.number().int().nonnegative(),
  vehicle_count: z.coerce.number().int().nonnegative(),
});

export type CustomerRecord = z.infer<typeof customerRecordSchema>;

const customerWorkspaceSchema = z.object({
  records: z.array(customerRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    customers: z.coerce.number().int().nonnegative(),
    active_opportunities: z.coerce.number().int().nonnegative(),
    customers_with_bookings: z.coerce.number().int().nonnegative(),
    vehicles: z.coerce.number().int().nonnegative(),
  }),
});

export type CustomerWorkspaceResult = z.infer<typeof customerWorkspaceSchema>;

export type CustomerWorkspacePermissions = {
  organizationId: string;
  scopeKey: string;
  canView: boolean;
  canCreate: boolean;
  canLink: boolean;
};

export async function fetchCustomerWorkspacePermissions(): Promise<CustomerWorkspacePermissions> {
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
  const organizationId = context.organization_id;
  const permissionResults = await Promise.all(
    ['customer.view', 'customer.create', 'customer.link'].map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: organizationId,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  const failed = permissionResults.find((response) => response.error);
  if (failed?.error) throw failed.error;
  const result = {
    organizationId,
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    canView: Boolean(permissionResults[0]?.data),
    canCreate: Boolean(permissionResults[1]?.data),
    canLink: Boolean(permissionResults[2]?.data),
  };
  if (!result.canView) throw new Error('CUSTOMER_VIEW_PERMISSION_REQUIRED');
  return result;
}

export async function fetchCustomerWorkspace(query: CustomerQuery) {
  const { data, error } = await createClient().rpc('get_customer_workspace_page', {
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
  });
  if (error) throw error;
  return customerWorkspaceSchema.parse(data);
}

const sectionAccessSchema = z.object({
  overview: z.boolean(),
  leads: z.boolean(),
  calls: z.boolean(),
  conversations: z.boolean(),
  followups: z.boolean(),
  appointments: z.boolean(),
  test_drives: z.boolean(),
  quotations: z.boolean(),
  bookings: z.boolean(),
  vehicles: z.boolean(),
  documents: z.boolean(),
  notes: z.boolean(),
  timeline: z.boolean(),
  exchange: z.boolean(),
  finance: z.boolean(),
  insurance: z.boolean(),
  rto: z.boolean(),
  delivery: z.boolean(),
  customer_care: z.boolean(),
});

const customer360Schema = z.object({
  customer: z.object({
    id: z.uuid(),
    full_name: z.string(),
    primary_phone: nullableString,
    primary_email: nullableString,
    created_at: z.string(),
    updated_at: z.string(),
  }),
  current_opportunity: z
    .object({
      id: z.uuid(),
      source: z.string(),
      source_detail: nullableString,
      campaign: nullableString,
      interested_model: nullableString,
      lifecycle_status: z.string(),
      temperature: nullableString,
      work_state: nullableString,
      branch_name: z.string(),
      team_name: nullableString,
      assigned_user_id: z.uuid().nullable(),
      assigned_user_name: nullableString,
      created_at: z.string(),
      updated_at: z.string(),
    })
    .nullable(),
  section_access: sectionAccessSchema,
  contacts: z.array(
    z.object({ id: z.uuid(), type: z.string(), value: z.string(), is_primary: z.boolean() }),
  ),
  addresses: z.array(
    z.object({
      id: z.uuid(),
      address_type: z.string(),
      address: z.record(z.string(), z.unknown()),
    }),
  ),
  vehicles: z.array(
    z.object({
      id: z.uuid(),
      registration: nullableString,
      brand: nullableString,
      model: nullableString,
      variant: nullableString,
      model_year: z.number().int().nullable(),
      created_at: z.string(),
    }),
  ),
  custom_fields: z.array(
    z.object({
      definition_id: z.uuid(),
      field_key: z.string(),
      label: z.string(),
      field_type: z.string(),
      value: z.unknown(),
    }),
  ),
  leads: z.array(
    z.object({
      id: z.uuid(),
      source: z.string(),
      source_detail: nullableString,
      campaign: nullableString,
      interested_model: nullableString,
      lifecycle_status: z.string(),
      temperature: nullableString,
      branch_name: z.string(),
      assigned_user_name: nullableString,
      created_at: z.string(),
      updated_at: z.string(),
    }),
  ),
  calls: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid().nullable(),
      direction: z.string(),
      call_source: z.string(),
      started_at: z.string(),
      ended_at: nullableString,
      duration_seconds: z.number().int().nullable(),
      outcome: nullableString,
      status: z.string(),
      assigned_user_name: nullableString,
      recording_status: nullableString,
      transcript_status: nullableString,
    }),
  ),
  conversations: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid().nullable(),
      channel: z.string(),
      status: z.string(),
      assigned_user_name: nullableString,
      message_count: z.coerce.number().int().nonnegative(),
      latest_message_at: nullableString,
      created_at: z.string(),
    }),
  ),
  followups: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid().nullable(),
      reason: z.string(),
      due_at: z.string(),
      status: z.string(),
      completed_at: nullableString,
      assigned_user_name: nullableString,
    }),
  ),
  appointments: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid().nullable(),
      appointment_type: z.string(),
      scheduled_at: z.string(),
      status: z.string(),
      attendance_status: nullableString,
      assigned_user_name: nullableString,
      branch_name: z.string(),
    }),
  ),
  test_drives: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid().nullable(),
      status: z.string(),
      started_at: nullableString,
      completed_at: nullableString,
      distance_meters: z.number().int().nullable(),
      duration_seconds: z.number().int().nullable(),
      assigned_user_name: nullableString,
      branch_name: z.string(),
    }),
  ),
  quotations: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid().nullable(),
      quotation_number: z.string(),
      status: z.string(),
      current_version: z.number().int(),
      total_amount: z.coerce.number(),
      approval_status: nullableString,
      created_at: z.string(),
      updated_at: z.string(),
    }),
  ),
  bookings: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid().nullable(),
      booking_number: z.string(),
      status: z.string(),
      booking_amount: z.coerce.number(),
      total_value: z.coerce.number().nullable(),
      finance_required: z.boolean(),
      exchange_required: z.boolean(),
      expected_delivery_date: nullableString,
      created_at: z.string(),
      updated_at: z.string(),
    }),
  ),
  documents: z.array(
    z.object({
      id: z.uuid(),
      file_name: nullableString,
      mime_type: z.string(),
      size_bytes: z.coerce.number().nonnegative(),
      created_at: z.string(),
    }),
  ),
  notes: z.array(
    z.object({
      id: z.uuid(),
      body: z.string(),
      created_by_name: nullableString,
      created_at: z.string(),
    }),
  ),
  timeline: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid().nullable(),
      activity_type: z.string(),
      actor_name: nullableString,
      occurred_at: z.string(),
    }),
  ),
});

export type Customer360 = z.infer<typeof customer360Schema>;

export async function fetchCustomer360(customerId: string) {
  const { data, error } = await createClient().rpc('get_customer_360', {
    target_customer_id: customerId,
  });
  if (error) throw error;
  return customer360Schema.parse(data);
}

const possibleMatchSchema = z.object({
  customer_id: z.uuid(),
  full_name: z.string(),
  masked_phone: nullableString,
  masked_email: nullableString,
  match_reason: z.enum(['PHONE', 'EMAIL', 'PHONE_AND_EMAIL']),
});

export type PossibleCustomerMatch = z.infer<typeof possibleMatchSchema>;

export async function fetchPossibleCustomerMatches(leadId: string) {
  const { data, error } = await createClient().rpc('possible_customer_matches', {
    target_lead_id: leadId,
  });
  if (error) throw error;
  return z.array(possibleMatchSchema).parse(data ?? []);
}

const resolutionSchema = z.object({
  customer_id: z.uuid(),
  lead_id: z.uuid(),
  resolution: z.enum(['LINK_EXISTING', 'CREATE_NEW']),
  possible_match_count: z.coerce.number().int().nonnegative(),
  replayed: z.boolean(),
});

export async function resolveLeadCustomer(input: {
  leadId: string;
  expectedLeadUpdatedAt: string;
  resolution: 'LINK_EXISTING' | 'CREATE_NEW';
  reason: string;
  requestId: string;
  customerId?: string;
  newCustomer?: { full_name: string; primary_phone: string; primary_email?: string };
}) {
  const { data, error } = await createClient().rpc('resolve_lead_customer', {
    target_lead_id: input.leadId,
    expected_lead_updated_at: input.expectedLeadUpdatedAt,
    resolution: input.resolution,
    resolution_reason: input.reason,
    target_request_id: input.requestId,
    target_customer_id: input.customerId ?? null,
    new_customer: input.newCustomer ?? {},
  });
  if (error) throw error;
  return resolutionSchema.parse(data);
}

type DownloadEnvelope = {
  ok: boolean;
  data: {
    download_url: string;
    expires_at: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
  } | null;
  error: { code: string; message: string } | null;
};

export async function createCustomerDocumentDownload(objectFileId: string) {
  const { data, error } = await createClient().functions.invoke<DownloadEnvelope>(
    'presign-download',
    { body: { object_file_id: objectFileId } },
  );
  if (error || !data?.ok || !data.data) throw error ?? new Error('DOCUMENT_DOWNLOAD_FAILED');
  return data.data;
}
