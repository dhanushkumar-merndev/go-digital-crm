import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

export const campaignPlatforms = [
  { value: 'META', label: 'Meta (Facebook / Instagram)' },
  { value: 'GOOGLE_ADS', label: 'Google Ads' },
  { value: 'GOOGLE_BUSINESS_PROFILE', label: 'Google Business Profile' },
  { value: 'WEBSITE', label: 'Website' },
  { value: 'OTHER', label: 'Other' },
] as const;
export type CampaignPlatform = (typeof campaignPlatforms)[number]['value'];

export const campaignSources = [
  'Facebook',
  'Instagram',
  'Google Ads',
  'Website',
  'WhatsApp Business',
  'CarWale',
  'CarDekho',
  'Justdial',
  'IndiaMART',
  'Manual',
  'Other',
] as const;
export type CampaignSource = (typeof campaignSources)[number];

export const campaignStatuses = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
export type CampaignStatus = (typeof campaignStatuses)[number];

export type CampaignInput = {
  campaignId: string | null;
  expectedVersion: number | null;
  name: string;
  platform: CampaignPlatform;
  canonicalSource: CampaignSource;
  status: CampaignStatus;
  branchId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  budgetAmount: number | null;
  currencyCode: string;
  externalCampaignId: string | null;
  notes: string | null;
  requestId: string;
};

export async function saveMarketingCampaign(input: CampaignInput) {
  const { data, error } = await createClient().rpc('save_marketing_campaign', {
    target_campaign_id: input.campaignId,
    target_expected_version: input.expectedVersion,
    target_name: input.name,
    target_platform: input.platform,
    target_canonical_source: input.canonicalSource,
    target_status: input.status,
    target_branch_id: input.branchId,
    target_starts_on: input.startsOn,
    target_ends_on: input.endsOn,
    target_budget_amount: input.budgetAmount,
    target_currency_code: input.currencyCode,
    target_external_campaign_id: input.externalCampaignId,
    target_notes: input.notes,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return z
    .object({ campaign_id: z.uuid(), version: z.coerce.number().int().positive() })
    .parse(data);
}

export async function recordMarketingCampaignMetrics(input: {
  campaignId: string;
  metricDate: string;
  spendAmount: number;
  impressions: number | null;
  clicks: number | null;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('record_marketing_campaign_metrics', {
    target_campaign_id: input.campaignId,
    target_metric_date: input.metricDate,
    target_spend_amount: input.spendAmount,
    target_impressions: input.impressions,
    target_clicks: input.clicks,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return z
    .object({
      campaign_id: z.uuid(),
      metric_date: z.string(),
      spend_amount: z.coerce.number(),
      currency_code: z.string(),
    })
    .parse(data);
}

const connectionSchema = z.object({
  id: z.uuid(),
  provider_key: z.string(),
  display_name: z.string(),
  status: z.string(),
  scope_mode: z.string(),
  last_sync_at: z.string().nullable(),
  mapping_count: z.coerce.number().int().nonnegative(),
});
const connectionsSchema = z.object({
  can_map: z.boolean(),
  connections: z.array(connectionSchema),
});
export type MarketingLeadSourceConnection = z.infer<typeof connectionSchema>;
export const marketingLeadSourceConnectionsKey = ['marketing-lead-source-connections'] as const;

export async function fetchMarketingLeadSourceConnections(signal?: AbortSignal) {
  const request = createClient().rpc('get_marketing_lead_source_connections');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return connectionsSchema.parse(data);
}

export function getCampaignErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('MARKETING_CAMPAIGN_VERSION_CONFLICT'))
    return 'Someone else changed this campaign. Reopen it to see the latest version.';
  if (message.includes('MARKETING_CAMPAIGN_EXTERNAL_ID_TAKEN'))
    return 'Another campaign already uses this ads campaign ID.';
  if (message.includes('MARKETING_CAMPAIGN_SCOPE_DENIED'))
    return 'Choose a branch inside your scope for this campaign.';
  if (message.includes('PROVIDER_METRICS_LOCKED'))
    return 'This day was synced from the ads account and cannot be overwritten by hand.';
  if (message.includes('INVALID_MARKETING_CAMPAIGN_METRICS'))
    return 'Spend must be zero or more, clicks cannot exceed impressions, and the date cannot be in the future.';
  if (message.includes('INVALID_MARKETING_CAMPAIGN'))
    return 'Check the name, dates and budget, then try again.';
  if (message.includes('MARKETING_MANAGE_PERMISSION_REQUIRED'))
    return 'You are not allowed to manage marketing campaigns.';
  if (message.includes('MARKETING_CAMPAIGN_NOT_FOUND'))
    return 'This campaign is no longer available.';
  return 'The campaign could not be saved. Try again in a moment.';
}
