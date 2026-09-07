'use client';

import {
  Bell,
  Building2,
  CalendarDays,
  CarFront,
  CheckCheck,
  ChevronDown,
  ClipboardList,
  FileText,
  LoaderCircle,
  LogOut,
  Menu,
  Monitor,
  Plus,
  QrCode,
  UserRoundPen,
  UserRoundPlus,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { roleHasNavigationSlug, roleNavigation } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import { useFixedCanvas } from '@/components/shared/viewport-scale';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import {
  fetchProfileAvatarUrl,
  profileAvatarUrlKey,
  type SavedProfile,
} from '@/features/auth/profile-settings-api';
import { ProfileSettingsDialog } from '@/features/auth/profile-settings-dialog';
import { GlobalCustomerSearch } from '@/components/shared/global-customer-search';
import { canLinkMobileApp } from '@/lib/auth/mobile-link-policy';
import { getSafeAuthErrorMessage } from '@/lib/auth/safe-errors';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
} from '@/components/providers/workspace-session-provider';
import {
  fetchHeaderNotifications,
  headerNotificationsKey,
  markHeaderNotificationRead,
} from '@/features/notifications/notification-api';
import { NotificationCenterSheet } from '@/features/notifications/notification-center-sheet';
import { notificationDetailHref } from '@/lib/navigation/record-links';

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

function notificationTime(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(
    new Date(value),
  );
}

export function AppHeader({ role, previewMode }: { role: RoleKey; previewMode: boolean }) {
  const router = useRouter();
  const workspaceSession = useWorkspaceSession();
  const openMobileNavigation = useUiStore((state) => state.setMobileNavigationOpen);
  const [mobileLinkOpen, setMobileLinkOpen] = useState(false);
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [profileOverride, setProfileOverride] = useState<SavedProfile>();
  const [signingOut, setSigningOut] = useState(false);
  const [menuError, setMenuError] = useState<string>();
  const fixedCanvas = useFixedCanvas();
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const queryClient = useQueryClient();
  const sessionProfile = {
    displayName: previewMode ? 'Local Preview' : (workspaceSession?.displayName ?? 'Account'),
    email: workspaceSession?.email ?? undefined,
    avatarObjectFileId: previewMode ? null : (workspaceSession?.avatarObjectFileId ?? null),
    version: previewMode ? 1 : (workspaceSession?.profileVersion ?? 1),
  };
  const profile = profileOverride
    ? { ...profileOverride, email: sessionProfile.email, displayName: profileOverride.fullName }
    : sessionProfile;

  const eligibleForMobile = canLinkMobileApp(role);
  // Telecaller works the same front-line surface as Sales Consultant, so it
  // gets the same header furniture rather than the generic tenant block.
  const salesWorkspace = role === 'sales-consultant' || role === 'telecaller';
  // Quick add only offers what the role can actually reach, and routes into
  // that role's own workspace instead of a hardcoded sales-consultant path.
  const quickAddItems = (
    [
      { slug: 'my-leads', label: 'Add lead', icon: UserRoundPlus },
      { slug: 'test-drives', label: 'Book test drive', icon: CarFront },
      { slug: 'quotations', label: 'Create quotation', icon: FileText },
    ] as const
  ).filter((item) => roleHasNavigationSlug(role, item.slug));
  const canNavigateTasks =
    roleHasNavigationSlug(role, 'tasks') &&
    (previewMode || hasWorkspacePermission(workspaceSession, 'task.view'));
  const notifications = useQuery({
    queryKey: [
      ...headerNotificationsKey,
      workspaceSession?.organizationId ?? 'no-organization',
      workspaceSession?.userId ?? 'no-user',
    ],
    queryFn: ({ signal }) => fetchHeaderNotifications(signal),
    enabled: !previewMode && hasSupabaseConfig(),
    staleTime: 60_000,
  });
  const profileAvatar = useQuery({
    queryKey: profileAvatarUrlKey(profile.avatarObjectFileId),
    queryFn: fetchProfileAvatarUrl,
    enabled: !previewMode && Boolean(profile.avatarObjectFileId) && hasSupabaseConfig(),
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    retry: 0,
  });
  const markRead = useMutation({
    mutationFn: markHeaderNotificationRead,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: headerNotificationsKey }),
  });
  const unreadCount =
    notifications.data?.filter((notification) => !notification.read_at).length ?? 0;
  const dealershipName = previewMode
    ? 'Apex Motors Pvt. Ltd.'
    : (workspaceSession?.workspaceName ?? 'Assigned dealership');
  const currentDate = new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date());

  async function signOut() {
    setMenuError(undefined);
    if (!hasSupabaseConfig()) {
      setMenuError(getSafeAuthErrorMessage('SIGN_OUT'));
      return;
    }
    setSigningOut(true);
    try {
      queryClient.clear();
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
      <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b bg-white/95 px-4 backdrop-blur md:px-6 lg:ml-[252px]">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="Open navigation"
          onClick={() => openMobileNavigation(true)}
        >
          <Menu className="size-5" />
        </Button>
        <GlobalCustomerSearch role={role} />
        {!salesWorkspace && (
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
        )}
        <div className="ml-auto flex items-center gap-2">
          {salesWorkspace && (
            <>
              <span
                className="hidden h-9 max-w-[220px] items-center gap-2 rounded-lg border bg-white px-3 text-[11px] font-medium text-[#263550] xl:flex"
                title={dealershipName}
              >
                <Building2 className="size-3.5 shrink-0 text-blue-600" />
                <span className="truncate">{dealershipName}</span>
              </span>
              <span className="hidden h-9 items-center gap-2 rounded-lg border bg-white px-3 text-[11px] font-medium text-[#263550] xl:flex">
                <CalendarDays className="size-3.5 text-blue-600" /> {currentDate}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className={quickAddItems.length ? 'hidden sm:inline-flex' : 'hidden'}
                  >
                    <Plus className="size-3.5" /> Quick add
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {quickAddItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <DropdownMenuItem
                        key={item.slug}
                        onSelect={() => router.push(`/${role}/${item.slug}?action=create`)}
                      >
                        <Icon className="size-4" /> {item.label}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          {canNavigateTasks ? (
            <Button
              variant="ghost"
              size="sm"
              className="hidden xl:inline-flex"
              onClick={() => router.push(`/${role}/tasks`)}
            >
              <ClipboardList className="size-4" /> Tasks
            </Button>
          ) : null}
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) void notifications.refetch();
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
                <Bell className="size-5" />
                {unreadCount > 0 && (
                  <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full border-2 border-white bg-red-500 px-0.5 text-[9px] font-bold leading-4 text-white">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
              <div className="flex items-center justify-between border-b px-3 py-2.5">
                <div>
                  <p className="text-sm font-semibold text-[#17233d]">Notifications</p>
                  <p className="text-xs text-muted-foreground">
                    {unreadCount ? `${unreadCount} unread` : 'You are up to date'}
                  </p>
                </div>
                {notifications.isFetching && (
                  <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="max-h-[min(28rem,calc(100vh-10rem))] overflow-y-auto p-1.5">
                {notifications.isError ? (
                  <p className="p-5 text-center text-sm text-muted-foreground">
                    Notifications could not be loaded. Try again in a moment.
                  </p>
                ) : notifications.isPending ? (
                  <div className="space-y-2 p-2" aria-label="Loading notifications">
                    <div className="h-14 animate-pulse rounded-md bg-slate-100" />
                    <div className="h-14 animate-pulse rounded-md bg-slate-100" />
                  </div>
                ) : notifications.data?.length ? (
                  notifications.data.map((notification) => (
                    <DropdownMenuItem
                      key={notification.id}
                      className="relative block cursor-pointer whitespace-normal rounded-md px-3 py-3 focus:bg-blue-50"
                      onSelect={(event) => {
                        const href = notificationDetailHref(
                          role,
                          notification.resource_type,
                          notification.resource_id,
                        );
                        if (href) router.push(href);
                        else event.preventDefault();
                        if (!notification.read_at) markRead.mutate(notification.id);
                      }}
                    >
                      <div className="flex gap-3">
                        <span
                          className={`mt-1.5 size-2 shrink-0 rounded-full ${notification.read_at ? 'bg-slate-300' : 'bg-blue-500'}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-[#17233d]">
                              {notification.title}
                            </p>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {notificationTime(notification.created_at)}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                            {notification.body}
                          </p>
                        </div>
                      </div>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <div className="flex flex-col items-center p-7 text-center">
                    <span className="grid size-10 place-items-center rounded-full bg-blue-50 text-blue-600">
                      <CheckCheck className="size-5" />
                    </span>
                    <p className="mt-3 text-sm font-semibold text-[#17233d]">All caught up</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      New lead and work updates will appear here.
                    </p>
                  </div>
                )}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="justify-center py-2 text-xs font-semibold text-blue-700 focus:text-blue-800"
                onSelect={(event) => {
                  event.preventDefault();
                  setNotificationCenterOpen(true);
                }}
              >
                View notification center
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="hidden h-8 w-px bg-border sm:block" />
          <DropdownMenu onOpenChange={(open) => open && setMenuError(undefined)}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="h-auto gap-3 p-1.5 text-left font-normal"
                aria-label="Open profile menu"
              >
                <Avatar>
                  {profileAvatar.data?.avatar_url ? (
                    <AvatarImage
                      src={profileAvatar.data.avatar_url}
                      alt={`${profile.displayName} profile photo`}
                    />
                  ) : null}
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
              {!previewMode && workspaceSession ? (
                <DropdownMenuItem onSelect={() => setProfileSettingsOpen(true)}>
                  <UserRoundPen className="size-4" />
                  My profile
                </DropdownMenuItem>
              ) : null}
              {eligibleForMobile && (
                <DropdownMenuItem onSelect={() => setMobileLinkOpen(true)}>
                  <QrCode className="size-4" />
                  Link mobile app
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                role="switch"
                aria-checked={fixedCanvas.enabled}
                onSelect={(event) => {
                  // Staying open lets the change be seen and undone in place:
                  // the whole page resizes underneath the menu.
                  event.preventDefault();
                  fixedCanvas.setEnabled(!fixedCanvas.enabled);
                }}
              >
                <Monitor className="size-4" />
                <span className="flex-1">Fixed layout</span>
                <span
                  aria-hidden
                  className={`flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                    fixedCanvas.enabled ? 'bg-blue-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`size-3 rounded-full bg-white transition-transform ${
                      fixedCanvas.enabled ? 'translate-x-3' : 'translate-x-0'
                    }`}
                  />
                </span>
              </DropdownMenuItem>
              <p className="px-2 pb-1 text-[11px] leading-4 text-muted-foreground">
                {fixedCanvas.enabled
                  ? 'Every screen shows the same layout, scaled to fit.'
                  : 'The layout reflows to this window, and browser zoom applies.'}
              </p>
              <DropdownMenuSeparator />
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
      {!previewMode && workspaceSession && profileSettingsOpen ? (
        <ProfileSettingsDialog
          open={profileSettingsOpen}
          onOpenChange={setProfileSettingsOpen}
          profile={{
            fullName: profile.displayName,
            avatarObjectFileId: profile.avatarObjectFileId,
            version: profile.version,
          }}
          organizationId={workspaceSession.organizationId}
          userId={workspaceSession.userId}
          currentAvatarUrl={profileAvatar.data?.avatar_url}
          onSaved={(saved) => {
            setProfileOverride(saved);
            void queryClient.invalidateQueries({
              queryKey: profileAvatarUrlKey(saved.avatarObjectFileId),
            });
            router.refresh();
          }}
        />
      ) : null}
      <NotificationCenterSheet
        open={notificationCenterOpen}
        onOpenChange={setNotificationCenterOpen}
        role={role}
      />
    </>
  );
}
