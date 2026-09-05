import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { SalesActivityKind } from './sales-consultant-activity-api';

const nullableString = z.string().nullable();
const memberTypeSchema = z.enum(['SALES_CONSULTANT', 'TELECALLER_BDC']);
export type TeamMemberType = z.infer<typeof memberTypeSchema>;

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
]) satisfies z.ZodType<SalesActivityKind>;

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

const memberOverviewSchema = z.object({
  user_id: z.uuid(),
  full_name: z.string(),
  member_type: memberTypeSchema,
  calls: z.coerce.number().int().nonnegative(),
  messages: z.coerce.number().int().nonnegative(),
  followups: z.coerce.number().int().nonnegative(),
  test_drives: z.coerce.number().int().nonnegative(),
  quotations: z.coerce.number().int().nonnegative(),
  tasks: z.coerce.number().int().nonnegative(),
  appointments: z.coerce.number().int().nonnegative(),
  notes: z.coerce.number().int().nonnegative(),
  total: z.coerce.number().int().nonnegative(),
});
export type TeamMemberActivityOverview = z.infer<typeof memberOverviewSchema>;

const overviewSchema = z.object({
  organization_id: z.uuid(),
  mode: z.literal('overview'),
  target_date: z.string(),
  members: z.array(memberOverviewSchema),
});
export type TeamActivityOverview = z.infer<typeof overviewSchema>;

const memberModeSchema = z.object({
  organization_id: z.uuid(),
  mode: z.literal('member'),
  target_date: z.string(),
  member_id: z.uuid(),
  member_name: z.string(),
  member_type: memberTypeSchema,
  records: z.array(activityRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  summary: z.object({
    calls: z.coerce.number().int().nonnegative(),
    messages: z.coerce.number().int().nonnegative(),
    followups: z.coerce.number().int().nonnegative(),
    test_drives: z.coerce.number().int().nonnegative(),
    quotations: z.coerce.number().int().nonnegative(),
    tasks: z.coerce.number().int().nonnegative(),
    appointments: z.coerce.number().int().nonnegative(),
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
export type TeamMemberActivityTimeline = z.infer<typeof memberModeSchema>;

export const teamActivityTimelineKey = ['team-manager-activity-timeline'] as const;

export type TeamActivityQuery = {
  search: string;
  kind: 'ALL' | SalesActivityKind;
  page: number;
  pageSize: 25 | 50 | 100;
  sort: 'latest:desc' | 'oldest:asc';
};

export async function fetchTeamActivityOverview(date: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_team_manager_activity_timeline', {
    target_member_id: null,
    target_date: date,
    target_search: '',
    target_kind: 'ALL',
    target_page: 1,
    target_page_size: 25,
    target_sort: 'latest:desc',
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return overviewSchema.parse(data);
}

export async function fetchTeamMemberActivity(
  memberId: string,
  date: string,
  query: TeamActivityQuery,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_team_manager_activity_timeline', {
    target_member_id: memberId,
    target_date: date,
    target_search: query.search,
    target_kind: query.kind,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return memberModeSchema.parse(data);
}
