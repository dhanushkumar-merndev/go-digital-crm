import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

export type LeadWhatsAppChannel = 'WHATSAPP_PERSONAL' | 'WHATSAPP_BUSINESS';

const openedConversationSchema = z.object({
  conversation_id: z.uuid(),
  channel: z.enum(['WHATSAPP_PERSONAL', 'WHATSAPP_BUSINESS']),
});

export async function openLeadWhatsAppConversation(input: {
  leadId: string;
  channel: LeadWhatsAppChannel;
}) {
  const { data, error } = await createClient().rpc('open_lead_whatsapp_conversation', {
    target_lead_id: input.leadId,
    target_channel: input.channel,
  });
  if (error) throw error;
  return openedConversationSchema.parse(data);
}

export function leadWhatsAppErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('PERSONAL_WHATSAPP_NOT_CONNECTED'))
    return 'Connect My WhatsApp from Inbox first, then try again.';
  if (message.includes('WHATSAPP_CONNECTION_UNAVAILABLE'))
    return 'No WhatsApp API connection is configured for this branch.';
  if (message.includes('LEAD_PHONE_INVALID'))
    return 'This lead does not have a valid WhatsApp phone number.';
  if (message.includes('MESSAGE_SEND_PERMISSION_REQUIRED'))
    return 'You do not have permission to send WhatsApp messages.';
  return 'The WhatsApp conversation could not be opened. Try again.';
}
