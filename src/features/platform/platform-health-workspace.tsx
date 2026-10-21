'use client';

import { ErrorState } from '@/components/shared/page-states';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { useQuery } from '@tanstack/react-query';
import { Activity, Building2, Cable, CircleAlert, RefreshCw, Workflow } from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PlatformHealthSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { fetchPlatformHealth } from './platform-health-workspace-api';

function time(value: string | null) {
  if (!value) return 'No recorded error';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unavailable'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function PlatformHealthWorkspace({ spec }: { spec: PageSpec }) {
  const query = useQuery({
    queryKey: ['platform-health-workspace'],
    queryFn: ({ signal }) => fetchPlatformHealth(signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <PlatformHealthSkeleton />;
  if (query.isError || !query.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          description="Platform health signals are unavailable. Confirm Super Admin MFA access and deploy the platform health migration."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );
  const data = query.data;
  const metrics: Metric[] = [
    {
      label: 'Active tenants',
      value: data.kpis.active_tenants.toLocaleString('en-IN'),
      icon: Building2,
    },
    {
      label: 'Provider connections',
      value: data.kpis.provider_connections.toLocaleString('en-IN'),
      icon: Cable,
    },
    {
      label: 'Sync runs · 24h',
      value: data.kpis.sync_runs_24h.toLocaleString('en-IN'),
      icon: Workflow,
    },
    {
      label: 'Provider attention',
      value: data.kpis.provider_attention.toLocaleString('en-IN'),
      icon: CircleAlert,
    },
    {
      label: 'Recorded errors · 24h',
      value: data.kpis.errors_24h.toLocaleString('en-IN'),
      icon: Activity,
    },
  ];
  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description="Provider, sync and error signals recorded by the CRM across every dealership. External uptime or latency is not claimed without a monitoring source."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw className="size-4" /> Refresh
            </Button>
          </>
        }
      />
      <KpiGrid metrics={metrics} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Service error signals</CardTitle>
            <CardDescription>Last 30 days; error count is for the last 24 hours.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Errors · 24h</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead>Safe code</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.services.map((service) => (
                  <TableRow key={service.service}>
                    <TableCell className="font-medium">{service.service}</TableCell>
                    <TableCell>
                      <Badge variant={service.errors_24h ? 'destructive' : 'success'}>
                        {service.errors_24h}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {time(service.last_error_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {service.last_safe_code ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
                {!data.services.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No sanitized error signals have been recorded.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card className="overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Provider connections requiring attention</CardTitle>
            <CardDescription>
              Connection-level status only; credentials and payloads stay hidden.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Connection</TableHead>
                  <TableHead>Dealership</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sync</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.provider_attention.map((connection) => (
                  <TableRow key={connection.id}>
                    <TableCell>
                      <p className="font-medium">{connection.display_name}</p>
                      <p className="text-xs text-muted-foreground">{connection.provider_key}</p>
                    </TableCell>
                    <TableCell>{connection.organization_name}</TableCell>
                    <TableCell>
                      <Badge variant="destructive">
                        {connection.last_error_code ?? connection.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {time(connection.last_sync_at)}
                    </TableCell>
                  </TableRow>
                ))}
                {!data.provider_attention.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No provider connection requires attention.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
