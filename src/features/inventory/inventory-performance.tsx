'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, CarFront, ClipboardCheck, PackagePlus } from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid, kpiGridColumns } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { SectionCard } from '@/components/shared/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import type { Metric, PageSpec } from '@/lib/domain';
import { formatDayMonth, formatNumber } from '@/lib/format';
import { performanceRangeForLastDays, performanceRangeLabel } from '@/lib/performance-date-range';
import {
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { cn } from '@/lib/utils';
import { fetchInventoryPerformance } from './inventory-api';

/**
 * The inventory user's own work: vehicles they allocated and the stock
 * movements they recorded. The stock dashboard stays on Dashboard.
 */
export function InventoryPerformance({ spec, role }: { spec: PageSpec; role: string }) {
  const session = useWorkspaceSession();
  const [range, setRange] = useState(() => performanceRangeForLastDays(30));
  const query = useQuery({
    queryKey: ['inventory-performance', ...workspaceQueryScope(session), range.from, range.to],
    queryFn: ({ signal }) => fetchInventoryPerformance(range, signal),
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
        <div className={cn('grid gap-2.5', kpiGridColumns(4))}>
          {Array.from({ length: 4 }, (_, index) => (
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
          description="Your inventory permission or scope needs attention."
          reference="GDM-INVENTORY-PERFORMANCE"
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </PageShell>
    );

  const { kpis, daily } = query.data;
  const metrics: Metric[] = [
    {
      label: 'Vehicles allocated',
      value: formatNumber(kpis.allocations),
      helper: performanceRangeLabel(range),
      icon: CarFront,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Active allocations',
      value: formatNumber(kpis.active_allocations),
      helper: 'Allocated by you, still held',
      icon: ClipboardCheck,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Stock received',
      value: formatNumber(kpis.intakes),
      helper: 'Intake recorded by you',
      icon: PackagePlus,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Transfers',
      value: formatNumber(kpis.transfers),
      helper: `${formatNumber(kpis.movements)} stock movements in all`,
      icon: ArrowLeftRight,
      tone: 'bg-amber-50 text-amber-600',
    },
  ];
  const quiet = kpis.allocations === 0 && kpis.movements === 0;

  return (
    <PageShell>
      {header}
      <KpiGrid metrics={metrics} />
      <SectionCard
        title="Daily activity"
        description="Allocations and stock movements you recorded, by day"
        actionHref={`/${role}/vehicle-inventory`}
        actionLabel="Vehicle inventory"
      >
        {quiet ? (
          <EmptyState
            bare
            title="No inventory work recorded in this period"
            description="Allocations, intake and transfers you record appear here."
          />
        ) : (
          <EChart
            kind="line"
            data={daily.map((row) => ({
              name: formatDayMonth(row.day),
              value: row.allocations,
              secondary: row.movements,
            }))}
            seriesNames={['Allocations', 'Stock movements']}
            className="h-[320px]"
          />
        )}
      </SectionCard>
    </PageShell>
  );
}
