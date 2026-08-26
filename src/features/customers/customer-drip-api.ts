import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

export const dripChannels = ['WHATSAPP', 'SMS', 'EMAIL'] as const;
export type DripChannel = (typeof dripChannels)[number];

export const dripChannelLabel: Record<DripChannel, string> = {
  WHATSAPP: 'WhatsApp',
  SMS: 'SMS',
  EMAIL: 'Email',
};

/** Steps are capped server-side; the form must not offer more than it will accept. */
export const DRIP_MAX_STEPS = 12;
export const DRIP_MAX_BODY_LENGTH = 4000;

const stepTemplateSchema = z.object({
  step_order: z.coerce.number().int().positive(),
  delay_hours: z.coerce.number().int().nonnegative(),
  channel: z.enum(dripChannels),
  message_body: z.string(),
});

const templateSchema = z.object({
  campaign_id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  default_channel: z.enum(dripChannels),
  steps: z.array(stepTemplateSchema),
});
export type DripTemplate = z.infer<typeof templateSchema>;

const messageSchema = z.object({
  id: z.uuid(),
  step_order: z.coerce.number().int().positive(),
  channel: z.enum(dripChannels),
  message_body: z.string(),
  scheduled_for: z.string(),
  status: z.enum(['QUEUED', 'SENT', 'FAILED', 'CANCELLED']),
  sent_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
});
export type DripMessage = z.infer<typeof messageSchema>;

const enrollmentSchema = z.object({
  id: z.uuid(),
  source_name: z.string(),
  source_campaign_id: z.uuid().nullable(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']),
  version: z.coerce.number().int().positive(),
  enrolled_by_name: z.string(),
  created_at: z.string(),
  cancelled_at: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
  completed_at: z.string().nullable(),
  messages: z.array(messageSchema),
});
export type DripEnrollment = z.infer<typeof enrollmentSchema>;

const panelSchema = z.object({
  can_manage: z.boolean(),
  enrollments: z.array(enrollmentSchema),
});
export type DripPanel = z.infer<typeof panelSchema>;

const mutationResultSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  version: z.coerce.number().int().positive(),
  replayed: z.boolean(),
});

export const customerDripPanelKey = (customerId: string) =>
  ['customer-drip-panel', customerId] as const;
export const customerDripTemplatesKey = ['customer-drip-templates'] as const;

export async function fetchCustomerDripPanel(customerId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_customer_drip_panel', {
    target_customer_id: customerId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return panelSchema.parse(data);
}

export async function fetchCustomerDripTemplates(signal?: AbortSignal) {
  const request = createClient().rpc('get_customer_drip_templates');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(templateSchema).parse(data);
}

export type DripStepDraft = {
  channel: DripChannel;
  delayHours: number;
  messageBody: string;
};

export async function createCustomerDripEnrollment(input: {
  customerId: string;
  leadId: string | null;
  sourceCampaignId: string | null;
  sourceName: string;
  steps: DripStepDraft[];
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_customer_drip_enrollment', {
    target_customer_id: input.customerId,
    target_lead_id: input.leadId,
    target_source_campaign_id: input.sourceCampaignId,
    target_source_name: input.sourceName,
    target_steps: input.steps.map((step, index) => ({
      step_order: index + 1,
      delay_hours: step.delayHours,
      channel: step.channel,
      message_body: step.messageBody,
    })),
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

export async function cancelCustomerDripEnrollment(input: {
  enrollmentId: string;
  expectedVersion: number;
  reason: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('cancel_customer_drip_enrollment', {
    target_enrollment_id: input.enrollmentId,
    expected_version: input.expectedVersion,
    target_reason: input.reason,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

/**
 * The RPCs raise their refusals as `raise exception using message = '…'`, so the
 * reason arrives in PostgREST's `message` and never in `code`, which only
 * carries the SQLSTATE.
 */
export function getDripErrorMessage(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';
  if (message.includes('CUSTOMER_DRIP_SCOPE_DENIED'))
    return 'This customer is outside your assigned scope, so a sequence cannot be started for them.';
  if (message.includes('CUSTOMER_DRIP_MANAGE_PERMISSION_REQUIRED'))
    return 'You are not allowed to start or cancel drip sequences.';
  if (message.includes('STALE_CUSTOMER_DRIP_VERSION'))
    return 'This sequence changed after you opened it. Refresh and try again.';
  if (message.includes('CUSTOMER_DRIP_TEMPLATE_NOT_FOUND'))
    return 'That sequence template is no longer available. Pick another or start from blank.';
  if (message.includes('INVALID_CUSTOMER_DRIP_STEP'))
    return 'Every step needs a channel and a message of 1 to 4000 characters.';
  if (message.includes('INVALID_CUSTOMER_DRIP_INPUT'))
    return 'Give the sequence a name and between 1 and 12 steps.';
  if (message.includes('CUSTOMER_NOT_FOUND')) return 'This customer record is no longer available.';
  return 'The drip sequence could not be saved. Try again in a moment.';
}
