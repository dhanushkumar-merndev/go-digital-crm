import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const recordSchema = z.object({
  id: z.uuid(),
  lead_id: z.uuid().nullable(),
  customer_id: z.uuid().nullable(),
  customer_name: z.string().nullable(),
  phone: z.string().nullable(),
  provider_name: z.string(),
  status: z.string(),
  outcome: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  duration_seconds: z.coerce.number().int().nonnegative().nullable(),
  recording_available: z.boolean(),
  transcript_available: z.boolean(),
});

const resultSchema = z.object({
  generated_at: z.string(),
  records: z.array(recordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    initiated_today: z.coerce.number().int().nonnegative(),
    connected_today: z.coerce.number().int().nonnegative(),
    callbacks_open: z.coerce.number().int().nonnegative(),
    recordings_ready_today: z.coerce.number().int().nonnegative(),
  }),
  has_verified_provider: z.boolean(),
});

export type AiVoiceCallWorkspace = z.infer<typeof resultSchema>;

export async function fetchAiVoiceCallWorkspace(
  input: { page: number; pageSize: 25 | 50 | 100; search: string; status: string },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_ai_voice_call_workspace', {
    target_page: input.page,
    target_page_size: input.pageSize,
    target_search: input.search.trim(),
    target_status: input.status,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}
