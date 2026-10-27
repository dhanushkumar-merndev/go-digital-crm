import { z } from 'zod';
import type { PerformanceDateRange } from '@/lib/performance-date-range';
import { performanceRangeDays, performanceRpcTimezone } from '@/lib/performance-date-range';
import { fetchCachedAggregate } from '@/lib/query/cached-dashboard-api';
import { createClient } from '@/lib/supabase/client';

const analyticsSchema = z.object({
  days: z.coerce.number().int().positive().max(9999),
  generated_at: z.string(),
  // Fields marked optional arrived with 202610270157; a response cached before
  // it lacks them and the page falls back.
  stock_visible: z.boolean().optional(),
  kpis: z.object({
    leads: z.coerce.number().int().nonnegative(),
    contacted: z.coerce.number().int().nonnegative().optional(),
    qualified: z.coerce.number().int().nonnegative().optional(),
    calls: z.coerce.number().int().nonnegative(),
    test_drives: z.coerce.number().int().nonnegative(),
    quotations: z.coerce.number().int().nonnegative(),
    bookings: z.coerce.number().int().nonnegative(),
    conversion: z.coerce.number().nonnegative(),
  }),
  branches: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      calls: z.coerce.number().int().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative(),
      quotations: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
      lost: z.coerce.number().int().nonnegative().optional(),
      conversion: z.coerce.number().nonnegative(),
    }),
  ),
  consultants: z.array(
    z.object({
      user_id: z.uuid(),
      full_name: z.string(),
      branch_name: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      calls: z.coerce.number().int().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative(),
      quotations: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
      conversion: z.coerce.number().nonnegative(),
    }),
  ),
  models: z.array(
    z.object({
      name: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative().optional(),
      quotations: z.coerce.number().int().nonnegative().optional(),
      bookings: z.coerce.number().int().nonnegative().optional(),
      lost: z.coerce.number().int().nonnegative().optional(),
      // Null when the caller cannot check stock.
      available: z.coerce.number().int().nonnegative().nullable().optional(),
      incoming: z.coerce.number().int().nonnegative().nullable().optional(),
    }),
  ),
  daily: z.array(
    z.object({
      name: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
    }),
  ),
});

export type GmSalesAnalytics = z.infer<typeof analyticsSchema>;

export async function fetchGmSalesAnalytics(range: PerformanceDateRange, signal?: AbortSignal) {
  const params = {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
  };
  return fetchCachedAggregate({
    resource: 'gm-sales-analytics',
    schema: analyticsSchema,
    params,
    signal,
    direct: async () => {
      const request = createClient().rpc('get_gm_sales_analytics_workspace', params);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return analyticsSchema.parse(data);
    },
  });
}

/** Exported for the IndexedDB copy, which is re-validated before it is shown. */
export { analyticsSchema as gmSalesAnalyticsSchema };
