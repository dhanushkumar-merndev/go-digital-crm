import { EMPTY_NAVIGATION_ACCESS, type NavigationAccess } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import {
  WorkspaceSessionProvider,
  type WorkspaceSession,
} from '@/components/providers/workspace-session-provider';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import { SessionExpiryGuard } from '@/features/auth/session-expiry-guard';
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
      <SessionExpiryGuard />
      {/* Two halves of one rule: the desktop layout is never squeezed below
          1280 (it scrolls instead of cramming), and never stretched past the
          1920 canvas it was designed on (it centres instead). Above 1920 the
          page is scaled up rather than reflowed -- see ViewportScale. Below
          lg the small-screen stack is untouched. */}
      <div className="min-h-screen lg:min-w-[1280px]">
        <AppSidebar role={role} previewMode={previewMode} navigationAccess={navigationAccess} />
        <AppHeader role={role} previewMode={previewMode} />
        <main className="px-4 py-5 md:px-6 lg:ml-[252px] lg:px-8">
          <div className="mx-auto w-full max-w-[1604px]">{children}</div>
        </main>
      </div>
    </WorkspaceSessionProvider>
  );
}
