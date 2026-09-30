import type { CanonicalLeadInput } from './contracts';

export type IndiaMartQuery = {
  UNIQUE_QUERY_ID?: unknown;
  QUERY_TYPE?: unknown;
  QUERY_TIME?: unknown;
  SENDER_NAME?: unknown;
  SENDER_MOBILE?: unknown;
  SENDER_EMAIL?: unknown;
  SUBJECT?: unknown;
  PRODUCT_NAME?: unknown;
  SENDER_COMPANY?: unknown;
  SENDER_ADDRESS?: unknown;
  SENDER_CITY?: unknown;
  SENDER_STATE?: unknown;
  QUERY_MESSAGE?: unknown;
  [key: string]: unknown;
};

export type IndiaMartEnvelope = {
  leadId: string;
  customerName: string;
  phone: string;
  email?: string;
  location?: string;
  interestedModel?: string;
  message?: string;
  raw: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeProviderPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  const stripped = digits.replace(/^0+/, '');
  return stripped.length === 10 ? `+91${stripped}` : `+${stripped}`;
}

export function parseIndiaMartQuery(payload: unknown): IndiaMartEnvelope {
  const root = record(payload);
  if (!root) throw new Error('INDIAMART_QUERY_INVALID');

  const leadId =
    text(root.UNIQUE_QUERY_ID) ??
    text(root.unique_query_id) ??
    text(root.lead_id) ??
    text(root.id) ??
    `indiamart-${Date.now()}`;

  const customerName =
    text(root.SENDER_NAME) ?? text(root.sender_name) ?? text(root.name) ?? text(root.customer_name);

  const rawPhone =
    text(root.SENDER_MOBILE) ??
    text(root.sender_mobile) ??
    text(root.mobile) ??
    text(root.phone) ??
    text(root.SENDER_PHONE);

  if (!customerName || !rawPhone) {
    throw new Error('INDIAMART_LEAD_MINIMUM_FIELDS_MISSING');
  }

  const email = text(root.SENDER_EMAIL) ?? text(root.sender_email) ?? text(root.email);
  const city = text(root.SENDER_CITY) ?? text(root.sender_city) ?? text(root.city);
  const state = text(root.SENDER_STATE) ?? text(root.sender_state) ?? text(root.state);
  const location = [city, state].filter(Boolean).join(', ') || undefined;

  const interestedModel =
    text(root.PRODUCT_NAME) ??
    text(root.product_name) ??
    text(root.model) ??
    text(root.SUBJECT) ??
    text(root.subject);

  const message = text(root.QUERY_MESSAGE) ?? text(root.query_message) ?? text(root.message);

  return {
    leadId,
    customerName,
    phone: normalizeProviderPhone(rawPhone),
    email: email?.includes('@') ? email : undefined,
    location,
    interestedModel,
    message,
    raw: root,
  };
}

export function normalizeIndiaMartLead(envelope: IndiaMartEnvelope): CanonicalLeadInput {
  return {
    source: 'IndiaMART',
    customerName: envelope.customerName,
    phone: envelope.phone,
    email: envelope.email,
    location: envelope.location,
    interestedModel: envelope.interestedModel,
    sourceDetail: envelope.message ? `IndiaMART: ${envelope.message}` : 'IndiaMART Buyer Query',
    externalLeadId: envelope.leadId,
  };
}
