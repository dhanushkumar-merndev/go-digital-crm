import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  downloadOperationalCaseDocument,
  uploadOperationalCaseDocument,
} from './operational-case-api';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();
const documentSchema = z.object({
  id: z.uuid(),
  file_name: z.string(),
  mime_type: z.string(),
  size_bytes: z.coerce.number().int().nonnegative(),
  created_at: z.string(),
});

const salesExchangeOptionSchema = z.object({
  booking_id: z.uuid(),
  booking_number: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  customer_id: z.uuid(),
  customer_name: z.string(),
  phone: nullableString,
  email: nullableString,
  consultant_name: nullableString,
  case_id: nullableUuid,
  case_status: nullableString,
  case_version: z.coerce.number().int().positive().nullable(),
  vehicle_id: nullableUuid,
  fuel_type: nullableString,
  ownership: nullableString,
  odometer_km: z.coerce.number().int().nonnegative().nullable(),
  customer_expected_value: z.coerce.number().nonnegative().nullable(),
  estimated_value: z.coerce.number().nonnegative().nullable(),
  accepted_value: z.coerce.number().nonnegative().nullable(),
  notes: nullableString,
  created_at: nullableString,
  updated_at: nullableString,
  address: z.record(z.string(), z.unknown()).nullable(),
  vehicles: z.array(
    z.object({
      id: z.uuid(),
      registration: nullableString,
      brand: nullableString,
      model: nullableString,
      variant: nullableString,
      model_year: z.coerce.number().int().nullable(),
    }),
  ),
  evaluation: z
    .object({
      evaluator_name: nullableString,
      inspection: z.record(z.string(), z.unknown()),
      quoted_value: z.coerce.number().nonnegative().nullable(),
      created_at: z.string(),
    })
    .nullable(),
  documents: z.array(documentSchema),
});

export type SalesExchangeOption = z.infer<typeof salesExchangeOptionSchema>;
export type SalesExchangeDocument = z.infer<typeof documentSchema>;

export async function fetchSalesExchangeOptions(search = '', signal?: AbortSignal) {
  const request = createClient().rpc('get_sales_exchange_options', {
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(salesExchangeOptionSchema).parse(data ?? []);
}

const mutationSchema = z.object({
  id: z.uuid(),
  department: z.literal('EXCHANGE'),
  status: z.string(),
  version: z.coerce.number().int().positive(),
  assigned_user_id: z.uuid(),
  replayed: z.boolean(),
});

export type SaveSalesExchangeInput = {
  bookingId: string;
  caseId?: string;
  expectedVersion?: number;
  vehicleId?: string;
  registration: string;
  brand: string;
  model: string;
  variant: string;
  modelYear?: number;
  fuelType: string;
  ownership: string;
  odometerKm?: number;
  customerExpectedValue?: number;
  notes: string;
  action: 'SAVE_DRAFT' | 'REQUEST_EVALUATION' | 'ACCEPT_OFFER';
  requestId: string;
};

export async function saveSalesExchangeRequest(input: SaveSalesExchangeInput) {
  const { data, error } = await createClient().rpc('save_sales_exchange_request', {
    target_booking_id: input.bookingId,
    target_case_id: input.caseId || null,
    expected_version: input.expectedVersion ?? null,
    target_vehicle_id: input.vehicleId || null,
    target_registration: input.registration || null,
    target_brand: input.brand || null,
    target_model: input.model || null,
    target_variant: input.variant || null,
    target_model_year: input.modelYear ?? null,
    target_fuel_type: input.fuelType || null,
    target_ownership: input.ownership || null,
    target_odometer_km: input.odometerKm ?? null,
    target_customer_expected_value: input.customerExpectedValue ?? null,
    target_notes: input.notes || null,
    target_action: input.action,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationSchema.parse(data);
}

export function uploadSalesExchangeDocument(input: {
  organizationId: string;
  branchId: string;
  caseId: string;
  file: File;
}) {
  return uploadOperationalCaseDocument({
    organizationId: input.organizationId,
    record: {
      id: input.caseId,
      branch_id: input.branchId,
      resource_type: 'exchange_case',
    },
    file: input.file,
  });
}

export const downloadSalesExchangeDocument = downloadOperationalCaseDocument;
