import { z } from 'npm:zod@4';
import { failure, preflight, requestId, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';

const leadSources = [
  'Facebook',
  'Instagram',
  'Google Ads',
  'Website',
  'WhatsApp Business',
  'CarWale',
  'CarDekho',
  'Justdial',
  'IndiaMART',
  'Manual',
  'Other',
] as const;

const rowSchema = z
  .object({
    customer_name: z.string().trim().min(2).max(160),
    phone: z.string().trim().min(7).max(24),
    email: z.union([z.literal(''), z.email().max(320)]),
    source: z.enum(leadSources),
    source_detail: z.string().trim().max(200),
    campaign: z.string().trim().max(200),
    interested_model: z.string().trim().max(160),
  })
  .strict();

const schema = z
  .object({
    organization_id: z.uuid(),
    branch_id: z.uuid(),
    file_name: z.string().trim().min(1).max(255),
    request_id: z.uuid(),
    rows: z.array(rowSchema).min(1).max(250),
  })
  .strict();

type RequestedImport = { id: string; status: string; total_rows: number };

function safeDatabaseCode(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const match = message.match(/(BULK_IMPORT_[A-Z0-9_]+|TELECALLER_BULK_IMPORT_REQUIRED)/);
  return match?.[1] ?? 'BULK_IMPORT_REQUEST_FAILED';
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const correlationId = requestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', correlationId, 405);

  try {
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', correlationId, 401);

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure(
        'INVALID_BULK_IMPORT',
        'The CSV rows or import destination are invalid.',
        correlationId,
        422,
      );

    const input = parsed.data;
    const { data, error } = await client.rpc('request_lead_bulk_import', {
      target_organization_id: input.organization_id,
      target_branch_id: input.branch_id,
      target_file_name: input.file_name,
      target_rows: input.rows,
      target_request_id: input.request_id,
    });
    if (error) {
      const code = safeDatabaseCode(error);
      return failure(
        code,
        code === 'TELECALLER_BULK_IMPORT_REQUIRED'
          ? 'Only a Telecaller can import leads into My Leads.'
          : 'The import failed server validation.',
        correlationId,
        code.includes('DENIED') || code.includes('REQUIRED') ? 403 : 422,
      );
    }
    const importRecord = data as RequestedImport;

    if (!['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(importRecord.status)) {
      const triggerSecret = Deno.env.get('TRIGGER_SECRET_KEY');
      if (!triggerSecret) {
        await client.rpc('mark_lead_bulk_import_enqueue_failed', {
          target_import_id: importRecord.id,
          target_safe_error_code: 'BULK_IMPORT_QUEUE_NOT_CONFIGURED',
        });
        throw new Error('TRIGGER_SECRET_KEY_MISSING');
      }
      const triggered = await fetch(
        'https://api.trigger.dev/api/v1/tasks/lead-bulk-import/trigger',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${triggerSecret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            payload: { importId: importRecord.id },
            options: { idempotencyKey: `lead-bulk-import:${importRecord.id}` },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!triggered.ok) {
        await client.rpc('mark_lead_bulk_import_enqueue_failed', {
          target_import_id: importRecord.id,
          target_safe_error_code: 'BULK_IMPORT_ENQUEUE_FAILED',
        });
        throw new Error('BULK_IMPORT_ENQUEUE_FAILED');
      }
      const triggerBody = (await triggered.json().catch(() => ({}))) as { id?: string };
      await client.rpc('set_lead_bulk_import_trigger_run', {
        target_import_id: importRecord.id,
        target_trigger_run_id: triggerBody.id ?? null,
      });
    }

    return success(importRecord, correlationId, 202);
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'TRIGGER_SECRET_KEY_MISSING'
        ? 'BULK_IMPORT_QUEUE_NOT_CONFIGURED'
        : 'BULK_IMPORT_ENQUEUE_FAILED';
    return failure(
      code,
      'The import could not be queued. Retry with the same file.',
      correlationId,
      503,
    );
  }
});
