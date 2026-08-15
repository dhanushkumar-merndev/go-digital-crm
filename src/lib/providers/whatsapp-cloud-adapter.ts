export type WhatsAppInboundMessage = {
  eventId: string;
  phoneNumberId: string;
  sender: string;
  senderName?: string;
  sentAt: string;
  messageType: string;
  body?: string;
  providerPayload: Record<string, unknown>;
};

export type WhatsAppDeliveryStatus = {
  eventId: string;
  phoneNumberId: string;
  providerMessageId: string;
  applicationMessageId?: string;
  recipient: string;
  status: string;
  occurredAt: string;
  providerPayload: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function timestamp(value: unknown) {
  const seconds = Number(text(value));
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

function inboundBody(message: Record<string, unknown>) {
  const type = text(message.type);
  if (type === 'text') return text(record(message.text)?.body);
  if (type === 'button') return text(record(message.button)?.text);
  if (type === 'interactive') {
    const interactive = record(message.interactive);
    return (
      text(record(interactive?.button_reply)?.title) ?? text(record(interactive?.list_reply)?.title)
    );
  }
  return undefined;
}

export function extractWhatsAppEvents(payload: unknown) {
  const root = record(payload);
  const messages: WhatsAppInboundMessage[] = [];
  const statuses: WhatsAppDeliveryStatus[] = [];
  if (!root || root.object !== 'whatsapp_business_account' || !Array.isArray(root.entry))
    return { messages, statuses };

  for (const rawEntry of root.entry) {
    const entry = record(rawEntry);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const rawChange of entry.changes) {
      const change = record(rawChange);
      const value = record(change?.value);
      const metadata = record(value?.metadata);
      const phoneNumberId = text(metadata?.phone_number_id);
      if (change?.field !== 'messages' || !value || !phoneNumberId) continue;
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const names = new Map<string, string>();
      for (const rawContact of contacts) {
        const contact = record(rawContact);
        const waId = text(contact?.wa_id);
        const name = text(record(contact?.profile)?.name);
        if (waId && name) names.set(waId, name);
      }
      if (Array.isArray(value.messages)) {
        for (const rawMessage of value.messages) {
          const message = record(rawMessage);
          const id = text(message?.id);
          const sender = text(message?.from);
          if (!message || !id || !sender) continue;
          messages.push({
            eventId: `whatsapp-message:${id}`,
            phoneNumberId,
            sender,
            senderName: names.get(sender),
            sentAt: timestamp(message.timestamp),
            messageType: text(message.type) ?? 'unknown',
            body: inboundBody(message),
            providerPayload: message,
          });
        }
      }
      if (Array.isArray(value.statuses)) {
        for (const rawStatus of value.statuses) {
          const status = record(rawStatus);
          const id = text(status?.id);
          const recipient = text(status?.recipient_id);
          const state = text(status?.status);
          if (!status || !id || !recipient || !state) continue;
          statuses.push({
            eventId: `whatsapp-status:${id}:${state}`,
            phoneNumberId,
            providerMessageId: id,
            applicationMessageId: text(status.biz_opaque_callback_data),
            recipient,
            status: state.toLocaleUpperCase(),
            occurredAt: timestamp(status.timestamp),
            providerPayload: status,
          });
        }
      }
    }
  }
  return { messages, statuses };
}
