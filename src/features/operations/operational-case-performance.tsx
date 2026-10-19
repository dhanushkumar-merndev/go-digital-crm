'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, FolderOpen, RotateCcw, Timer, TriangleAlert } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { SectionCard } from '@/components/shared/section-card';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { RoleKey } from '@/config/navigation/types';
import type { Metric, PageSpec } from '@/lib/domain';
import { performanceRangeForLastDays, performanceRangeLabel } from '@/lib/performance-date-range';
import {
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { fetchOperationalCasePerformance } from './operational-case-api';
import { operationalCaseCasesHref, operationalCaseRoute } from './operational-case-query';

function closeTime(hours: number | null) {
  if (hours === null) return '—';
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`;
}

/**
 * The desk user's own numbers: what is on their plate now and what they closed
 * in the chosen range. The case list itself lives on the desk's Cases page.
 */
export function OperationalCasePerformance({ spec, role }: { spec: PageSpec; role: RoleKey }) {
  const route = operationalCaseRoute(role, 'my-performance');
  if (!route) throw new Error('INVALID_OPERATIONAL_CASE_ROUTE');
  const session = useWorkspaceSession();
  const [range, setRange] = useState(() => performanceRangeForLastDays(30));
  const query = useQuery({
    queryKey: [
      'ops-performance',
      route.department,
      ...workspaceQueryScope(session),
      range.from,
      range.to,
    ],
    queryFn: ({ signal }) => fetchOperationalCasePerformance(route.department, range, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    placeholderData: (previous) => previous,
  });

  const header = (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <PerformanceDateRangeSelector value={range} onChange={setRange} className="sm:mt-7" />
    </div>
  );

  if (query.isPending)
    return (
      <div className="mx-auto max-w-[1800px]">
        {header}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-[118px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="mt-6 h-[360px] rounded-xl" />
      </div>
    );

  if (query.isError || !query.data)
    return (
      <div className="mx-auto max-w-[1800px]">
        {header}
        <Card className="mx-auto max-w-xl shadow-none">
          <CardContent className="p-10 text-center">
            <div className="mx-auto grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
              <TriangleAlert />
            </div>
            <h2 className="mt-4 font-semibold">Your performance is not available yet</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your department permission or scope needs attention. Reference: GDM-OPS-PERFORMANCE.
            </p>
            <Button className="mt-5" variant="outline" onClick={() => void query.refetch()}>
              <RotateCcw className="size-4" /> Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    );

  const { kpis, daily } = query.data;
  const metrics: Metric[] = [
    {
      label: 'Open with me',
      value: kpis.open.toLocaleString(),
      helper: 'Assigned to you, not closed',
      icon: FolderOpen,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Due today',
      value: kpis.due_today.toLocaleString(),
      helper: 'Open cases due today',
      icon: Clock,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Overdue',
      value: kpis.overdue.toLocaleString(),
      helper: 'Past their due time',
      icon: TriangleAlert,
      tone: 'bg-rose-50 text-rose-600',
    },
    {
      label: 'Completed',
      value: kpis.completed.toLocaleString(),
      helper: `${kpis.handled.toLocaleString()} handled · ${performanceRangeLabel(range)}`,
      icon: CheckCircle2,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Avg time to close',
      value: closeTime(kpis.avg_close_hours),
      helper: 'Created to completed',
      icon: Timer,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];
  const quiet = kpis.handled === 0 && kpis.open === 0;
  const casesHref = operationalCaseCasesHref(role, route.department);

  return (
    <div className="mx-auto max-w-[1800px]">
      {header}
      <div className="space-y-6">
        <KpiGrid metrics={metrics} className="xl:grid-cols-5" />
        <SectionCard
          title="Daily activity"
          description="Cases you updated and completed, by day"
          actionHref={casesHref}
          actionLabel="Open my cases"
        >
          {quiet ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No cases assigned to you in this period.
            </p>
          ) : (
            <EChart
              kind="line"
              data={daily.map((row) => ({
                name: row.day.slice(5),
                value: row.handled,
                secondary: row.completed,
              }))}
              seriesNames={['Handled', 'Completed']}
              className="h-[320px]"
            />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
