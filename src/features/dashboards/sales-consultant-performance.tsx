'use client';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  CarFront,
  CheckCircle2,
  Clock3,
  Phone,
  Target,
  TriangleAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Metric } from '@/lib/domain';
import { fetchSalesPerformance } from './sales-consultant-performance-api';

const duration = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
export function SalesConsultantPerformance() {
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const query = useQuery({
    queryKey: ['sales-consultant-performance', days],
    queryFn: ({ signal }) => fetchSalesPerformance(days, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <PageSkeleton />;
  if (query.isError)
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <TriangleAlert className="mx-auto text-destructive" />
          <p className="mt-3 font-semibold">Performance data could not be loaded</p>
          <p className="text-sm text-muted-foreground">
            Apply the personal-performance migration and confirm your scoped role assignment.
          </p>
        </CardContent>
      </Card>
    );
  const d = query.data;
  const contact = d.kpis.leads ? Math.round((d.kpis.contacted / d.kpis.leads) * 100) : 0;
  const metrics: Metric[] = [
    {
      label: 'Leads Assigned',
      value: String(d.kpis.leads),
      icon: UserPlus,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Contact Rate',
      value: `${contact}%`,
      icon: Users,
      tone: 'bg-indigo-50 text-indigo-600',
    },
    {
      label: 'Calls',
      value: String(d.kpis.calls),
      icon: Phone,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Connected Calls',
      value: String(d.kpis.connected_calls),
      icon: CheckCircle2,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Talk Time',
      value: duration(d.kpis.talk_seconds),
      icon: Clock3,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Appointments',
      value: String(d.kpis.appointments),
      icon: CalendarDays,
      tone: 'bg-rose-50 text-rose-600',
    },
    {
      label: 'Test Drives',
      value: String(d.kpis.test_drives),
      icon: Target,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Bookings',
      value: String(d.kpis.bookings),
      icon: CarFront,
      tone: 'bg-green-50 text-green-600',
    },
    {
      label: 'Average Response Time',
      value: duration(d.kpis.average_response_seconds),
      icon: Clock3,
      tone: 'bg-orange-50 text-orange-600',
    },
  ];
  const funnel = [
    { name: 'Leads Assigned', value: d.kpis.leads },
    { name: 'Contacted', value: d.kpis.contacted },
    { name: 'Connected Calls', value: d.kpis.connected_calls },
    { name: 'Appointments', value: d.kpis.appointments },
    { name: 'Test Drives', value: d.kpis.test_drives },
    { name: 'Bookings', value: d.kpis.bookings },
  ];
  const summary = [
    ['leads', d.kpis.leads, 'Leads Assigned'],
    ['contacted', d.kpis.contacted, 'Contacted'],
    ['connected_calls', d.kpis.connected_calls, 'Connected Calls'],
    ['appointments', d.kpis.appointments, 'Appointments'],
    ['test_drives', d.kpis.test_drives, 'Test Drives'],
    ['bookings', d.kpis.bookings, 'Bookings'],
  ] as const;
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-xs">
            <span className="text-primary">Dashboard</span>
            <span className="mx-2 text-muted-foreground">›</span>
            <span className="text-muted-foreground">My Performance</span>
          </div>
          <h1 className="text-2xl font-bold">My Performance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track your personal activity, conversion and target achievement.
          </p>
        </div>
        <Select
          value={String(days)}
          onValueChange={(value) => setDays(Number(value) as 7 | 14 | 30)}
        >
          <SelectTrigger className="w-48">
            <CalendarDays className="size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="14">Last 14 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <KpiGrid metrics={metrics.slice(0, 5)} className="xl:grid-cols-5" />
      <KpiGrid metrics={metrics.slice(5)} className="xl:grid-cols-4" />
      <div className="grid gap-4 xl:grid-cols-3">
        <Chart title="Calls by Day">
          <EChart
            kind="line"
            data={d.daily.map((x) => ({ name: x.name, value: x.calls, secondary: x.connected }))}
            seriesNames={['Calls', 'Connected Calls']}
          />
        </Chart>
        <Chart title="Lead Conversion Funnel">
          <EChart kind="funnel" data={funnel} funnelMode="staged" />
        </Chart>
        <Chart title="Appointment Trend">
          <EChart
            kind="line"
            data={d.daily.map((x) => ({
              name: x.name,
              value: x.appointments,
              secondary: x.test_drives,
            }))}
            seriesNames={['Appointments', 'Test Drives']}
          />
        </Chart>
      </div>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Performance Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {summary.map(([key, value, label]) => {
            const target = d.targets[key];
            const percent = target ? Math.round((value / target) * 100) : null;
            return (
              <div key={key} className="border-r pr-4 last:border-0">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-2 text-lg font-bold">
                  {value}
                  {target ? ` / ${target}` : ''}
                </p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full bg-blue-600"
                    style={{ width: `${Math.min(percent ?? 0, 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs font-medium text-muted-foreground">
                  {percent === null ? 'Target not set' : `${percent}% of target`}
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>
      <p className="text-center text-xs text-muted-foreground">
        Performance is calculated from your authorized records for the selected period.
      </p>
    </div>
  );
}
function Chart({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
