'use client';

import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  CarFront,
  ChartNoAxesCombined,
  Target,
  Trophy,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { GmTargetSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

function currency(value: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
    notation: value >= 10_000_000 ? 'compact' : 'standard',
  }).format(value);
}

function progress(actual: number, target: number) {
  return target > 0 ? (actual / target) * 100 : null;
}

export function GmTargetWorkspace() {
  const [month, setMonth] = useState(currentMonth);
  const query = useQuery({
    queryKey: ['gm-target', month],
    queryFn: ({ signal }) => fetchGmTarget(month, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <GmTargetSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <TriangleAlert className="mx-auto size-8 text-destructive" />
          <h1 className="mt-4 font-semibold">GM target data is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm your GM Sales Executive role, authorized branch scope, and the target workspace
            migration.
          </p>
        </CardContent>
      </Card>
    );

  const data = query.data;
  const salesProgress = progress(data.kpis.sales_value, data.kpis.sales_target);
  const metrics: Metric[] = [
    {
      label: 'Sales target',
      value: data.kpis.sales_target ? currency(data.kpis.sales_target) : 'Not configured',
      helper: 'Authorized showrooms combined',
      icon: Target,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Booked sales',
      value: currency(data.kpis.sales_value),
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
        ? data.kpis.booking_target.toLocaleString()
        : 'Not configured',
      helper: `${data.kpis.bookings.toLocaleString()} booked this month`,
      icon: Trophy,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Test-drive target',
      value: data.kpis.drive_target ? data.kpis.drive_target.toLocaleString() : 'Not configured',
      helper: `${data.kpis.test_drives.toLocaleString()} scheduled this month`,
      icon: CarFront,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">GM Sales Executive › Targets</div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">Sales targets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configured branch targets and live booked outcomes in your authorized scope.
          </p>
        </div>
        <Input
          aria-label="Target month"
          className="w-44"
          max="2030-12"
          min="2025-01"
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value || currentMonth())}
        />
      </div>
      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Booked sales by showroom</CardTitle>
            <CardDescription>
              Actual sales value against the configured revenue target.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EChart
              kind="bar"
              data={data.branches.map((branch) => ({
                name: branch.name,
                value: branch.sales_value,
                secondary: branch.sales_target,
              }))}
              seriesNames={['Booked sales', 'Target']}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Booking and test-drive progress</CardTitle>
            <CardDescription>Counts are displayed separately from revenue targets.</CardDescription>
          </CardHeader>
          <CardContent>
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
              {data.kpis.test_drives.toLocaleString()} /{' '}
              {data.kpis.drive_target ? data.kpis.drive_target.toLocaleString() : 'not configured'}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Showroom target attainment</CardTitle>
          <CardDescription>
            Only branch-level targets are included; individual and team targets remain separate.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
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
                      {branch.sales_target ? currency(branch.sales_target) : '—'}
                    </TableCell>
                    <TableCell className="text-right">{currency(branch.sales_value)}</TableCell>
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
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No accessible active showrooms are available.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
