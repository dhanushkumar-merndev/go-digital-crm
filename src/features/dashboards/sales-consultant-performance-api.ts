import { z } from 'zod';
import type { PerformanceDateRange } from '@/lib/performance-date-range';
import { performanceRangeDays, performanceRpcTimezone } from '@/lib/performance-date-range';
import { createClient } from '@/lib/supabase/client';

const schema = z.object({
  days: z.coerce.number().int().positive().max(9999),
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
export async function fetchSalesPerformance(range: PerformanceDateRange, signal?: AbortSignal) {
  const request = createClient().rpc('get_sales_consultant_performance', {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return schema.parse(data);
}

const telecallerSchema = z.object({
  days: schema.shape.days,
  generated_at: z.string(),
  kpis: z.object({
    leads: z.coerce.number(),
    contacted: z.coerce.number(),
    calls: z.coerce.number(),
    connected_calls: z.coerce.number(),
    talk_seconds: z.coerce.number(),
    qualified: z.coerce.number(),
    transferred: z.coerce.number(),
    followups_completed: z.coerce.number(),
  }),
  daily: z.array(
    z.object({
      name: z.string(),
      calls: z.coerce.number(),
      connected: z.coerce.number(),
      followups_completed: z.coerce.number(),
      transferred: z.coerce.number(),
    }),
  ),
  targets: schema.shape.targets,
});

export async function fetchTelecallerPerformance(
  range: PerformanceDateRange,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_telecaller_performance', {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return telecallerSchema.parse(data);
}
