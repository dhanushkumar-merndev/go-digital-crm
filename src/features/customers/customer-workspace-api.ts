import { z } from 'zod';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';
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
  canUpdate: boolean;
  canCreateCall: boolean;
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
    ['customer.view', 'customer.create', 'customer.link', 'customer.update', 'call.create'].map(
      (target_permission) =>
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
    canUpdate: Boolean(permissionResults[3]?.data),
    canCreateCall: Boolean(permissionResults[4]?.data),
  };
  if (!result.canView) throw new Error('CUSTOMER_VIEW_PERMISSION_REQUIRED');
  return result;
}

export async function fetchCustomerWorkspace(query: CustomerQuery, signal?: AbortSignal) {
  const request = createClient().rpc('get_customer_workspace_page', {
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
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

const customer360EditDataSchema = customer360Schema.pick({
  customer: true,
  contacts: true,
  addresses: true,
  vehicles: true,
  custom_fields: true,
});

export type Customer360EditData = z.infer<typeof customer360EditDataSchema>;

export async function fetchCustomer360EditData(customerId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_customer_360_edit_data', {
    target_customer_id: customerId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return customer360EditDataSchema.parse(data);
}

const customer360UpdateResultSchema = z.object({
  customer_id: z.uuid(),
  updated_at: z.string(),
  replayed: z.boolean(),
});

export type UpdateCustomer360Input = {
  customerId: string;
  expectedUpdatedAt: string;
  requestId: string;
  payload: {
    full_name: string;
    primary_phone: string | null;
    primary_email: string | null;
    contacts: Array<{ id?: string; type: 'PHONE' | 'EMAIL'; value: string; is_primary: boolean }>;
    addresses: Array<{
      id?: string;
      address_type: string;
      address: Record<string, string>;
    }>;
    vehicles: Array<{
      id?: string;
      registration: string | null;
      brand: string | null;
      model: string | null;
      variant: string | null;
      model_year: number | null;
    }>;
    custom_fields: Array<{ definition_id: string; value: unknown }>;
  };
};

export async function updateCustomer360(input: UpdateCustomer360Input) {
  const { data, error } = await createClient().rpc('update_customer_360', {
    target_customer_id: input.customerId,
    expected_customer_updated_at: input.expectedUpdatedAt,
    target_payload: input.payload,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return customer360UpdateResultSchema.parse(data);
}

const customerTelecmiCallOptionsSchema = z.object({
  lead_id: z.uuid().nullable(),
  branch_name: z.string().nullable(),
  connections: z.array(
    z.object({
      id: z.uuid(),
      display_name: z.string(),
      caller_id_label: nullableString,
      scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    }),
  ),
});

export type CustomerTelecmiCallOptions = z.infer<typeof customerTelecmiCallOptionsSchema>;

export async function fetchCustomerTelecmiCallOptions(
  customerId: string,
  signal?: AbortSignal,
  leadId?: string,
) {
  const request = leadId
    ? createClient().rpc('get_lead_telecmi_call_options', { target_lead_id: leadId })
    : createClient().rpc('get_customer_telecmi_call_options', {
        target_customer_id: customerId,
      });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return customerTelecmiCallOptionsSchema.parse(data);
}

const customer360CoreSchema = customer360Schema.pick({
  customer: true,
  current_opportunity: true,
  section_access: true,
  contacts: true,
  addresses: true,
  custom_fields: true,
  notes: true,
});

export type Customer360Core = z.infer<typeof customer360CoreSchema>;

export const customer360LazySections = [
  'leads',
  'calls',
  'conversations',
  'followups',
  'appointments',
  'test_drives',
  'quotations',
  'bookings',
  'vehicles',
  'documents',
  'timeline',
] as const;

export type Customer360LazySection = (typeof customer360LazySections)[number];
export type Customer360SectionPageSize = 25 | 50 | 100;
export type Customer360TimelineCursor = { occurred_at: string; id: string };

const customer360SectionEnvelopeSchema = z.object({
  section: z.enum(customer360LazySections),
  records: z.array(z.unknown()),
  total: z.coerce.number().int().nonnegative(),
  page: z.coerce.number().int().positive(),
  page_size: z.union([z.literal(25), z.literal(50), z.literal(100)]),
  has_more: z.boolean(),
  next_cursor: z.object({ occurred_at: z.string(), id: z.uuid() }).nullable(),
});

const customer360SectionRecordSchemas = {
  leads: customer360Schema.shape.leads,
  calls: customer360Schema.shape.calls,
  conversations: customer360Schema.shape.conversations,
  followups: customer360Schema.shape.followups,
  appointments: customer360Schema.shape.appointments,
  test_drives: customer360Schema.shape.test_drives,
  quotations: customer360Schema.shape.quotations,
  bookings: customer360Schema.shape.bookings,
  vehicles: customer360Schema.shape.vehicles,
  documents: customer360Schema.shape.documents,
  timeline: customer360Schema.shape.timeline,
} satisfies Record<Customer360LazySection, z.ZodType>;

export type Customer360SectionResult<S extends Customer360LazySection = Customer360LazySection> = {
  section: S;
  records: Customer360[S];
  total: number;
  page: number;
  page_size: Customer360SectionPageSize;
  has_more: boolean;
  next_cursor: Customer360TimelineCursor | null;
};

export async function fetchCustomer360(customerId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_customer_360', {
    target_customer_id: customerId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return customer360Schema.parse(data);
}

export async function fetchSalesCustomer360Core(customerId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_sales_consultant_customer_360_core', {
    target_customer_id: customerId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return customer360CoreSchema.parse(data);
}

export async function fetchSalesCustomer360Section<S extends Customer360LazySection>(
  input: {
    customerId: string;
    section: S;
    page: number;
    pageSize: Customer360SectionPageSize;
    cursor?: Customer360TimelineCursor | null;
  },
  signal?: AbortSignal,
): Promise<Customer360SectionResult<S>> {
  const request = createClient().rpc('get_sales_consultant_customer_360_section', {
    target_customer_id: input.customerId,
    target_section: input.section.toUpperCase(),
    target_page: input.page,
    target_page_size: input.pageSize,
    target_cursor_at: input.cursor?.occurred_at ?? null,
    target_cursor_id: input.cursor?.id ?? null,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  const envelope = customer360SectionEnvelopeSchema.parse(data);
  if (envelope.section !== input.section) throw new Error('CUSTOMER_360_SECTION_MISMATCH');
  return {
    ...envelope,
    section: input.section,
    records: customer360SectionRecordSchemas[input.section].parse(envelope.records),
  } as Customer360SectionResult<S>;
}

const possibleMatchSchema = z.object({
  customer_id: z.uuid(),
  full_name: z.string(),
  masked_phone: nullableString,
  masked_email: nullableString,
  match_reason: z.enum(['PHONE', 'EMAIL', 'PHONE_AND_EMAIL']),
});

export type PossibleCustomerMatch = z.infer<typeof possibleMatchSchema>;

export async function fetchPossibleCustomerMatches(leadId: string, signal?: AbortSignal) {
  const request = createClient().rpc('possible_customer_matches', {
    target_lead_id: leadId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
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

type UploadEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

function sha256Base64(buffer: ArrayBuffer) {
  return crypto.subtle.digest('SHA-256', buffer).then((digest) => {
    const bytes = new Uint8Array(digest);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
}

export async function uploadCustomerDocument(input: {
  organizationId: string;
  customerId: string;
  file: File;
}) {
  if (!hasSupabaseConfig()) throw new Error('SUPABASE_NOT_CONFIGURED');
  const checksum = await sha256Base64(await input.file.arrayBuffer());
  const supabase = createClient();
  const presignResponse = await supabase.functions.invoke<
    UploadEnvelope<{
      upload_intent_id: string;
      upload_url: string;
      required_headers: Record<string, string>;
    }>
  >('presign-upload', {
    body: {
      organization_id: input.organizationId,
      branch_id: null,
      resource_type: 'customer',
      resource_id: input.customerId,
      file_name: input.file.name,
      mime_type: input.file.type,
      size_bytes: input.file.size,
      checksum_sha256: checksum,
    },
  });
  if (presignResponse.error || !presignResponse.data?.ok || !presignResponse.data.data)
    throw presignResponse.error ?? new Error('CUSTOMER_DOCUMENT_PRESIGN_FAILED');
  const presign = presignResponse.data.data;
  const upload = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: presign.required_headers,
    body: input.file,
  });
  if (!upload.ok) throw new Error('CUSTOMER_DOCUMENT_UPLOAD_FAILED');
  const finalizeResponse = await supabase.functions.invoke<
    UploadEnvelope<{ object_file_id: string }>
  >('object-upload-finalize', { body: { upload_intent_id: presign.upload_intent_id } });
  if (finalizeResponse.error || !finalizeResponse.data?.ok || !finalizeResponse.data.data)
    throw finalizeResponse.error ?? new Error('CUSTOMER_DOCUMENT_FINALIZE_FAILED');
  return z.uuid().parse(finalizeResponse.data.data.object_file_id);
}

export async function createCustomerDocumentDownload(objectFileId: string) {
  const { data, error } = await createClient().functions.invoke<DownloadEnvelope>(
    'presign-download',
    { body: { object_file_id: objectFileId } },
  );
  if (error || !data?.ok || !data.data) throw error ?? new Error('DOCUMENT_DOWNLOAD_FAILED');
  return data.data;
}
