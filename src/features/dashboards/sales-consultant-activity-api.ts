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
export type ActivityTimelineRole = 'sales-consultant' | 'telecaller';

export async function fetchSalesConsultantActivityTimeline(
  query: SalesActivityQuery,
  role: ActivityTimelineRole = 'sales-consultant',
  signal?: AbortSignal,
) {
  const request = createClient().rpc(
    role === 'telecaller'
      ? 'get_telecaller_activity_timeline'
      : 'get_sales_consultant_activity_timeline',
    {
      target_search: query.search,
      target_kind: query.kind,
      target_page: query.page,
      target_page_size: query.pageSize,
      target_sort: query.sort,
      target_timezone: 'Asia/Kolkata',
    },
  );
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return timelineSchema.parse(data);
}

export type DayActivityFeed = {
  organization_id: string;
  consultant_name: string;
  date: string;
  records: SalesConsultantActivityTimeline['records'];
  totalsByKind: Record<SalesActivityKind, number>;
  total: number;
  truncated: boolean;
  upcoming_followups: SalesConsultantActivityTimeline['upcoming_followups'];
  recent_notes: SalesConsultantActivityTimeline['recent_notes'];
};

const DAY_FEED_PAGE_SIZE = 100 as const;
const DAY_FEED_MAX_PAGES = 20;

/** yyyy-mm-dd for a record's occurred_at, in the app's Asia/Kolkata timezone. */
function activityDayKey(value: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

/**
 * The personal timeline RPCs only page through "latest N" -- there is no
 * server-side day filter. A specific day is instead assembled client-side by
 * walking pages (sorted newest first) until a page's oldest record falls
 * before the target day, so this never risks re-emitting (and silently
 * drifting from) the deployed plpgsql bodies of the two timeline functions.
 */
export async function fetchActivityTimelineForDay(
  role: ActivityTimelineRole,
  date: string,
  signal?: AbortSignal,
): Promise<DayActivityFeed> {
  let page = 1;
  let matched: SalesConsultantActivityTimeline['records'] = [];
  let base: SalesConsultantActivityTimeline | null = null;
  let truncated = false;

  while (page <= DAY_FEED_MAX_PAGES) {
    const chunk = await fetchSalesConsultantActivityTimeline(
      { search: '', kind: 'ALL', page, pageSize: DAY_FEED_PAGE_SIZE, sort: 'latest:desc' },
      role,
      signal,
    );
    if (!base) base = chunk;
    if (!chunk.records.length) break;
    matched = matched.concat(
      chunk.records.filter((record) => activityDayKey(record.occurred_at) === date),
    );
    const oldestKey = activityDayKey(chunk.records[chunk.records.length - 1]!.occurred_at);
    if (oldestKey < date) break;
    if (chunk.records.length < DAY_FEED_PAGE_SIZE) break;
    if (page === DAY_FEED_MAX_PAGES) truncated = true;
    page += 1;
  }

  const totalsByKind = matched.reduce(
    (totals, record) => {
      totals[record.activity_kind] = (totals[record.activity_kind] ?? 0) + 1;
      return totals;
    },
    {} as Record<SalesActivityKind, number>,
  );

  return {
    organization_id: base?.organization_id ?? '',
    consultant_name: base?.consultant_name ?? '',
    date,
    records: matched.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)),
    totalsByKind,
    total: matched.length,
    truncated,
    upcoming_followups: base?.upcoming_followups ?? [],
    recent_notes: base?.recent_notes ?? [],
  };
}
