import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const calendarSchema = z.object({
  start_date: z.string(),
  days: z.union([z.literal(7), z.literal(14), z.literal(31)]),
  posts: z.array(
    z.object({
      id: z.uuid(),
      platform: z.string(),
      content: z.string(),
      status: z.string(),
      scheduled_for: z.string().nullable(),
      published_at: z.string().nullable(),
    }),
  ),
});

export type SocialContentCalendar = z.infer<typeof calendarSchema>;

export async function fetchSocialContentCalendar(input: {
  startDate: string;
  days: 7 | 14 | 31;
  signal?: AbortSignal;
}) {
  const request = createClient().rpc('get_social_content_calendar', {
    target_start: input.startDate,
    target_days: input.days,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return calendarSchema.parse(data);
}
