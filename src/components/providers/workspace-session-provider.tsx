'use client';

import { createContext, useContext } from 'react';
import type { RoleKey } from '@/config/navigation/types';

export type WorkspaceSession = {
  userId: string;
  organizationId: string | null;
  roleKey: RoleKey;
  dataScope: string | null;
  scopeKey: string;
  permissions: readonly string[];
  displayName: string;
  email: string | null;
  organizationName: string | null;
  workspaceName: string | null;
};

const WorkspaceSessionContext = createContext<WorkspaceSession | null>(null);

export function WorkspaceSessionProvider({
  session,
  children,
}: {
  session: WorkspaceSession | null;
  children: React.ReactNode;
}) {
  return (
    <WorkspaceSessionContext.Provider value={session}>{children}</WorkspaceSessionContext.Provider>
  );
}

export function useWorkspaceSession() {
  return useContext(WorkspaceSessionContext);
}

export function hasWorkspacePermission(session: WorkspaceSession | null, permission: string) {
  return session?.permissions.includes(permission) ?? false;
}

export function workspaceQueryScope(session: WorkspaceSession | null) {
  return [
    session?.organizationId ?? 'no-organization',
    session?.userId ?? 'no-user',
    session?.scopeKey ?? 'no-scope',
  ] as const;
}
