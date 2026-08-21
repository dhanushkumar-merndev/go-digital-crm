import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const schema = z.object({
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  generated_at: z.string(),
  kpis: z.object({
    leads: z.coerce.number(),
    contacted: z.coerce.number(),
    calls: z.coerce.number(),
    connected_calls: z.coerce.number(),
    talk_seconds: z.coerce.number(),
    appointments: z.coerce.number(),
    test_drives: z.coerce.number(),
    bookings: z.coerce.number(),
    average_response_seconds: z.coerce.number(),
  }),
  daily: z.array(
    z.object({
      name: z.string(),
      calls: z.coerce.number(),
      connected: z.coerce.number(),
      appointments: z.coerce.number(),
      test_drives: z.coerce.number(),
    }),
  ),
  targets: z.record(z.string(), z.coerce.number()),
});
export type SalesPerformance = z.infer<typeof schema>;
export async function fetchSalesPerformance(days: 7 | 14 | 30, signal?: AbortSignal) {
  const request = createClient().rpc('get_sales_consultant_performance', {
    target_days: days,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return schema.parse(data);
}
