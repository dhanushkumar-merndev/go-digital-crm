import { jidDecode, type WAMessage } from '@whiskeysockets/baileys';

// LID values are opaque identities, never phone numbers. Only a provider-supplied
// PN alternative may be used; no contact/profile harvesting is performed.
export function normalizeMessage(message: WAMessage, linkedAt: number) {
  const jid = message.key.remoteJid;
  if (!jid || (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid'))) return null;
  const alternate = (message.key as typeof message.key & { remoteJidAlt?: string }).remoteJidAlt;
  const phoneJid = jid.endsWith('@s.whatsapp.net') ? jid : alternate;
  if (!phoneJid?.endsWith('@s.whatsapp.net')) return null;
  const phone = jidDecode(phoneJid)?.user;
  if (!phone || !/^\d{7,15}$/.test(phone)) return null;
  const sentAt = Number(message.messageTimestamp) * 1000;
  if (
    !Number.isFinite(sentAt) ||
    sentAt < linkedAt ||
    sentAt > Date.now() + 60_000 ||
    !message.key.id
  )
    return null;
  const content = message.message;
  if (!content) return null;
  // Do not retain view-once/disappearing content or protocol/control messages.
  if (
    content.viewOnceMessage ||
    content.viewOnceMessageV2 ||
    content.ephemeralMessage ||
    content.protocolMessage
  )
    return null;
  const body = content.conversation ?? content.extendedTextMessage?.text;
  const type =
    body != null
      ? 'text'
      : content.imageMessage
        ? 'image'
        : content.videoMessage
          ? 'video'
          : content.audioMessage
            ? 'audio'
            : content.documentMessage
              ? 'document'
              : null;
  if (!type) return null;
  return {
    phone,
    provider_message_id: message.key.id,
    from_me: Boolean(message.key.fromMe),
    sent_at: new Date(sentAt).toISOString(),
    message_type: type,
    body: body?.slice(0, 65535) ?? null,
  };
}
