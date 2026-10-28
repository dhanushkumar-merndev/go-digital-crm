import { z } from 'zod';
import type { PerformanceDateRange } from '@/lib/performance-date-range';
import { performanceRangeDays, performanceRpcTimezone } from '@/lib/performance-date-range';
import { fetchCachedAggregate } from '@/lib/query/cached-dashboard-api';
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
  const params = {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
  };
  // A consultant's own numbers take about 150 ms in PostgreSQL against a
  // 400–500 ms Redis hit through Edge (entries are per user), so read directly.
  const request = createClient().rpc('get_sales_consultant_performance', params);
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
export type TelecallerPerformance = z.infer<typeof telecallerSchema>;

export async function fetchTelecallerPerformance(
  range: PerformanceDateRange,
  signal?: AbortSignal,
) {
  const params = {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
  };
  return fetchCachedAggregate({
    resource: 'telecaller-performance',
    schema: telecallerSchema,
    params,
    signal,
    direct: async () => {
      const request = createClient().rpc('get_telecaller_performance', params);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return telecallerSchema.parse(data);
    },
  });
}

/** Exported for the IndexedDB copy, which is re-validated before it is shown. */
export { schema as salesPerformanceSchema, telecallerSchema as telecallerPerformanceSchema };
