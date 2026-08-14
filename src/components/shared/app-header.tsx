'use client';

import { Bell, Building2, ChevronDown, Menu } from 'lucide-react';
import { roleNavigation } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import { Button } from '@/components/ui/button';
import { useUiStore } from '@/stores/ui-store';
import { MobileLinkDialog } from '@/features/auth/mobile-link-dialog';

export function AppHeader({ role }: { role: RoleKey }) {
  const openMobileNavigation = useUiStore((state) => state.setMobileNavigationOpen);
  const eligibleForMobile = role === 'telecaller' || role === 'sales-consultant';
  const profileButton = (
    <button className="flex items-center gap-3 rounded-lg p-1.5 text-left hover:bg-muted">
      <div className="grid size-9 place-items-center rounded-full bg-blue-100 text-sm font-bold text-blue-700">
        PN
      </div>
      <div className="hidden leading-tight sm:block">
        <p className="text-xs font-semibold">Priya Nair</p>
        <p className="max-w-36 truncate text-[11px] text-muted-foreground">
          {roleNavigation[role].shortLabel}
        </p>
      </div>
      <ChevronDown className="hidden size-4 text-muted-foreground sm:block" />
    </button>
  );
  return (
    <header className="sticky top-0 z-20 flex h-[72px] items-center gap-4 border-b bg-white/95 px-4 backdrop-blur md:px-6 lg:ml-[252px]">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open navigation"
        onClick={() => openMobileNavigation(true)}
      >
        <Menu className="size-5" />
      </Button>
      <div className="hidden items-center gap-2 text-sm md:flex">
        <div className="grid size-8 place-items-center rounded-lg bg-blue-50 text-blue-700">
          <Building2 className="size-4" />
        </div>
        <div>
          <p className="text-xs font-semibold">Apex Motors Pvt. Ltd.</p>
          <p className="text-[11px] text-muted-foreground">{roleNavigation[role].scope}</p>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="size-5" />
          <span className="absolute right-2 top-2 size-2 rounded-full border-2 border-white bg-red-500" />
        </Button>
        <div className="hidden h-8 w-px bg-border sm:block" />
        {eligibleForMobile ? <MobileLinkDialog>{profileButton}</MobileLinkDialog> : profileButton}
      </div>
    </header>
  );
}
