'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CircleHelp, ShieldCheck } from 'lucide-react';
import {
  EMPTY_NAVIGATION_ACCESS,
  filterNavigationItems,
  roleNavigation,
  type NavigationAccess,
} from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useUiStore } from '@/stores/ui-store';
import { AppIcon } from './icon';
import { RoleSwitcher } from './role-switcher';

function SidebarContent({
  role,
  previewMode,
  navigationAccess,
  onNavigate,
}: {
  role: RoleKey;
  previewMode: boolean;
  navigationAccess: NavigationAccess;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const navigation = roleNavigation[role];
  const navigationItems = filterNavigationItems(navigation.items, navigationAccess);
  return (
    <>
      <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
        <Image
          src="/logo.webp"
          alt="Go Digital Marketing CRM"
          width={36}
          height={36}
          className="rounded-lg object-contain"
          priority
        />
        <div>
          <p className="text-sm font-bold text-white">Go Digital</p>
          <p className="text-[11px] text-slate-400">Marketing CRM</p>
        </div>
      </div>
      <div className="border-b border-white/10 p-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          {previewMode ? 'Viewing as' : 'Workspace'}
        </p>
        {previewMode ? (
          <RoleSwitcher role={role} />
        ) : (
          <p className="truncate text-sm font-semibold text-white">{navigation.shortLabel}</p>
        )}
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <ShieldCheck className="size-3.5" />
          {previewMode ? navigation.scope : 'Assigned data scope'}
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {navigationItems.map((item) => {
          const href = `/${role}/${item.slug}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              href={href}
              onClick={onNavigate}
              key={item.slug}
              className={cn(
                'flex h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors',
                active
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-white/7 hover:text-white',
              )}
            >
              <AppIcon name={item.icon} className="size-[17px] shrink-0" />
              <span className="truncate">{item.title}</span>
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-white/10 p-3">
        <button className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-xs text-slate-400 hover:bg-white/5 hover:text-white">
          <CircleHelp className="size-4" />
          Help & support
        </button>
      </div>
    </>
  );
}

export function AppSidebar({
  role,
  previewMode,
  navigationAccess = EMPTY_NAVIGATION_ACCESS,
}: {
  role: RoleKey;
  previewMode: boolean;
  navigationAccess?: NavigationAccess;
}) {
  const open = useUiStore((state) => state.mobileNavigationOpen);
  const setOpen = useUiStore((state) => state.setMobileNavigationOpen);
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[252px] flex-col bg-[#17233d] text-slate-200 lg:flex">
        <SidebarContent role={role} previewMode={previewMode} navigationAccess={navigationAccess} />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex flex-col border-0 bg-[#17233d] p-0 text-slate-200 lg:hidden">
          <SheetTitle className="sr-only">Application navigation</SheetTitle>
          <SheetDescription className="sr-only">Role-specific CRM navigation</SheetDescription>
          <SidebarContent
            role={role}
            previewMode={previewMode}
            navigationAccess={navigationAccess}
            onNavigate={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
