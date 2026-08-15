import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  normalizeUserSearch,
  userSortValues,
  userStatusValues,
  type UserWorkspaceQuery,
} from './user-workspace-query';

export const userAdministrationModes = ['USER_ADMIN', 'CLIENT_ADMIN_BOOTSTRAP'] as const;
export type UserAdministrationMode = (typeof userAdministrationModes)[number];

export const dataScopeSchema = z.enum([
  'OWN_RECORDS',
  'OWN_TEAM',
  'ONE_BRANCH',
  'SELECTED_BRANCHES',
  'ALL_BRANCHES',
  'ORGANIZATION',
]);
export type UserDataScope = z.infer<typeof dataScopeSchema>;

const branchSchema = z.object({ id: z.uuid(), name: z.string(), code: z.string() });
const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  branch_id: z.uuid(),
  member_type: z.string().optional(),
});
const roleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role_key: z.string(),
  authority_level: z.coerce.number().int(),
  mfa_required: z.boolean(),
});

const userRecordSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  email: z.email(),
  phone: z.string().nullable(),
  employee_id: z.string().nullable(),
  active: z.boolean(),
  mfa_required: z.boolean(),
  version: z.coerce.number().int().positive(),
  assignment_id: z.uuid(),
  role_id: z.uuid(),
  role_name: z.string(),
  role_key: z.string(),
  authority_level: z.coerce.number().int(),
  data_scope: dataScopeSchema,
  scope_branch_id: z.uuid().nullable(),
  selected_branch_ids: z.array(z.uuid()),
  branches: z.array(branchSchema),
  teams: z.array(teamSchema),
  created_at: z.string(),
  updated_at: z.string(),
  can_edit: z.boolean(),
});

const workspaceSchema = z.object({
  organization_id: z.uuid(),
  mode: z.enum(userAdministrationModes),
  records: z.array(userRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total_users: z.coerce.number().int().nonnegative(),
    active_users: z.coerce.number().int().nonnegative(),
    inactive_users: z.coerce.number().int().nonnegative(),
    mfa_required: z.coerce.number().int().nonnegative(),
  }),
});

const optionsSchema = z.object({
  organization_id: z.uuid(),
  mode: z.enum(userAdministrationModes),
  roles: z.array(roleSchema),
  branches: z.array(branchSchema),
  teams: z.array(teamSchema.omit({ member_type: true })),
  data_scopes: z.array(z.object({ value: dataScopeSchema, label: z.string() })),
});

export type UserAdministrationRecord = z.infer<typeof userRecordSchema>;
export type UserWorkspaceResult = z.infer<typeof workspaceSchema>;
export type UserAdministrationOptions = z.infer<typeof optionsSchema>;
export type UserMutationInput = {
  mode: UserAdministrationMode;
  fullName: string;
  phone: string;
  employeeId: string;
  roleId: string;
  dataScope: UserDataScope;
  scopeBranchId: string | null;
  selectedBranchIds: string[];
  teamIds: string[];
  active: boolean;
  mfaRequired: boolean;
};

export async function fetchUserWorkspace(
  query: UserWorkspaceQuery,
  mode: UserAdministrationMode,
): Promise<UserWorkspaceResult> {
  const { data, error } = await createClient().rpc('get_tenant_user_workspace', {
    target_page: query.page,
    target_page_size: query.pageSize,
    target_search: normalizeUserSearch(query.search),
    target_status: userStatusValues[query.status],
    target_role_id: query.roleId || null,
    target_branch_id: query.branchId || null,
    target_sort: userSortValues[query.sort],
    target_mode: mode,
  });
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export async function fetchUserAdministrationOptions(mode: UserAdministrationMode) {
  const { data, error } = await createClient().rpc('get_tenant_user_admin_options', {
    target_mode: mode,
  });
  if (error) throw error;
  return optionsSchema.parse(data);
}

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  request_id: string;
};

export class UserAdministrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function invokeUserFunction<T>(
  name: 'tenant-user-invite' | 'tenant-user-update',
  requestId: string,
  body: Record<string, unknown>,
) {
  const { data, error } = await createClient().functions.invoke<EdgeEnvelope<T>>(name, {
    body,
    headers: { 'x-request-id': requestId },
  });
  let envelope = data;
  if (!envelope && error && 'context' in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        envelope = (await context.clone().json()) as EdgeEnvelope<T>;
      } catch {
        // A gateway/network failure may not have a JSON Edge envelope.
      }
    }
  }
  if (error || !envelope?.ok || !envelope.data)
    throw new UserAdministrationError(
      envelope?.error?.code ?? 'USER_ADMINISTRATION_REQUEST_FAILED',
      envelope?.error?.message ?? error?.message ?? 'The user request failed.',
    );
  return envelope.data;
}

export function inviteTenantUser(input: UserMutationInput & { email: string; requestId: string }) {
  return invokeUserFunction<{ user_id: string; version: number }>(
    'tenant-user-invite',
    input.requestId,
    {
      mode: input.mode,
      email: input.email.trim().toLowerCase(),
      full_name: input.fullName.trim(),
      phone: input.phone.trim() || undefined,
      employee_id: input.employeeId.trim() || undefined,
      role_id: input.roleId,
      data_scope: input.dataScope,
      scope_branch_id: input.scopeBranchId,
      selected_branch_ids: input.selectedBranchIds,
      team_ids: input.teamIds,
      active: input.active,
      mfa_required: input.mfaRequired,
    },
  );
}

export function updateTenantUser(
  input: UserMutationInput & { userId: string; expectedVersion: number; requestId: string },
) {
  return invokeUserFunction<{ user_id: string; version: number }>(
    'tenant-user-update',
    input.requestId,
    {
      mode: input.mode,
      user_id: input.userId,
      expected_version: input.expectedVersion,
      full_name: input.fullName.trim(),
      phone: input.phone.trim() || undefined,
      employee_id: input.employeeId.trim() || undefined,
      role_id: input.roleId,
      data_scope: input.dataScope,
      scope_branch_id: input.scopeBranchId,
      selected_branch_ids: input.selectedBranchIds,
      team_ids: input.teamIds,
      active: input.active,
      mfa_required: input.mfaRequired,
    },
  );
}
