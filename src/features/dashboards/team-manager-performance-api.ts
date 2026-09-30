import { z } from 'zod';
import type { PerformanceDateRange } from '@/lib/performance-date-range';
import { performanceRangeDays, performanceRpcTimezone } from '@/lib/performance-date-range';
import { createClient } from '@/lib/supabase/client';

const teamPerformanceSchema = z.object({
  days: z.coerce.number().int().positive().max(9999),
  generated_at: z.string(),
  team_ids: z.array(z.uuid()),
  kpis: z.object({
    leads: z.coerce.number().int().nonnegative(),
    contacted: z.coerce.number().int().nonnegative(),
    calls: z.coerce.number().int().nonnegative(),
    connected_calls: z.coerce.number().int().nonnegative(),
    talk_seconds: z.coerce.number().int().nonnegative(),
    test_drives: z.coerce.number().int().nonnegative(),
    quotations: z.coerce.number().int().nonnegative(),
    bookings: z.coerce.number().int().nonnegative(),
    conversion: z.coerce.number().nonnegative(),
  }),
  daily: z.array(
    z.object({
      name: z.string(),
      calls: z.coerce.number().int().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative(),
      quotations: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
    }),
  ),
  leaderboard: z.array(
    z.object({
      user_id: z.uuid(),
      full_name: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      contacted: z.coerce.number().int().nonnegative(),
      calls: z.coerce.number().int().nonnegative(),
      connected_calls: z.coerce.number().int().nonnegative(),
      talk_seconds: z.coerce.number().int().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative(),
      quotations: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
      conversion: z.coerce.number().nonnegative(),
    }),
  ),
});

export type TeamManagerPerformance = z.infer<typeof teamPerformanceSchema>;

export async function fetchTeamManagerPerformance(
  range: PerformanceDateRange,
  signal?: AbortSignal,
): Promise<TeamManagerPerformance> {
  const request = createClient().rpc('get_team_manager_performance', {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return teamPerformanceSchema.parse(data);
}
