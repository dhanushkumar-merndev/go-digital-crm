import { EMPTY_NAVIGATION_ACCESS, type NavigationAccess } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import { AppHeader } from './app-header';
import { AppSidebar } from './app-sidebar';

export function CrmShell({
  role,
  children,
  navigationAccess = EMPTY_NAVIGATION_ACCESS,
}: {
  role: RoleKey;
  children: React.ReactNode;
  navigationAccess?: NavigationAccess;
}) {
  const previewMode = isLocalPreviewMode();
  return (
    <div className="min-h-screen">
      <AppSidebar role={role} previewMode={previewMode} navigationAccess={navigationAccess} />
      <AppHeader role={role} previewMode={previewMode} />
      <main className="px-4 py-6 md:px-6 lg:ml-[252px] lg:px-8">{children}</main>
    </div>
  );
}
