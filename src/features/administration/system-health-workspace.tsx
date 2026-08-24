'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Cable, CircleAlert, RefreshCw, Workflow } from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { SystemHealthSkeleton } from '@/components/skeletons';
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
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import type { Metric, PageSpec } from '@/lib/domain';
import { fetchSystemHealthWorkspace } from './system-health-workspace-api';

function formatTime(value: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function attentionVariant(status: string, safeCode: string | null) {
  return status === 'ERROR' || status === 'DISCONNECTED' || safeCode ? 'destructive' : 'secondary';
}

export function SystemHealthWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const query = useQuery({
    queryKey: ['system-health-workspace', ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchSystemHealthWorkspace(signal),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    { resource: 'integrations', queryKeys: [['system-health-workspace']] },
  ]);

  if (query.isPending) return <SystemHealthSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          System health signals are unavailable. Confirm your System Administrator role, MFA
          assurance, and the deployed health workspace migration.
        </CardContent>
      </Card>
    );

  const data = query.data;
  const metrics: Metric[] = [
    {
      label: 'Visible connections',
      value: data.kpis.visible_connections.toLocaleString(),
      icon: Cable,
    },
    {
      label: 'Need attention',
      value: data.kpis.attention_connections.toLocaleString(),
      icon: CircleAlert,
    },
    { label: 'Sync runs · 24h', value: data.kpis.sync_runs_24h.toLocaleString(), icon: Workflow },
    {
      label: 'Failed syncs · 24h',
      value: data.kpis.failed_syncs_24h.toLocaleString(),
      icon: Activity,
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">Administration › System health</div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Recorded provider connection and sync signals in your allowed branch scope. This view
            does not claim external uptime, latency, backups, or tenant-wide error monitoring.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw className="size-4" /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">
          {data.scope.organization_wide ? 'Organization-wide scope' : 'Branch-scoped view'}
        </Badge>
        <span>{data.scope.accessible_branches.toLocaleString()} accessible branches</span>
        <span>Updated {formatTime(data.generated_at)}</span>
      </div>

      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />

      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <Card className="overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Provider summary</CardTitle>
            <CardDescription>
              Connection status and recorded sync activity for the last 7 days.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Connections</TableHead>
                  <TableHead>Attention</TableHead>
                  <TableHead>Syncs · 7d</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.provider_summary.map((provider) => (
                  <TableRow key={provider.provider_key}>
                    <TableCell className="font-medium">{provider.provider_key}</TableCell>
                    <TableCell>{provider.connections.toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge variant={provider.attention_connections ? 'destructive' : 'success'}>
                        {provider.attention_connections}
                      </Badge>
                    </TableCell>
                    <TableCell>{provider.sync_runs_7d.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {!data.provider_summary.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No provider connections are available in your current scope.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Connections requiring attention</CardTitle>
            <CardDescription>
              Credentials, payloads, and unscoped tenant errors are never shown.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Connection</TableHead>
                  <TableHead>Visible branches</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sync</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.attention_connections.map((connection) => (
                  <TableRow key={connection.id}>
                    <TableCell>
                      <p className="font-medium">{connection.display_name}</p>
                      <p className="text-xs text-muted-foreground">{connection.provider_key}</p>
                    </TableCell>
                    <TableCell className="max-w-48 text-xs text-muted-foreground">
                      {connection.visible_branch_names.join(', ') ||
                        (connection.scope_mode === 'ALL_BRANCHES'
                          ? 'Available across accessible branches'
                          : 'No mapped branch visible')}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={attentionVariant(connection.status, connection.last_error_code)}
                      >
                        {connection.last_error_code ?? connection.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTime(connection.last_sync_at)}
                    </TableCell>
                  </TableRow>
                ))}
                {!data.attention_connections.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No visible provider connection currently requires attention.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Recent recorded sync runs</CardTitle>
          <CardDescription>
            Most recent 25 sync runs for provider connections visible to you.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Connection</TableHead>
                <TableHead>Sync type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Records</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recent_sync_runs.map((syncRun) => (
                <TableRow key={syncRun.id}>
                  <TableCell>
                    <p className="font-medium">{syncRun.display_name}</p>
                    <p className="text-xs text-muted-foreground">{syncRun.provider_key}</p>
                  </TableCell>
                  <TableCell>{syncRun.sync_type}</TableCell>
                  <TableCell>
                    <Badge variant={attentionVariant(syncRun.status, null)}>{syncRun.status}</Badge>
                  </TableCell>
                  <TableCell>{syncRun.records_processed.toLocaleString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTime(syncRun.started_at)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTime(syncRun.completed_at)}
                  </TableCell>
                </TableRow>
              ))}
              {!data.recent_sync_runs.length ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No sync runs have been recorded for visible connections.
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
