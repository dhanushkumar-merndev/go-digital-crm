import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const valueSchema = z.unknown().nullable();

const workspaceSchema = z.object({
  call: z.object({
    id: z.uuid(),
    lead_id: z.uuid().nullable(),
    customer_name: z.string(),
    phone: z.string(),
    interested_model: z.string().nullable(),
    started_at: z.string(),
    duration_seconds: z.coerce.number().int().nullable(),
  }),
  transcript: z.object({ text: z.string().nullable(), language: z.string().nullable() }).nullable(),
  summary: z.string().nullable(),
  extraction: z
    .object({
      id: z.uuid(),
      status: z.string(),
      created_at: z.string(),
      fields: z.array(
        z.object({
          field_key: z.string(),
          suggested_value: valueSchema,
          current_value: valueSchema,
          decision: z.enum(['PENDING', 'APPLIED', 'REJECTED', 'EDITED']),
          applied_value: valueSchema,
        }),
      ),
    })
    .nullable(),
});

export type AiCallFieldReviewWorkspace = z.infer<typeof workspaceSchema>;
export type AiFieldDecision = 'APPLIED' | 'REJECTED' | 'EDITED';

export async function fetchAiCallFieldReview(callId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_ai_call_field_review', { target_call_id: callId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export async function reviewAiCallFields(input: {
  extractionRunId: string;
  decisions: Array<{ field_key: string; decision: AiFieldDecision; value?: unknown }>;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('review_ai_call_fields', {
    target_extraction_run_id: input.extractionRunId,
    target_decisions: input.decisions,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return z.object({ lead_id: z.uuid(), accepted_fields: z.array(z.string()) }).parse(data);
}
