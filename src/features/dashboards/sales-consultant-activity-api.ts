import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const nullableString = z.string().nullable();

const activityKindSchema = z.enum([
  'CALL',
  'MESSAGE',
  'FOLLOW_UP',
  'TEST_DRIVE',
  'QUOTATION',
  'TASK',
  'APPOINTMENT',
  'NOTE',
  'OTHER',
]);
export type SalesActivityKind = z.infer<typeof activityKindSchema>;

const activityRecordSchema = z.object({
  id: z.uuid(),
  activity_type: z.string(),
  activity_kind: activityKindSchema,
  detail: nullableString,
  occurred_at: z.string(),
  customer_name: z.string(),
  customer_phone: nullableString,
  lead_reference: z.string(),
  interested_model: nullableString,
  actor_name: nullableString,
});

const timelineSchema = z.object({
  organization_id: z.uuid(),
  consultant_name: z.string(),
  records: z.array(activityRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  summary: z.object({
    calls: z.coerce.number().int().nonnegative(),
    messages: z.coerce.number().int().nonnegative(),
    followups: z.coerce.number().int().nonnegative(),
    test_drives: z.coerce.number().int().nonnegative(),
    quotations: z.coerce.number().int().nonnegative(),
    notes: z.coerce.number().int().nonnegative(),
  }),
  upcoming_followups: z.array(
    z.object({
      id: z.uuid(),
      customer_name: z.string(),
      detail: nullableString,
      due_at: z.string(),
      priority: z.string(),
    }),
  ),
  recent_notes: z.array(
    z.object({
      id: z.uuid(),
      body: z.string(),
      customer_name: z.string(),
      created_at: z.string(),
    }),
  ),
});
export type SalesConsultantActivityTimeline = z.infer<typeof timelineSchema>;

export type SalesActivityQuery = {
  search: string;
  kind: 'ALL' | SalesActivityKind;
  page: number;
  pageSize: 25 | 50 | 100;
  sort: 'latest:desc' | 'oldest:asc';
};

export const salesActivityTimelineKey = ['sales-consultant-activity-timeline'] as const;

export async function fetchSalesConsultantActivityTimeline(
  query: SalesActivityQuery,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_sales_consultant_activity_timeline', {
    target_search: query.search,
    target_kind: query.kind,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return timelineSchema.parse(data);
}
