import { z } from 'zod';
import type { PerformanceDateRange } from '@/lib/performance-date-range';
import { performanceRangeDays, performanceRpcTimezone } from '@/lib/performance-date-range';
import { createClient } from '@/lib/supabase/client';

const teamPerformanceSchema = z.object({
  days: z.coerce.number().int().positive().max(9999),
  generated_at: z.string(),
  team_ids: z.array(z.uuid()),
  // Added with the Sales Manager preset; absent from a response cached before it.
  branch_id: z.uuid().nullable().optional(),
  branches: z.array(z.object({ id: z.uuid(), name: z.string() })).default([]),
  kpis: z.object({
    leads: z.coerce.number().int().nonnegative(),
    contacted: z.coerce.number().int().nonnegative(),
    qualified: z.coerce.number().int().nonnegative().optional(),
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
      // Added with the member roles; absent from a response cached before them.
      connected_calls: z.coerce.number().int().nonnegative().optional(),
      test_drives: z.coerce.number().int().nonnegative(),
      quotations: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
    }),
  ),
  leaderboard: z.array(
    z.object({
      user_id: z.uuid(),
      full_name: z.string(),
      member_type: z.enum(['SALES_CONSULTANT', 'TELECALLER_BDC']).optional(),
      team_name: z.string().optional(),
      leads: z.coerce.number().int().nonnegative(),
      contacted: z.coerce.number().int().nonnegative(),
      qualified: z.coerce.number().int().nonnegative().optional(),
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
export type TeamMember = TeamManagerPerformance['leaderboard'][number];

export function teamMemberRole(member: TeamMember) {
  if (member.member_type === 'TELECALLER_BDC') return 'Telecaller';
  if (member.member_type === 'SALES_CONSULTANT') return 'Sales consultant';
  return null;
}

/** Bookings per lead only means something for a consultant; a telecaller hands leads on. */
export function isTelecallerMember(member: TeamMember) {
  return member.member_type === 'TELECALLER_BDC';
}

/**
 * A Team Manager reads their managed teams; a Sales Manager every team in the
 * branches they can open, narrowed to `branchId` when one is chosen. The server
 * re-checks that branch against the caller's teams.
 */
export async function fetchTeamManagerPerformance(
  range: PerformanceDateRange,
  signal?: AbortSignal,
  branchId: string | null = null,
): Promise<TeamManagerPerformance> {
  const params = {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
  };
  // Read directly: about 100–550 ms in PostgreSQL for a team or showroom,
  // against 300–1,200 ms for a Redis hit through Edge (entries are per user).
  const request = createClient().rpc('get_team_manager_performance', {
    ...params,
    ...(branchId ? { target_branch_id: branchId } : {}),
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return teamPerformanceSchema.parse(data);
}

/** Exported for the IndexedDB copy, which is re-validated before it is shown. */
export { teamPerformanceSchema };
