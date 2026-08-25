import { createClient } from '@/lib/supabase/client';
import type { LeadQuery } from './lead-workspace-query';
import { isLeadVersionConflict, LeadVersionConflictError } from './lead-workspace-query';

export type LeadRecord = {
  id: string;
  organization_id: string;
  branch_id: string;
  team_id: string | null;
  customer_id: string | null;
  source: string;
  customer_name: string;
  phone: string;
  normalized_phone: string;
  email: string | null;
  interested_model: string | null;
  lifecycle_status: string;
  temperature: 'COLD' | 'WARM' | 'HOT' | null;
  lost_reason: string | null;
  work_state: 'NEW_TODAY' | 'PENDING' | 'SLA_RISK' | null;
  assigned_user_id: string | null;
  first_contacted_at: string | null;
  sla_due_at: string | null;
  created_at: string;
  updated_at: string;
  next_followup_at: string | null;
  lead_stage: string;
  assigned_user_name: string | null;
};

export type LeadKpis = {
  new_today: number;
  pending: number;
  sla_risk: number;
  qualified: number;
  new_count: number;
  contacted_count: number;
  appointment_scheduled_count: number;
  transferred_to_sales_count: number;
  lost_count: number;
  total: number;
  hot: number;
  warm: number;
  cold: number;
  follow_up: number;
  test_drive: number;
  quotation: number;
  booking: number;
  sales_new_today: number;
  sales_pending: number;
  sales_contacted: number;
};

export type LeadWorkspaceResult = {
  records: LeadRecord[];
  total: number;
  kpis: LeadKpis;
  filters: { models: string[]; sources: string[] };
};

export type LeadWorkspacePermissions = {
  organizationId: string;
  canCreate: boolean;
  canAssign: boolean;
  canUpdate: boolean;
  canCreateFollowup: boolean;
  canCreateAppointment: boolean;
  canManageTestDrive: boolean;
  canCreateCustomer: boolean;
  canLinkCustomer: boolean;
};

export type PersonalLeadFlag = {
  pinned: boolean;
  starred: boolean;
  // ISO timestamp of the moment the row was pinned. Newer pins outrank older
  // ones so the most recently pinned lead lands at the very top.
  pinnedAt: string | null;
};

export type PersonalLeadFlags = Record<string, PersonalLeadFlag>;

type ProfileRow = { id: string; full_name: string };
type KpiRow = Partial<Record<keyof LeadKpis, number | string | null>>;

const emptyKpis: LeadKpis = {
  new_today: 0,
  pending: 0,
  sla_risk: 0,
  qualified: 0,
  new_count: 0,
  contacted_count: 0,
  appointment_scheduled_count: 0,
  transferred_to_sales_count: 0,
  lost_count: 0,
  total: 0,
  hot: 0,
  warm: 0,
  cold: 0,
  follow_up: 0,
  test_drive: 0,
  quotation: 0,
  booking: 0,
  sales_new_today: 0,
  sales_pending: 0,
  sales_contacted: 0,
};

function normalizeKpis(row: KpiRow | null): LeadKpis {
  if (!row) return emptyKpis;
  return Object.fromEntries(
    Object.entries(emptyKpis).map(([key, fallback]) => [
      key,
      Number(row[key as keyof LeadKpis] ?? fallback),
    ]),
  ) as LeadKpis;
}

/**
 * The counters and filter options depend only on the filter set, never on the
 * offset, so they are fetched once per filter set and reused across pages.
 * Splitting them keeps a page change to one indexed limit/offset instead of
 * seventeen aggregates over every lead in scope.
 */
export type LeadWorkspaceMeta = Pick<LeadWorkspaceResult, 'total' | 'kpis' | 'filters'>;
export type LeadWorkspaceRecords = Pick<LeadWorkspaceResult, 'records'>;

export type LeadMetaQuery = Omit<LeadQuery, 'page' | 'pageSize' | 'sort'>;

export function toLeadMetaQuery(query: LeadQuery): LeadMetaQuery {
  return {
    search: query.search,
    status: query.status,
    model: query.model,
    source: query.source,
    stage: query.stage,
    temperature: query.temperature,
    followupFrom: query.followupFrom,
    followupTo: query.followupTo,
  };
}

async function callLeadWorkspace(
  query: LeadQuery,
  parts: { records: boolean; kpis: boolean },
  signal?: AbortSignal,
): Promise<LeadWorkspaceResult> {
  const supabase = createClient();
  const request = supabase.rpc('get_lead_workspace_page_v2', {
    target_page: query.page,
    target_page_size: query.pageSize,
    target_search: query.search,
    target_status: query.status,
    target_sort: query.sort,
    target_model: query.model || null,
    target_source: query.source || null,
    target_stage: query.stage,
    target_temperature: query.temperature,
    target_followup_from: query.followupFrom || null,
    target_followup_to: query.followupTo || null,
    target_include_records: parts.records,
    target_include_kpis: parts.kpis,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  const result = data as Partial<LeadWorkspaceResult> | null;
  return {
    records: Array.isArray(result?.records) ? (result.records as LeadRecord[]) : [],
    total: Number(result?.total ?? 0),
    kpis: normalizeKpis((result?.kpis ?? null) as KpiRow | null),
    filters: {
      models: Array.isArray(result?.filters?.models)
        ? (result.filters.models.filter(
            (value): value is string => typeof value === 'string',
          ) as string[])
        : [],
      sources: Array.isArray(result?.filters?.sources)
        ? (result.filters.sources.filter(
            (value): value is string => typeof value === 'string',
          ) as string[])
        : [],
    },
  };
}

export async function fetchLeadWorkspaceRecords(
  query: LeadQuery,
  signal?: AbortSignal,
): Promise<LeadWorkspaceRecords> {
  const { records } = await callLeadWorkspace(query, { records: true, kpis: false }, signal);
  return { records };
}

export async function fetchLeadWorkspaceMeta(
  query: LeadMetaQuery,
  signal?: AbortSignal,
): Promise<LeadWorkspaceMeta> {
  // Page and sort are fixed here: they cannot change a counter, and pinning
  // them keeps this request identical while the user pages around.
  const { total, kpis, filters } = await callLeadWorkspace(
    { ...query, page: 1, pageSize: 25, sort: 'updated:desc' },
    { records: false, kpis: true },
    signal,
  );
  return { total, kpis, filters };
}

export async function fetchLeadWorkspacePermissions(): Promise<LeadWorkspacePermissions> {
  const supabase = createClient();
  const contextResponse = await supabase.rpc('get_access_context');
  if (contextResponse.error) throw contextResponse.error;
  const context = contextResponse.data as { destination?: string; organization_id?: string } | null;
  if (context?.destination !== 'CRM' || !context.organization_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');

  const organizationId = context.organization_id;
  const permissionResults = await Promise.all(
    [
      'lead.create',
      'lead.assign',
      'lead.update',
      'followup.create',
      'appointment.create',
      'test_drive.manage',
      'customer.create',
      'customer.link',
    ].map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: organizationId,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  const failed = permissionResults.find((response) => response.error);
  if (failed?.error) throw failed.error;
  return {
    organizationId,
    canCreate: Boolean(permissionResults[0]?.data),
    canAssign: Boolean(permissionResults[1]?.data),
    canUpdate: Boolean(permissionResults[2]?.data),
    canCreateFollowup: Boolean(permissionResults[3]?.data),
    canCreateAppointment: Boolean(permissionResults[4]?.data),
    canManageTestDrive: Boolean(permissionResults[5]?.data),
    canCreateCustomer: Boolean(permissionResults[6]?.data),
    canLinkCustomer: Boolean(permissionResults[7]?.data),
  };
}

type PersonalLeadPreferenceRow = {
  lead_id: string;
  pinned: boolean;
  starred: boolean;
  pinned_at: string | null;
};

export async function fetchPersonalLeadFlags(signal?: AbortSignal): Promise<PersonalLeadFlags> {
  const request = createClient().rpc('get_my_lead_preferences');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;

  return Object.fromEntries(
    ((data ?? []) as PersonalLeadPreferenceRow[]).map((row) => [
      row.lead_id,
      { pinned: row.pinned, starred: row.starred, pinnedAt: row.pinned_at ?? null },
    ]),
  );
}

export async function setPersonalLeadPreference(input: {
  leadId: string;
  pinned: boolean;
  starred: boolean;
}): Promise<{ leadId: string } & PersonalLeadFlag> {
  const { data, error } = await createClient().rpc('set_my_lead_preference', {
    target_lead_id: input.leadId,
    target_pinned: input.pinned,
    target_starred: input.starred,
  });
  if (error) throw error;
  const result = (data as PersonalLeadPreferenceRow[] | null)?.[0];
  if (!result) throw new Error('LEAD_PREFERENCE_WRITE_FAILED');
  return {
    leadId: result.lead_id,
    pinned: result.pinned,
    starred: result.starred,
    pinnedAt: result.pinned_at ?? null,
  };
}

export async function recordSalesLeadContact(input: {
  leadId: string;
  channel: 'CALL' | 'WHATSAPP';
}): Promise<{ lead_id: string; contacted_at: string }> {
  const { data, error } = await createClient().rpc('record_sales_lead_contact', {
    target_lead_id: input.leadId,
    contact_channel: input.channel,
  });
  if (error) throw error;
  return data as { lead_id: string; contacted_at: string };
}

export type LeadCreateInput = {
  organizationId: string;
  branchId: string;
  teamId: string | null;
  source: string;
  customerName: string;
  phone: string;
  email: string;
  sourceDetail: string;
  campaign: string;
  interestedModel: string;
};

export async function createLead(input: LeadCreateInput) {
  const { error } = await createClient().rpc('create_lead', {
    target_organization_id: input.organizationId,
    target_branch_id: input.branchId,
    target_team_id: input.teamId,
    lead_source: input.source,
    lead_customer_name: input.customerName,
    lead_phone: input.phone,
    lead_email: input.email || null,
    lead_source_detail: input.sourceDetail || null,
    lead_campaign: input.campaign || null,
    lead_interested_model: input.interestedModel || null,
  });
  if (error) throw error;
}

export async function assignLead(input: {
  leadId: string;
  userId: string;
  assignmentKind: 'FRESH' | 'QUALIFIED';
  reason: string;
}) {
  const { error } = await createClient().rpc('assign_lead', {
    target_lead_id: input.leadId,
    target_user_id: input.userId,
    assignment_kind: input.assignmentKind,
    assignment_reason: input.reason || null,
  });
  if (error) throw error;
}

export type LeadUpdateInput = {
  leadId: string;
  expectedUpdatedAt: string;
  patch: {
    lifecycle_status?: string;
    temperature?: 'COLD' | 'WARM' | 'HOT';
    lost_reason?: string;
  };
  reason: string;
};

export async function updateLead(input: LeadUpdateInput) {
  const { error } = await createClient().rpc('update_lead', {
    target_lead_id: input.leadId,
    expected_updated_at: input.expectedUpdatedAt,
    lead_patch: input.patch,
    change_reason: input.reason.trim(),
  });
  if (isLeadVersionConflict(error)) throw new LeadVersionConflictError();
  if (error) throw error;
}

export type LeadCreateOptions = {
  branches: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; branch_id: string; name: string }>;
};

export async function fetchLeadCreateOptions(signal?: AbortSignal): Promise<LeadCreateOptions> {
  const supabase = createClient();
  const branchRequest = supabase
    .from('branches')
    .select('id,name')
    .eq('active', true)
    .order('name');
  const teamRequest = supabase
    .from('teams')
    .select('id,branch_id,name')
    .eq('active', true)
    .order('name');
  const [branches, teams] = await Promise.all([
    signal ? branchRequest.abortSignal(signal) : branchRequest,
    signal ? teamRequest.abortSignal(signal) : teamRequest,
  ]);
  if (branches.error) throw branches.error;
  if (teams.error) throw teams.error;
  return {
    branches: branches.data as LeadCreateOptions['branches'],
    teams: teams.data as LeadCreateOptions['teams'],
  };
}

export async function fetchAssignableUsers(leadId: string, search = '', signal?: AbortSignal) {
  const request = createClient().rpc('get_lead_assignment_candidates', {
    target_lead_id: leadId,
    target_search: search.normalize('NFKC').trim().slice(0, 160),
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return data as ProfileRow[];
}
