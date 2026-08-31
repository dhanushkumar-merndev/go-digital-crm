import { EMPTY_NAVIGATION_ACCESS, type NavigationAccess } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import {
  WorkspaceSessionProvider,
  type WorkspaceSession,
} from '@/components/providers/workspace-session-provider';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import { AppHeader } from './app-header';
import { AppSidebar } from './app-sidebar';

export function CrmShell({
  role,
  children,
  navigationAccess = EMPTY_NAVIGATION_ACCESS,
  session = null,
}: {
  role: RoleKey;
  children: React.ReactNode;
  navigationAccess?: NavigationAccess;
  session?: WorkspaceSession | null;
}) {
  const previewMode = isLocalPreviewMode();
  return (
    <WorkspaceSessionProvider session={session}>
      <div className="min-h-screen">
        <AppSidebar role={role} previewMode={previewMode} navigationAccess={navigationAccess} />
        <AppHeader role={role} previewMode={previewMode} />
        <main className="px-4 py-5 md:px-6 lg:ml-[252px] lg:px-8">{children}</main>
      </div>
    </WorkspaceSessionProvider>
  );
}
