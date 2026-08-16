import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const notificationSchema = z.object({
  id: z.uuid(),
  event_type: z.string(),
  title: z.string(),
  body: z.string(),
  resource_type: z.string().nullable(),
  resource_id: z.uuid().nullable(),
  read_at: z.string().nullable(),
  created_at: z.string(),
});

export type HeaderNotification = z.infer<typeof notificationSchema>;

export const headerNotificationsKey = ['header-notifications'] as const;

/** Bounded to the latest eight notifications; RLS restricts this to auth.uid(). */
export async function fetchHeaderNotifications(signal?: AbortSignal) {
  const request = createClient()
    .from('notifications')
    .select('id,event_type,title,body,resource_type,resource_id,read_at,created_at')
    .order('created_at', { ascending: false })
    .limit(8);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(notificationSchema).parse(data ?? []);
}

export async function markHeaderNotificationRead(notificationId: string) {
  const { error } = await createClient().rpc('mark_notification_read', {
    target_notification_id: notificationId,
  });
  if (error) throw error;
}
