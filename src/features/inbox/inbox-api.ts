import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();

const conversationSchema = z.object({
  id: z.uuid(),
  lead_id: nullableUuid,
  customer_id: nullableUuid,
  channel: z.string(),
  status: z.string(),
  customer_name: z.string(),
  phone: nullableString,
  interested_model: nullableString,
  assigned_user_name: nullableString,
  last_message_at: nullableString,
  last_message_body: nullableString,
  last_message_direction: nullableString,
});

const conversationPageSchema = z.object({
  records: z.array(conversationSchema),
  total: z.coerce.number().int().nonnegative(),
});

const messagePageSchema = z.object({
  records: z.array(
    z.object({
      id: z.uuid(),
      direction: z.enum(['INBOUND', 'OUTBOUND']),
      body: nullableString,
      delivery_status: nullableString,
      sent_at: z.string(),
      metadata: z.record(z.string(), z.unknown()),
    }),
  ),
  has_more: z.boolean(),
  next_before_at: nullableString,
  next_before_id: nullableUuid,
});

export type InboxConversation = z.infer<typeof conversationSchema>;
export type InboxMessagePage = z.infer<typeof messagePageSchema>;

export async function fetchInboxConversationPage(
  input: { search: string; channel: string; page: number; leadId?: string; customerId?: string },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_context_inbox_page', {
    target_lead_id: input.leadId ?? null,
    target_customer_id: input.customerId ?? null,
    target_search: input.search,
    target_channel: input.channel,
    target_page: input.page,
    target_page_size: 25,
  });
  const timeout = AbortSignal.timeout(10_000);
  const { data, error } = await request.abortSignal(
    signal ? AbortSignal.any([signal, timeout]) : timeout,
  );
  if (error) throw error;
  return conversationPageSchema.parse(data);
}

export async function fetchInboxMessagePage(
  input: {
    conversationId: string;
    leadId?: string;
    beforeAt?: string | null;
    beforeId?: string | null;
  },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_context_inbox_messages', {
    target_conversation_id: input.conversationId,
    target_lead_id: input.leadId ?? null,
    target_before_at: input.beforeAt ?? null,
    target_before_id: input.beforeId ?? null,
    target_page_size: 25,
  });
  const timeout = AbortSignal.timeout(10_000);
  const { data, error } = await request.abortSignal(
    signal ? AbortSignal.any([signal, timeout]) : timeout,
  );
  if (error) throw error;
  return messagePageSchema.parse(data);
}

type EdgeEnvelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string } };

export async function sendInboxWhatsAppMessage(input: {
  organizationId: string;
  conversationId: string;
  body: string;
  applicationMessageId?: string;
  expectedLeadId: string | null;
}) {
  const { data, error } = await createClient().functions.invoke<
    EdgeEnvelope<{ message_id: string; status?: string }>
  >('send-message', {
    body: {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      expected_lead_id: input.expectedLeadId,
      application_message_id: input.applicationMessageId ?? crypto.randomUUID(),
      content: { type: 'text', body: input.body },
    },
  });
  if (error) {
    // The request never got a response (connection dropped): the caller may
    // resend with the same application_message_id, which the server dedupes.
    if (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError')
      throw new Error('NETWORK_UNAVAILABLE');
    const context = (error as { context?: unknown }).context;
    const envelope = context instanceof Response ? await context.json().catch(() => null) : null;
    throw new Error(envelope?.error?.code ?? 'MESSAGE_SEND_FAILED');
  }
  if (!data?.ok) throw new Error(data?.error?.code ?? 'MESSAGE_SEND_FAILED');
  return data.data;
}

const replyTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider_template_id: z.string(),
  body: z.string(),
  placeholders: z.array(z.string()),
  // Templates synced from Meta: header and body fill their own {{n}} fields.
  sections: z
    .object({
      header: z.string().optional(),
      body: z.string().optional(),
      footer: z.string().optional(),
    })
    .nullable()
    .optional(),
});
const replyTemplateStateSchema = z.object({
  window_open: z.boolean(),
  window_expires_at: nullableString,
  suggestions: z.record(z.string(), z.string()),
  templates: z.array(replyTemplateSchema),
});
export type WhatsAppReplyTemplate = z.infer<typeof replyTemplateSchema>;
export type WhatsAppReplyTemplateState = z.infer<typeof replyTemplateStateSchema>;

/**
 * Whether Official WhatsApp's 24-hour customer-service window is open for this
 * conversation, and the approved templates that may open it when it is not.
 */
export async function fetchWhatsAppReplyTemplates(conversationId: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(10_000);
  const { data, error } = await createClient()
    .rpc('get_whatsapp_business_reply_templates', { target_conversation_id: conversationId })
    .abortSignal(signal ? AbortSignal.any([signal, timeout]) : timeout);
  if (error) throw error;
  return replyTemplateStateSchema.parse(data);
}

/** Meta refused the send; carries Meta's own error code and description. */
export class WhatsAppProviderError extends Error {
  constructor(
    readonly providerCode: number | null,
    readonly providerDetail: string | null,
  ) {
    super('WHATSAPP_PROVIDER_REJECTED');
    this.name = 'WhatsAppProviderError';
  }
}

/**
 * Sends an approved template. The server resolves the Meta template name and
 * body from the CRM record, so only the template and its field values go up.
 */
export async function sendInboxWhatsAppTemplate(input: {
  organizationId: string;
  conversationId: string;
  expectedLeadId: string | null;
  templateId: string;
  variables: Record<string, string>;
  applicationMessageId: string;
}) {
  const { data, error } = await createClient().functions.invoke<
    EdgeEnvelope<{ message_id: string; status?: string }>
  >('send-message', {
    body: {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      expected_lead_id: input.expectedLeadId,
      application_message_id: input.applicationMessageId,
      content: { type: 'crm_template', template_id: input.templateId, variables: input.variables },
    },
  });
  if (error) {
    if (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError')
      throw new Error('NETWORK_UNAVAILABLE');
    const context = (error as { context?: unknown }).context;
    const envelope = (
      context instanceof Response ? await context.json().catch(() => null) : null
    ) as EdgeEnvelope<{
      status?: string;
      provider_error_code?: number | null;
      provider_error?: string | null;
    }> | null;
    // Meta rejected it: the attempt is stored as a failed message in the thread.
    if (envelope?.data?.status === 'FAILED')
      throw new WhatsAppProviderError(
        envelope.data.provider_error_code ?? null,
        envelope.data.provider_error ?? null,
      );
    throw new Error(envelope?.error?.code ?? 'MESSAGE_SEND_FAILED');
  }
  if (!data?.ok) throw new Error(data?.error?.code ?? 'MESSAGE_SEND_FAILED');
  return data.data;
}

const leadOptionSchema = z.object({
  id: z.uuid(),
  customer_id: nullableUuid,
  branch_id: z.uuid(),
  team_id: nullableUuid,
  assigned_user_id: nullableUuid,
  customer_name: z.string(),
  phone: z.string(),
  interested_model: nullableString,
  lifecycle_status: z.string(),
  created_at: z.string(),
});
export async function fetchInboxLeadOptions(
  conversationId: string,
  search: string,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_inbox_lead_options', {
    target_conversation_id: conversationId,
    target_search: search,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(leadOptionSchema).parse(data);
}
export async function setInboxWorkingLead(input: {
  conversationId: string;
  leadId: string;
  expectedLeadId: string | null;
}) {
  const { error } = await createClient().rpc('set_inbox_working_lead', {
    target_conversation_id: input.conversationId,
    target_lead_id: input.leadId,
    expected_lead_id: input.expectedLeadId,
  });
  if (error) throw error;
}

const reviewTemplateSchema = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    template_id: z.uuid(),
    template_name: z.string(),
    variables: z.record(z.string(), z.string()),
  }),
]);

/**
 * The review template a Client Admin chose for this conversation's WhatsApp
 * connection, filled for this customer and the given review link. Used only
 * outside the 24-hour window, when Meta accepts nothing but a template.
 */
export async function resolveInboxReviewTemplate(conversationId: string, reviewLink: string) {
  const { data, error } = await createClient().rpc('resolve_inbox_review_template', {
    target_conversation_id: conversationId,
    target_review_link: reviewLink,
  });
  if (error) throw new Error(error.message || 'REVIEW_TEMPLATE_UNAVAILABLE');
  return reviewTemplateSchema.parse(data);
}
