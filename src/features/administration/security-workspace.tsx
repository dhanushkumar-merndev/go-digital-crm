'use client';

import { KpiGrid } from '@/components/shared/kpi-grid';
import { humanizeEnum } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
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

// Role keys and scopes arrive as `client_admin` / `ALL_BRANCHES`; show them as words.
function readable(value: string | null | undefined) {
  return value ? humanizeEnum(value.replace(/-/g, '_').toUpperCase()) : 'Unavailable';
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
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description="Sign-in security for your session and recent security activity. It does not claim external monitoring, backups, or threat detection."
      />
      <KpiGrid
        metrics={[
          {
            label: 'MFA assurance',
            value: mfaVerified ? 'Verified' : 'Needs attention',
            helper: `Current session: ${assurance.currentLevel.toUpperCase()}`,
            icon: ShieldCheck,
            tone: mfaVerified ? 'emerald' : 'rose',
          },
          {
            label: 'Role',
            value: readable(context.role_key ?? session?.roleKey),
            helper: 'Authenticated route role',
            icon: KeyRound,
            tone: 'blue',
          },
          {
            label: 'Data scope',
            value: readable(context.data_scope ?? session?.dataScope),
            helper: 'Access remains RLS enforced',
            icon: UserRoundCheck,
            tone: 'violet',
          },
          {
            label: 'Tenant status',
            value: readable(context.tenant_status ?? 'PLATFORM'),
            helper: `Access destination: ${readable(context.destination)}`,
            icon: ShieldEllipsis,
            tone: 'amber',
          },
        ]}
      />
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
