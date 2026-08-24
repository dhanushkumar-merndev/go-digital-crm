'use client';

import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  ShieldCheck,
  ShieldEllipsis,
  UserRoundCheck,
} from 'lucide-react';
import { SecurityWorkspaceSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import type { PageSpec } from '@/lib/domain';
import { fetchSecurityPosture } from './security-workspace-api';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

export function SecurityWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const query = useQuery({
    queryKey: ['security-posture', ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchSecurityPosture(signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <SecurityWorkspaceSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="shadow-none">
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Security posture could not be loaded for this authenticated session.
        </CardContent>
      </Card>
    );
  const { context, assurance } = query.data;
  const mfaVerified = context.mfa_satisfied && assurance.currentLevel === 'aal2';
  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <div>
        <div className="mb-2 text-xs text-muted-foreground">Administration › Security</div>
        <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Current authenticated-session posture and immutable security-related activity. It does not
          claim external monitoring, backups, or threat detection.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="shadow-none">
          <CardContent className="p-5">
            <ShieldCheck className="size-5 text-emerald-600" />
            <p className="mt-4 text-sm font-medium">MFA assurance</p>
            <p className="mt-1 text-lg font-bold">{mfaVerified ? 'Verified' : 'Needs attention'}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Current session: {assurance.currentLevel.toUpperCase()}
            </p>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardContent className="p-5">
            <KeyRound className="size-5 text-blue-600" />
            <p className="mt-4 text-sm font-medium">Role</p>
            <p className="mt-1 text-lg font-bold">
              {context.role_key ?? session?.roleKey ?? 'Unavailable'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Authenticated route role</p>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardContent className="p-5">
            <UserRoundCheck className="size-5 text-violet-600" />
            <p className="mt-4 text-sm font-medium">Data scope</p>
            <p className="mt-1 text-lg font-bold">
              {context.data_scope ?? session?.dataScope ?? 'Unavailable'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Access remains RLS enforced</p>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardContent className="p-5">
            <ShieldEllipsis className="size-5 text-amber-600" />
            <p className="mt-4 text-sm font-medium">Tenant status</p>
            <p className="mt-1 text-lg font-bold">{context.tenant_status ?? 'Platform'}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Access destination: {context.destination}
            </p>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Access controls in effect</CardTitle>
            <CardDescription>
              These are the current evaluated controls, not configurable settings on this page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              {
                label: 'Privileged MFA policy',
                value: context.mfa_required ? 'Required' : 'Not required',
                ok: mfaVerified || !context.mfa_required,
              },
              {
                label: 'MFA session level',
                value: assurance.currentLevel.toUpperCase(),
                ok: assurance.currentLevel === 'aal2',
              },
              {
                label: 'Support maintenance controller',
                value: context.support_controller ? 'Authorized' : 'Not active',
                ok: true,
              },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex items-center gap-2">
                  <span className={item.ok ? 'text-emerald-600' : 'text-amber-600'}>
                    {item.ok ? (
                      <CheckCircle2 className="size-4" />
                    ) : (
                      <CircleAlert className="size-4" />
                    )}
                  </span>
                  <span className="text-sm font-medium">{item.label}</span>
                </div>
                <Badge variant={item.ok ? 'success' : 'secondary'}>{item.value}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Recent authorized audit activity</CardTitle>
            <CardDescription>
              Newest records visible within your audit-log permission and scope.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {query.data.auditEvents.length ? (
              query.data.auditEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex items-start justify-between gap-3 border-b pb-3 last:border-0 last:pb-0"
                >
                  <div>
                    <p className="text-sm font-medium">{event.action}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{event.resource_type}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(event.created_at)}
                  </span>
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No audit records are available in your current scope.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
