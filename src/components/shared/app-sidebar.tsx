'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, CircleHelp, ShieldCheck } from 'lucide-react';
import {
  EMPTY_NAVIGATION_ACCESS,
  filterNavigationItems,
  roleNavigation,
  type NavigationAccess,
} from '@/config/navigation';
import type { NavItem, RoleKey } from '@/config/navigation/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useUiStore } from '@/stores/ui-store';
import { AppIcon } from './icon';

type NavigationEntry =
  | { kind: 'item'; item: NavItem }
  | { kind: 'group'; title: string; icon: string; items: NavItem[] };

// Consecutive items that share a group become one collapsible entry.
function navigationEntries(items: NavItem[]) {
  const entries: NavigationEntry[] = [];
  for (const item of items) {
    const previous = entries.at(-1);
    if (!item.group) entries.push({ kind: 'item', item });
    else if (previous?.kind === 'group' && previous.title === item.group.title)
      previous.items.push(item);
    else entries.push({ kind: 'group', ...item.group, items: [item] });
  }
  return entries;
}

function NavigationLink({
  item,
  href,
  active,
  nested,
  onNavigate,
}: {
  item: NavItem;
  href: string;
  active: boolean;
  nested?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors',
        nested && 'h-9 pl-9',
        active
          ? 'bg-blue-500 text-white shadow-sm'
          : 'text-slate-300 hover:bg-white/7 hover:text-white',
      )}
    >
      <AppIcon name={item.icon} className="size-[17px] shrink-0" />
      <span className="truncate">{item.title}</span>
    </Link>
  );
}

function NavigationGroup({
  title,
  icon,
  items,
  role,
  pathname,
  onNavigate,
}: {
  title: string;
  icon: string;
  items: NavItem[];
  role: RoleKey;
  pathname: string;
  onNavigate?: () => void;
}) {
  const isActive = (slug: string) =>
    pathname === `/${role}/${slug}` || pathname.startsWith(`/${role}/${slug}/`);
  const containsActive = items.some((item) => isActive(item.slug));
  // Open on the group's own pages; elsewhere it stays as the user left it.
  const [expanded, setExpanded] = useState(containsActive);
  const open = expanded || containsActive;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setExpanded(!open)}
        className={cn(
          'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors',
          containsActive ? 'text-white' : 'text-slate-300 hover:bg-white/7 hover:text-white',
        )}
      >
        <AppIcon name={icon} className="size-[17px] shrink-0" />
        <span className="flex-1 truncate text-left">{title}</span>
        <ChevronDown
          className={cn('size-4 shrink-0 transition-transform', open ? 'rotate-180' : '')}
        />
      </button>
      {open ? (
        <div className="mt-1 space-y-1">
          {items.map((item) => (
            <NavigationLink
              key={item.slug}
              item={item}
              href={`/${role}/${item.slug}`}
              active={isActive(item.slug)}
              nested
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
  const supportHref =
    role === 'super-admin'
      ? '/super-admin/support-sessions'
      : role === 'business-owner'
        ? '/business-owner/support-maintenance'
        : null;
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
        <p className="truncate text-sm font-semibold text-white">{navigation.shortLabel}</p>
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <ShieldCheck className="size-3.5" />
          {previewMode ? navigation.scope : 'Assigned data scope'}
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {navigationEntries(navigationItems).map((entry) => {
          if (entry.kind === 'group')
            return (
              <NavigationGroup
                key={`group:${entry.title}`}
                title={entry.title}
                icon={entry.icon}
                items={entry.items}
                role={role}
                pathname={pathname}
                onNavigate={onNavigate}
              />
            );
          const href = `/${role}/${entry.item.slug}`;
          return (
            <NavigationLink
              key={entry.item.slug}
              item={entry.item}
              href={href}
              active={pathname === href || pathname.startsWith(`${href}/`)}
              onNavigate={onNavigate}
            />
          );
        })}
      </nav>
      <div className="border-t border-white/10 p-3">
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-xs text-slate-400 hover:bg-white/5 hover:text-white"
            >
              <CircleHelp className="size-4" />
              Help & support
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Help & support</DialogTitle>
              <DialogDescription>
                {supportHref
                  ? 'Open the authorized support workspace to review or manage support access.'
                  : 'Contact your dealership Client Admin and share the page name and what you were trying to do. Platform support can access tenant data only through an approved support session.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Close
                </Button>
              </DialogClose>
              {supportHref ? (
                <Button asChild>
                  <Link href={supportHref} onClick={onNavigate}>
                    Open support workspace
                  </Link>
                </Button>
              ) : null}
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
