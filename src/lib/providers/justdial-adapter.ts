import type { CanonicalLeadInput } from './contracts';

export type JustdialEnvelope = {
  leadId: string;
  customerName: string;
  phone: string;
  email?: string;
  location?: string;
  category?: string;
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

export function parseJustdialLead(payload: unknown): JustdialEnvelope {
  const root = record(payload);
  if (!root) throw new Error('JUSTDIAL_PAYLOAD_INVALID');

  const leadId =
    text(root.leadid) ??
    text(root.lead_id) ??
    text(root.leadId) ??
    text(root.enquiryid) ??
    text(root.id) ??
    `justdial-${Date.now()}`;

  const customerName =
    text(root.name) ??
    text(root.customer_name) ??
    text(root.customerName) ??
    text(root.caller_name) ??
    text(root.lead_name);

  const rawPhone =
    text(root.mobile) ??
    text(root.phone) ??
    text(root.contact_number) ??
    text(root.caller_number) ??
    text(root.lead_phone) ??
    text(root.tel);

  if (!customerName || !rawPhone) {
    throw new Error('JUSTDIAL_LEAD_MINIMUM_FIELDS_MISSING');
  }

  const email =
    text(root.email) ?? text(root.email_id) ?? text(root.emailId) ?? text(root.customer_email);

  const area = text(root.area) ?? text(root.locality);
  const city = text(root.city) ?? text(root.city_name);
  const state = text(root.state);
  const location = [area, city, state].filter(Boolean).join(', ') || undefined;

  const category =
    text(root.category) ??
    text(root.service) ??
    text(root.enquiry_for) ??
    text(root.product) ??
    text(root.interested_in);

  const message =
    text(root.message) ??
    text(root.description) ??
    text(root.comments) ??
    text(root.notes) ??
    text(root.query);

  return {
    leadId,
    customerName,
    phone: normalizeProviderPhone(rawPhone),
    email: email?.includes('@') ? email : undefined,
    location,
    category,
    message,
    raw: root,
  };
}

export function normalizeJustdialLead(envelope: JustdialEnvelope): CanonicalLeadInput {
  const details = [
    envelope.category ? `Category: ${envelope.category}` : null,
    envelope.message ? `Details: ${envelope.message}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    source: 'Justdial',
    customerName: envelope.customerName,
    phone: envelope.phone,
    email: envelope.email,
    location: envelope.location,
    interestedModel: envelope.category,
    sourceDetail: details ? `Justdial: ${details}` : 'Justdial Verified Lead',
    externalLeadId: envelope.leadId,
  };
}
