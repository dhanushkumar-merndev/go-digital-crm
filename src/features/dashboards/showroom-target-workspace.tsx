'use client';

import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  CarFront,
  ChartNoAxesCombined,
  Target,
  TriangleAlert,
  Trophy,
} from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { fetchShowroomTarget } from './showroom-target-api';

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

function percent(value: number, target: number) {
  return target > 0 ? (value / target) * 100 : null;
}

export function ShowroomTargetWorkspace() {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [month, setMonth] = useState(currentMonth);
  const query = useQuery({
    queryKey: ['showroom-target', ...queryScope, month],
    queryFn: ({ signal }) => fetchShowroomTarget(month, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <TriangleAlert className="mx-auto size-8 text-destructive" />
          <h1 className="mt-4 font-semibold">Showroom target data is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page requires one authorized showroom branch and sales-view permission.
          </p>
        </CardContent>
      </Card>
    );

  const data = query.data;
  const salesAchievement = percent(data.kpis.sales_value, data.kpis.sales_target);
  const bookingAchievement = percent(data.kpis.bookings, data.kpis.booking_target);
  const driveAchievement = percent(data.kpis.test_drives, data.kpis.drive_target);
  const metrics: Metric[] = [
    {
      label: 'Monthly sales target',
      value: data.kpis.sales_target ? currency(data.kpis.sales_target) : 'Not configured',
      helper: data.kpis.sales_target ? 'Branch revenue target' : 'Set a branch revenue target',
      icon: Target,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Achieved sales',
      value: currency(data.kpis.sales_value),
      helper:
        salesAchievement === null
          ? 'No sales target configured'
          : `${salesAchievement.toFixed(1)}% of target`,
      icon: ChartNoAxesCombined,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Booking target',
      value: data.kpis.booking_target
        ? data.kpis.booking_target.toLocaleString()
        : 'Not configured',
      helper: `${data.kpis.bookings.toLocaleString()} bookings this month`,
      icon: CalendarDays,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Test-drive target',
      value: data.kpis.drive_target ? data.kpis.drive_target.toLocaleString() : 'Not configured',
      helper: `${data.kpis.test_drives.toLocaleString()} test drives this month`,
      icon: CarFront,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];
  const best = data.consultants[0];
  const atRisk = data.consultants
    .filter(
      (consultant) =>
        consultant.sales_target > 0 && consultant.sales_value < consultant.sales_target,
    )
    .sort(
      (left, right) =>
        left.sales_value / left.sales_target - right.sales_value / right.sales_target,
    )
    .slice(0, 4);

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-2 text-xs">
            <span className="text-primary">Dashboard</span>
            <span className="mx-2 text-muted-foreground">›</span>
            <span className="text-muted-foreground">Showroom targets</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Showroom Target</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.branch.name} · actual booked sales and configured branch targets.
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
            <CardTitle className="text-base">Sales value vs pacing target</CardTitle>
          </CardHeader>
          <CardContent>
            <EChart
              kind="bar"
              data={data.daily.map((day) => ({
                name: day.day,
                value: day.sales_value,
                secondary: day.target_to_date,
              }))}
              seriesNames={['Booked sales', 'Pacing target']}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Achievement progression</CardTitle>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={data.daily.map((day, index) => {
                const cumulative = data.daily
                  .slice(0, index + 1)
                  .reduce((total, item) => total + item.sales_value, 0);
                return {
                  name: day.day,
                  value:
                    salesAchievement === null
                      ? cumulative
                      : (percent(cumulative, data.kpis.sales_target) ?? 0),
                  secondary:
                    salesAchievement === null
                      ? undefined
                      : (percent(day.target_to_date, data.kpis.sales_target) ?? 0),
                };
              })}
              seriesNames={['Actual %', 'Pacing %']}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Pacing is distributed evenly across the selected month; it is not a forecast.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[.85fr_1.15fr]">
        <Card className="overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Model-wise booked sales</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Bookings</TableHead>
                  <TableHead className="text-right">Sales value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.models.map((model) => (
                  <TableRow key={model.model}>
                    <TableCell className="font-medium">{model.model}</TableCell>
                    <TableCell>{model.bookings}</TableCell>
                    <TableCell className="text-right font-medium">
                      {currency(model.sales_value)}
                    </TableCell>
                  </TableRow>
                ))}
                {!data.models.length && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No booked sales in this month.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card className="overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Consultant-wise target progress</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Consultant</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Achieved</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Bookings</TableHead>
                  <TableHead>Test drives</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.consultants.map((consultant) => {
                  const achievement = percent(consultant.sales_value, consultant.sales_target);
                  return (
                    <TableRow key={consultant.user_id}>
                      <TableCell className="font-medium">{consultant.full_name}</TableCell>
                      <TableCell>
                        {consultant.sales_target ? currency(consultant.sales_target) : '—'}
                      </TableCell>
                      <TableCell>{currency(consultant.sales_value)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            achievement !== null && achievement >= 100 ? 'success' : 'outline'
                          }
                        >
                          {achievement === null ? 'Target not set' : `${achievement.toFixed(0)}%`}
                        </Badge>
                      </TableCell>
                      <TableCell>{consultant.bookings}</TableCell>
                      <TableCell>{consultant.test_drives}</TableCell>
                    </TableRow>
                  );
                })}
                {!data.consultants.length && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No active consultants in this showroom.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Best performing consultant</CardTitle>
          </CardHeader>
          <CardContent>
            {best ? (
              <>
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-full bg-emerald-50 text-emerald-600">
                    <Trophy className="size-5" />
                  </span>
                  <div>
                    <p className="font-semibold">{best.full_name}</p>
                    <p className="text-sm text-muted-foreground">
                      {currency(best.sales_value)} booked sales
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-sm text-muted-foreground">
                  {best.sales_target
                    ? `${(percent(best.sales_value, best.sales_target) ?? 0).toFixed(1)}% of individual target`
                    : 'Individual target is not configured.'}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No consultant activity in this period.
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Target at risk</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {atRisk.length ? (
              atRisk.map((consultant) => (
                <div
                  className="flex items-center justify-between gap-2 text-sm"
                  key={consultant.user_id}
                >
                  <span className="font-medium">{consultant.full_name}</span>
                  <span className="text-destructive">
                    Gap {currency(consultant.sales_target - consultant.sales_value)}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No configured individual targets are behind pace.
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Month position</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {salesAchievement === null ? '—' : `${salesAchievement.toFixed(1)}%`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {salesAchievement === null
                ? 'Configure a sales-value target to calculate achievement.'
                : `${currency(Math.max(data.kpis.sales_target - data.kpis.sales_value, 0))} remaining to branch target.`}
            </p>
            <div className="mt-4 flex gap-2 text-xs">
              <Badge
                variant={
                  bookingAchievement !== null && bookingAchievement >= 100 ? 'success' : 'outline'
                }
              >
                Bookings {bookingAchievement === null ? '—' : `${bookingAchievement.toFixed(0)}%`}
              </Badge>
              <Badge
                variant={
                  driveAchievement !== null && driveAchievement >= 100 ? 'success' : 'outline'
                }
              >
                Drives {driveAchievement === null ? '—' : `${driveAchievement.toFixed(0)}%`}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
