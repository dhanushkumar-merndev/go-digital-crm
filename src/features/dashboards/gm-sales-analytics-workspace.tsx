'use client';

import { useState } from 'react';
import Link from 'next/link';
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
import { Card, CardContent } from '@/components/ui/card';
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
import { fetchGmSalesAnalytics, gmSalesAnalyticsSchema } from './gm-sales-analytics-api';

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
    label: 'Consultant ranking',
    description: 'Rank active sales consultants by current-period CRM outcomes.',
  },
  {
    value: 'model-performance',
    label: 'Model performance',
    description: 'Interested-model demand in your authorized sales lead scope.',
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

export function GmSalesAnalyticsWorkspace() {
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
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <h1 className="font-semibold">GM analytics is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm your GM Sales Executive role, branch scope, and the analytics migration.
          </p>
        </CardContent>
      </Card>
    );
  const data = query.data;
  const metrics: Metric[] = [
    {
      label: 'Leads',
      value: data.kpis.leads.toLocaleString(),
      helper: performanceRangeLabel(range),
      icon: UsersRound,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Calls',
      value: data.kpis.calls.toLocaleString(),
      helper: 'Authorized calls',
      icon: PhoneCall,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Test drives',
      value: data.kpis.test_drives.toLocaleString(),
      helper: 'Scheduled drives',
      icon: CarFront,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Quotations',
      value: data.kpis.quotations.toLocaleString(),
      helper: 'Created in period',
      icon: FileText,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Bookings',
      value: data.kpis.bookings.toLocaleString(),
      helper: `${data.kpis.conversion.toFixed(1)}% lead conversion`,
      icon: Trophy,
      tone: 'bg-orange-50 text-orange-600',
    },
  ];

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <nav aria-label="Breadcrumb" className="mb-2 text-xs text-muted-foreground">
            <Link href="/gm-sales/dashboard" className="hover:text-foreground hover:underline">
              Dashboard
            </Link>{' '}
            › Sales Analytics
          </nav>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">Sales Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">{activeView.description}</p>
        </div>
        <PerformanceDateRangeSelector value={range} onChange={setRange} />
      </div>
      <KpiGrid metrics={metrics} className="xl:grid-cols-5" />
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
      {view === 'showroom-comparison' ? <BranchTable data={data} /> : null}
      {view === 'consultant-ranking' ? <ConsultantTable data={data} /> : null}
      {view === 'model-performance' ? <ModelTable data={data} /> : null}
    </div>
  );
}

function PerformanceContent({ data }: { data: Awaited<ReturnType<typeof fetchGmSalesAnalytics>> }) {
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
      <SectionCard
        title="Sales funnel volumes"
        description="Activity counts in the selected period"
        className="xl:col-span-5"
      >
        <EChart
          kind="funnel"
          data={[
            { name: 'Leads', value: data.kpis.leads },
            { name: 'Calls', value: data.kpis.calls },
            { name: 'Test drives', value: data.kpis.test_drives },
            { name: 'Quotations', value: data.kpis.quotations },
            { name: 'Bookings', value: data.kpis.bookings },
          ]}
          className="h-[320px]"
        />
      </SectionCard>
      <div className="xl:col-span-12">
        <BranchTable data={data} compact />
      </div>
    </div>
  );
}

function BranchTable({
  data,
  compact = false,
}: {
  data: Awaited<ReturnType<typeof fetchGmSalesAnalytics>>;
  compact?: boolean;
}) {
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
              <TableCell>
                <Badge variant={branch.conversion >= 10 ? 'success' : 'outline'}>
                  {branch.conversion.toFixed(1)}%
                </Badge>
              </TableCell>
            </TableRow>
          ))}
          {!data.branches.length ? (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
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

function ConsultantTable({ data }: { data: Awaited<ReturnType<typeof fetchGmSalesAnalytics>> }) {
  return (
    <SectionCard
      title="Consultant leaderboard"
      description="Ranked by bookings, quotations, calls, then consultant name."
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

function ModelTable({ data }: { data: Awaited<ReturnType<typeof fetchGmSalesAnalytics>> }) {
  return (
    <SectionCard
      title="Interested-model demand"
      description="Derived from live lead interest fields; it is not inventory availability."
      contentClassName="grid gap-5 xl:grid-cols-[1.1fr_1fr]"
    >
      <EChart
        kind="bar"
        data={data.models.slice(0, 12).map((row) => ({ name: row.name, value: row.leads }))}
        className="h-[360px]"
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Leads</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.models.map((model) => (
            <TableRow key={model.name}>
              <TableCell className="font-medium">{model.name}</TableCell>
              <TableCell className="text-right">{model.leads}</TableCell>
            </TableRow>
          ))}
          {!data.models.length ? (
            <TableRow>
              <TableCell colSpan={2} className="py-10 text-center text-sm text-muted-foreground">
                No interested-model values are available in this period.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
