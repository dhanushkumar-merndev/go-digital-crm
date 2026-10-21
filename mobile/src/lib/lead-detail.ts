import { fetchAccessContext } from '@/lib/access-context';
import { supabase } from '@/lib/supabase';

export type MobileLeadDetail = {
  lead: {
    id: string;
    branch_id: string;
    branch_name: string;
    team_id: string | null;
    team_name: string | null;
    customer_id: string | null;
    customer_name: string;
    phone: string;
    email: string | null;
    source: string;
    interested_model: string | null;
    lifecycle_status: string;
    temperature: 'COLD' | 'WARM' | 'HOT' | 'DORMANT' | null;
    work_state: 'NEW_TODAY' | 'PENDING' | 'SLA_RISK' | null;
    assigned_user_name: string | null;
    next_followup_at: string | null;
    updated_at: string;
    /** Null until the lead's requirements are first saved. */
    requirements?: {
      variant: string | null;
      budget_max: number | string | null;
      purchase_timeline: string | null;
      finance_required: boolean | null;
      exchange_required: boolean | null;
      test_drive_required: boolean | null;
      competitors: string[] | null;
    } | null;
  };
  access: {
    can_followups: boolean;
    can_calls: boolean;
    can_appointments: boolean;
    can_update: boolean;
  };
  counts: { calls: number; messages: number; followups: number; appointments: number };
  followups: Array<{
    id: string;
    reason: string;
    priority: string;
    due_at: string;
    status: string;
    assigned_user_name: string | null;
  }>;
  calls: Array<{
    id: string;
    started_at: string;
    duration_seconds: number | null;
    outcome: string | null;
    status: string;
  }>;
  timeline: Array<{
    id: string;
    occurred_at: string;
    kind: string;
    title: string;
    detail: string;
  }>;
  latest_ai_summary: string | null;
};

export async function fetchMobileLeadDetail(leadId: string): Promise<MobileLeadDetail> {
  const { data, error } = await supabase.rpc('get_lead_detail_workspace', {
    target_lead_id: leadId,
  });
  if (error || !data) throw error ?? new Error('LEAD_DETAIL_NOT_FOUND');
  return data as MobileLeadDetail;
}

export async function createMobileLeadFollowup(input: {
  detail: MobileLeadDetail;
  reason: string;
  dueAt: string;
  requestId: string;
}) {
  const { error } = await supabase.rpc('create_followup', {
    target_lead_id: input.detail.lead.id,
    target_customer_id: input.detail.lead.customer_id,
    target_branch_id: input.detail.lead.branch_id,
    target_team_id: input.detail.lead.team_id,
    target_assigned_user_id: null,
    followup_reason: input.reason,
    followup_due_at: input.dueAt,
    followup_priority: 'NORMAL',
    target_request_id: input.requestId,
  });
  if (error) throw error;
}

export type MobileRole = 'telecaller' | 'sales-consultant' | null;

// Throws on a failed read: a role silently read as null would make Call skip
// recording the contact with no message.
export async function fetchMobileRole(): Promise<MobileRole> {
  const role = (await fetchAccessContext()).role_key;
  return role === 'telecaller' || role === 'sales-consultant' ? role : null;
}

// Telecaller intake and Sales ownership record a contact through different
// RPCs, the same ones the web lead list calls when Call is pressed.
export async function recordMobileLeadContact(role: MobileRole, leadId: string) {
  if (!role) return;
  const { error } = await supabase.rpc(
    role === 'telecaller' ? 'record_telecaller_lead_contact' : 'record_sales_lead_contact',
    { target_lead_id: leadId, contact_channel: 'CALL' },
  );
  if (error) throw error;
}

export type CustomerMatch = {
  customer_id: string;
  full_name: string;
  masked_phone: string | null;
  match_reason: string;
  lead_count: number;
  latest_interested_model: string | null;
};

export async function fetchCustomerMatches(leadId: string) {
  const { data, error } = await supabase.rpc('possible_customer_matches', {
    target_lead_id: leadId,
  });
  if (error) throw error;
  return (data ?? []) as CustomerMatch[];
}

// Linking is an explicit, audited decision (AGENTS.md rule 11): never merged
// from a phone match without the user choosing it.
export async function resolveMobileLeadCustomer(input: {
  detail: MobileLeadDetail;
  customerId: string | null;
  reason: string;
  requestId: string;
}) {
  const { lead } = input.detail;
  const { error } = await supabase.rpc('resolve_lead_customer', {
    target_lead_id: lead.id,
    expected_lead_updated_at: lead.updated_at,
    resolution: input.customerId ? 'LINK_EXISTING' : 'CREATE_NEW',
    resolution_reason: input.reason,
    target_request_id: input.requestId,
    target_customer_id: input.customerId,
    new_customer: input.customerId
      ? {}
      : {
          full_name: lead.customer_name,
          primary_phone: lead.phone,
          primary_email: lead.email ?? '',
        },
  });
  if (error) throw error;
}

export type HandoffCandidate = {
  user_id: string;
  full_name: string;
  open_leads: number;
  hot_leads: number;
  recommended: boolean;
};

export async function fetchHandoffCandidates(leadId: string) {
  const { data, error } = await supabase.rpc('get_sales_handoff_candidates', {
    target_lead_id: leadId,
    target_search: '',
  });
  if (error) throw error;
  return (data ?? []) as HandoffCandidate[];
}

// An open follow-up blocks a plain handoff; completing it with Transfer to
// Sales performs both in one transaction (AGENTS.md rule 15).
export async function transferMobileLeadToSales(input: {
  leadId: string;
  consultantId: string | null;
  note: string;
  requestId: string;
}) {
  const { data: openFollowup } = await supabase.rpc('get_lead_open_followup', {
    target_lead_id: input.leadId,
  });
  const followup = openFollowup as { id: string; version: number } | null;
  const { error } = followup?.id
    ? await supabase.rpc('complete_followup', {
        target_followup_id: followup.id,
        expected_version: followup.version,
        completion_note: input.note,
        target_request_id: input.requestId,
        followup_outcome: 'TRANSFER_TO_SALES',
        target_sales_consultant_id: input.consultantId,
      })
    : await supabase.rpc('transfer_lead_to_sales', {
        target_lead_id: input.leadId,
        target_user_id: input.consultantId,
        transfer_reason: input.note,
      });
  if (error) throw error;
}

const leadActionMessages: Record<string, string> = {
  LEAD_NOT_IN_INTAKE: 'This lead is already with Sales or closed.',
  TELECALLER_REQUIRED: 'Only a Telecaller can record this contact.',
  LEAD_CUSTOMER_REQUIRED: 'Link or create the customer before handing off.',
  LEAD_ALREADY_WITH_SALES: 'This lead is already with Sales.',
  LOST_LEAD_CANNOT_TRANSFER: 'A lost lead cannot be handed to Sales.',
  NO_ELIGIBLE_SALES_CONSULTANT: 'No Sales Consultant in this team can take the lead.',
  SALES_CONSULTANT_NOT_ELIGIBLE: 'That consultant cannot take this lead. Pick another.',
  LEAD_TEAM_REQUIRED: 'The lead has no team, so it cannot be handed off.',
  WORK_VERSION_CONFLICT: 'The follow-up changed. Reopen the lead and try again.',
  LEAD_VERSION_CONFLICT: 'The lead changed. Reopen it and try again.',
  LEAD_ALREADY_LINKED: 'This lead is already linked to a customer.',
  RESOLUTION_REASON_REQUIRED: 'Enter a reason of at least 3 characters.',
  SALES_HANDOFF_REQUIRED: 'The call was placed; contact is recorded once the lead is with Sales.',
  PERMISSION_DENIED: 'Your role cannot do this.',
  SCOPE_DENIED: 'This lead is outside your scope.',
  INVALID_TEST_DRIVE_INPUT: 'Check the vehicle, registration and a future date/time.',
  TEST_DRIVE_VEHICLE_UNAVAILABLE: 'That vehicle is no longer available. Pick another.',
  TEST_DRIVE_VEHICLE_SCHEDULE_CONFLICT: 'That vehicle is already booked at this time.',
  TEST_DRIVE_CONSULTANT_SCHEDULE_CONFLICT: 'You already have a test drive at this time.',
  TEST_DRIVE_MANAGE_PERMISSION_REQUIRED: 'Your role cannot schedule test drives.',
  TEST_DRIVE_SCOPE_DENIED: 'This lead is outside your scope.',
  TEST_DRIVE_RELATION_DENIED: 'This lead is not assigned to you.',
};

export function leadActionMessage(error: unknown, fallback: string) {
  const text =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : '';
  const code = text.match(/[A-Z][A-Z0-9_]{5,}/)?.[0] ?? '';
  return leadActionMessages[code] ?? fallback;
}

export type TestDriveVehicle = {
  stock_unit_id: string;
  brand_name: string;
  model_name: string;
  variant_name: string;
  color: string | null;
  vin: string;
};

export async function fetchTestDriveVehicles(branchId: string, search = '') {
  const { data, error } = await supabase.rpc('get_test_drive_vehicle_options', {
    target_branch_id: branchId,
    target_search: search.trim().slice(0, 120),
    target_limit: 25,
  });
  if (error) throw error;
  return (data ?? []) as TestDriveVehicle[];
}

// Same rule as the web form (test-drive-registration.ts).
export function sanitizeRegistration(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9 -]/g, '')
    .slice(0, 24);
}

export function isValidRegistration(value: string) {
  return /^[A-Z0-9 -]{4,24}$/.test(value.trim().toUpperCase());
}

// Test drives are their own record with a vehicle; `create_appointment` no
// longer accepts the Test Drive type.
export async function createMobileTestDrive(input: {
  leadId: string;
  stockUnitId: string;
  scheduledAt: string;
  registration: string;
  requestId: string;
}) {
  const { error } = await supabase.rpc('create_test_drive', {
    target_lead_id: input.leadId,
    target_stock_unit_id: input.stockUnitId,
    target_scheduled_at: input.scheduledAt,
    target_expected_duration_minutes: 60,
    target_vehicle_registration: input.registration.trim().toUpperCase(),
    target_start_location: null,
    target_destination: null,
    target_request_id: input.requestId,
  });
  if (error) throw error;
}

export const leadTemperatures = ['HOT', 'WARM', 'COLD', 'DORMANT'] as const;
export type LeadTemperature = (typeof leadTemperatures)[number];

// Same audited update the web "Set temperature" menu makes; every change lands
// in lead_temperature_history. DORMANT is a deliberate human choice (AGENTS 9.7).
export async function setMobileLeadTemperature(input: {
  lead: MobileLeadDetail['lead'];
  temperature: LeadTemperature;
}) {
  const { error } = await supabase.rpc('update_lead', {
    target_lead_id: input.lead.id,
    expected_updated_at: input.lead.updated_at,
    lead_patch: { temperature: input.temperature },
    change_reason: `Temperature set to ${input.temperature} from the mobile app`,
  });
  if (error) throw error;
}
