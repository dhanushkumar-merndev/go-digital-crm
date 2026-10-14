import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();
// PostgreSQL timestamptz JSON includes offsets such as +00:00, as well as Z.
const requiredTimestamp = z.string().datetime({ offset: true });
const timestamp = requiredTimestamp.nullable();

const campaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: nullableString,
  branch_id: nullableUuid,
  default_channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']),
  starts_at: timestamp,
  step_count: z.coerce.number().int().nonnegative(),
  version: z.coerce.number().int().positive(),
  updated_at: requiredTimestamp,
});

const reviewSchema = z.object({
  id: z.uuid(),
  customer_id: z.uuid(),
  customer_name: z.string(),
  customer_phone: nullableString,
  booking_id: nullableUuid,
  booking_number: nullableString,
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'MANUAL']),
  status: z.enum(['QUEUED', 'SENT', 'DELIVERED', 'COMPLETED', 'FAILED', 'CANCELLED']),
  scheduled_for: timestamp,
  sent_at: timestamp,
  created_at: requiredTimestamp,
  updated_at: requiredTimestamp,
  version: z.coerce.number().int().positive(),
});

const workspaceSchema = z.object({
  organization_id: z.uuid(),
  drip_kpis: z.object({
    total: z.coerce.number().int().nonnegative(),
    active: z.coerce.number().int().nonnegative(),
    paused: z.coerce.number().int().nonnegative(),
    steps: z.coerce.number().int().nonnegative(),
  }),
  campaigns: z.array(campaignSchema),
  review_kpis: z.object({
    queued: z.coerce.number().int().nonnegative(),
    sent_today: z.coerce.number().int().nonnegative(),
    delivered: z.coerce.number().int().nonnegative(),
    completed: z.coerce.number().int().nonnegative(),
  }),
  reviews: z.array(reviewSchema),
});
export type MarketingAutomationWorkspace = z.infer<typeof workspaceSchema>;

const customerOptionSchema = z.object({
  customer_id: z.uuid(),
  customer_name: z.string(),
  phone: nullableString,
  booking_id: z.uuid(),
  booking_number: z.string(),
  branch_id: z.uuid(),
  updated_at: requiredTimestamp,
});
export type MarketingReviewCustomerOption = z.infer<typeof customerOptionSchema>;

const scopeOptionsSchema = z.object({
  can_use_organization_scope: z.boolean(),
  branches: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type MarketingAutomationScopeOptions = z.infer<typeof scopeOptionsSchema>;

const builderOptionsSchema = z.object({
  can_manage: z.boolean(),
  tokens: z.array(z.string()),
  sources: z.array(z.string()),
  channels: z.object({ WHATSAPP: z.boolean(), SMS: z.boolean(), EMAIL: z.boolean() }),
  templates: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
      status: z.string(),
      body: nullableString,
      placeholders: z.array(z.string()),
    }),
  ),
});

export async function fetchMarketingDripBuilderOptions(signal?: AbortSignal) {
  const request = createClient().rpc('get_marketing_drip_builder_options');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return builderOptionsSchema.parse(data);
}

const dripChannelSchema = z.object({
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
  template_id: nullableUuid,
  variable_map: z.record(z.string(), z.string()),
  body: z.string(),
});
const dripDetailSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: nullableString,
  branch_id: nullableUuid,
  status: campaignSchema.shape.status,
  version: z.coerce.number().int().positive(),
  trigger_type: z.enum([
    'AUDIENCE',
    'LEAD_CREATED',
    'BIRTHDAY',
    'ANNIVERSARY',
    'BOOKING_CONFIRMED',
    'VEHICLE_DELIVERED',
    'DELIVERY_ANNIVERSARY',
    'AUTOMATION',
  ]),
  trigger_conditions: z.record(z.string(), z.unknown()),
  audience_filter: z.record(z.string(), z.unknown()),
  steps: z.array(
    z.object({
      step_order: z.number().int(),
      delay_hours: z.number().int(),
      channels: z.array(dripChannelSchema),
    }),
  ),
});
export type MarketingDripDetail = z.infer<typeof dripDetailSchema>;
export type MarketingDripChannel = z.infer<typeof dripChannelSchema>;

export async function fetchMarketingDripCampaign(id: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_marketing_drip_campaign', { target_campaign_id: id });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return dripDetailSchema.parse(data);
}

// `create` saves a new event-triggered campaign: the same RPC with no id or
// version. A new audience campaign is created by createMarketingDripCampaign and
// then saved here as an edit, because only the audience editor attaches templates.
export async function saveMarketingDripCampaign(
  detail: MarketingDripDetail,
  requestId: string,
  create = false,
) {
  const { data, error } = await createClient().rpc(
    detail.trigger_type === 'AUDIENCE'
      ? 'update_marketing_audience_drip_campaign'
      : 'save_marketing_drip_campaign',
    {
      target_campaign_id: create ? null : detail.id,
      target_expected_version: create ? null : detail.version,
      target_branch_id: detail.branch_id,
      target_payload: {
        name: detail.name,
        description: detail.description,
        trigger_type: detail.trigger_type,
        trigger_conditions: detail.trigger_conditions,
        audience_filter: detail.audience_filter,
        steps: detail.steps,
      },
      target_request_id: requestId,
    },
  );
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

export async function setMarketingDripStatus(
  id: string,
  status: 'ACTIVE' | 'PAUSED',
  version: number,
) {
  const { data, error } = await createClient().rpc('set_marketing_drip_campaign_status', {
    target_campaign_id: id,
    target_status: status,
    target_expected_version: version,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

export async function createMarketingDripTemplate(
  name: string,
  channel: MarketingDripChannel['channel'],
  body: string,
  requestId: string,
) {
  const { data, error } = await createClient().rpc('create_marketing_template', {
    target_name: name.slice(0, 120),
    target_channel: channel,
    target_body: body,
    target_request_id: requestId,
  });
  if (error) throw error;
  return z.object({ id: z.uuid(), status: z.literal('DRAFT'), replayed: z.boolean() }).parse(data);
}

export async function createSmsFallbackCampaign(input: {
  name: string;
  branchId?: string;
  sources: string[];
  templateId: string;
  variableMap: Record<string, string>;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('save_marketing_drip_campaign', {
    target_campaign_id: null,
    target_expected_version: null,
    target_branch_id: input.branchId || null,
    target_payload: {
      name: input.name,
      description:
        'Send an enquiry thank-you by SMS when no lead or linked customer email is available.',
      trigger_type: 'LEAD_CREATED',
      trigger_conditions: { sources: input.sources, models: [], email_presence: 'MISSING' },
      steps: [
        {
          step_order: 1,
          delay_hours: 0,
          channels: [
            {
              channel: 'SMS',
              template_id: input.templateId,
              variable_map: input.variableMap,
            },
          ],
        },
      ],
    },
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

const mutationResultSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  version: z.coerce.number().int().positive(),
  replayed: z.boolean(),
});

export async function fetchMarketingAutomationWorkspace(signal?: AbortSignal) {
  const request = createClient().rpc('get_marketing_automation_workspace', {
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export async function fetchMarketingAutomationPermissions() {
  const supabase = createClient();
  const { data: context, error: contextError } = await supabase.rpc('get_access_context');
  if (contextError) throw contextError;
  const access = context as { destination?: string; organization_id?: string } | null;
  if (access?.destination !== 'CRM' || !access.organization_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  const { data, error } = await supabase.rpc('authorize_action', {
    target_organization_id: access.organization_id,
    target_permission: 'marketing.automation.manage',
    target_branch_id: null,
  });
  if (error) throw error;
  return { canManage: Boolean(data) };
}

export async function fetchMarketingReviewCustomerOptions(search: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_marketing_review_customer_options', {
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(customerOptionSchema).parse(data ?? []);
}

export async function fetchMarketingAutomationScopeOptions(signal?: AbortSignal) {
  const request = createClient().rpc('get_marketing_automation_scope_options');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return scopeOptionsSchema.parse(data);
}

export async function createMarketingDripCampaign(input: {
  name: string;
  description?: string;
  branchId?: string;
  defaultChannel: 'WHATSAPP' | 'SMS' | 'EMAIL';
  audienceFilter: Record<string, unknown>;
  steps: Array<{
    step_order: number;
    delay_hours: number;
    channel: 'WHATSAPP' | 'SMS' | 'EMAIL';
    message_body: string;
  }>;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_marketing_drip_campaign', {
    target_name: input.name,
    target_description: input.description || null,
    target_branch_id: input.branchId || null,
    target_default_channel: input.defaultChannel,
    target_audience_filter: input.audienceFilter,
    target_steps: input.steps,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

export async function createMarketingReviewRequest(input: {
  option: MarketingReviewCustomerOption;
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'MANUAL';
  messageBody: string;
  scheduledFor?: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_marketing_review_request', {
    target_customer_id: input.option.customer_id,
    target_booking_id: input.option.booking_id,
    target_channel: input.channel,
    target_message_body: input.messageBody,
    target_scheduled_for: input.scheduledFor || null,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}
