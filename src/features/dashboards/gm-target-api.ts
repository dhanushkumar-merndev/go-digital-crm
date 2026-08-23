import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const gmTargetSchema = z.object({
  month: z.string(),
  kpis: z.object({
    sales_target: z.coerce.number().nonnegative(),
    sales_value: z.coerce.number().nonnegative(),
    booking_target: z.coerce.number().nonnegative(),
    bookings: z.coerce.number().int().nonnegative(),
    drive_target: z.coerce.number().nonnegative(),
    test_drives: z.coerce.number().int().nonnegative(),
  }),
  branches: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      sales_target: z.coerce.number().nonnegative(),
      sales_value: z.coerce.number().nonnegative(),
      booking_target: z.coerce.number().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
      drive_target: z.coerce.number().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative(),
    }),
  ),
});

export type GmTargetResult = z.infer<typeof gmTargetSchema>;

export async function fetchGmTarget(month: string, signal?: AbortSignal): Promise<GmTargetResult> {
  const request = createClient().rpc('get_gm_target_workspace', {
    target_month: `${month}-01`,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return gmTargetSchema.parse(data);
}
