import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { MarketingQuery } from './marketing-query';

const number = z.coerce.number().nonnegative();
const sourceRecord = z.object({
  source: z.string(),
  leads: number,
  qualified: number,
  test_drives: number,
  quotations: number,
  bookings: number,
  conversion: number,
});
const campaignRecord = z.object({
  id: z.uuid(),
  name: z.string(),
  platform: z.string(),
  canonical_source: z.string(),
  status: z.string(),
  branch_id: z.uuid().nullable(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  budget_amount: z.coerce.number().nullable(),
  currency_code: z.string(),
  version: z.coerce.number().int().positive(),
  updated_at: z.string(),
});
const postRecord = z.object({
  id: z.uuid(),
  platform: z.string(),
  content: z.string(),
  status: z.string(),
  branch_id: z.uuid().nullable(),
  scheduled_for: z.string().nullable(),
  published_at: z.string().nullable(),
  safe_error_code: z.string().nullable(),
  version: z.coerce.number().int().positive(),
  updated_at: z.string(),
});
const chartDatum = z.object({ name: z.string(), value: number, secondary: number.optional() });
const resultSchema = z.object({
  organization_id: z.uuid(),
  view: z.enum(['SOURCES', 'CAMPAIGNS', 'SOCIAL_POSTS']),
  records: z.array(z.union([sourceRecord, campaignRecord, postRecord])),
  total: z.coerce.number().int().nonnegative(),
  kpis: z
    .object({
      leads_generated: number,
      qualified_leads: number,
      bookings: number,
      conversion_percent: number,
      active_campaigns: number,
      review_requests: number,
      posts_published: number,
    })
    .optional(),
  source_chart: z.array(chartDatum).optional(),
  funnel_chart: z.array(chartDatum).optional(),
});
export type MarketingWorkspaceResult = z.infer<typeof resultSchema>;

export async function fetchMarketingWorkspace(query: MarketingQuery, signal?: AbortSignal) {
  const request = createClient().rpc('get_marketing_workspace_page', {
    target_view: query.view,
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}
