import type { CanonicalLeadInput } from './contracts';

export type CarDekhoEnvelope = {
  leadId: string;
  customerName: string;
  phone: string;
  email?: string;
  location?: string;
  interestedModel?: string;
  budget?: string;
  remarks?: string;
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

export function parseCarDekhoLead(payload: unknown): CarDekhoEnvelope {
  const root = record(payload);
  if (!root) throw new Error('CARDEKHO_PAYLOAD_INVALID');

  const leadId =
    text(root.lead_id) ??
    text(root.leadId) ??
    text(root.enquiry_id) ??
    text(root.enquiryId) ??
    text(root.id) ??
    `cardekho-${Date.now()}`;

  const customerName =
    text(root.name) ??
    text(root.customer_name) ??
    text(root.customerName) ??
    text(root.buyer_name) ??
    text(root.buyerName);

  const rawPhone =
    text(root.mobile) ??
    text(root.phone) ??
    text(root.contact_no) ??
    text(root.contactNo) ??
    text(root.mobile_number) ??
    text(root.mobileNumber);

  if (!customerName || !rawPhone) {
    throw new Error('CARDEKHO_LEAD_MINIMUM_FIELDS_MISSING');
  }

  const email =
    text(root.email) ?? text(root.email_id) ?? text(root.emailId) ?? text(root.customer_email);

  const city = text(root.city) ?? text(root.city_name) ?? text(root.cityName);
  const state = text(root.state) ?? text(root.state_name) ?? text(root.stateName);
  const location = [city, state].filter(Boolean).join(', ') || undefined;

  const interestedModel =
    text(root.model) ??
    text(root.car_model) ??
    text(root.carModel) ??
    text(root.variant) ??
    text(root.version) ??
    text(root.make);

  const budget = text(root.budget) ?? text(root.buyer_budget) ?? text(root.buyerBudget);
  const remarks =
    text(root.remarks) ??
    text(root.comments) ??
    text(root.message) ??
    text(root.notes) ??
    text(root.description);

  return {
    leadId,
    customerName,
    phone: normalizeProviderPhone(rawPhone),
    email: email?.includes('@') ? email : undefined,
    location,
    interestedModel,
    budget,
    remarks,
    raw: root,
  };
}

export function normalizeCarDekhoLead(envelope: CarDekhoEnvelope): CanonicalLeadInput {
  const details = [
    envelope.remarks ? `Remarks: ${envelope.remarks}` : null,
    envelope.budget ? `Budget: ${envelope.budget}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    source: 'CarDekho',
    customerName: envelope.customerName,
    phone: envelope.phone,
    email: envelope.email,
    location: envelope.location,
    interestedModel: envelope.interestedModel,
    sourceDetail: details ? `CarDekho: ${details}` : 'CarDekho Inbound Lead',
    externalLeadId: envelope.leadId,
  };
}
