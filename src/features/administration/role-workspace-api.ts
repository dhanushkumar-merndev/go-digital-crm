import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { RoleWorkspaceQuery } from './role-workspace-query';

const roleRecordSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  role_key: z.string().min(1),
  authority_level: z.coerce.number().int().min(0).max(1000),
  system_role: z.boolean(),
  mfa_required: z.boolean(),
  permissions: z.array(z.string()),
  assigned_users: z.coerce.number().int().nonnegative(),
  can_edit: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const roleWorkspaceSchema = z.object({
  records: z.array(roleRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total_roles: z.coerce.number().int().nonnegative(),
    custom_roles: z.coerce.number().int().nonnegative(),
    mfa_roles: z.coerce.number().int().nonnegative(),
    assigned_users: z.coerce.number().int().nonnegative(),
  }),
  viewer: z.object({
    organization_id: z.uuid(),
    authority_ceiling: z.coerce.number().int().min(1).max(1000),
    can_manage: z.boolean(),
  }),
});

const delegablePermissionSchema = z.object({
  permission_key: z.string().min(1).max(100),
  module: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
});

export type RoleAdministrationRecord = z.infer<typeof roleRecordSchema>;
export type RoleWorkspaceResult = z.infer<typeof roleWorkspaceSchema>;
export type DelegablePermission = z.infer<typeof delegablePermissionSchema>;

export async function fetchRoleWorkspace(query: RoleWorkspaceQuery): Promise<RoleWorkspaceResult> {
  const { data, error } = await createClient().rpc('get_role_administration_page', {
    search_term: query.search || null,
    role_filter: query.filter,
    page_size: query.pageSize,
    page_offset: (query.page - 1) * query.pageSize,
    sort_key: query.sort,
  });
  if (error) throw error;
  return roleWorkspaceSchema.parse(data);
}

export async function fetchDelegablePermissions(): Promise<DelegablePermission[]> {
  const { data, error } = await createClient().rpc('list_delegable_role_permissions');
  if (error) throw error;
  return z.array(delegablePermissionSchema).parse(data ?? []);
}

export async function saveDelegatedRole(input: {
  roleId?: string;
  expectedUpdatedAt?: string;
  name: string;
  roleKey: string;
  authorityLevel: number;
  requireMfa: boolean;
  permissionKeys: string[];
}) {
  const { data, error } = await createClient().rpc('save_delegated_role', {
    target_role_id: input.roleId ?? null,
    expected_updated_at: input.expectedUpdatedAt ?? null,
    target_role_name: input.name.trim(),
    target_role_key: input.roleKey,
    target_authority_level: input.authorityLevel,
    target_require_mfa: input.requireMfa,
    target_permission_keys: input.permissionKeys,
  });
  if (error) throw error;
  return roleRecordSchema.partial().parse(data);
}

export function isRoleVersionConflict(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === '40001' || candidate.message === 'ROLE_VERSION_CONFLICT';
}
