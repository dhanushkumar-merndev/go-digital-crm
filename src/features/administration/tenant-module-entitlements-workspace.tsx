'use client';

import { ErrorState } from '@/components/shared/page-states';
import { useQuery } from '@tanstack/react-query';
import { Blocks, CalendarClock, CheckCircle2, PackageX } from 'lucide-react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { TenantModuleEntitlementsSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Metric, PageSpec } from '@/lib/domain';
import { fetchTenantModuleEntitlementsWorkspace } from './tenant-module-entitlements-api';

function formatDate(value: string | null) {
  if (!value) return 'No expiry recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unavailable'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date);
}

function statusVariant(status: string) {
  if (status === 'ENABLED') return 'success' as const;
  if (status === 'EXPIRED') return 'destructive' as const;
  if (status === 'DISABLED') return 'secondary' as const;
  return 'outline' as const;
}

export function TenantModuleEntitlementsWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const query = useQuery({
    queryKey: ['tenant-module-entitlements', ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchTenantModuleEntitlementsWorkspace(signal),
    staleTime: 60_000,
  });

  if (query.isPending) return <TenantModuleEntitlementsSkeleton />;
  if (query.isError || !query.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="Module access is unavailable"
          description="This view requires organization-wide Client Admin access. Platform module changes remain restricted to Super Admin."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );

  const { kpis, records } = query.data;
  const metrics: Metric[] = [
    { label: 'Enabled modules', value: kpis.enabled.toLocaleString('en-IN'), icon: CheckCircle2 },
    {
      label: 'Expiring in 30 days',
      value: kpis.expiring_30_days.toLocaleString('en-IN'),
      icon: CalendarClock,
    },
    { label: 'Disabled', value: kpis.disabled.toLocaleString('en-IN'), icon: PackageX },
    { label: 'Not configured', value: kpis.not_configured.toLocaleString('en-IN'), icon: Blocks },
  ];

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <KpiGrid metrics={metrics} />
      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base">Tenant module entitlements</CardTitle>
          <CardDescription>
            Read-only entitlement status and recorded usage for this dealership. Contact the
            platform Super Admin to change a module package or entitlement.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Valid until</TableHead>
                <TableHead className="text-right">Recorded usage · 30 days</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <p className="font-medium">{record.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">{record.module_key}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(record.status)}>{record.status}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(record.valid_until)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {record.usage_last_30_days.toLocaleString('en-IN')}
                  </TableCell>
                </TableRow>
              ))}
              {!records.length ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-28 text-center text-sm text-muted-foreground">
                    No module catalog entries are available.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
