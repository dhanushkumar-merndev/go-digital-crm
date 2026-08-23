'use client';

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Cable,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  RadioTower,
  Search,
  Workflow,
} from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  fetchPlatformIntegrationWorkspace,
  type PlatformIntegrationStatus,
} from './platform-integration-workspace-api';

function pretty(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unavailable'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function PlatformIntegrationWorkspace({ spec }: { spec: PageSpec }) {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [status, setStatus] = useState<PlatformIntegrationStatus>('ALL');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['platform-integration-workspace', page, search, status],
    queryFn: ({ signal }) => fetchPlatformIntegrationWorkspace({ page, search, status, signal }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const result = query.data;
  const metrics: Metric[] = result
    ? [
        {
          label: 'Connections',
          value: result.kpis.total_connections.toLocaleString(),
          icon: Cable,
        },
        {
          label: 'Healthy',
          value: result.kpis.healthy_connections.toLocaleString(),
          icon: RadioTower,
        },
        {
          label: 'Needs attention',
          value: result.kpis.attention_connections.toLocaleString(),
          icon: CircleAlert,
        },
        {
          label: 'Provider events · 7d',
          value: result.kpis.events_last_7_days.toLocaleString(),
          icon: Workflow,
        },
        { label: 'Sync runs · 7d', value: result.kpis.sync_runs_last_7_days.toLocaleString() },
      ]
    : [];
  const hasNext = Boolean(result && page * 25 < result.total);

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div>
        <div className="mb-2 text-xs text-muted-foreground">Platform › Providers</div>
        <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Monitor tenant provider connections without exposing credentials or provider payloads.
        </p>
      </div>
      {query.isPending ? <PageSkeleton /> : null}
      {result ? <KpiGrid metrics={metrics} className="xl:grid-cols-5" /> : null}
      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-3 p-4 md:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
                setPage(1);
              }}
              className="pl-9"
              placeholder="Search provider, connection, or dealership"
              aria-label="Search platform integrations"
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as PlatformIntegrationStatus);
              setPage(1);
            }}
          >
            <SelectTrigger className="md:w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All connections</SelectItem>
              <SelectItem value="CONNECTED">Healthy</SelectItem>
              <SelectItem value="ATTENTION">Needs attention</SelectItem>
              <SelectItem value="PENDING">Pending setup</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
      {query.isError ? (
        <Card className="shadow-none">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Platform integration data is unavailable. Confirm Super Admin MFA access and deploy the
            platform integration migration.
          </CardContent>
        </Card>
      ) : null}
      {result ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Card className="overflow-hidden shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Tenant provider connections</CardTitle>
              <CardDescription>
                Server-side filters · newest connection activity first
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Dealership</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last sync</TableHead>
                    <TableHead>Events · 30d</TableHead>
                    <TableHead>Sync runs · 30d</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.records.map((connection) => (
                    <TableRow key={connection.id}>
                      <TableCell>
                        <p className="font-medium">{connection.display_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {pretty(connection.provider_key)}
                          {connection.external_account_hint
                            ? ` · ${connection.external_account_hint}`
                            : ''}
                        </p>
                      </TableCell>
                      <TableCell className="font-medium">{connection.organization_name}</TableCell>
                      <TableCell>{pretty(connection.scope_mode)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            connection.has_attention
                              ? 'destructive'
                              : connection.status === 'CONNECTED'
                                ? 'success'
                                : 'outline'
                          }
                        >
                          {connection.has_attention ? 'Attention' : pretty(connection.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(connection.last_sync_at)}
                      </TableCell>
                      <TableCell>{connection.events_last_30_days.toLocaleString()}</TableCell>
                      <TableCell>{connection.sync_runs_last_30_days.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                  {!result.records.length ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        No provider connections match these server-side filters.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
            <CardContent className="flex items-center justify-between border-t py-3">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1 || query.isFetching}
                onClick={() => setPage((current) => current - 1)}
              >
                <ChevronLeft className="size-4" /> Previous
              </Button>
              <p className="text-xs text-muted-foreground">
                Page {page} · {result.total} connections
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext || query.isFetching}
                onClick={() => setPage((current) => current + 1)}
              >
                Next <ChevronRight className="size-4" />
              </Button>
            </CardContent>
          </Card>
          <Card className="h-fit shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Connection status</CardTitle>
              <CardDescription>Current platform-visible connection health</CardDescription>
            </CardHeader>
            <CardContent>
              <EChart
                kind="donut"
                data={[
                  { name: 'Healthy', value: result.status_overview.healthy },
                  { name: 'Attention', value: result.status_overview.attention },
                  { name: 'Pending', value: result.status_overview.pending },
                ]}
                className="h-60"
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
