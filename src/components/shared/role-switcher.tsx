'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, ShieldUser } from 'lucide-react';
import { isRoleKey, roleKeys, roleNavigation } from '@/config/navigation';
import type { RoleKey, RoleNavigation } from '@/config/navigation/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import {
  DEVELOPMENT_DEMO_ROLE_LOGIN_PATH,
  developmentDemoOrganizations,
  type DevelopmentDemoOrganizationKey,
} from '@/lib/auth/development-demo-role-login';

// Which demo dealership the current session belongs to. Only a per-browser
// convenience for the Active marker; the session itself is the source of truth.
const demoOrganizationStorageKey = 'gdm-demo-organization';

function readDemoOrganization(): DevelopmentDemoOrganizationKey {
  try {
    const stored = window.localStorage.getItem(demoOrganizationStorageKey);
    return developmentDemoOrganizations.some((row) => row.key === stored)
      ? (stored as DevelopmentDemoOrganizationKey)
      : 'demo';
  } catch {
    return 'demo';
  }
}

const roleGroupOrder: RoleNavigation['group'][] = [
  'Platform',
  'Administration',
  'Sales',
  'Operations',
];

export function RoleSwitcher({
  role,
  mode = 'preview',
}: {
  role?: RoleKey;
  mode?: 'preview' | 'demo-login';
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<RoleKey>();
  const [isPending, startTransition] = useTransition();
  const [sessionOrganization, setSessionOrganization] =
    useState<DevelopmentDemoOrganizationKey>('demo');
  const [organizationKey, setOrganizationKey] = useState<DevelopmentDemoOrganizationKey>('demo');
  // Read on open rather than on mount: storage is browser-only, and the sheet
  // is the only place the value is shown.
  function openSwitcher() {
    const stored = readDemoOrganization();
    setSessionOrganization(stored);
    setOrganizationKey(stored);
    setOpen(true);
  }
  const organization =
    developmentDemoOrganizations.find((row) => row.key === organizationKey) ??
    developmentDemoOrganizations[0];
  const pathnameRole = pathname.split('/')[1] ?? '';
  const currentRoleKey = role ?? (isRoleKey(pathnameRole) ? pathnameRole : undefined);
  const currentRole = currentRoleKey ? roleNavigation[currentRoleKey] : undefined;
  const realDemoLogin = mode === 'demo-login';
  const isSwitching = Boolean(switchingTo) || isPending;
  const organizationRoles: readonly RoleKey[] | undefined =
    realDemoLogin && 'roles' in organization ? organization.roles : undefined;

  async function switchRole(nextRole: RoleKey) {
    const sameOrganization = !realDemoLogin || organizationKey === sessionOrganization;
    if (nextRole === currentRoleKey && sameOrganization) {
      setOpen(false);
      return;
    }

    setSwitchingTo(nextRole);
    if (realDemoLogin) {
      try {
        const response = await fetch(DEVELOPMENT_DEMO_ROLE_LOGIN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: nextRole, organization: organizationKey }),
        });
        if (!response.ok) throw new Error('DEMO_ROLE_LOGIN_FAILED');
        try {
          window.localStorage.setItem(demoOrganizationStorageKey, organizationKey);
        } catch {
          // Only the Active marker depends on this.
        }
        queryClient.clear();
        setSwitchingTo(undefined);
        setOpen(false);
        // Authentication replaced the session cookies. A full document
        // navigation gives the next request one coherent cookie snapshot and
        // avoids overlapping replace/refresh performance marks in Turbopack.
        window.location.replace('/');
      } catch {
        setSwitchingTo(undefined);
        toast.add({
          type: 'error',
          priority: 'high',
          title: 'Demo role sign-in failed',
          description:
            'The selected demo account could not be opened. Check the local setup and try again.',
        });
      }
      return;
    }

    startTransition(() => {
      setOpen(false);
      router.replace(`/${nextRole}/dashboard`);
    });
  }

  return (
    <>
      <Button
        type="button"
        onClick={openSwitcher}
        className="fixed bottom-5 right-5 z-[35] h-auto rounded-full border border-blue-300/30 bg-[#17233d] px-3 py-2.5 text-white shadow-xl hover:bg-[#223252] sm:px-4"
        aria-label={`Open development role switcher. ${currentRole ? `Viewing as ${currentRole.label}` : 'Choose a role preview'}`}
      >
        <span className="grid size-8 place-items-center rounded-full bg-blue-500">
          <ShieldUser className="size-4" />
        </span>
        <span className="hidden min-w-0 text-left sm:block">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-200">
            {realDemoLogin ? 'Demo login' : 'Dev role'}
          </span>
          <span className="block max-w-40 truncate text-xs">
            {currentRole?.shortLabel ?? 'Choose a role'}
          </span>
        </span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-[min(28rem,calc(100vw-0.75rem))] flex-col sm:w-[28rem]"
        >
          <SheetHeader className="border-b">
            <div className="flex items-center gap-2">
              <SheetTitle>{realDemoLogin ? 'Sign in as a demo role' : 'Preview a role'}</SheetTitle>
              <Badge variant="warning">Development only</Badge>
            </div>
            <SheetDescription>
              {realDemoLogin
                ? 'Switch to the selected seeded demo account and use its real permissions and data scope.'
                : 'Open any role dashboard with its navigation, scope label, and isolated preview data.'}
            </SheetDescription>
          </SheetHeader>

          {realDemoLogin ? (
            <div className="space-y-2 border-b px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Organization
              </p>
              <Tabs
                value={organizationKey}
                onValueChange={(value) =>
                  setOrganizationKey(value as DevelopmentDemoOrganizationKey)
                }
              >
                <TabsList className="flex h-auto w-full flex-wrap justify-start">
                  {developmentDemoOrganizations.map((row) => (
                    <TabsTrigger key={row.key} value={row.key} className="text-xs">
                      {row.label}
                      {row.key === sessionOrganization ? (
                        <span className="ml-1 size-1.5 rounded-full bg-blue-600" aria-hidden />
                      ) : null}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <p className="text-xs text-muted-foreground">{organization.state}</p>
            </div>
          ) : null}

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-6 p-4">
              {roleGroupOrder.map((group) => {
                const roles = roleKeys.filter(
                  (key) =>
                    roleNavigation[key].group === group &&
                    (!organizationRoles || organizationRoles.includes(key)),
                );
                if (!roles.length) return null;

                return (
                  <section key={group} aria-labelledby={`dev-role-group-${group}`}>
                    <h3
                      id={`dev-role-group-${group}`}
                      className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                    >
                      {group}
                    </h3>
                    <div className="space-y-1">
                      {roles.map((key) => {
                        const candidate = roleNavigation[key];
                        const active =
                          key === currentRoleKey &&
                          (!realDemoLogin ||
                            key === 'super-admin' ||
                            organizationKey === sessionOrganization);
                        const loading = switchingTo === key;

                        return (
                          <Button
                            key={key}
                            type="button"
                            variant="ghost"
                            onClick={() => switchRole(key)}
                            disabled={isSwitching}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                              'h-auto w-full justify-start gap-3 whitespace-normal px-3 py-2.5 text-left',
                              active && 'bg-blue-50 text-blue-800 hover:bg-blue-50',
                            )}
                          >
                            <span
                              className={cn(
                                'grid size-8 shrink-0 place-items-center rounded-lg border bg-background text-muted-foreground',
                                active && 'border-blue-200 bg-blue-100 text-blue-700',
                              )}
                            >
                              {loading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : active ? (
                                <Check className="size-4" />
                              ) : (
                                <ShieldUser className="size-4" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold">{candidate.label}</span>
                              <span className="block text-xs font-normal text-muted-foreground">
                                {candidate.scope}
                              </span>
                            </span>
                            {active ? <Badge variant="info">Active</Badge> : null}
                          </Button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </ScrollArea>

          <div className="border-t bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
            {realDemoLogin
              ? 'This uses a real Supabase session for the selected seeded demo account. Development login completes demo MFA automatically; actual permissions and RLS scope still apply.'
              : 'This simulates the selected role for local UI testing. It never changes a real account, role assignment, permission, or data scope.'}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
