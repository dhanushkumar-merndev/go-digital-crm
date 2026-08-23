import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const pageSizes = [25, 50, 100] as const;
const statusValues = ['all', 'unread', 'read'] as const;

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

export type NotificationRecord = z.infer<typeof notificationSchema>;
export type NotificationStatusFilter = (typeof statusValues)[number];
export type NotificationPageSize = (typeof pageSizes)[number];

export const notificationPageSizes = pageSizes;
export const notificationStatusFilters = statusValues;
export const notificationWorkspaceKey = ['notification-workspace'] as const;

function sanitizeSearch(value: string) {
  return value
    .trim()
    .slice(0, 80)
    .replace(/[,.()]/g, '');
}

export async function fetchNotificationPage(input: {
  page: number;
  pageSize: NotificationPageSize;
  search: string;
  status: NotificationStatusFilter;
  signal?: AbortSignal;
}) {
  const page = Math.max(1, Math.floor(input.page));
  const search = sanitizeSearch(input.search);
  const from = (page - 1) * input.pageSize;
  let request = createClient()
    .from('notifications')
    .select('id,event_type,title,body,resource_type,resource_id,read_at,created_at')
    .order('created_at', { ascending: false })
    .range(from, from + input.pageSize);

  if (input.status === 'unread') request = request.is('read_at', null);
  if (input.status === 'read') request = request.not('read_at', 'is', null);
  if (search) request = request.or(`title.ilike.%${search}%,body.ilike.%${search}%`);

  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  const records = z.array(notificationSchema).parse(data ?? []);
  return { records: records.slice(0, input.pageSize), hasNext: records.length > input.pageSize };
}
