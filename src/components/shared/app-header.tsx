'use client';

import { Bell, Building2, ChevronDown, LoaderCircle, LogOut, Menu, QrCode } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { roleNavigation } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUiStore } from '@/stores/ui-store';
import { MobileLinkDialog } from '@/features/auth/mobile-link-dialog';
import { canLinkMobileApp } from '@/lib/auth/mobile-link-policy';
import { getSafeAuthErrorMessage } from '@/lib/auth/safe-errors';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';

type HeaderProfile = {
  displayName: string;
  email?: string;
};

function getInitials(value: string) {
  const initials = value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return initials || 'A';
}

export function AppHeader({ role, previewMode }: { role: RoleKey; previewMode: boolean }) {
  const router = useRouter();
  const openMobileNavigation = useUiStore((state) => state.setMobileNavigationOpen);
  const [mobileLinkOpen, setMobileLinkOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [menuError, setMenuError] = useState<string>();
  const [profile, setProfile] = useState<HeaderProfile>({
    displayName: previewMode ? 'Local Preview' : 'Account',
  });
  const eligibleForMobile = canLinkMobileApp(role);

  useEffect(() => {
    if (!hasSupabaseConfig()) return;
    let active = true;
    void createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!active || !data.user) return;
        const metadata = data.user.user_metadata as Record<string, unknown>;
        const metadataName = [metadata.full_name, metadata.name].find(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        );
        setProfile({
          displayName: metadataName ?? data.user.email?.split('@')[0] ?? 'Account',
          email: data.user.email,
        });
      })
      .catch(() => {
        /* The menu keeps a non-sensitive account fallback if profile loading fails. */
      });
    return () => {
      active = false;
    };
  }, []);

  async function signOut() {
    setMenuError(undefined);
    if (!hasSupabaseConfig()) {
      setMenuError(getSafeAuthErrorMessage('SIGN_OUT'));
      return;
    }
    setSigningOut(true);
    try {
      const { error } = await createClient().auth.signOut();
      if (error) throw error;
      router.replace('/login');
      router.refresh();
    } catch {
      setMenuError(getSafeAuthErrorMessage('SIGN_OUT'));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
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
            <p className="text-xs font-semibold">
              {previewMode ? 'Apex Motors Pvt. Ltd.' : 'Dealership workspace'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {previewMode ? roleNavigation[role].scope : 'Assigned data scope'}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
            <Bell className="size-5" />
            <span className="absolute right-2 top-2 size-2 rounded-full border-2 border-white bg-red-500" />
          </Button>
          <div className="hidden h-8 w-px bg-border sm:block" />
          <DropdownMenu onOpenChange={(open) => open && setMenuError(undefined)}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="h-auto gap-3 p-1.5 text-left font-normal"
                aria-label="Open profile menu"
              >
                <Avatar>
                  <AvatarFallback>{getInitials(profile.displayName)}</AvatarFallback>
                </Avatar>
                <span className="hidden min-w-0 leading-tight sm:block">
                  <span className="block max-w-40 truncate text-xs font-semibold">
                    {profile.displayName}
                  </span>
                  <span className="block max-w-40 truncate text-[11px] text-muted-foreground">
                    {roleNavigation[role].shortLabel}
                  </span>
                </span>
                <ChevronDown className="hidden size-4 text-muted-foreground sm:block" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="font-normal">
                <span className="block truncate text-sm font-semibold">{profile.displayName}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {profile.email ?? roleNavigation[role].label}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {eligibleForMobile && (
                <DropdownMenuItem onSelect={() => setMobileLinkOpen(true)}>
                  <QrCode className="size-4" />
                  Link mobile app
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={signingOut}
                className="text-red-700 focus:bg-red-50 focus:text-red-800"
                onSelect={(event) => {
                  event.preventDefault();
                  void signOut();
                }}
              >
                {signingOut ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <LogOut className="size-4" />
                )}
                {signingOut ? 'Signing out…' : 'Sign out'}
              </DropdownMenuItem>
              {menuError && (
                <p
                  className="mx-2 my-1 rounded-md bg-red-50 p-2 text-xs leading-5 text-red-700"
                  role="alert"
                >
                  {menuError}
                </p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {eligibleForMobile && (
        <MobileLinkDialog open={mobileLinkOpen} onOpenChange={setMobileLinkOpen} />
      )}
    </>
  );
}
