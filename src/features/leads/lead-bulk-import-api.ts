import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { LeadBulkImportRow } from './lead-bulk-import-csv';

const statusSchema = z.enum([
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'RETRY',
  'FAILED',
]);

const leadBulkImportSchema = z.object({
  id: z.uuid(),
  status: statusSchema,
  file_name: z.string().optional(),
  total_rows: z.coerce.number().int().nonnegative(),
  imported_rows: z.coerce.number().int().nonnegative().default(0),
  rejected_rows: z.coerce.number().int().nonnegative().default(0),
  row_errors: z
    .array(z.object({ row_number: z.coerce.number().int().positive(), code: z.string() }))
    .default([]),
  safe_error_code: z.string().nullable().optional(),
  created_at: z.string().optional(),
  completed_at: z.string().nullable().optional(),
});

export type LeadBulkImport = z.infer<typeof leadBulkImportSchema>;

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  request_id: string;
};

export async function submitLeadBulkImport(input: {
  organizationId: string;
  branchId: string;
  fileName: string;
  requestId: string;
  rows: LeadBulkImportRow[];
}) {
  const { data, error } = await createClient().functions.invoke<EdgeEnvelope<LeadBulkImport>>(
    'lead-bulk-import',
    {
      body: {
        organization_id: input.organizationId,
        branch_id: input.branchId,
        file_name: input.fileName,
        request_id: input.requestId,
        rows: input.rows,
      },
    },
  );
  if (error || !data?.ok || !data.data)
    throw error ?? new Error(data?.error?.code ?? 'BULK_IMPORT_REQUEST_FAILED');
  return leadBulkImportSchema.parse(data.data);
}

export async function fetchLeadBulkImport(importId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_lead_bulk_import', { target_import_id: importId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return leadBulkImportSchema.parse(data);
}
