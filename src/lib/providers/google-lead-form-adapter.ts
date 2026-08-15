import type { CanonicalLeadInput } from './contracts';

type GoogleLeadColumn = {
  column_id?: unknown;
  column_name?: unknown;
  string_value?: unknown;
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

function normalizeProviderPhone(phone: string) {
  const normalized = phone.replace(/[^\d+]/g, '');
  return normalized.startsWith('+') ? normalized : `+91${normalized.replace(/^0+/, '')}`;
}

export type GoogleLeadEnvelope = {
  leadId: string;
  googleKey: string;
  formId?: string;
  campaignId?: string;
  isTest: boolean;
  raw: Record<string, unknown>;
};

export function parseGoogleLeadEnvelope(payload: unknown): GoogleLeadEnvelope {
  const root = record(payload);
  const leadId = text(root?.lead_id);
  const googleKey = text(root?.google_key);
  if (!root || !leadId || !googleKey || !Array.isArray(root.user_column_data))
    throw new Error('GOOGLE_LEAD_ENVELOPE_INVALID');
  return {
    leadId,
    googleKey,
    formId: text(root.form_id),
    campaignId: text(root.campaign_id),
    isTest: root.is_test === true,
    raw: root,
  };
}

export function normalizeGoogleLead(envelope: GoogleLeadEnvelope): CanonicalLeadInput {
  const fields = new Map<string, string>();
  for (const rawColumn of envelope.raw.user_column_data as GoogleLeadColumn[]) {
    const value = text(rawColumn.string_value);
    const columnId = text(rawColumn.column_id)?.toLocaleUpperCase();
    const columnName = text(rawColumn.column_name)?.toLocaleLowerCase();
    if (!value) continue;
    if (columnId) fields.set(columnId, value);
    if (columnName) fields.set(columnName, value);
  }
  const customerName =
    fields.get('FULL_NAME') ??
    fields.get('full name') ??
    [fields.get('FIRST_NAME'), fields.get('LAST_NAME')].filter(Boolean).join(' ').trim();
  const phone =
    fields.get('PHONE_NUMBER') ?? fields.get('phone number') ?? fields.get('user phone');
  if (!customerName || !phone) throw new Error('GOOGLE_LEAD_MINIMUM_FIELDS_MISSING');
  return {
    source: 'Google Ads',
    customerName,
    phone: normalizeProviderPhone(phone),
    email: fields.get('EMAIL') ?? fields.get('user email'),
    location:
      fields.get('CITY') ??
      fields.get('city') ??
      fields.get('POSTAL_CODE') ??
      fields.get('postal code'),
    campaign: envelope.campaignId,
    interestedModel:
      fields.get('INTERESTED_MODEL') ??
      fields.get('preferred model') ??
      fields.get('what is your preferred model?'),
    sourceDetail: envelope.formId ? `Google Lead Form ${envelope.formId}` : 'Google Lead Form',
    externalLeadId: envelope.leadId,
  };
}
