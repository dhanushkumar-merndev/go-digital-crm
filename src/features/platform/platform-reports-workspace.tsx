'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Blocks, Building2, Download, PlugZap, Sparkles } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { SectionCard } from '@/components/shared/section-card';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Metric, PageSpec } from '@/lib/domain';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { fetchPlatformAiUsage } from './platform-ai-usage-workspace-api';
import { fetchPlatformDashboard } from './platform-dashboard-api';
import { fetchPlatformIntegrationWorkspace } from './platform-integration-workspace-api';
import { fetchPlatformModuleWorkspace } from './module-workspace-api';

type ReportView = 'ai-usage' | 'modules' | 'integrations';

const views: Array<{ value: ReportView; label: string }> = [
  { value: 'ai-usage', label: 'AI usage by dealership' },
  { value: 'modules', label: 'Module adoption' },
  { value: 'integrations', label: 'Integration health' },
];

/** Aggregate rows only (no customer data), so a CSV is built in the browser. */
function downloadCsv(name: string, header: string[], rows: Array<Array<string | number>>) {
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** call_transcription and CALL_TRANSCRIPTION read as one label: "Call transcription". */
function featureLabel(key: string) {
  const words = key.replaceAll('_', ' ').toLowerCase().trim();
  return words ? words[0]!.toUpperCase() + words.slice(1).replace(/\bai\b/g, 'AI') : 'Other';
}

const queryOptions = {
  staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
  gcTime: DASHBOARD_QUERY_GC_TIME_MS,
};

/**
 * Super Admin reports (PRD 54.10 §60): platform aggregates across dealerships.
 * The tenant export queue does not apply here; a Super Admin has no tenant.
 */
export function PlatformReportsWorkspace({ spec }: { spec: PageSpec }) {
  const [view, setView] = useState<ReportView>('ai-usage');
  const dashboard = useQuery({
    queryKey: ['platform-reports', 'dashboard'],
    queryFn: () => fetchPlatformDashboard(),
    ...queryOptions,
  });
  const aiUsage = useQuery({
    queryKey: ['platform-reports', 'ai-usage', 30],
    queryFn: ({ signal }) => fetchPlatformAiUsage({ days: 30, page: 1, search: '', signal }),
    ...queryOptions,
  });
  const modules = useQuery({
    queryKey: ['platform-reports', 'modules'],
    queryFn: ({ signal }) =>
      fetchPlatformModuleWorkspace({ page: 1, search: '', status: 'ALL', signal }),
    enabled: view === 'modules' || dashboard.isSuccess,
    ...queryOptions,
  });
  const integrations = useQuery({
    queryKey: ['platform-reports', 'integrations'],
    queryFn: ({ signal }) =>
      fetchPlatformIntegrationWorkspace({ page: 1, search: '', status: 'ALL', signal }),
    enabled: view === 'integrations' || dashboard.isSuccess,
    ...queryOptions,
  });
  const header = (
    <PageHeader
      spec={{ ...spec, primaryAction: undefined }}
      description="Platform usage across dealerships: AI credits, module adoption and provider health."
    />
  );

  if (dashboard.isPending || aiUsage.isPending)
    return (
      <PageShell>
        {header}
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </PageShell>
    );
  if (dashboard.isError || aiUsage.isError)
    return (
      <PageShell>
        {header}
        <ErrorState
          title="Platform reports are unavailable"
          description="Confirm your Super Admin session and MFA, then try again."
          onRetry={() => {
            void dashboard.refetch();
            void aiUsage.refetch();
          }}
        />
      </PageShell>
    );

  const metrics: Metric[] = [
    {
      label: 'Active dealerships',
      value: formatNumber(dashboard.data.kpis.active_dealerships),
      helper: `${formatNumber(dashboard.data.kpis.onboarding)} onboarding`,
      icon: Building2,
      tone: 'blue',
    },
    {
      label: 'AI credits used',
      value: formatNumber(aiUsage.data.kpis.used_period),
      helper: 'Last 30 days, all dealerships',
      icon: Sparkles,
      tone: 'violet',
    },
    {
      label: 'Active modules',
      value: modules.data ? formatNumber(modules.data.kpis.active_modules) : '—',
      helper: modules.data
        ? `${formatNumber(modules.data.kpis.enabled_entitlements)} tenant entitlements`
        : 'Module catalogue',
      icon: Blocks,
      tone: 'emerald',
    },
    {
      label: 'Providers needing attention',
      value: formatNumber(dashboard.data.kpis.provider_attention),
      helper: integrations.data
        ? `${formatNumber(integrations.data.kpis.total_connections)} connections`
        : 'Tenant connections',
      icon: PlugZap,
      tone: 'rose',
    },
  ];

  return (
    <PageShell>
      {header}
      <KpiGrid metrics={metrics} />
      <Tabs value={view} onValueChange={(next) => setView(next as ReportView)}>
        <TabsList>
          {views.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {view === 'ai-usage' ? <AiUsageReport data={aiUsage.data} /> : null}
      {view === 'modules' ? (
        modules.data ? (
          <ModuleReport data={modules.data} />
        ) : modules.isError ? (
          <ErrorState
            title="Module adoption is unavailable"
            onRetry={() => void modules.refetch()}
          />
        ) : (
          <Skeleton className="h-96" />
        )
      ) : null}
      {view === 'integrations' ? (
        integrations.data ? (
          <IntegrationReport data={integrations.data} />
        ) : integrations.isError ? (
          <ErrorState
            title="Integration health is unavailable"
            onRetry={() => void integrations.refetch()}
          />
        ) : (
          <Skeleton className="h-96" />
        )
      ) : null}
    </PageShell>
  );
}

function CsvButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Download className="size-4" />
      Download CSV
    </Button>
  );
}

function AiUsageReport({ data }: { data: Awaited<ReturnType<typeof fetchPlatformAiUsage>> }) {
  return (
    <div className="grid gap-4 xl:grid-cols-12">
      <SectionCard
        title="Daily AI credit use"
        description="All dealerships"
        className="xl:col-span-7"
      >
        <EChart kind="line" data={data.daily} seriesNames={['Credits used', '']} className="h-64" />
      </SectionCard>
      <SectionCard title="By feature" description="Last 30 days" className="xl:col-span-5">
        {data.features.length ? (
          <EChart
            kind="donut"
            data={data.features.map((row) => ({ name: featureLabel(row.name), value: row.value }))}
            className="h-64"
          />
        ) : (
          <p className="grid h-64 place-items-center text-sm text-muted-foreground">
            No AI usage in the period.
          </p>
        )}
      </SectionCard>
      <SectionCard
        title="Dealerships"
        description={`Credits used in the last 30 days (first ${formatNumber(data.organizations.length)} of ${formatNumber(data.total)})`}
        className="xl:col-span-12"
        flush
        contentClassName="overflow-x-auto"
        action={
          <CsvButton
            onClick={() =>
              downloadCsv(
                'platform-ai-usage-30-days',
                ['Dealership', 'Status', 'Credits used', 'Daily average', 'Balance'],
                data.organizations.map((row) => [
                  row.name,
                  row.status,
                  row.used_period,
                  row.daily_average,
                  row.balance,
                ]),
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dealership</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Credits used</TableHead>
              <TableHead className="text-right">Daily average</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.organizations.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell>
                  <StatusBadge value={row.status} />
                </TableCell>
                <TableCell className="text-right">{formatNumber(row.used_period)}</TableCell>
                <TableCell className="text-right">{row.daily_average.toFixed(1)}</TableCell>
                <TableCell className="text-right">{formatNumber(row.balance)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!data.organizations.length ? <EmptyState bare title="No dealerships yet" /> : null}
      </SectionCard>
    </div>
  );
}

function ModuleReport({
  data,
}: {
  data: Awaited<ReturnType<typeof fetchPlatformModuleWorkspace>>;
}) {
  return (
    <SectionCard
      title="Module adoption"
      description="Dealerships with each module enabled, and its use in the last 30 days"
      flush
      contentClassName="overflow-x-auto"
      action={
        <CsvButton
          onClick={() =>
            downloadCsv(
              'platform-module-adoption',
              ['Module', 'Active', 'Dealerships enabled', 'Dealerships', 'Plans', 'Use (30 days)'],
              data.records.map((row) => [
                row.name,
                row.active ? 'Yes' : 'No',
                row.enabled_tenant_count,
                row.tenant_count,
                row.plan_count,
                row.usage_last_30_days,
              ]),
            )
          }
        />
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Module</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Dealerships enabled</TableHead>
            <TableHead className="text-right">Plans</TableHead>
            <TableHead className="text-right">Use (30 days)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.records.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell>
                <StatusBadge value={row.active ? 'ACTIVE' : 'INACTIVE'} />
              </TableCell>
              <TableCell className="text-right">
                {formatNumber(row.enabled_tenant_count)} of {formatNumber(row.tenant_count)}
              </TableCell>
              <TableCell className="text-right">{formatNumber(row.plan_count)}</TableCell>
              <TableCell className="text-right">{formatNumber(row.usage_last_30_days)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function IntegrationReport({
  data,
}: {
  data: Awaited<ReturnType<typeof fetchPlatformIntegrationWorkspace>>;
}) {
  const overview = [
    { name: 'Healthy', value: data.status_overview.healthy },
    { name: 'Needs attention', value: data.status_overview.attention },
    { name: 'Pending', value: data.status_overview.pending },
  ].filter((row) => row.value > 0);
  return (
    <div className="grid gap-4 xl:grid-cols-12">
      <SectionCard
        title="Connection health"
        description="Every tenant connection"
        className="xl:col-span-4"
      >
        {overview.length ? (
          <EChart kind="donut" data={overview} className="h-64" />
        ) : (
          <p className="grid h-64 place-items-center text-sm text-muted-foreground">
            No connections yet.
          </p>
        )}
      </SectionCard>
      <SectionCard
        title="Connections"
        description={`Events and syncs in the last 30 days (first ${formatNumber(data.records.length)} of ${formatNumber(data.total)})`}
        className="xl:col-span-8"
        flush
        contentClassName="overflow-x-auto"
        action={
          <CsvButton
            onClick={() =>
              downloadCsv(
                'platform-integration-health',
                [
                  'Provider',
                  'Dealership',
                  'Status',
                  'Last sync',
                  'Events (30 days)',
                  'Syncs (30 days)',
                ],
                data.records.map((row) => [
                  row.display_name,
                  row.organization_name,
                  row.status,
                  row.last_sync_at ?? '',
                  row.events_last_30_days,
                  row.sync_runs_last_30_days,
                ]),
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Dealership</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last sync</TableHead>
              <TableHead className="text-right">Events</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.records.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.display_name}</TableCell>
                <TableCell className="text-xs">{row.organization_name}</TableCell>
                <TableCell>
                  <StatusBadge value={row.has_attention ? 'ATTENTION' : row.status} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.last_sync_at ? formatDateTime(row.last_sync_at) : 'Never'}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(row.events_last_30_days)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!data.records.length ? <EmptyState bare title="No connections yet" /> : null}
      </SectionCard>
    </div>
  );
}
