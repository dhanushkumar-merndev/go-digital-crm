import type { CanonicalLeadInput } from './contracts';

export type CarWaleEnvelope = {
  leadId: string;
  customerName: string;
  phone: string;
  email?: string;
  location?: string;
  interestedModel?: string;
  budget?: string;
  comments?: string;
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

export function parseCarWaleLead(payload: unknown): CarWaleEnvelope {
  const root = record(payload);
  if (!root) throw new Error('CARWALE_PAYLOAD_INVALID');

  const leadId =
    text(root.LeadId) ??
    text(root.lead_id) ??
    text(root.EnquiryId) ??
    text(root.enquiry_id) ??
    text(root.id) ??
    `carwale-${Date.now()}`;

  const customerName =
    text(root.CustomerName) ??
    text(root.customer_name) ??
    text(root.Name) ??
    text(root.name) ??
    text(root.buyer_name);

  const rawPhone =
    text(root.CustomerPhone) ??
    text(root.customer_phone) ??
    text(root.Phone) ??
    text(root.phone) ??
    text(root.Mobile) ??
    text(root.mobile);

  if (!customerName || !rawPhone) {
    throw new Error('CARWALE_LEAD_MINIMUM_FIELDS_MISSING');
  }

  const email =
    text(root.CustomerEmail) ?? text(root.customer_email) ?? text(root.Email) ?? text(root.email);

  const city = text(root.City) ?? text(root.city);
  const state = text(root.State) ?? text(root.state);
  const location = [city, state].filter(Boolean).join(', ') || undefined;

  const interestedModel =
    text(root.CarName) ??
    text(root.car_name) ??
    text(root.Model) ??
    text(root.model) ??
    text(root.MakeModel) ??
    text(root.make_model) ??
    text(root.Variant) ??
    text(root.variant);

  const budget = text(root.Budget) ?? text(root.budget);
  const comments =
    text(root.Comments) ??
    text(root.comments) ??
    text(root.Description) ??
    text(root.description) ??
    text(root.Notes) ??
    text(root.notes);

  return {
    leadId,
    customerName,
    phone: normalizeProviderPhone(rawPhone),
    email: email?.includes('@') ? email : undefined,
    location,
    interestedModel,
    budget,
    comments,
    raw: root,
  };
}

export function normalizeCarWaleLead(envelope: CarWaleEnvelope): CanonicalLeadInput {
  const details = [
    envelope.comments ? `Comments: ${envelope.comments}` : null,
    envelope.budget ? `Budget: ${envelope.budget}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    source: 'CarWale',
    customerName: envelope.customerName,
    phone: envelope.phone,
    email: envelope.email,
    location: envelope.location,
    interestedModel: envelope.interestedModel,
    sourceDetail: details ? `CarWale: ${details}` : 'CarWale Buyer Enquiry',
    externalLeadId: envelope.leadId,
  };
}
