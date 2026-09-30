import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { MarketingQuery } from './marketing-query';

const number = z.coerce.number().nonnegative();
/** Cost figures stay null until spend is recorded, so "no data" never reads as zero. */
const money = z.number().nonnegative().nullable().default(null);
const sourceRecord = z.object({
  source: z.string(),
  leads: number,
  qualified: number,
  test_drives: number,
  quotations: number,
  bookings: number,
  conversion: number,
  spend: money,
  cost_per_lead: money,
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
  external_campaign_id: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  version: z.coerce.number().int().positive(),
  updated_at: z.string(),
  leads: number.default(0),
  qualified: number.default(0),
  bookings: number.default(0),
  spend: money,
  impressions: money,
  clicks: money,
  spend_days: number.default(0),
  last_metric_date: z.string().nullable().default(null),
  spend_source: z.enum(['MANUAL', 'PROVIDER_SYNC']).nullable().default(null),
  cost_per_lead: money,
  cost_per_booking: money,
  click_through_percent: money,
  budget_used_percent: money,
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
const spendKpis = {
  ad_spend: money,
  cost_per_lead: money,
  cost_per_booking: money,
  click_through_percent: money,
  spend_currency: z.string().default('INR'),
};
const resultSchema = z.object({
  organization_id: z.uuid(),
  view: z.enum(['SOURCES', 'CAMPAIGNS', 'SOCIAL_POSTS']),
  can_manage: z.boolean().default(false),
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
      paid_leads: number.default(0),
      ...spendKpis,
    })
    .optional(),
  campaign_kpis: z
    .object({
      active_campaigns: number,
      campaign_leads: number,
      campaign_bookings: number,
      ...spendKpis,
    })
    .optional(),
  campaign_chart: z.array(chartDatum).optional(),
  source_chart: z.array(chartDatum).optional(),
  funnel_chart: z.array(chartDatum).optional(),
});
export type MarketingWorkspaceResult = z.infer<typeof resultSchema>;
export type MarketingSourceRecord = z.infer<typeof sourceRecord>;
export type MarketingCampaignRecord = z.infer<typeof campaignRecord>;
export type MarketingPostRecord = z.infer<typeof postRecord>;

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
