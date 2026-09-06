import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

export const bulkChannels = ['WHATSAPP', 'SMS', 'EMAIL'] as const;
export type BulkChannel = (typeof bulkChannels)[number];

const campaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  channel: z.enum(bulkChannels),
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED']),
  recipient_count: z.coerce.number().int().nonnegative(),
  sent: z.coerce.number().int().nonnegative(),
  failed: z.coerce.number().int().nonnegative(),
  pending: z.coerce.number().int().nonnegative(),
  created_at: z.string(),
});
const workspaceSchema = z.object({
  records: z.array(campaignSchema),
  total: z.coerce.number().int().nonnegative(),
});

export type BulkCampaign = z.infer<typeof campaignSchema>;
export const bulkCampaignKey = (page: number) => ['bulk-campaign-workspace', page] as const;

export async function fetchBulkCampaigns(page: number, signal?: AbortSignal) {
  const request = createClient().rpc('get_bulk_campaign_workspace', {
    target_page: page,
    target_page_size: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

/**
 * The audience is resolved and frozen when the campaign is created, so the
 * recipient list is exactly what was counted at review time.
 */
export type BulkAudienceFilter = {
  lifecycle_status?: string[];
  temperature?: string[];
  source?: string[];
  created_within_days?: number;
};

export async function createBulkCampaign(input: {
  name: string;
  channel: BulkChannel;
  templateId: string;
  templateVariables: Record<string, string>;
  assetId: string | null;
  branchId: string | null;
  audienceFilter: BulkAudienceFilter;
}) {
  const { data, error } = await createClient().rpc('create_bulk_campaign', {
    target_name: input.name,
    target_channel: input.channel,
    target_template_id: input.templateId,
    target_template_variables: input.templateVariables,
    target_asset_id: input.assetId,
    target_branch_id: input.branchId,
    target_audience_filter: input.audienceFilter,
    target_request_id: globalThis.crypto.randomUUID(),
  });
  if (error) throw error;
  return z
    .object({
      id: z.uuid(),
      recipient_count: z.coerce.number().int().nonnegative(),
      status: z.string(),
      replayed: z.boolean(),
    })
    .parse(data);
}

export async function cancelBulkCampaign(campaignId: string) {
  const { data, error } = await createClient().rpc('cancel_bulk_campaign', {
    target_campaign_id: campaignId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export function getBulkCampaignErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('BULK_CAMPAIGN_TEMPLATE_CHANNEL_MISMATCH'))
    return 'That approved template belongs to a different channel than the one you picked.';
  if (message.includes('BULK_CAMPAIGN_TEMPLATE_NOT_APPROVED'))
    return 'Pick a template the provider has approved. A blast cannot send free text.';
  if (message.includes('BULK_CAMPAIGN_ASSET_NOT_FOUND'))
    return 'That asset is no longer in the library. Pick another.';
  if (message.includes('BULK_CAMPAIGN_SCOPE_DENIED'))
    return 'That branch is outside your assigned scope.';
  if (message.includes('MARKETING_AUTOMATION_PERMISSION_REQUIRED'))
    return 'You are not allowed to create or cancel bulk campaigns.';
  return 'The campaign could not be created. Try again in a moment.';
}
