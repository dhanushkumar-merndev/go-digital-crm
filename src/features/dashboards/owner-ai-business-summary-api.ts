import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const number = z.coerce.number().int().nonnegative();

const resultSchema = z.object({
  period_days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  kpis: z.object({
    credits_used: number,
    credits_remaining: z.coerce.number().int(),
    summaries_generated: number,
    extractions_completed: number,
    reviews_pending: number,
  }),
  daily_usage: z.array(z.object({ date: z.string(), credits_used: number })),
  feature_usage: z.array(z.object({ name: z.string(), value: number })),
  recent_summaries: z.array(
    z.object({
      id: z.uuid(),
      summary: z.string(),
      created_at: z.string(),
      model_reference: z.string().nullable(),
    }),
  ),
});

export type OwnerAiBusinessSummary = z.infer<typeof resultSchema>;

export async function fetchOwnerAiBusinessSummary(days: 7 | 30 | 90, signal?: AbortSignal) {
  const request = createClient().rpc('get_owner_ai_business_summary', { target_days: days });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}
