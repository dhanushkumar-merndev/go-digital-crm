import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const analyticsSchema = z.object({
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  generated_at: z.string(),
  kpis: z.object({
    leads: z.coerce.number().int().nonnegative(),
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
  models: z.array(z.object({ name: z.string(), leads: z.coerce.number().int().nonnegative() })),
  daily: z.array(
    z.object({
      name: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
    }),
  ),
});

export type GmSalesAnalytics = z.infer<typeof analyticsSchema>;

export async function fetchGmSalesAnalytics(days: 7 | 14 | 30, signal?: AbortSignal) {
  const request = createClient().rpc('get_gm_sales_analytics_workspace', {
    target_days: days,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return analyticsSchema.parse(data);
}
