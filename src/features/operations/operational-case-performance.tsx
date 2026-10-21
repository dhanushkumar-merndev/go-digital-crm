'use client';

import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, FolderOpen, Timer, TriangleAlert } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid, kpiGridColumns } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { SectionCard } from '@/components/shared/section-card';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { Skeleton } from '@/components/ui/skeleton';
import type { RoleKey } from '@/config/navigation/types';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  performanceRangeForLastDays,
  performanceRangeLabel,
  type PerformanceDateRange,
} from '@/lib/performance-date-range';
import { formatDayMonth, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import {
  fetchOperationalCasePerformance,
  type OperationalCasePerformance as OperationalCasePerformanceResult,
} from './operational-case-api';
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
  return (
    <PersonalCasePerformance
      spec={spec}
      cacheKey={route.department}
      casesHref={operationalCaseCasesHref(role, route.department)}
      fetchPerformance={(range, signal) =>
        fetchOperationalCasePerformance(route.department, range, signal)
      }
    />
  );
}

/**
 * One personal performance view for every case desk. Customer Care uses it with
 * its own RPC, so "My Performance" never falls back to the dashboard.
 */
export function PersonalCasePerformance({
  spec,
  cacheKey,
  casesHref,
  fetchPerformance,
}: {
  spec: PageSpec;
  cacheKey: string;
  casesHref?: string;
  fetchPerformance: (
    range: PerformanceDateRange,
    signal?: AbortSignal,
  ) => Promise<OperationalCasePerformanceResult>;
}) {
  const session = useWorkspaceSession();
  const [range, setRange] = useState(() => performanceRangeForLastDays(30));
  const query = useQuery({
    queryKey: ['ops-performance', cacheKey, ...workspaceQueryScope(session), range.from, range.to],
    queryFn: ({ signal }) => fetchPerformance(range, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    placeholderData: (previous) => previous,
  });

  const header = (
    <PageHeader
      spec={{ ...spec, primaryAction: undefined }}
      actions={<PerformanceDateRangeSelector value={range} onChange={setRange} />}
    />
  );

  if (query.isPending)
    return (
      <PageShell>
        {header}
        <div className={cn('grid gap-2.5', kpiGridColumns(5))}>
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-[118px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[360px] rounded-xl" />
      </PageShell>
    );

  if (query.isError || !query.data)
    return (
      <PageShell>
        {header}
        <ErrorState
          title="Your performance is not available yet"
          description="Your department permission or scope needs attention."
          reference="GDM-OPS-PERFORMANCE"
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </PageShell>
    );

  const { kpis, daily } = query.data;
  const metrics: Metric[] = [
    {
      label: 'Open with me',
      value: formatNumber(kpis.open),
      helper: 'Assigned to you, not closed',
      icon: FolderOpen,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Due today',
      value: formatNumber(kpis.due_today),
      helper: 'Open cases due today',
      icon: Clock,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Overdue',
      value: formatNumber(kpis.overdue),
      helper: 'Past their due time',
      icon: TriangleAlert,
      tone: 'bg-rose-50 text-rose-600',
    },
    {
      label: 'Completed',
      value: formatNumber(kpis.completed),
      helper: `${formatNumber(kpis.handled)} handled · ${performanceRangeLabel(range)}`,
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

  return (
    <PageShell>
      {header}
      <KpiGrid metrics={metrics} />
      <SectionCard
        title="Daily activity"
        description="Cases you updated and completed, by day"
        actionHref={casesHref}
        actionLabel="Open my cases"
      >
        {quiet ? (
          <EmptyState
            bare
            title="No cases assigned to you in this period"
            description="Pick a wider range, or open your cases to take one on."
          />
        ) : (
          <EChart
            kind="line"
            data={daily.map((row) => ({
              name: formatDayMonth(row.day),
              value: row.handled,
              secondary: row.completed,
            }))}
            seriesNames={['Handled', 'Completed']}
            className="h-[320px]"
          />
        )}
      </SectionCard>
    </PageShell>
  );
}
