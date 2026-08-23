import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const showroomTargetSchema = z.object({
  month: z.string(),
  branch: z.object({ id: z.uuid(), name: z.string() }),
  kpis: z.object({
    sales_target: z.coerce.number().nonnegative(),
    sales_value: z.coerce.number().nonnegative(),
    booking_target: z.coerce.number().nonnegative(),
    bookings: z.coerce.number().int().nonnegative(),
    drive_target: z.coerce.number().nonnegative(),
    test_drives: z.coerce.number().int().nonnegative(),
  }),
  daily: z.array(
    z.object({
      day: z.string(),
      sales_value: z.coerce.number().nonnegative(),
      target_to_date: z.coerce.number().nonnegative(),
    }),
  ),
  models: z.array(
    z.object({
      model: z.string(),
      bookings: z.coerce.number().int().nonnegative(),
      sales_value: z.coerce.number().nonnegative(),
    }),
  ),
  consultants: z.array(
    z.object({
      user_id: z.uuid(),
      full_name: z.string(),
      sales_target: z.coerce.number().nonnegative(),
      sales_value: z.coerce.number().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative(),
    }),
  ),
});

export type ShowroomTargetResult = z.infer<typeof showroomTargetSchema>;

export async function fetchShowroomTarget(
  month: string,
  signal?: AbortSignal,
): Promise<ShowroomTargetResult> {
  const request = createClient().rpc('get_showroom_target_workspace', {
    target_month: `${month}-01`,
    target_branch_id: null,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return showroomTargetSchema.parse(data);
}
