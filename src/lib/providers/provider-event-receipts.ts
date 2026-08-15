import { parseGoogleLeadEnvelope, type GoogleLeadEnvelope } from './google-lead-form-adapter';
import type { MetaLeadEvent } from './meta-lead-adapter';
import {
  extractWhatsAppEvents,
  type WhatsAppDeliveryStatus,
  type WhatsAppInboundMessage,
} from './whatsapp-cloud-adapter';

const encoder = new TextEncoder();

export class InvalidProviderReceiptError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
    this.name = 'InvalidProviderReceiptError';
  }
}

function invalid(safeCode: string): never {
  throw new InvalidProviderReceiptError(safeCode);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : undefined;
}

function assertPayloadSize(payload: unknown, maximumBytes: number) {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    invalid('PROVIDER_EVENT_PAYLOAD_INVALID');
  }
  if (encoder.encode(serialized).byteLength > maximumBytes)
    invalid('PROVIDER_EVENT_PAYLOAD_TOO_LARGE');
}

function assertProviderEventId(actual: string, expected: string) {
  if (actual !== expected) invalid('PROVIDER_EVENT_ID_MISMATCH');
}

export function readMetaLeadReceipt(
  payload: unknown,
  expectedProviderEventId: string,
): MetaLeadEvent {
  assertPayloadSize(payload, 64_000);
  const event = record(record(payload)?.event);
  const leadId = boundedText(event?.leadId, 255);
  const pageId = boundedText(event?.pageId, 255);
  const eventId = boundedText(event?.eventId, 300);
  const formId = event?.formId === undefined ? undefined : boundedText(event.formId, 255);
  const occurredAt =
    event?.occurredAt === undefined ? undefined : boundedText(event.occurredAt, 64);
  if (!leadId || !pageId || !eventId || (event?.formId !== undefined && !formId))
    invalid('META_LEAD_RECEIPT_INVALID');
  if (occurredAt && !Number.isFinite(Date.parse(occurredAt))) invalid('META_LEAD_RECEIPT_INVALID');
  assertProviderEventId(eventId, expectedProviderEventId);
  assertProviderEventId(eventId, `leadgen:${leadId}`);
  return { eventId, leadId, pageId, formId, occurredAt };
}

export function readGoogleLeadReceipt(
  payload: unknown,
  expectedProviderEventId: string,
): { envelope: GoogleLeadEnvelope; safePayload: Record<string, unknown> } {
  assertPayloadSize(payload, 256_000);
  const receipt = record(payload);
  if (!receipt || !Array.isArray(receipt.user_column_data) || receipt.user_column_data.length > 100)
    invalid('GOOGLE_LEAD_RECEIPT_INVALID');
  const safePayload = { ...receipt };
  delete safePayload.google_key;
  let envelope: GoogleLeadEnvelope;
  try {
    envelope = parseGoogleLeadEnvelope({
      ...safePayload,
      google_key: 'verified-at-webhook-ingress',
    });
  } catch {
    invalid('GOOGLE_LEAD_RECEIPT_INVALID');
  }
  if (envelope.isTest) invalid('GOOGLE_TEST_EVENT_NOT_DISPATCHABLE');
  if (
    envelope.leadId.length > 255 ||
    (envelope.formId?.length ?? 0) > 255 ||
    (envelope.campaignId?.length ?? 0) > 255
  )
    invalid('GOOGLE_LEAD_RECEIPT_INVALID');
  assertProviderEventId(`google-lead:${envelope.leadId}`, expectedProviderEventId);
  return { envelope, safePayload };
}

function whatsAppEnvelope(
  payload: Record<string, unknown>,
  phoneNumberId: string,
  kind: 'message' | 'status',
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              ...(kind === 'message' ? { messages: [payload] } : { statuses: [payload] }),
            },
          },
        ],
      },
    ],
  };
}

function whatsappStoredPayload(payload: unknown, expectedPhoneNumberId: string) {
  const root = record(payload);
  if (!root) invalid('WHATSAPP_RECEIPT_INVALID');
  if (!('provider_payload' in root)) return { providerPayload: root, senderName: undefined };
  const phoneNumberId = boundedText(root.phone_number_id, 255);
  const providerPayload = record(root.provider_payload);
  if (!phoneNumberId || phoneNumberId !== expectedPhoneNumberId || !providerPayload)
    invalid('WHATSAPP_RECEIPT_ROUTE_MISMATCH');
  const senderName =
    root.sender_name === undefined ? undefined : boundedText(root.sender_name, 200);
  if (root.sender_name !== undefined && !senderName) invalid('WHATSAPP_INBOUND_RECEIPT_INVALID');
  return { providerPayload, senderName };
}

function validProviderTimestamp(value: unknown) {
  const normalized = boundedText(value, 20);
  const seconds = Number(normalized);
  return Boolean(normalized && Number.isFinite(seconds) && seconds > 0);
}

export function readWhatsAppInboundReceipt(
  payload: unknown,
  phoneNumberId: string,
  expectedProviderEventId: string,
): WhatsAppInboundMessage {
  assertPayloadSize(payload, 262_144);
  const stored = whatsappStoredPayload(payload, phoneNumberId);
  const receipt = stored.providerPayload;
  const sender = boundedText(receipt.from, 32);
  if (
    !boundedText(receipt.id, 512) ||
    !sender ||
    !/^[0-9]{7,20}$/.test(sender) ||
    !boundedText(receipt.type, 64) ||
    !validProviderTimestamp(receipt.timestamp)
  )
    invalid('WHATSAPP_INBOUND_RECEIPT_INVALID');
  const events = extractWhatsAppEvents(whatsAppEnvelope(receipt, phoneNumberId, 'message'));
  if (events.messages.length !== 1 || events.statuses.length !== 0)
    invalid('WHATSAPP_INBOUND_RECEIPT_INVALID');
  const message = events.messages[0];
  if ((message.body?.length ?? 0) > 65_535) invalid('WHATSAPP_INBOUND_RECEIPT_INVALID');
  assertProviderEventId(message.eventId, expectedProviderEventId);
  return stored.senderName ? { ...message, senderName: stored.senderName } : message;
}

const whatsappDeliveryStates = new Set(['SENT', 'DELIVERED', 'READ', 'FAILED']);

export function readWhatsAppStatusReceipt(
  payload: unknown,
  phoneNumberId: string,
  expectedProviderEventId: string,
): WhatsAppDeliveryStatus {
  assertPayloadSize(payload, 256_000);
  const receipt = whatsappStoredPayload(payload, phoneNumberId).providerPayload;
  const recipient = boundedText(receipt.recipient_id, 32);
  if (
    !boundedText(receipt.id, 512) ||
    !recipient ||
    !/^[0-9]{7,20}$/.test(recipient) ||
    !boundedText(receipt.status, 32) ||
    !validProviderTimestamp(receipt.timestamp)
  )
    invalid('WHATSAPP_STATUS_RECEIPT_INVALID');
  const events = extractWhatsAppEvents(whatsAppEnvelope(receipt, phoneNumberId, 'status'));
  if (events.statuses.length !== 1 || events.messages.length !== 0)
    invalid('WHATSAPP_STATUS_RECEIPT_INVALID');
  const status = events.statuses[0];
  if (!whatsappDeliveryStates.has(status.status)) invalid('WHATSAPP_STATUS_UNSUPPORTED');
  assertProviderEventId(status.eventId, expectedProviderEventId);
  return status;
}

export function providerEventRetryDelaySeconds(attemptCount: number, eventId: string) {
  const normalizedAttempt = Number.isSafeInteger(attemptCount)
    ? Math.max(1, Math.min(attemptCount, 8))
    : 1;
  const base = Math.min(3_600, 30 * 2 ** (normalizedAttempt - 1));
  let hash = 0;
  for (const character of eventId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const jitter = hash % (Math.floor(base / 4) + 1);
  return Math.min(3_600, base + jitter);
}
