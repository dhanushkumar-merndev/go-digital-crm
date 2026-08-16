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
  const { data, error } = await supabase.rpc('get_lead_workspace_page', {
    target_page: query.page,
    target_page_size: query.pageSize,
    target_search: query.search,
    target_status: query.status,
    target_sort: query.sort,
  });
  if (error) throw error;
  const result = data as Partial<LeadWorkspaceResult> | null;
  return {
    records: Array.isArray(result?.records) ? (result.records as LeadRecord[]) : [],
    total: Number(result?.total ?? 0),
    kpis: normalizeKpis((result?.kpis ?? null) as KpiRow | null),
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
