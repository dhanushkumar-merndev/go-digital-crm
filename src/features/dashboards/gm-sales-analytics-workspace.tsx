'use client';

import { ErrorState } from '@/components/shared/page-states';
import type { PageSpec } from '@/lib/domain';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { BarChart3, CarFront, FileText, PhoneCall, Trophy, UsersRound } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { SectionCard } from '@/components/shared/section-card';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { GmSalesAnalyticsSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { performanceRangeForLastDays, performanceRangeLabel } from '@/lib/performance-date-range';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Metric } from '@/lib/domain';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import {
  AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { usePersistedQuery } from '@/lib/query/persisted-query';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { formatNumber, formatPercent } from '@/lib/format';
import { fetchGmSalesAnalytics, gmSalesAnalyticsSchema } from './gm-sales-analytics-api';
import { funnelNarrows } from './sales-consultant-performance';

type Analytics = Awaited<ReturnType<typeof fetchGmSalesAnalytics>>;

const rate = (part: number, whole: number) => (whole > 0 ? (part * 100) / whole : 0);

export type GmSalesAnalyticsView =
  'sales-performance' | 'showroom-comparison' | 'consultant-ranking' | 'model-performance';

// One page, four tabs: every view reads the same aggregate payload, so switching
// tabs re-renders from cache instead of fetching again. The old per-view routes
// redirect here with `?view=`.
const views: Array<{ value: GmSalesAnalyticsView; label: string; description: string }> = [
  {
    value: 'sales-performance',
    label: 'Performance',
    description: 'Organization-wide sales activity within your authorized branch scope.',
  },
  {
    value: 'showroom-comparison',
    label: 'Showroom comparison',
    description: 'Compare branch activity using only live, scope-authorized CRM records.',
  },
  {
    value: 'consultant-ranking',
    label: 'Sales consultant ranking',
    description:
      'Sales consultants ranked on bookings in the period; telecallers are compared in Reports.',
  },
  {
    value: 'model-performance',
    label: 'Model performance',
    description: 'Demand and conversion for each model customers asked for.',
  },
];
const defaultView: GmSalesAnalyticsView = 'sales-performance';

function parseView(value: string | null): GmSalesAnalyticsView {
  return views.find((item) => item.value === value)?.value ?? defaultView;
}

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function GmSalesAnalyticsWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, setView] = useState(() => parseView(searchParams.get('view')));
  const changeView = (next: string) => {
    const parsed = parseView(next);
    setView(parsed);
    replaceQueryString(pathname, parsed === defaultView ? '' : `view=${parsed}`);
  };
  const [range, setRange] = useState(() => performanceRangeForLastDays(30));
  const query = usePersistedQuery({
    // Every GM analytics route consumes the same bounded aggregate payload.
    // Keep one scope-aware cache entry so changing views does not repeat the RPC.
    queryKey: ['gm-sales-analytics', ...workspaceQueryScope(session), range.from, range.to],
    queryFn: ({ signal }) => fetchGmSalesAnalytics(range, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: gmSalesAnalyticsSchema },
  });
  useTenantRealtimeInvalidation(
    session?.organizationId,
    (['leads', 'communications', 'work', 'sales'] as const).map((resource) => ({
      resource,
      queryKeys: [['gm-sales-analytics', ...workspaceQueryScope(session)]],
      minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
    })),
  );
  const activeView = views.find((item) => item.value === view) ?? views[0];
  if (query.isPending) return <GmSalesAnalyticsSkeleton />;
  if (query.isError || !query.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="GM analytics is unavailable"
          description="Confirm your GM Sales Executive role, branch scope, and the analytics migration."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );
  const data = query.data;
  const metrics: Metric[] = [
    {
      label: 'Leads',
      value: data.kpis.leads.toLocaleString('en-IN'),
      helper: performanceRangeLabel(range),
      icon: UsersRound,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Calls',
      value: data.kpis.calls.toLocaleString('en-IN'),
      helper: 'Authorized calls',
      icon: PhoneCall,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Test drives',
      value: data.kpis.test_drives.toLocaleString('en-IN'),
      helper: 'Scheduled drives',
      icon: CarFront,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Quotations',
      value: data.kpis.quotations.toLocaleString('en-IN'),
      helper: 'Created in period',
      icon: FileText,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Bookings',
      value: data.kpis.bookings.toLocaleString('en-IN'),
      helper: `${data.kpis.conversion.toFixed(1)}% lead conversion`,
      icon: Trophy,
      tone: 'bg-orange-50 text-orange-600',
    },
  ];

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description={activeView.description}
        actions={<PerformanceDateRangeSelector value={range} onChange={setRange} />}
      />
      <KpiGrid metrics={metrics} />
      <Tabs value={view} onValueChange={changeView}>
        <div className="overflow-x-auto pb-1">
          <TabsList>
            {views.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
      {view === 'sales-performance' ? <PerformanceContent data={data} /> : null}
      {view === 'showroom-comparison' ? <ShowroomComparison data={data} /> : null}
      {view === 'consultant-ranking' ? <ConsultantTable data={data} /> : null}
      {view === 'model-performance' ? <ModelTable data={data} /> : null}
    </div>
  );
}

function PerformanceContent({ data }: { data: Analytics }) {
  const { kpis } = data;
  // Leads, contacted and qualified follow the leads created in the period; the
  // later steps count activity in it, so a later step can outgrow an earlier one.
  const funnel = [
    { name: 'Leads', value: kpis.leads },
    ...(kpis.contacted === undefined ? [] : [{ name: 'Contacted', value: kpis.contacted }]),
    ...(kpis.qualified === undefined ? [] : [{ name: 'Qualified', value: kpis.qualified }]),
    { name: 'Test drive', value: kpis.test_drives },
    { name: 'Quotation', value: kpis.quotations },
    { name: 'Booking', value: kpis.bookings },
  ];
  return (
    <div className="grid gap-5 xl:grid-cols-12">
      <SectionCard
        title="Daily trend"
        description="Leads and bookings, by day"
        className="xl:col-span-7"
      >
        <EChart
          kind="line"
          data={data.daily.map((row) => ({
            name: row.name,
            value: row.leads,
            secondary: row.bookings,
          }))}
          seriesNames={['Leads', 'Bookings']}
          className="h-[320px]"
        />
      </SectionCard>
      {funnelNarrows(funnel) ? (
        <SectionCard
          title="Sales funnel"
          description="From leads created in the period to bookings"
          className="xl:col-span-5"
        >
          <EChart
            kind="funnel"
            data={funnel}
            funnelMode="staged"
            funnelStages={funnel.length}
            funnelLabels="side"
            className="h-[320px]"
          />
        </SectionCard>
      ) : (
        <SectionCard
          title="Sales steps in the period"
          description="Bookings can come from leads created before the period"
          className="xl:col-span-5"
        >
          <EChart
            kind="bar"
            data={funnel}
            series={[{ name: 'Count', values: funnel.map((stage) => stage.value) }]}
            className="h-[320px]"
          />
        </SectionCard>
      )}
      <div className="xl:col-span-12">
        <BranchTable data={data} compact />
      </div>
    </div>
  );
}

/** PRD 54.5 §3: the showrooms side by side, then the table. */
function ShowroomComparison({ data }: { data: Analytics }) {
  const branches = data.branches;
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <SectionCard
          title="Bookings by showroom"
          description="Test drives and bookings in the period"
        >
          <EChart
            kind="bar"
            data={branches.map((branch) => ({ name: branch.name, value: branch.bookings }))}
            series={[
              { name: 'Test drives', values: branches.map((branch) => branch.test_drives) },
              { name: 'Bookings', values: branches.map((branch) => branch.bookings) },
            ]}
            className="h-[300px]"
          />
        </SectionCard>
        <SectionCard title="Conversion by showroom" description="Percent, in the period">
          <EChart
            kind="bar"
            data={branches.map((branch) => ({ name: branch.name, value: branch.conversion }))}
            series={[
              {
                name: 'Lead to booking %',
                values: branches.map((branch) => Number(branch.conversion.toFixed(1))),
              },
              {
                name: 'Test drive to booking %',
                values: branches.map((branch) =>
                  Number(rate(branch.bookings, branch.test_drives).toFixed(1)),
                ),
              },
              ...(branches.some((branch) => branch.lost !== undefined)
                ? [
                    {
                      name: 'Lost %',
                      values: branches.map((branch) =>
                        Number(rate(branch.lost ?? 0, branch.leads).toFixed(1)),
                      ),
                    },
                  ]
                : []),
            ]}
            className="h-[300px]"
          />
        </SectionCard>
      </div>
      <BranchTable data={data} />
    </div>
  );
}

function BranchTable({ data, compact = false }: { data: Analytics; compact?: boolean }) {
  const showLost = data.branches.some((branch) => branch.lost !== undefined);
  return (
    <SectionCard
      title="Branch performance"
      description="Only branches in the GM's current authorized scope are included."
      action={<BarChart3 className="size-4 text-blue-600" />}
      flush
      contentClassName="overflow-x-auto"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Showroom</TableHead>
            <TableHead>Leads</TableHead>
            <TableHead>Calls</TableHead>
            <TableHead>Test drives</TableHead>
            <TableHead>Quotations</TableHead>
            <TableHead>Bookings</TableHead>
            {showLost ? <TableHead>Lost</TableHead> : null}
            <TableHead>Conversion</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.branches.map((branch) => (
            <TableRow key={branch.id}>
              <TableCell className="font-medium">{branch.name}</TableCell>
              <TableCell>{branch.leads}</TableCell>
              <TableCell>{branch.calls}</TableCell>
              <TableCell>{branch.test_drives}</TableCell>
              <TableCell>{branch.quotations}</TableCell>
              <TableCell>{branch.bookings}</TableCell>
              {showLost ? <TableCell>{branch.lost ?? '—'}</TableCell> : null}
              <TableCell>
                <Badge variant={branch.conversion >= 10 ? 'success' : 'outline'}>
                  {branch.conversion.toFixed(1)}%
                </Badge>
              </TableCell>
            </TableRow>
          ))}
          {!data.branches.length ? (
            <TableRow>
              <TableCell
                colSpan={showLost ? 8 : 7}
                className="py-10 text-center text-sm text-muted-foreground"
              >
                No accessible active branches are available.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {compact ? null : (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          Sorted by bookings, then leads. This does not infer or display unavailable revenue/target
          values.
        </p>
      )}
    </SectionCard>
  );
}

function ConsultantTable({ data }: { data: Analytics }) {
  return (
    <SectionCard
      title="Sales consultant ranking"
      description="Ranked by bookings, then quotations and calls. Telecallers are not ranked here."
      flush
      contentClassName="overflow-x-auto"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rank</TableHead>
            <TableHead>Consultant</TableHead>
            <TableHead>Showroom</TableHead>
            <TableHead>Leads</TableHead>
            <TableHead>Calls</TableHead>
            <TableHead>Drives</TableHead>
            <TableHead>Quotes</TableHead>
            <TableHead>Bookings</TableHead>
            <TableHead>Conversion</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.consultants.map((member, index) => (
            <TableRow key={member.user_id}>
              <TableCell className="font-semibold">{index + 1}</TableCell>
              <TableCell>
                <span className="flex items-center gap-2">
                  <span className="grid size-8 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                    {initials(member.full_name)}
                  </span>
                  {member.full_name}
                </span>
              </TableCell>
              <TableCell>{member.branch_name}</TableCell>
              <TableCell>{member.leads}</TableCell>
              <TableCell>{member.calls}</TableCell>
              <TableCell>{member.test_drives}</TableCell>
              <TableCell>{member.quotations}</TableCell>
              <TableCell>{member.bookings}</TableCell>
              <TableCell>
                <Badge variant={member.conversion >= 10 ? 'success' : 'outline'}>
                  {member.conversion.toFixed(1)}%
                </Badge>
              </TableCell>
            </TableRow>
          ))}
          {!data.consultants.length ? (
            <TableRow>
              <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                No active consultants are visible in your current scope.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

/** PRD 54.5 §7: demand, conversion and, for callers who may check stock, availability. */
function ModelTable({ data }: { data: Analytics }) {
  const detailed = data.models.some((model) => model.bookings !== undefined);
  const stock = Boolean(data.stock_visible);
  const top = data.models.slice(0, 10);
  const columns = 2 + (detailed ? 5 : 0) + (stock ? 2 : 0);
  return (
    <div className="space-y-5">
      <SectionCard
        title="Demand and bookings by model"
        description="Leads created in the period for each model, and the bookings credited to it"
      >
        <EChart
          kind="bar"
          data={top.map((model) => ({ name: model.name, value: model.leads }))}
          series={[
            { name: 'Leads', values: top.map((model) => model.leads) },
            ...(detailed
              ? [
                  { name: 'Test drives', values: top.map((model) => model.test_drives ?? 0) },
                  { name: 'Bookings', values: top.map((model) => model.bookings ?? 0) },
                ]
              : []),
          ]}
          className="h-[320px]"
        />
      </SectionCard>
      <SectionCard
        title="Model performance"
        description={
          stock
            ? 'Drives, quotations and bookings are credited to the model the enquiry asked for. Stock is read-only from Inventory.'
            : 'Drives, quotations and bookings are credited to the model the enquiry asked for.'
        }
        flush
        contentClassName="overflow-x-auto"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              {detailed ? (
                <>
                  <TableHead className="text-right">Test drives</TableHead>
                  <TableHead className="text-right">Quotations</TableHead>
                  <TableHead className="text-right">Bookings</TableHead>
                  <TableHead className="text-right">Lost</TableHead>
                  <TableHead className="text-right">Conversion</TableHead>
                </>
              ) : null}
              {stock ? (
                <>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Incoming</TableHead>
                </>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.models.map((model) => (
              <TableRow key={model.name}>
                <TableCell className="font-medium">{model.name}</TableCell>
                <TableCell className="text-right">{formatNumber(model.leads)}</TableCell>
                {detailed ? (
                  <>
                    <TableCell className="text-right">
                      {formatNumber(model.test_drives ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(model.quotations ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(model.bookings ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(model.lost ?? 0)}</TableCell>
                    <TableCell className="text-right">
                      {formatPercent(rate(model.bookings ?? 0, model.leads))}
                    </TableCell>
                  </>
                ) : null}
                {stock ? (
                  <>
                    <TableCell className="text-right">
                      {model.available == null ? '—' : formatNumber(model.available)}
                    </TableCell>
                    <TableCell className="text-right">
                      {model.incoming == null ? '—' : formatNumber(model.incoming)}
                    </TableCell>
                  </>
                ) : null}
              </TableRow>
            ))}
            {!data.models.length ? (
              <TableRow>
                <TableCell
                  colSpan={columns}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No interested-model values are available in this period.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}
