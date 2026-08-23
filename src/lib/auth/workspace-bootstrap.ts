import { z } from 'zod';
import { isRoleKey } from '@/config/navigation';
import type { WorkspaceSession } from '@/components/providers/workspace-session-provider';

export const workspaceBootstrapSchema = z.object({
  authenticated: z.boolean().optional(),
  destination: z.string(),
  user_id: z.uuid().optional(),
  organization_id: z.uuid().nullable().optional(),
  role_key: z.string().optional(),
  data_scope: z.string().nullable().optional(),
  scope_key: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  display_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  organization_name: z.string().nullable().optional(),
  workspace_name: z.string().nullable().optional(),
});

export type WorkspaceBootstrap = z.infer<typeof workspaceBootstrapSchema>;

export function toWorkspaceSession(context: WorkspaceBootstrap): WorkspaceSession | null {
  if (
    context.destination !== 'CRM' ||
    !context.user_id ||
    !context.role_key ||
    !isRoleKey(context.role_key)
  )
    return null;

  return {
    userId: context.user_id,
    organizationId: context.organization_id ?? null,
    roleKey: context.role_key,
    dataScope: context.data_scope ?? null,
    scopeKey:
      context.scope_key ??
      [
        context.organization_id ?? 'platform',
        context.user_id,
        context.role_key,
        context.data_scope ?? 'none',
      ].join(':'),
    permissions: context.permissions ?? [],
    displayName: context.display_name?.trim() || 'Account',
    email: context.email ?? null,
    organizationName: context.organization_name ?? null,
    workspaceName: context.workspace_name ?? context.organization_name ?? null,
  };
}
