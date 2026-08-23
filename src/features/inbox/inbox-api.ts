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
  input: { search: string; channel: string; page: number },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_inbox_conversation_page', {
    target_search: input.search,
    target_channel: input.channel,
    target_page: input.page,
    target_page_size: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return conversationPageSchema.parse(data);
}

export async function fetchInboxMessagePage(
  input: { conversationId: string; beforeAt?: string | null; beforeId?: string | null },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_inbox_message_page', {
    target_conversation_id: input.conversationId,
    target_before_at: input.beforeAt ?? null,
    target_before_id: input.beforeId ?? null,
    target_page_size: 100,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return messagePageSchema.parse(data);
}

type EdgeEnvelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string } };

export async function sendInboxWhatsAppMessage(input: {
  organizationId: string;
  conversationId: string;
  body: string;
}) {
  const { data, error } = await createClient().functions.invoke<
    EdgeEnvelope<{ message_id: string }>
  >('send-message', {
    body: {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      application_message_id: crypto.randomUUID(),
      content: { type: 'text', body: input.body },
    },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error?.code ?? 'MESSAGE_SEND_FAILED');
  return data.data;
}
