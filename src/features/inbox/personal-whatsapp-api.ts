import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const statusSchema = z.object({
  connection_id: z.uuid(),
  status: z.string(),
  enabled: z.boolean(),
  masked_phone: z.string().nullable(),
  heartbeat_at: z.string().nullable(),
  daily_sent: z.number(),
  daily_limit: z.number(),
  paused_until: z.string().nullable(),
  next_send_at: z.string().nullable(),
  reply_window_expires_at: z.string().nullable(),
  send_disabled_reason: z.string().nullable(),
  qr: z.string().nullable(),
  qr_expires_at: z.string().nullable(),
  attempt_expires_at: z.string(),
});
export type PersonalWhatsAppStatus = z.infer<typeof statusSchema>;
export async function fetchPersonalWhatsAppStatus(conversationId?: string, signal?: AbortSignal) {
  const query = createClient().rpc('get_personal_whatsapp_status', {
    target_conversation_id: conversationId ?? null,
  });
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw error;
  return statusSchema.nullable().parse(data);
}
async function invoke(name: string, body: unknown) {
  const { data, error } = await createClient().functions.invoke(name, {
    body: body as Record<string, unknown>,
  });
  if (error) {
    const response = (error as { context?: Response }).context;
    const envelope = await response?.json().catch(() => null);
    throw new Error(envelope?.error?.code ?? 'PERSONAL_WHATSAPP_REQUEST_FAILED');
  }
  if (!data?.ok) throw new Error(data?.error?.code ?? 'PERSONAL_WHATSAPP_REQUEST_FAILED');
  return data.data;
}
export const startPersonalWhatsApp = () =>
  invoke('personal-whatsapp-link-start', { consent_version: 'pilot-v1' });
export const disconnectPersonalWhatsApp = (connectionId: string) =>
  invoke('personal-whatsapp-disconnect', { connection_id: connectionId });
export async function acknowledgeUnknownWhatsAppMessage(messageId: string) {
  const { error } = await createClient().rpc('personal_whatsapp_resolve_unknown', {
    target_message_id: messageId,
  });
  if (error) throw error;
}

export function personalWhatsAppReason(code: string | null | undefined) {
  const reasons: Record<string, string> = {
    PERSONAL_WHATSAPP_DISCONNECTED: 'Your WhatsApp is disconnected. Open My WhatsApp to reconnect.',
    PERSONAL_WHATSAPP_REPLY_WINDOW_CLOSED:
      'Wait for a new customer message. Replies are available for 24 hours after they contact you.',
    PERSONAL_WHATSAPP_RATE_LIMITED:
      'Your reply limit has been reached. Wait until the next available send time.',
    PERSONAL_WHATSAPP_PAUSED: 'Sending is paused for 30 minutes after repeated failures.',
    PERSONAL_WHATSAPP_SEND_UNRESOLVED:
      'A previous send is pending or unconfirmed. Check its status before sending again.',
    PERSONAL_WHATSAPP_CAPACITY:
      'The pilot has reached its connected-number limit. Try again when a slot is free.',
    PERSONAL_WHATSAPP_NOT_CONFIGURED:
      'Personal WhatsApp setup is not complete. Contact your administrator.',
    PERSONAL_WHATSAPP_BRANCH_REQUIRED: 'A branch assignment is required to link WhatsApp.',
    PERSONAL_WHATSAPP_ROLE_REQUIRED:
      'Personal WhatsApp is available only to authorized Telecallers and Sales Consultants.',
  };
  return code ? (reasons[code] ?? 'Personal WhatsApp is unavailable. Please try again.') : null;
}
