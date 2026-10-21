'use client';

import { ArrowRightLeft, CircleOff, UsersRound } from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardList, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { EChart } from '@/components/charts/e-chart';
import { PageHeader } from '@/components/shared/page-header';
import { TenantDashboardSkeleton } from '@/components/skeletons/dashboard-skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PageSpec } from '@/lib/domain';
import { fetchTenantTargetConfiguration } from '@/features/administration/tenant-target-configuration-api';
import {
  AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { usePersistedQuery } from '@/lib/query/persisted-query';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { performanceRangeForLastDays } from '@/lib/performance-date-range';
import { SalesHandoffReport } from './sales-handoff-report';
import {
  businessOperationsKey,
  businessOperationsSchema,
  businessSalesOverviewKey,
  businessSalesOverviewSchema,
  businessShowroomAnalyticsKey,
  businessShowroomAnalyticsSchema,
  fetchBusinessOperationsOverview,
  fetchBusinessSalesOverview,
  fetchBusinessShowroomAnalytics,
} from './business-overview-api';

const windowChoices = [7, 30, 90] as const;

function Unavailable({ what }: { what: string }) {
  return (
    <Alert>
      <AlertTitle>{what} is unavailable</AlertTitle>
      <AlertDescription>
        Confirm your assigned data scope, then refresh. If this persists, the overview migration may
        not be deployed.
      </AlertDescription>
    </Alert>
  );
}

/** A proportion bar. The number stays readable; the bar carries the comparison. */
function ShareBar({ value, of }: { value: number; of: number }) {
  const share = of > 0 ? Math.round((value / of) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-blue-600" style={{ width: `${share}%` }} />
      </div>
      <span className="w-9 text-xs tabular-nums text-muted-foreground">{share}%</span>
    </div>
  );
}

function WindowPicker({ days, onChange }: { days: number; onChange: (value: number) => void }) {
  return (
    <Select value={String(days)} onValueChange={(value) => onChange(Number(value))}>
      <SelectTrigger className="w-40" aria-label="Reporting window">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {windowChoices.map((choice) => (
          <SelectItem key={choice} value={String(choice)}>
            Last {choice} days
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function BusinessSalesOverview({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [days, setDays] = useState<number>(30);
  const overview = usePersistedQuery({
    queryKey: businessSalesOverviewKey(workspaceQueryScope(session), days),
    queryFn: ({ signal }) => fetchBusinessSalesOverview(days, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: businessSalesOverviewSchema },
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    {
      resource: 'leads',
      queryKeys: [['business-sales-overview', ...workspaceQueryScope(session)]],
      minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
    },
  ]);
  if (overview.isPending) return <TenantDashboardSkeleton role="business-owner" />;
  if (overview.isError) return <Unavailable what="Sales overview" />;
  const data = overview.data;
  const totals = data?.totals;
  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        actions={<WindowPicker days={days} onChange={setDays} />}
      />
      <KpiGrid
        metrics={[
          {
            label: 'Leads created',
            value: formatNumber(totals?.leads ?? 0),
            helper: `In the last ${days} days`,
            icon: UsersRound,
            tone: 'blue',
          },
          {
            label: 'Moved to sales',
            value: formatNumber(totals?.transferred ?? 0),
            helper: 'Handed to a Sales Consultant',
            icon: ArrowRightLeft,
            tone: 'emerald',
          },
          {
            label: 'Conversion to sales',
            value: formatPercent(percent(totals?.transferred ?? 0, totals?.leads ?? 0)),
            helper: 'Moved to sales of leads created',
            icon: TrendingUp,
            tone: 'cyan',
          },
          {
            label: 'Lost',
            value: formatNumber(totals?.lost ?? 0),
            helper: `${formatPercent(percent(totals?.lost ?? 0, totals?.leads ?? 0))} of leads created`,
            icon: CircleOff,
            tone: 'rose',
          },
        ]}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="size-4 text-blue-600" /> Pipeline by stage
            </CardTitle>
            <CardDescription>Where leads created in this window currently sit.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.pipeline.length ? (
                  data.pipeline.map((row) => (
                    <TableRow key={row.stage}>
                      <TableCell>
                        <StatusBadge value={row.stage} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.leads}</TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <ShareBar value={row.leads} of={totals?.leads ?? 0} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                      No leads created in this window.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Lead sources</CardTitle>
            <CardDescription>Which channels produced this window&apos;s leads.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.sources.length ? (
                  data.sources.map((row) => (
                    <TableRow key={row.source}>
                      <TableCell className="font-medium">{row.source}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.leads}</TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <ShareBar value={row.leads} of={totals?.leads ?? 0} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                      No sources to report yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Consultant activity</CardTitle>
          <CardDescription>
            Top ten by lead volume, with how many each moved through to sales.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Consultant</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Moved to sales</TableHead>
                <TableHead className="text-right">Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.consultants.length ? (
                data.consultants.map((row) => (
                  <TableRow key={row.name}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.leads}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.won}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <ShareBar value={row.won} of={row.leads} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No consultant activity in this window.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

const allShowrooms = 'all';

// One row per department count, so five departments sit 5-across instead of
// three over two; at two columns an odd last card spans the row.
const departmentColumns: Record<number, string> = {
  1: '',
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-2 xl:grid-cols-4',
  5: 'md:grid-cols-2 xl:grid-cols-5 md:[&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1',
  6: 'md:grid-cols-3',
};

function percent(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** Rupees in the Indian grouping the owner reads: crore, then lakh. */
function formatRupees(value: number) {
  if (value >= 1e7) return `₹${(value / 1e7).toFixed(2)} Cr`;
  if (value >= 1e5) return `₹${(value / 1e5).toFixed(1)} L`;
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

function formatMinutes(value: number | null) {
  if (value === null) return '—';
  if (value < 60) return `${value}m`;
  if (value < 1440) return `${Math.floor(value / 60)}h ${value % 60}m`;
  return `${Math.floor(value / 1440)}d ${Math.floor((value % 1440) / 60)}h`;
}

const toLakh = (value: number) => Math.round(value / 1e3) / 100;
const temperatureOrder = ['HOT', 'WARM', 'COLD', 'DORMANT', 'UNRATED'] as const;

function ChartCard({
  title,
  description,
  empty,
  children,
}: {
  title: string;
  description: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
            No activity in this window.
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Per-model unit targets for one showroom. Reuses the Client Admin target RPC
 * (read-only for the Business Owner) so model matching lives in one place.
 */
function ModelTargetCard({
  branchId,
  branchName,
  month,
}: {
  branchId: string | null;
  branchName: string | undefined;
  month: string;
}) {
  const session = useWorkspaceSession();
  const monthKey = month.slice(0, 7);
  const models = useQuery({
    queryKey: ['business-model-targets', ...workspaceQueryScope(session), monthKey, branchId],
    queryFn: ({ signal }) =>
      fetchTenantTargetConfiguration({
        month: monthKey,
        branchId,
        search: '',
        page: 1,
        pageSize: 100,
        signal,
      }),
    enabled: Boolean(branchId),
    staleTime: 60_000,
  });
  const rows = useMemo(
    () =>
      (models.data?.records ?? [])
        .filter((row) => row.target_units > 0 || row.booked_units > 0)
        .sort((left, right) => right.target_units - left.target_units)
        .slice(0, 12)
        .map((row) => ({ name: row.name, value: row.booked_units, secondary: row.target_units })),
    [models.data],
  );
  const body = !branchId
    ? 'Select a showroom above to see its target and bookings for each model.'
    : models.isPending
      ? 'Loading model targets…'
      : models.isError
        ? 'Model targets could not be loaded. Model targets need an organisation-wide owner session with MFA.'
        : !rows.length
          ? 'No model targets or matched bookings for this showroom this month.'
          : null;
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Model targets{branchName ? ` — ${branchName}` : ''}
        </CardTitle>
        <CardDescription>Booked units against the unit target for each model.</CardDescription>
      </CardHeader>
      <CardContent>
        {body ? (
          <div className="flex h-72 items-center justify-center text-center text-sm text-muted-foreground">
            {body}
          </div>
        ) : (
          <EChart kind="bar" data={rows} seriesNames={['Booked', 'Target']} />
        )}
      </CardContent>
    </Card>
  );
}

export function BusinessShowroomPerformance({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const scope = workspaceQueryScope(session);
  const [days, setDays] = useState<number>(30);
  const [branchId, setBranchId] = useState<string | null>(null);
  // The handoff report shares this page's window and showroom selection.
  const handoffRange = useMemo(() => performanceRangeForLastDays(days), [days]);
  const analytics = usePersistedQuery({
    queryKey: businessShowroomAnalyticsKey(scope, days, branchId),
    queryFn: ({ signal }) => fetchBusinessShowroomAnalytics(days, branchId, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    // A new window or showroom is a new key; keep the page mounted meanwhile.
    placeholderData: keepPreviousData,
    persist: { version: 1, schema: businessShowroomAnalyticsSchema },
  });
  useTenantRealtimeInvalidation(
    session?.organizationId,
    (['leads', 'work', 'sales', 'operations'] as const).map((resource) => ({
      resource,
      queryKeys: [['business-showroom-analytics', ...scope]],
      minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
    })),
  );
  const data = analytics.data;
  const charts = useMemo(() => {
    if (!data) return null;
    const branches = data.per_branch;
    const names = branches.map((branch) => ({ name: branch.branch, value: 0 }));
    const totals = data.focus.totals;
    const sourceNames = [
      ...new Set(branches.flatMap((branch) => Object.keys(branch.sources))),
    ].sort();
    return {
      names,
      funnel: [
        { name: 'Leads', value: totals.leads },
        { name: 'Contacted', value: totals.contacted },
        { name: 'Moved to sales', value: totals.moved_to_sales },
        { name: 'Test drives', value: totals.test_drives },
        { name: 'Quotations', value: totals.quotations },
        { name: 'Bookings', value: totals.bookings },
        { name: 'Delivered', value: totals.delivered },
      ],
      daily: data.focus.daily.map((row) => ({
        name: new Date(`${row.day}T00:00:00`).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
        }),
        value: row.leads,
        secondary: row.bookings,
      })),
      pipeline: [
        { name: 'Leads', values: branches.map((branch) => branch.leads) },
        { name: 'Contacted', values: branches.map((branch) => branch.contacted) },
        { name: 'Moved to sales', values: branches.map((branch) => branch.moved_to_sales) },
        { name: 'Test drives', values: branches.map((branch) => branch.test_drives) },
        { name: 'Quotations', values: branches.map((branch) => branch.quotations) },
        { name: 'Bookings', values: branches.map((branch) => branch.bookings) },
        { name: 'Delivered', values: branches.map((branch) => branch.delivered) },
      ],
      rates: [
        {
          name: 'Contact %',
          values: branches.map((branch) => percent(branch.contacted, branch.leads)),
        },
        {
          name: 'Lead → booking %',
          values: branches.map((branch) => percent(branch.bookings, branch.leads)),
        },
        { name: 'Lost %', values: branches.map((branch) => percent(branch.lost, branch.leads)) },
      ],
      leadConversion: branches.map((branch) => ({
        name: branch.branch,
        value: percent(branch.bookings, branch.leads),
      })),
      driveConversion: branches.map((branch) => ({
        name: branch.branch,
        value: percent(branch.bookings, branch.test_drives),
      })),
      bookingValue: branches.map((branch) => ({
        name: branch.branch,
        value: toLakh(branch.booking_value),
      })),
      sources: data.focus.sources.map((row) => ({ name: row.name, value: row.leads })),
      sourceMix: sourceNames.map((source) => ({
        name: source,
        values: branches.map((branch) => branch.sources[source] ?? 0),
      })),
      bookingSources: data.focus.booking_sources.map((row) => ({
        name: row.name,
        value: row.bookings,
      })),
      models: data.focus.models.map((row) => ({ name: row.name, value: row.leads })),
      temperatureMix: temperatureOrder.map((temperature) => ({
        name: temperature === 'UNRATED' ? 'Not rated' : temperature,
        values: branches.map((branch) => branch.temperatures[temperature] ?? 0),
      })),
      calls: branches.map((branch) => ({
        name: branch.branch,
        value: branch.calls,
        secondary: branch.connected_calls,
      })),
      response: branches.map((branch) => ({
        name: branch.branch,
        value: branch.response_minutes ?? 0,
      })),
      bookingTargets: data.targets.map((row) => ({
        name: row.branch,
        value: row.bookings,
        secondary: row.unit_target,
      })),
      attainment: data.targets
        .filter((row) => row.unit_target > 0)
        .map((row) => ({ name: row.branch, value: percent(row.bookings, row.unit_target) })),
      hasTargets: data.targets.some((row) => row.unit_target > 0),
      lostReasons: data.focus.lost_reasons.map((row) => ({ name: row.name, value: row.leads })),
      delivery: [
        { name: 'Delivered', values: branches.map((branch) => branch.delivered) },
        { name: 'Pending delivery', values: branches.map((branch) => branch.pending_delivery) },
      ],
    };
  }, [data]);

  if (analytics.isPending) return <TenantDashboardSkeleton role="business-owner" />;
  if (analytics.isError || !data || !charts) return <Unavailable what="Showroom performance" />;
  const totals = data.focus.totals;
  const selectedName = data.per_branch.find((branch) => branch.branch_id === branchId)?.branch;
  const focusLabel = selectedName ?? 'All showrooms';
  const monthLabel = new Date(`${data.month}T00:00:00`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
  const zero = (rows: { value: number }[]) => rows.every((row) => row.value === 0);
  const zeroSeries = (rows: { values: number[] }[]) =>
    rows.every((row) => row.values.every((value) => value === 0));
  const kpis: [string, string][] = [
    ['Leads', String(totals.leads)],
    ['Contact rate', `${percent(totals.contacted, totals.leads)}%`],
    ['Moved to sales', String(totals.moved_to_sales)],
    ['Test drives', String(totals.test_drives)],
    ['Quotations', String(totals.quotations)],
    ['Bookings', String(totals.bookings)],
    ['Booking value', formatRupees(totals.booking_value)],
    ['Delivered', String(totals.delivered)],
    ['Lead → booking', `${percent(totals.bookings, totals.leads)}%`],
    ['Lost', `${percent(totals.lost, totals.leads)}%`],
    ['First response', formatMinutes(totals.response_minutes)],
    ['Calls connected', `${percent(totals.connected_calls, totals.calls)}%`],
  ];

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        actions={
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={branchId ?? allShowrooms}
                onValueChange={(value) => setBranchId(value === allShowrooms ? null : value)}
              >
                <SelectTrigger className="w-56" aria-label="Showroom">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={allShowrooms}>All showrooms</SelectItem>
                  {data.per_branch.map((branch) => (
                    <SelectItem key={branch.branch_id} value={branch.branch_id}>
                      {branch.branch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <WindowPicker days={days} onChange={setDays} />
            </div>
          </>
        }
      />

      <KpiGrid
        className={analytics.isPlaceholderData ? 'opacity-60' : undefined}
        metrics={kpis.map(([label, value]) => ({ label, value: String(value) }))}
      />
      <p className="text-xs text-muted-foreground">
        Cards and single-showroom charts show <span className="font-medium">{focusLabel}</span> for
        the last {data.window_days} days. Showroom-by-showroom charts always compare every showroom
        in your scope.
      </p>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="conversion">Conversion</TabsTrigger>
          <TabsTrigger value="sources">Lead sources</TabsTrigger>
          <TabsTrigger value="demand">Models & demand</TabsTrigger>
          <TabsTrigger value="calls">Calls & response</TabsTrigger>
          <TabsTrigger value="targets">Targets</TabsTrigger>
          <TabsTrigger value="lost">Lost & delivery</TabsTrigger>
          <TabsTrigger value="handoffs">Sales handoffs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid gap-5 lg:grid-cols-2">
          <ChartCard
            title="Sales funnel"
            description={`${focusLabel}: from enquiry to delivered car.`}
            empty={zero(charts.funnel)}
          >
            <EChart
              kind="funnel"
              data={charts.funnel}
              funnelMode="staged"
              funnelStages={7}
              funnelLabels="side"
            />
          </ChartCard>
          <ChartCard
            title="Daily leads and bookings"
            description={`${focusLabel}: new enquiries against new bookings each day.`}
            empty={charts.daily.every((row) => row.value === 0 && row.secondary === 0)}
          >
            <EChart kind="line" data={charts.daily} seriesNames={['Leads', 'Bookings']} />
          </ChartCard>
          <div className="lg:col-span-2">
            <ChartCard
              title="Pipeline by showroom"
              description="Every stage from lead to delivery, side by side for each showroom."
              empty={zeroSeries(charts.pipeline)}
            >
              <EChart kind="bar" data={charts.names} series={charts.pipeline} className="h-80" />
            </ChartCard>
          </div>
        </TabsContent>

        <TabsContent value="conversion" className="grid gap-5 lg:grid-cols-2">
          <ChartCard
            title="Lead → booking conversion (%)"
            description="Bookings as a share of new leads, per showroom."
            empty={zero(charts.leadConversion)}
          >
            <EChart kind="bar" data={charts.leadConversion} seriesNames={['Conversion %', '']} />
          </ChartCard>
          <ChartCard
            title="Test drive → booking conversion (%)"
            description="How often a test drive turns into a booking."
            empty={zero(charts.driveConversion)}
          >
            <EChart kind="bar" data={charts.driveConversion} seriesNames={['Conversion %', '']} />
          </ChartCard>
          <ChartCard
            title="Contact, conversion and lost rate (%)"
            description="Share of each showroom's new leads that were contacted, booked or lost."
            empty={zeroSeries(charts.rates)}
          >
            <EChart kind="bar" data={charts.names} series={charts.rates} />
          </ChartCard>
          <ChartCard
            title="Booking value by showroom (₹ lakh)"
            description="Total value of non-cancelled bookings made in the window."
            empty={zero(charts.bookingValue)}
          >
            <EChart kind="bar" data={charts.bookingValue} seriesNames={['₹ lakh', '']} />
          </ChartCard>
        </TabsContent>

        <TabsContent value="sources" className="grid gap-5 lg:grid-cols-2">
          <ChartCard
            title="Lead source share"
            description={`${focusLabel}: where new enquiries came from.`}
            empty={zero(charts.sources)}
          >
            <EChart kind="donut" data={charts.sources} />
          </ChartCard>
          <ChartCard
            title="Bookings by lead source"
            description={`${focusLabel}: which sources actually turn into bookings.`}
            empty={zero(charts.bookingSources)}
          >
            <EChart kind="bar" data={charts.bookingSources} seriesNames={['Bookings', '']} />
          </ChartCard>
          <div className="lg:col-span-2">
            <ChartCard
              title="Source mix by showroom"
              description="Each showroom's leads split by source."
              empty={zeroSeries(charts.sourceMix)}
            >
              <EChart kind="bar" data={charts.names} series={charts.sourceMix} stacked />
            </ChartCard>
          </div>
        </TabsContent>

        <TabsContent value="demand" className="grid gap-5 lg:grid-cols-2">
          <ChartCard
            title="Top interested models"
            description={`${focusLabel}: the eight most-asked-for models.`}
            empty={zero(charts.models)}
          >
            <EChart kind="bar" data={charts.models} seriesNames={['Leads', '']} />
          </ChartCard>
          <ChartCard
            title="Lead temperature by showroom"
            description="Buying intent set by the consultant or telecaller."
            empty={zeroSeries(charts.temperatureMix)}
          >
            <EChart kind="bar" data={charts.names} series={charts.temperatureMix} stacked />
          </ChartCard>
        </TabsContent>

        <TabsContent value="calls" className="grid gap-5 lg:grid-cols-2">
          <ChartCard
            title="Calls and connected calls"
            description="Every call made from each showroom, and how many connected."
            empty={charts.calls.every((row) => row.value === 0)}
          >
            <EChart kind="bar" data={charts.calls} seriesNames={['Calls', 'Connected']} />
          </ChartCard>
          <ChartCard
            title="Average first response (minutes)"
            description="Time from a lead arriving to its first contact."
            empty={zero(charts.response)}
          >
            <EChart kind="bar" data={charts.response} seriesNames={['Minutes', '']} />
          </ChartCard>
        </TabsContent>

        <TabsContent value="targets" className="grid gap-5 lg:grid-cols-2">
          {charts.hasTargets ? (
            <>
              <ChartCard
                title="Bookings vs unit target"
                description={`${monthLabel}, month to date. Targets are the model unit targets set for each showroom.`}
                empty={false}
              >
                <EChart
                  kind="bar"
                  data={charts.bookingTargets}
                  seriesNames={['Booked', 'Target']}
                />
              </ChartCard>
              <ChartCard
                title="Target attainment (%)"
                description={`${monthLabel}, India time. Showrooms without a target are left out.`}
                empty={false}
              >
                <EChart kind="bar" data={charts.attainment} seriesNames={['Attainment %', '']} />
              </ChartCard>
            </>
          ) : (
            <Card className="shadow-none">
              <CardContent className="flex h-full min-h-72 items-center justify-center p-10 text-center text-sm text-muted-foreground">
                No showroom unit targets are set for {monthLabel}. A Client Admin sets them in
                Targets & Approval Rules; these charts fill in as soon as they do.
              </CardContent>
            </Card>
          )}
          <div className={charts.hasTargets ? 'lg:col-span-2' : undefined}>
            <ModelTargetCard branchId={branchId} branchName={selectedName} month={data.month} />
          </div>
        </TabsContent>

        <TabsContent value="lost" className="grid gap-5 lg:grid-cols-2">
          <ChartCard
            title="Why leads were lost"
            description={`${focusLabel}: lost reasons recorded on leads from this window.`}
            empty={zero(charts.lostReasons)}
          >
            <EChart kind="donut" data={charts.lostReasons} />
          </ChartCard>
          <ChartCard
            title="Deliveries by showroom"
            description="Delivered in the window, and cars still waiting today."
            empty={zeroSeries(charts.delivery)}
          >
            <EChart kind="bar" data={charts.names} series={charts.delivery} stacked />
          </ChartCard>
        </TabsContent>

        <TabsContent value="handoffs">
          <SalesHandoffReport preset="ORGANIZATION" range={handoffRange} branchId={branchId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function BusinessOperationsOverview({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const overview = usePersistedQuery({
    queryKey: [...businessOperationsKey, ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchBusinessOperationsOverview(signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: businessOperationsSchema },
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    {
      resource: 'operations',
      queryKeys: [[...businessOperationsKey, ...workspaceQueryScope(session)]],
      minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
    },
  ]);
  if (overview.isPending) return <TenantDashboardSkeleton role="business-owner" />;
  if (overview.isError) return <Unavailable what="Operations overview" />;
  const departments = overview.data?.departments ?? [];
  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <div className={cn('grid gap-4', departmentColumns[departments.length] ?? 'md:grid-cols-3')}>
        {departments.map((department) => (
          <Card key={department.department} className="shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <ClipboardList className="size-4 text-blue-600" /> {department.department}
                </span>
                <span
                  className={
                    department.open
                      ? 'text-2xl font-bold tabular-nums text-orange-600'
                      : 'text-2xl font-bold tabular-nums text-muted-foreground'
                  }
                >
                  {department.open}
                </span>
              </CardTitle>
              <CardDescription>
                {department.open} open of {department.total} total
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {department.statuses.length ? (
                department.statuses.map((status) => (
                  <div
                    key={status.status}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <StatusBadge value={status.status} />
                    <span className="tabular-nums text-muted-foreground">{status.count}</span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No cases on this desk.</p>
              )}
            </CardContent>
          </Card>
        ))}
        {!departments.length && (
          <Card className="shadow-none md:col-span-2 xl:col-span-3">
            <CardContent className="p-10 text-center text-muted-foreground">
              No operational cases in your assigned scope.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
