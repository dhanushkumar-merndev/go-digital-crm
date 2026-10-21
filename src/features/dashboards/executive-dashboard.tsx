'use client';

import {
  BadgeIndianRupee,
  CalendarCheck2,
  CarFront,
  ClipboardList,
  PackageCheck,
  Percent,
  Target,
  UsersRound,
} from 'lucide-react';
import Link from 'next/link';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid, kpiGridColumns } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { SectionCard } from '@/components/shared/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  formatCompactCurrency,
  formatDayMonth,
  formatNumber,
  formatPercent,
  humanizeEnum,
} from '@/lib/format';
import {
  AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { usePersistedQuery } from '@/lib/query/persisted-query';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { cn } from '@/lib/utils';
import {
  businessOperationsKey,
  businessOperationsSchema,
  businessShowroomAnalyticsKey,
  businessShowroomAnalyticsSchema,
  fetchBusinessOperationsOverview,
  fetchBusinessShowroomAnalytics,
} from './business-overview-api';

const WINDOW_DAYS = 30;

function share(part: number, whole: number) {
  return whole ? (part / whole) * 100 : 0;
}

/**
 * The Business Owner home (PRD 54.9 §14-18): the whole dealership at a glance.
 * It reads the same 30-day, all-showroom aggregate as Showroom Performance and
 * the same operations bundle as Operations Overview, so opening either page
 * after the dashboard is served from cache.
 */
export function ExecutiveDashboard({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const scope = workspaceQueryScope(session);
  const analytics = usePersistedQuery({
    queryKey: businessShowroomAnalyticsKey(scope, WINDOW_DAYS, null),
    queryFn: ({ signal }) => fetchBusinessShowroomAnalytics(WINDOW_DAYS, null, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: businessShowroomAnalyticsSchema },
  });
  const operations = usePersistedQuery({
    queryKey: [...businessOperationsKey, ...scope],
    queryFn: ({ signal }) => fetchBusinessOperationsOverview(signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: businessOperationsSchema },
  });
  useTenantRealtimeInvalidation(
    session?.organizationId,
    (['leads', 'work', 'sales', 'operations'] as const).map((resource) => ({
      resource,
      queryKeys: [
        ['business-showroom-analytics', ...scope],
        [...businessOperationsKey, ...scope],
      ],
      minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
    })),
  );
  const header = (
    <PageHeader
      spec={{ ...spec, primaryAction: undefined }}
      description={`The whole dealership over the last ${WINDOW_DAYS} days.`}
    />
  );

  if (analytics.isPending)
    return (
      <PageShell>
        {header}
        <div className={cn('grid gap-2.5', kpiGridColumns(8))}>
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-[104px] rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-12">
          <Skeleton className="h-[320px] rounded-xl xl:col-span-5" />
          <Skeleton className="h-[320px] rounded-xl xl:col-span-7" />
        </div>
      </PageShell>
    );
  if (analytics.isError || !analytics.data)
    return (
      <PageShell>
        {header}
        <ErrorState
          title="The business overview is unavailable"
          description="Your organization-wide access or the analytics connection needs attention."
          reference="GDM-EXECUTIVE-DASHBOARD"
          onRetry={() => void analytics.refetch()}
          retrying={analytics.isFetching}
        />
      </PageShell>
    );

  const { totals, daily } = analytics.data.focus;
  const targets = analytics.data.targets;
  const unitTarget = targets.reduce((sum, row) => sum + row.unit_target, 0);
  const monthBookings = targets.reduce((sum, row) => sum + row.bookings, 0);
  const metrics: Metric[] = [
    {
      label: 'Leads',
      value: formatNumber(totals.leads),
      helper: `Last ${WINDOW_DAYS} days`,
      icon: UsersRound,
      href: '/business-owner/sales-overview',
    },
    {
      label: 'Moved to sales',
      value: formatNumber(totals.moved_to_sales),
      helper: 'Qualified and handed over',
      icon: ClipboardList,
    },
    {
      label: 'Test drives',
      value: formatNumber(totals.test_drives),
      helper: `${formatNumber(totals.completed_drives)} completed`,
      icon: CarFront,
    },
    {
      label: 'Bookings',
      value: formatNumber(totals.bookings),
      helper: `${formatNumber(totals.quotations)} quotations`,
      icon: CalendarCheck2,
      href: '/business-owner/bookings-delivery',
    },
    {
      label: 'Delivered',
      value: formatNumber(totals.delivered),
      helper: `${formatNumber(totals.pending_delivery)} awaiting delivery`,
      icon: PackageCheck,
      href: '/business-owner/bookings-delivery',
    },
    {
      label: 'Conversion',
      value: formatPercent(share(totals.bookings, totals.leads)),
      helper: 'Bookings per lead',
      icon: Percent,
    },
    {
      label: 'Target achievement',
      value: unitTarget ? formatPercent(share(monthBookings, unitTarget)) : '—',
      helper: unitTarget
        ? `${formatNumber(monthBookings)} of ${formatNumber(unitTarget)} units this month`
        : 'No showroom targets set this month',
      icon: Target,
      href: '/business-owner/showroom-performance',
    },
    {
      label: 'Booking value',
      value: formatCompactCurrency(totals.booking_value),
      helper: `Last ${WINDOW_DAYS} days`,
      icon: BadgeIndianRupee,
    },
  ];
  const funnel = [
    { name: 'Leads', value: totals.leads },
    { name: 'Contacted', value: totals.contacted },
    { name: 'Moved to sales', value: totals.moved_to_sales },
    { name: 'Test drive', value: totals.test_drives },
    { name: 'Quotation', value: totals.quotations },
    { name: 'Booking', value: totals.bookings },
    { name: 'Delivered', value: totals.delivered },
  ];
  const departments = operations.data?.departments ?? [];

  return (
    <PageShell>
      {header}
      <KpiGrid metrics={metrics} />
      <div className="grid gap-4 xl:grid-cols-12">
        <SectionCard
          title="Sales funnel"
          description="Lead to delivered"
          className="xl:col-span-5"
          actionHref="/business-owner/sales-overview"
          actionLabel="Sales overview"
        >
          {totals.leads ? (
            <EChart
              kind="funnel"
              funnelMode="staged"
              funnelStages={funnel.length}
              data={funnel}
              className="h-[300px]"
            />
          ) : (
            <EmptyState bare title="No leads in the last 30 days" />
          )}
        </SectionCard>
        <SectionCard
          title="Leads and bookings"
          description="Per day, all showrooms"
          className="xl:col-span-7"
        >
          <EChart
            kind="line"
            data={daily.map((row) => ({
              name: formatDayMonth(row.day),
              value: row.leads,
              secondary: row.bookings,
            }))}
            seriesNames={['Leads', 'Bookings']}
            className="h-[300px]"
          />
        </SectionCard>
      </div>
      <div className="grid gap-4 xl:grid-cols-12">
        <SectionCard
          title="Target vs booked by showroom"
          description="Units this month"
          className="xl:col-span-7"
          actionHref="/business-owner/showroom-performance"
          actionLabel="Showroom performance"
        >
          {targets.length ? (
            <EChart
              kind="bar"
              data={targets.map((row) => ({
                name: row.branch,
                value: row.unit_target,
                secondary: row.bookings,
              }))}
              seriesNames={['Target', 'Booked']}
              className="h-[280px]"
            />
          ) : (
            <EmptyState
              bare
              title="No showroom targets this month"
              description="A Client Admin sets monthly model targets per showroom."
            />
          )}
        </SectionCard>
        <SectionCard
          title="Operations health"
          description="Open cases by department"
          className="xl:col-span-5"
          actionHref="/business-owner/operations-overview"
          actionLabel="Operations overview"
          contentClassName="space-y-2"
        >
          {operations.isPending ? (
            Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-9" />)
          ) : operations.isError ? (
            <ErrorState
              className="border-0"
              title="Operations are unavailable"
              onRetry={() => void operations.refetch()}
            />
          ) : departments.length ? (
            departments.map((department) => (
              <Link
                key={department.department}
                href="/business-owner/operations-overview"
                className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              >
                <span className="font-medium text-heading">
                  {humanizeEnum(department.department)}
                </span>
                <span className="text-xs text-muted-foreground">
                  <b
                    className={cn(
                      'mr-1 text-base tabular-nums',
                      department.open ? 'text-orange-600' : 'text-muted-foreground',
                    )}
                  >
                    {formatNumber(department.open)}
                  </b>
                  open of {formatNumber(department.total)}
                </span>
              </Link>
            ))
          ) : (
            <EmptyState bare title="No operational cases yet" />
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}
