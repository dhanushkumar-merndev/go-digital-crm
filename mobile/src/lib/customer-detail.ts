import { fetchMobileRole } from '@/lib/lead-detail';
import { supabase } from '@/lib/supabase';

// Customer 360 on mobile, grouped by enquiry (AGENTS.md 9.9).
// - Sales Consultant: the same core + per-section RPCs as the web workspace;
//   each tab is server-paged and the lead picker filters in SQL.
// - Telecaller: those RPCs require customer.view, which a Telecaller lacks, so
//   the tabs read the one scope-checked `get_customer_360` payload the web
//   Telecaller view uses. Its lists are bounded server-side.

export const customer360Tabs = [
  { key: 'overview', label: 'Overview' },
  { key: 'leads', label: 'Leads' },
  { key: 'calls', label: 'Calls' },
  { key: 'followups', label: 'Follow-ups' },
  { key: 'appointments', label: 'Visits' },
  { key: 'test_drives', label: 'Test drives' },
  { key: 'quotations', label: 'Quotations' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'vehicles', label: 'Vehicles' },
  { key: 'timeline', label: 'Timeline' },
] as const;

export type Customer360Tab = (typeof customer360Tabs)[number]['key'];
export type Customer360Section = Exclude<Customer360Tab, 'overview'>;

/** Tabs whose rows belong to one enquiry, so the lead picker applies. */
export const leadScopedSections: ReadonlySet<Customer360Section> = new Set([
  'calls',
  'followups',
  'appointments',
  'timeline',
]);

type Access = Record<string, boolean>;

export type Customer360Requirements = {
  variant: string | null;
  budget_max: number | string | null;
  purchase_timeline: string | null;
  finance_required: boolean | null;
  exchange_required: boolean | null;
  test_drive_required: boolean | null;
  competitors: string[] | null;
} | null;

export type Customer360LeadOption = {
  id: string;
  source: string;
  interested_model: string | null;
  lifecycle_status: string;
  created_at: string;
};

export type Customer360Core = {
  role: 'telecaller' | 'sales-consultant';
  customer: {
    id: string;
    full_name: string;
    primary_phone: string | null;
    primary_email: string | null;
    whatsapp_phone?: string | null;
  };
  opportunity: {
    id: string;
    source: string;
    campaign?: string | null;
    interested_model: string | null;
    lifecycle_status: string;
    temperature: string | null;
    work_state: string | null;
    branch_name: string;
    team_name: string | null;
    assigned_user_name: string | null;
    requirements?: Customer360Requirements;
    latest_call_summary?: {
      call_id: string;
      summary: string;
      started_at: string;
      caller_name: string | null;
    } | null;
  } | null;
  access: Access;
  leadOptions: Customer360LeadOption[];
  contacts: Array<{ id: string; type: string; value: string; is_primary: boolean }>;
  notes: Array<{ id: string; body: string; created_by_name: string | null; created_at: string }>;
  /** The whole Telecaller payload; the Sales path pages sections instead. */
  full: Record<string, unknown> | null;
};

export type Customer360Row = Record<string, unknown> & { id: string };

export type Customer360Page = {
  records: Customer360Row[];
  total: number;
  hasMore: boolean;
  /** Keyset cursor for the timeline, which pages by (occurred_at, id). */
  nextCursor: { occurred_at: string; id: string } | null;
};

function rows(value: unknown): Customer360Row[] {
  return Array.isArray(value) ? (value as Customer360Row[]) : [];
}

export async function fetchCustomer360(customerId: string): Promise<Customer360Core> {
  const role = (await fetchMobileRole()) === 'sales-consultant' ? 'sales-consultant' : 'telecaller';
  const { data, error } = await supabase.rpc(
    role === 'sales-consultant' ? 'get_sales_consultant_customer_360_core' : 'get_customer_360',
    { target_customer_id: customerId },
  );
  if (error || !data) throw error ?? new Error('CUSTOMER_NOT_FOUND');
  const payload = data as Record<string, unknown>;
  const leads = rows(payload.leads) as unknown as Customer360LeadOption[];
  return {
    role,
    customer: payload.customer as Customer360Core['customer'],
    opportunity: (payload.current_opportunity ?? null) as Customer360Core['opportunity'],
    access: (payload.section_access ?? {}) as Access,
    leadOptions:
      role === 'sales-consultant'
        ? (rows(payload.lead_options) as unknown as Customer360LeadOption[])
        : leads,
    contacts: rows(payload.contacts) as unknown as Customer360Core['contacts'],
    notes: rows(payload.notes) as unknown as Customer360Core['notes'],
    full: role === 'sales-consultant' ? null : payload,
  };
}

export function customer360TabAllowed(core: Customer360Core, tab: Customer360Tab) {
  return tab === 'overview' || core.access[tab] === true;
}

export async function fetchCustomer360Section(input: {
  core: Customer360Core;
  section: Customer360Section;
  page: number;
  leadId: string | null;
  cursor: Customer360Page['nextCursor'];
}): Promise<Customer360Page> {
  const { core, section, leadId } = input;
  if (core.full) {
    const all = rows(core.full[section]);
    const records =
      leadId && leadScopedSections.has(section)
        ? all.filter((record) => record.lead_id === leadId)
        : all;
    return { records, total: records.length, hasMore: false, nextCursor: null };
  }
  const { data, error } = await supabase.rpc('get_sales_consultant_customer_360_section', {
    target_customer_id: core.customer.id,
    target_section: section.toUpperCase(),
    target_page: input.page,
    target_page_size: 25,
    target_cursor_at: input.cursor?.occurred_at ?? null,
    target_cursor_id: input.cursor?.id ?? null,
    target_lead_id: leadScopedSections.has(section) ? leadId : null,
  });
  if (error || !data) throw error ?? new Error('CUSTOMER_360_SECTION_UNAVAILABLE');
  const envelope = data as {
    records?: unknown;
    total?: number;
    has_more?: boolean;
    next_cursor?: Customer360Page['nextCursor'];
  };
  return {
    records: rows(envelope.records),
    total: Number(envelope.total ?? 0),
    hasMore: Boolean(envelope.has_more),
    nextCursor: envelope.next_cursor ?? null,
  };
}

export type LeadJourneyEvent = {
  id: string;
  occurred_at: string;
  kind: string;
  title: string;
  detail: string | null;
  actor_name: string | null;
  status: string | null;
};

/** Who called and when, stage and owner changes, visits, drives, quotes for one lead. */
export async function fetchLeadJourney(
  leadId: string,
  cursor: { occurred_at: string; id: string } | null,
) {
  const { data, error } = await supabase.rpc('get_lead_journey', {
    target_lead_id: leadId,
    target_cursor_at: cursor?.occurred_at ?? null,
    target_cursor_id: cursor?.id ?? null,
    target_limit: 25,
  });
  if (error || !data) throw error ?? new Error('LEAD_JOURNEY_UNAVAILABLE');
  const page = data as {
    events?: LeadJourneyEvent[];
    next_cursor?: { occurred_at: string; id: string } | null;
  };
  return { events: page.events ?? [], nextCursor: page.next_cursor ?? null };
}
