import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const showroomSalesTeamSchema = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  branch: z.object({ id: z.uuid(), name: z.string() }),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    consultants: z.coerce.number().int().nonnegative(),
    active_in_period: z.coerce.number().int().nonnegative(),
    active_leads: z.coerce.number().int().nonnegative(),
    test_drives: z.coerce.number().int().nonnegative(),
    bookings: z.coerce.number().int().nonnegative(),
    conversion: z.coerce.number().nonnegative(),
  }),
  distribution: z.array(
    z.object({ name: z.string(), value: z.coerce.number().int().nonnegative() }),
  ),
  workload: z.object({
    up_to_10: z.coerce.number().int().nonnegative(),
    up_to_20: z.coerce.number().int().nonnegative(),
    up_to_30: z.coerce.number().int().nonnegative(),
    over_30: z.coerce.number().int().nonnegative(),
  }),
  records: z.array(
    z.object({
      rank: z.coerce.number().int().positive(),
      user_id: z.uuid(),
      full_name: z.string(),
      member_type: z.enum(['SALES_CONSULTANT', 'TELECALLER_BDC']),
      active_leads: z.coerce.number().int().nonnegative(),
      calls: z.coerce.number().int().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative(),
      quotations: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
      sales_value: z.coerce.number().nonnegative(),
      sales_target: z.coerce.number().nonnegative(),
    }),
  ),
});

export type ShowroomSalesTeamResult = z.infer<typeof showroomSalesTeamSchema>;

export async function fetchShowroomSalesTeam(
  input: { days: 7 | 30; page: number; pageSize: 25 | 50 | 100 },
  signal?: AbortSignal,
): Promise<ShowroomSalesTeamResult> {
  const request = createClient().rpc('get_showroom_sales_team_workspace', {
    target_days: input.days,
    target_page: input.page,
    target_page_size: input.pageSize,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return showroomSalesTeamSchema.parse(data);
}
