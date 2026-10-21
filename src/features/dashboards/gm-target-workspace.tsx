'use client';

import { formatCompactCurrency, formatNumber } from '@/lib/format';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Skeleton } from '@/components/ui/skeleton';
import type { PageSpec } from '@/lib/domain';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CarFront, ChartNoAxesCombined, Target, Trophy } from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { SectionCard } from '@/components/shared/section-card';
import { GmTargetSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Metric } from '@/lib/domain';
import { fetchGmTarget } from './gm-target-api';

function currentMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

function progress(actual: number, target: number) {
  return target > 0 ? (actual / target) * 100 : null;
}

export function GmTargetWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [month, setMonth] = useState(currentMonth);
  const query = useQuery({
    // Scoped like every tenant read (AGENTS.md 11.8), so a cached month never
    // crosses from one session or tenant to the next.
    queryKey: ['gm-target', ...workspaceQueryScope(session), month],
    queryFn: ({ signal }) => fetchGmTarget(month, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <GmTargetSkeleton />;
  if (query.isError || !query.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="GM target data is unavailable"
          description="Confirm your GM Sales Executive role, authorized branch scope, and the target workspace migration."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );

  const data = query.data;
  const salesProgress = progress(data.kpis.sales_value, data.kpis.sales_target);
  const metrics: Metric[] = [
    {
      label: 'Sales target',
      value: data.kpis.sales_target
        ? formatCompactCurrency(data.kpis.sales_target)
        : 'Not configured',
      helper: 'Authorized showrooms combined',
      icon: Target,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Booked sales',
      value: formatCompactCurrency(data.kpis.sales_value),
      helper:
        salesProgress === null
          ? 'No revenue target configured'
          : `${salesProgress.toFixed(1)}% of target`,
      icon: ChartNoAxesCombined,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Booking target',
      value: data.kpis.booking_target
        ? data.kpis.booking_target.toLocaleString('en-IN')
        : 'Not configured',
      helper: `${data.kpis.bookings.toLocaleString('en-IN')} booked this month`,
      icon: Trophy,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Test-drive target',
      value: data.kpis.drive_target
        ? data.kpis.drive_target.toLocaleString('en-IN')
        : 'Not configured',
      helper: `${data.kpis.test_drives.toLocaleString('en-IN')} scheduled this month`,
      icon: CarFront,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description="Branch targets for the month and the bookings made against them in your scope."
        actions={
          <>
            <Input
              aria-label="Target month"
              className="w-44"
              max="2030-12"
              min="2025-01"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value || currentMonth())}
            />
          </>
        }
      />
      <KpiGrid metrics={metrics} />
      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="Booked sales by showroom"
          description="Actual sales value against the configured revenue target."
        >
          <EChart
            kind="bar"
            data={data.branches.map((branch) => ({
              name: branch.name,
              value: branch.sales_value,
              secondary: branch.sales_target,
            }))}
            seriesNames={['Booked sales', 'Target']}
          />
        </SectionCard>
        <SectionCard
          title="Booking and test-drive progress"
          description="Counts are displayed separately from revenue targets."
        >
          <EChart
            kind="bar"
            data={data.branches.map((branch) => ({
              name: branch.name,
              value: branch.bookings,
              secondary: branch.booking_target,
            }))}
            seriesNames={['Bookings', 'Booking target']}
          />
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarDays className="size-3.5" /> Test drives:{' '}
            {data.kpis.test_drives.toLocaleString('en-IN')} /{' '}
            {data.kpis.drive_target
              ? data.kpis.drive_target.toLocaleString('en-IN')
              : 'not configured'}
          </div>
        </SectionCard>
      </div>
      <SectionCard
        title="Showroom target attainment"
        description="Only branch-level targets are included; individual and team targets remain separate."
        flush
        contentClassName="overflow-x-auto"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Showroom</TableHead>
              <TableHead className="text-right">Sales target</TableHead>
              <TableHead className="text-right">Booked sales</TableHead>
              <TableHead>Attainment</TableHead>
              <TableHead className="text-right">Bookings</TableHead>
              <TableHead className="text-right">Test drives</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.branches.map((branch) => {
              const attainment = progress(branch.sales_value, branch.sales_target);
              return (
                <TableRow key={branch.id}>
                  <TableCell className="font-medium">{branch.name}</TableCell>
                  <TableCell className="text-right">
                    {branch.sales_target ? formatCompactCurrency(branch.sales_target) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCompactCurrency(branch.sales_value)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={attainment !== null && attainment >= 100 ? 'success' : 'outline'}
                    >
                      {attainment === null ? 'No target' : `${attainment.toFixed(1)}%`}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {branch.bookings}
                    {branch.booking_target ? ` / ${branch.booking_target}` : ''}
                  </TableCell>
                  <TableCell className="text-right">
                    {branch.test_drives}
                    {branch.drive_target ? ` / ${branch.drive_target}` : ''}
                  </TableCell>
                </TableRow>
              );
            })}
            {!data.branches.length ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No accessible active showrooms are available.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}

/**
 * The GM dashboard's showroom target vs actual (PRD 54.5 §1), for the current
 * month under the Targets page's query key.
 */
export function GmShowroomTargetsCard() {
  const session = useWorkspaceSession();
  const [month] = useState(currentMonth);
  const query = useQuery({
    queryKey: ['gm-target', ...workspaceQueryScope(session), month],
    queryFn: ({ signal }) => fetchGmTarget(month, signal),
    staleTime: 60_000,
  });
  const branches = query.data?.branches ?? [];
  const kpis = query.data?.kpis;
  return (
    <SectionCard
      title="Showroom targets this month"
      description={
        kpis && kpis.booking_target
          ? `${formatNumber(kpis.bookings)} of ${formatNumber(kpis.booking_target)} bookings across your showrooms`
          : 'Bookings against each showroom target'
      }
      actionHref="/gm-sales/targets"
      actionLabel="Targets"
    >
      {query.isPending ? (
        <Skeleton className="h-[280px] rounded-lg" />
      ) : query.isError || !query.data ? (
        <ErrorState
          className="border-0"
          title="Targets are unavailable"
          onRetry={() => void query.refetch()}
        />
      ) : branches.some((branch) => branch.booking_target > 0) ? (
        <EChart
          kind="bar"
          data={branches.map((branch) => ({
            name: branch.name,
            value: branch.booking_target,
            secondary: branch.bookings,
          }))}
          seriesNames={['Booking target', 'Booked']}
          className="h-[280px]"
        />
      ) : (
        <EmptyState
          bare
          title="No showroom targets set this month"
          description="Allocate monthly booking targets to your showrooms on Targets."
        />
      )}
    </SectionCard>
  );
}
