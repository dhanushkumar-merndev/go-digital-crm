import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  AdministrationVersionConflictError,
  type AdministrationKind,
  type AdministrationQuery,
  type BranchWorkspacePreset,
} from './branch-team-query';

const nullableText = z.string().nullable();
const jsonObject = z.record(z.string(), z.unknown());

export const branchAdministrationRecordSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  code: z.string(),
  name: z.string(),
  address: jsonObject,
  city: nullableText,
  state: nullableText,
  postal_code: nullableText,
  contact_phone: nullableText,
  contact_email: nullableText,
  timezone: z.string(),
  working_hours: jsonObject,
  showroom_category: nullableText,
  latitude: z.coerce.number().nullable(),
  longitude: z.coerce.number().nullable(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  team_count: z.coerce.number().int().nonnegative(),
  active_team_count: z.coerce.number().int().nonnegative(),
  user_count: z.coerce.number().int().nonnegative(),
  manager_names: z.string(),
  integration_count: z.coerce.number().int().nonnegative(),
  explicit_access_count: z.coerce.number().int().nonnegative(),
  last_configured_at: z.string(),
});

export const teamAdministrationRecordSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  branch_active: z.boolean(),
  name: z.string(),
  manager_id: z.uuid().nullable(),
  manager_name: nullableText,
  fresh_assignment_mode: z.enum(['ROUND_ROBIN', 'MANUAL_ASSIGNMENT']),
  qualified_assignment_mode: z.enum(['ROUND_ROBIN', 'MANUAL_ASSIGNMENT']),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  member_count: z.coerce.number().int().nonnegative(),
  telecaller_count: z.coerce.number().int().nonnegative(),
  consultant_count: z.coerce.number().int().nonnegative(),
  manager_count: z.coerce.number().int().nonnegative(),
  active_lead_count: z.coerce.number().int().nonnegative(),
  open_followup_count: z.coerce.number().int().nonnegative(),
});

const branchOptionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string().optional(),
  active: z.boolean().optional(),
});

const branchWorkspaceSchema = z.object({
  records: z.array(branchAdministrationRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total: z.coerce.number().int().nonnegative(),
    active: z.coerce.number().int().nonnegative(),
    inactive: z.coerce.number().int().nonnegative(),
    users_assigned: z.coerce.number().int().nonnegative(),
  }),
  preset: z.enum(['MANAGE', 'ACCESS']),
});

const teamWorkspaceSchema = z.object({
  records: z.array(teamAdministrationRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total: z.coerce.number().int().nonnegative(),
    active: z.coerce.number().int().nonnegative(),
    telecallers: z.coerce.number().int().nonnegative(),
    consultants: z.coerce.number().int().nonnegative(),
  }),
  branches: z.array(branchOptionSchema),
});

export type BranchAdministrationRecord = z.infer<typeof branchAdministrationRecordSchema>;
export type TeamAdministrationRecord = z.infer<typeof teamAdministrationRecordSchema>;
export type BranchAdministrationWorkspace = z.infer<typeof branchWorkspaceSchema>;
export type TeamAdministrationWorkspace = z.infer<typeof teamWorkspaceSchema>;

export type BranchTeamPermissions = {
  organizationId: string;
  userId: string;
  roleKey: string;
  dataScope: string;
  scopeKey: string;
  canManageBranches: boolean;
  canManageTeams: boolean;
  canManageUsers: boolean;
};

export async function fetchBranchTeamPermissions(): Promise<BranchTeamPermissions> {
  const supabase = createClient();
  const contextResponse = await supabase.rpc('get_access_context');
  if (contextResponse.error) throw contextResponse.error;
  const context = contextResponse.data as {
    destination?: string;
    organization_id?: string;
    user_id?: string;
    role_key?: string;
    data_scope?: string;
  } | null;
  if (context?.destination !== 'CRM' || !context.organization_id || !context.user_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  const permissionKeys = ['branch.manage', 'team.manage', 'user.manage'];
  const responses = await Promise.all(
    permissionKeys.map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: context.organization_id,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  const failed = responses.find((response) => response.error);
  if (failed?.error) throw failed.error;
  return {
    organizationId: context.organization_id,
    userId: context.user_id,
    roleKey: context.role_key ?? 'unknown',
    dataScope: context.data_scope ?? 'unknown',
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    canManageBranches: Boolean(responses[0]?.data),
    canManageTeams: Boolean(responses[1]?.data),
    canManageUsers: Boolean(responses[2]?.data),
  };
}

function nullableUuid(value: string) {
  return value === 'all' ? null : value;
}

export async function fetchBranchAdministrationWorkspace(
  query: AdministrationQuery,
  preset: BranchWorkspacePreset,
) {
  const { data, error } = await createClient().rpc('get_branch_administration_page', {
    target_search: query.search,
    target_status: query.status,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_preset: preset,
  });
  if (error) throw error;
  return branchWorkspaceSchema.parse(data);
}

export async function fetchTeamAdministrationWorkspace(query: AdministrationQuery) {
  const { data, error } = await createClient().rpc('get_team_administration_page', {
    target_search: query.search,
    target_status: query.status,
    target_branch_id: nullableUuid(query.branchId),
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
  });
  if (error) throw error;
  return teamWorkspaceSchema.parse(data);
}

const teamCandidateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  member_type: z.enum(['TEAM_MANAGER', 'SALES_CONSULTANT', 'TELECALLER_BDC']),
  membership_active: z.boolean().nullable(),
  membership_version: z.coerce.number().int().positive().nullable(),
  eligible_for_fresh_leads: z.boolean().nullable(),
  eligible_for_qualified_leads: z.boolean().nullable(),
  other_team_id: z.uuid().nullable(),
  other_team_name: nullableText,
});

const teamOptionsSchema = z.object({
  branches: z.array(branchOptionSchema.extend({ code: z.string(), active: z.boolean() })),
  users: z.array(teamCandidateSchema),
});

export type TeamAdministrationOptions = z.infer<typeof teamOptionsSchema>;
export type TeamCandidate = z.infer<typeof teamCandidateSchema>;

export async function fetchTeamAdministrationOptions(
  branchId: string | null,
  teamId: string | null,
  search = '',
) {
  const { data, error } = await createClient().rpc('get_team_administration_options', {
    target_branch_id: branchId,
    target_team_id: teamId,
    target_search: search,
  });
  if (error) throw error;
  return teamOptionsSchema.parse(data);
}

const branchAccessUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  roles: z.string(),
  explicit_access: z.boolean(),
  inherited_access: z.boolean(),
  access_version: z.coerce.number().int().nonnegative(),
});

const branchAccessOptionsSchema = z.object({ users: z.array(branchAccessUserSchema) });
export type BranchAccessUser = z.infer<typeof branchAccessUserSchema>;

export async function fetchBranchAccessOptions(branchId: string, search = '') {
  const { data, error } = await createClient().rpc('get_branch_access_options', {
    target_branch_id: branchId,
    target_search: search,
  });
  if (error) throw error;
  return branchAccessOptionsSchema.parse(data);
}

const mutationResultSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  active: z.boolean(),
  replayed: z.boolean(),
});

function throwMutationError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  if (error.code === '40001' || error.message?.includes('VERSION_CONFLICT'))
    throw new AdministrationVersionConflictError();
  throw error;
}

export type BranchMutationInput = {
  id?: string;
  expectedVersion?: number;
  name: string;
  code: string;
  address: Record<string, unknown>;
  contactPhone: string | null;
  contactEmail: string | null;
  timezone: string;
  workingHours: Record<string, unknown>;
  showroomCategory: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  requestId: string;
};

export async function saveBranch(input: BranchMutationInput) {
  const supabase = createClient();
  if (!input.id) {
    const { data, error } = await supabase.rpc('create_branch', {
      branch_name: input.name,
      branch_code: input.code,
      branch_address: input.address,
      branch_contact_phone: input.contactPhone,
      branch_contact_email: input.contactEmail,
      branch_timezone: input.timezone,
      branch_working_hours: input.workingHours,
      branch_showroom_category: input.showroomCategory,
      branch_latitude: input.latitude,
      branch_longitude: input.longitude,
      target_request_id: input.requestId,
    });
    throwMutationError(error);
    return mutationResultSchema.parse(data);
  }
  const { data, error } = await supabase.rpc('update_branch', {
    target_branch_id: input.id,
    expected_version: input.expectedVersion,
    branch_name: input.name,
    branch_code: input.code,
    branch_address: input.address,
    branch_contact_phone: input.contactPhone,
    branch_contact_email: input.contactEmail,
    branch_timezone: input.timezone,
    branch_working_hours: input.workingHours,
    branch_showroom_category: input.showroomCategory,
    branch_latitude: input.latitude,
    branch_longitude: input.longitude,
    branch_active: input.active,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return mutationResultSchema.parse(data);
}

export type TeamMutationInput = {
  id?: string;
  expectedVersion?: number;
  branchId: string;
  name: string;
  managerId: string | null;
  freshMode: 'ROUND_ROBIN' | 'MANUAL_ASSIGNMENT';
  qualifiedMode: 'ROUND_ROBIN' | 'MANUAL_ASSIGNMENT';
  active: boolean;
  requestId: string;
};

export async function saveTeam(input: TeamMutationInput) {
  const supabase = createClient();
  if (!input.id) {
    const { data, error } = await supabase.rpc('create_team', {
      target_branch_id: input.branchId,
      team_name: input.name,
      target_manager_id: input.managerId,
      fresh_mode: input.freshMode,
      qualified_mode: input.qualifiedMode,
      target_request_id: input.requestId,
    });
    throwMutationError(error);
    return mutationResultSchema.parse(data);
  }
  const { data, error } = await supabase.rpc('update_team', {
    target_team_id: input.id,
    expected_version: input.expectedVersion,
    team_name: input.name,
    target_manager_id: input.managerId,
    fresh_mode: input.freshMode,
    qualified_mode: input.qualifiedMode,
    team_active: input.active,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return mutationResultSchema.parse(data);
}

const memberMutationResultSchema = mutationResultSchema.extend({
  membership_version: z.coerce.number().int().positive(),
  user_id: z.uuid(),
});

export async function setTeamMember(input: {
  teamId: string;
  expectedTeamVersion: number;
  userId: string;
  memberType: 'TEAM_MANAGER' | 'SALES_CONSULTANT' | 'TELECALLER_BDC';
  active: boolean;
  eligibleForFresh: boolean;
  eligibleForQualified: boolean;
  moveFromExisting: boolean;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('set_team_member', {
    target_team_id: input.teamId,
    expected_team_version: input.expectedTeamVersion,
    target_user_id: input.userId,
    target_member_type: input.memberType,
    member_active: input.active,
    eligible_for_fresh: input.eligibleForFresh,
    eligible_for_qualified: input.eligibleForQualified,
    move_from_existing: input.moveFromExisting,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return memberMutationResultSchema.parse(data);
}

const accessMutationResultSchema = z.object({
  branch_id: z.uuid(),
  user_id: z.uuid(),
  version: z.coerce.number().int().nonnegative(),
  active: z.boolean(),
  replayed: z.boolean(),
});

export async function setUserBranchAccess(input: {
  branchId: string;
  userId: string;
  expectedVersion: number;
  grantAccess: boolean;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('set_user_branch_access', {
    target_branch_id: input.branchId,
    target_user_id: input.userId,
    expected_version: input.expectedVersion,
    grant_access: input.grantAccess,
    target_request_id: input.requestId,
  });
  throwMutationError(error);
  return accessMutationResultSchema.parse(data);
}

export function resourcePermission(kind: AdministrationKind) {
  return kind === 'branches' ? 'branch.manage' : 'team.manage';
}
