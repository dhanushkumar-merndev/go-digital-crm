import { createClient } from '@/lib/supabase/client';
import type { LeadQuery } from './lead-workspace-query';
import {
  getLeadStatusConstraint,
  isLeadVersionConflict,
  isUuid,
  leadSortOptions,
  LeadVersionConflictError,
  toPostgrestSearchTerm,
} from './lead-workspace-query';

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
};

export type LeadWorkspaceResult = { records: LeadRecord[]; total: number; kpis: LeadKpis };

export type LeadWorkspacePermissions = {
  organizationId: string;
  canCreate: boolean;
  canAssign: boolean;
  canUpdate: boolean;
  canCreateCustomer: boolean;
  canLinkCustomer: boolean;
};

type RawLead = Omit<LeadRecord, 'assigned_user_name'>;
type ProfileRow = { id: string; full_name: string };
type KpiRow = Partial<Record<keyof LeadKpis, number | string | null>>;

const leadListColumns =
  'id,organization_id,branch_id,team_id,customer_id,source,customer_name,phone,normalized_phone,email,interested_model,lifecycle_status,temperature,lost_reason,work_state,assigned_user_id,first_contacted_at,sla_due_at,created_at,updated_at';

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

export async function fetchLeadWorkspace(query: LeadQuery): Promise<LeadWorkspaceResult> {
  const supabase = createClient();
  const status = getLeadStatusConstraint(query.status);
  const sort = leadSortOptions[query.sort];
  let listQuery = supabase
    .from('leads_with_work_state')
    .select(leadListColumns, { count: 'exact' })
    .order(sort.column, { ascending: sort.ascending })
    .order('id', { ascending: sort.ascending })
    .range((query.page - 1) * query.pageSize, query.page * query.pageSize - 1);

  if (status) listQuery = listQuery.eq(status.column, status.value);
  if (query.search) {
    const term = toPostgrestSearchTerm(query.search);
    if (term) {
      listQuery = isUuid(query.search)
        ? listQuery.or(
            `id.eq.${query.search},customer_name.ilike.%${term}%,normalized_phone.ilike.%${term}%`,
          )
        : listQuery.or(`customer_name.ilike.%${term}%,normalized_phone.ilike.%${term}%`);
    }
  }

  const [listResponse, kpiResponse] = await Promise.all([
    listQuery,
    supabase.rpc('get_lead_workspace_kpis'),
  ]);
  if (listResponse.error) throw listResponse.error;
  if (kpiResponse.error) throw kpiResponse.error;

  const rawRecords = (listResponse.data ?? []) as RawLead[];
  const assignedUserIds = [
    ...new Set(
      rawRecords.flatMap((record) => (record.assigned_user_id ? [record.assigned_user_id] : [])),
    ),
  ];
  let owners = new Map<string, string>();
  if (assignedUserIds.length) {
    const profilesResponse = await supabase
      .from('profiles')
      .select('id,full_name')
      .in('id', assignedUserIds);
    if (profilesResponse.error) throw profilesResponse.error;
    owners = new Map(
      (profilesResponse.data as ProfileRow[]).map((profile) => [profile.id, profile.full_name]),
    );
  }

  return {
    records: rawRecords.map((record) => ({
      ...record,
      assigned_user_name: record.assigned_user_id
        ? (owners.get(record.assigned_user_id) ?? null)
        : null,
    })),
    total: listResponse.count ?? 0,
    kpis: normalizeKpis((kpiResponse.data?.[0] ?? null) as KpiRow | null),
  };
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
    ['lead.create', 'lead.assign', 'lead.update', 'customer.create', 'customer.link'].map(
      (target_permission) =>
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
    canCreateCustomer: Boolean(permissionResults[3]?.data),
    canLinkCustomer: Boolean(permissionResults[4]?.data),
  };
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

export async function fetchLeadCreateOptions(): Promise<LeadCreateOptions> {
  const supabase = createClient();
  const [branches, teams] = await Promise.all([
    supabase.from('branches').select('id,name').eq('active', true).order('name'),
    supabase.from('teams').select('id,branch_id,name').eq('active', true).order('name'),
  ]);
  if (branches.error) throw branches.error;
  if (teams.error) throw teams.error;
  return {
    branches: branches.data as LeadCreateOptions['branches'],
    teams: teams.data as LeadCreateOptions['teams'],
  };
}

export async function fetchAssignableUsers() {
  const { data, error } = await createClient()
    .from('profiles')
    .select('id,full_name')
    .eq('active', true)
    .order('full_name');
  if (error) throw error;
  return data as ProfileRow[];
}
