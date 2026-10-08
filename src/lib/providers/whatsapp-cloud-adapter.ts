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

export type WhatsAppGraphFailure = {
  code: string;
  message: string;
  status: 422 | 429 | 502;
  providerCode: number | null;
  providerSubcode: number | null;
  providerType: string | null;
  fbtraceId: string | null;
};

const graphRateLimitCodes = new Set([4, 17, 32, 613, 80007, 130429]);

// Turns a Graph API error response into a stable CRM code and an actionable message. Only the
// numeric codes and trace ID are kept; Graph's own message text is dropped so nothing it echoes
// back ends up in logs or the browser.
export function classifyWhatsAppGraphError(
  httpStatus: number,
  body: unknown,
): WhatsAppGraphFailure {
  const error = record(record(body)?.error);
  const providerCode = Number.isFinite(Number(error?.code)) ? Number(error?.code) : null;
  const providerSubcode = Number.isFinite(Number(error?.error_subcode))
    ? Number(error?.error_subcode)
    : null;
  const provider = {
    providerCode,
    providerSubcode,
    providerType: text(error?.type) ?? null,
    fbtraceId: text(error?.fbtrace_id) ?? null,
  };

  if (providerCode === 190)
    return {
      code: 'WHATSAPP_TOKEN_INVALID',
      message:
        providerSubcode === 463
          ? 'Meta says this access token has expired. Generate a System User token set to never expire.'
          : 'Meta did not accept this access token. Copy the full token again or generate a new one.',
      status: 422,
      ...provider,
    };
  if (providerCode === 100 && providerSubcode === 33)
    return {
      code: 'WHATSAPP_ASSET_NOT_ASSIGNED',
      message:
        'This token cannot see that phone number. Assign the WhatsApp account to the System User with full control, then generate a new token.',
      status: 422,
      ...provider,
    };
  if (providerCode === 100)
    return {
      code: 'WHATSAPP_PHONE_NUMBER_ID_INVALID',
      message:
        'Meta did not recognise the phone number ID. Copy it from WhatsApp Manager > API Setup; it is not the WhatsApp Business Account ID or the phone number itself.',
      status: 422,
      ...provider,
    };
  if (providerCode === 10 || (providerCode !== null && providerCode >= 200 && providerCode <= 299))
    return {
      code: 'WHATSAPP_PERMISSION_MISSING',
      message:
        'This token is missing WhatsApp permissions. Generate it again with whatsapp_business_messaging and whatsapp_business_management.',
      status: 422,
      ...provider,
    };
  if (providerCode !== null && graphRateLimitCodes.has(providerCode))
    return {
      code: 'WHATSAPP_RATE_LIMITED',
      message: 'Meta is rate limiting this account. Wait a few minutes and try again.',
      status: 429,
      ...provider,
    };
  if (httpStatus >= 500 || providerCode === 1 || providerCode === 2)
    return {
      code: 'WHATSAPP_PROVIDER_UNAVAILABLE',
      message: 'Meta could not process the check right now. Try again in a few minutes.',
      status: 502,
      ...provider,
    };
  return {
    code: 'WHATSAPP_CONNECTION_TEST_FAILED',
    message:
      providerCode === null
        ? 'WhatsApp rejected the phone-number credential.'
        : `WhatsApp rejected the phone-number credential (Meta error ${providerCode}${providerSubcode === null ? '' : `/${providerSubcode}`}).`,
    status: 422,
    ...provider,
  };
}
