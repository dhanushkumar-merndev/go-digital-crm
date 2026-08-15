import type { CanonicalLeadInput } from './contracts';

export type MetaLeadEvent = {
  eventId: string;
  leadId: string;
  pageId: string;
  formId?: string;
  occurredAt?: string;
};

type MetaField = { name?: unknown; values?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeProviderPhone(phone: string) {
  const normalized = phone.replace(/[^\d+]/g, '');
  return normalized.startsWith('+') ? normalized : `+91${normalized.replace(/^0+/, '')}`;
}

export function extractMetaLeadEvents(payload: unknown): MetaLeadEvent[] {
  const root = record(payload);
  if (!root || root.object !== 'page' || !Array.isArray(root.entry)) return [];
  const events: MetaLeadEvent[] = [];
  for (const rawEntry of root.entry) {
    const entry = record(rawEntry);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const rawChange of entry.changes) {
      const change = record(rawChange);
      const value = record(change?.value);
      const leadId = text(value?.leadgen_id);
      const pageId = text(value?.page_id) ?? text(entry.id);
      if (change?.field !== 'leadgen' || !leadId || !pageId) continue;
      const createdSeconds =
        typeof value?.created_time === 'number' && Number.isFinite(value.created_time)
          ? value.created_time
          : undefined;
      events.push({
        eventId: `leadgen:${leadId}`,
        leadId,
        pageId,
        formId: text(value?.form_id),
        occurredAt: createdSeconds ? new Date(createdSeconds * 1000).toISOString() : undefined,
      });
    }
  }
  return events;
}

export function normalizeMetaLead(
  payload: unknown,
  input: { externalLeadId: string; sourceDetail?: string },
): CanonicalLeadInput {
  const lead = record(payload);
  if (!lead || !Array.isArray(lead.field_data)) throw new Error('META_LEAD_FIELDS_MISSING');
  const fields = new Map<string, string>();
  for (const rawField of lead.field_data as MetaField[]) {
    const name = text(rawField.name)?.toLocaleLowerCase();
    const value = Array.isArray(rawField.values) ? text(rawField.values[0]) : undefined;
    if (name && value) fields.set(name, value);
  }
  const firstName = fields.get('first_name');
  const lastName = fields.get('last_name');
  const customerName =
    fields.get('full_name') ??
    fields.get('name') ??
    [firstName, lastName].filter(Boolean).join(' ').trim();
  const phone =
    fields.get('phone_number') ??
    fields.get('phone') ??
    fields.get('mobile_number') ??
    fields.get('mobile');
  if (!customerName || !phone) throw new Error('META_LEAD_MINIMUM_FIELDS_MISSING');
  const city = fields.get('city');
  const state = fields.get('state');
  const campaign = text(lead.campaign_name) ?? fields.get('campaign');
  const platform = text(lead.platform)?.toLocaleLowerCase();
  return {
    source: platform === 'instagram' ? 'Instagram' : 'Facebook',
    customerName,
    phone: normalizeProviderPhone(phone),
    email: fields.get('email'),
    location: fields.get('location') ?? ([city, state].filter(Boolean).join(', ') || undefined),
    campaign,
    interestedModel:
      fields.get('interested_model') ?? fields.get('car_model') ?? fields.get('model'),
    sourceDetail: input.sourceDetail ?? 'Meta Lead Ads',
    externalLeadId: input.externalLeadId,
  };
}
