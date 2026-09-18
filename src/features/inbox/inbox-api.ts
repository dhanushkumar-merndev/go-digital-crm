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
    const envelope = await (error as { context?: Response }).context?.json().catch(() => null);
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
