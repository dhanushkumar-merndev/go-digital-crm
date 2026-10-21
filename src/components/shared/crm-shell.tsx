import {
  EMPTY_NAVIGATION_ACCESS,
  NAVIGATION_CAPABILITIES,
  type NavigationAccess,
} from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import {
  WorkspaceSessionProvider,
  type WorkspaceSession,
} from '@/components/providers/workspace-session-provider';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import { SessionExpiryGuard } from '@/features/auth/session-expiry-guard';
import { LiveCallBar } from '@/features/calls/live-call-bar';
import { AppHeader } from './app-header';
import { AppSidebar } from './app-sidebar';

// Sidebar items gated on a capability follow the session's permissions. The
// optional Sales Manager / GM "Users" item needs `user.manage`; nothing passed
// this in before, so the item never appeared even for a delegated manager.
function navigationAccessFor(session: WorkspaceSession | null): NavigationAccess {
  if (!session?.permissions.includes('user.manage')) return EMPTY_NAVIGATION_ACCESS;
  return { capabilities: [NAVIGATION_CAPABILITIES.MANAGE_DELEGATED_USERS] };
}

export function CrmShell({
  role,
  children,
  navigationAccess,
  session = null,
}: {
  role: RoleKey;
  children: React.ReactNode;
  navigationAccess?: NavigationAccess;
  session?: WorkspaceSession | null;
}) {
  const previewMode = isLocalPreviewMode();
  const access = navigationAccess ?? navigationAccessFor(session);
  return (
    <WorkspaceSessionProvider session={session}>
      <SessionExpiryGuard />
      {/* Follows a dealership call wherever the user navigates, so leaving the
          lead list does not lose sight of a call that is still ringing. */}
      <LiveCallBar />
      {/* Two halves of one rule: the desktop layout is never squeezed below
          1280 (it scrolls instead of cramming), and never stretched past the
          1920 canvas it was designed on (it centres instead). Above 1920 the
          page is scaled up rather than reflowed -- see ViewportScale. Below
          lg the small-screen stack is untouched. */}
      <div className="min-h-screen lg:min-w-[1280px]">
        <AppSidebar role={role} previewMode={previewMode} navigationAccess={access} />
        <AppHeader role={role} previewMode={previewMode} />
        <main className="px-4 py-5 md:px-6 lg:ml-[252px] lg:px-8">
          <div className="mx-auto w-full max-w-[1604px]">{children}</div>
        </main>
      </div>
    </WorkspaceSessionProvider>
  );
}
