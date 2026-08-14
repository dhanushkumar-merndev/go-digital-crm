import type { RoleKey } from '@/config/navigation/types';
import { AppHeader } from './app-header';
import { AppSidebar } from './app-sidebar';

export function CrmShell({ role, children }: { role: RoleKey; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <AppSidebar role={role} />
      <AppHeader role={role} />
      <main className="px-4 py-6 md:px-6 lg:ml-[252px] lg:px-8">{children}</main>
    </div>
  );
}
