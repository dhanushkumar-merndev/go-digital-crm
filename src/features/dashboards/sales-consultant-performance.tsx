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
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { SalesConsultantPerformanceSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Metric } from '@/lib/domain';
import { istToday, toDateInputValue } from '@/components/ui/day-picker';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { salesConsultantKeys } from '@/features/sales-consultant/sales-consultant-cache';
import {
  fetchTelecallerPerformance,
  fetchSalesPerformance,
} from './sales-consultant-performance-api';

const duration = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

const performancePeriods = [7, 14, 30] as const;

function rangeStartFor(days: number, end = istToday()) {
  const date = new Date(`${end}T00:00:00`);
  date.setDate(date.getDate() - (days - 1));
  return toDateInputValue(date);
}

function inclusiveDays(start: string, end: string) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  return Math.round((endTime - startTime) / 86_400_000) + 1;
}

export function SalesConsultantPerformance({ role = 'sales-consultant' }: { role?: string }) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const [rangeStart, setRangeStart] = useState(() => rangeStartFor(7));
  const today = istToday();
  const selectPeriod = (nextDays: 7 | 14 | 30) => {
    setDays(nextDays);
    setRangeStart(rangeStartFor(nextDays, today));
  };
  const selectRangeStart = (nextStart: string) => {
    const rangeDays = inclusiveDays(nextStart, today);
    if (!performancePeriods.includes(rangeDays as 7 | 14 | 30)) return;
    setRangeStart(nextStart);
    setDays(rangeDays as 7 | 14 | 30);
  };
  const query = useQuery({
    queryKey: [...salesConsultantKeys.performance(queryScope), role, 'activity-v2', days],
    queryFn: async ({ signal }) =>
      role === 'telecaller'
        ? fetchTelecallerPerformance(days, signal)
        : fetchSalesPerformance(days, signal),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(
    workspaceSession?.organizationId,
    (
      [
        'leads',
        'communications',
        'work',
        ...(role === 'sales-consultant' ? (['sales'] as const) : []),
      ] as const
    ).map((resource) => ({
      resource,
      queryKeys: [salesConsultantKeys.performance(queryScope)],
    })),
  );
  if (query.isPending) return <SalesConsultantPerformanceSkeleton />;
  if (query.isError)
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <TriangleAlert className="mx-auto text-destructive" />
          <p className="mt-3 font-semibold">Performance data could not be loaded</p>
          <p className="text-sm text-muted-foreground">
            Confirm your scoped role assignment and personal-performance data access.
          </p>
        </CardContent>
      </Card>
    );
  const d = query.data;
  const telecaller = role === 'telecaller';
  const salesKpis = 'appointments' in d.kpis ? d.kpis : null;
  const telecallerKpis = 'transferred' in d.kpis ? d.kpis : null;
  const contact = d.kpis.leads ? Math.round((d.kpis.contacted / d.kpis.leads) * 100) : 0;
  const metrics: Metric[] = [
    {
      label: 'Leads Assigned',
      value: String(d.kpis.leads),
      icon: UserPlus,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: telecaller ? 'Connection Rate' : 'Contact Rate',
      value: `${telecaller ? (d.kpis.calls ? Math.round((d.kpis.connected_calls / d.kpis.calls) * 100) : 0) : contact}%`,
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
      value: String(salesKpis?.appointments ?? 0),
      icon: CalendarDays,
      tone: 'bg-rose-50 text-rose-600',
    },
    {
      label: 'Test Drives',
      value: String(salesKpis?.test_drives ?? 0),
      icon: Target,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Bookings',
      value: String(salesKpis?.bookings ?? 0),
      icon: CarFront,
      tone: 'bg-green-50 text-green-600',
    },
    {
      label: 'Average Response Time',
      value: duration(salesKpis?.average_response_seconds ?? 0),
      icon: Clock3,
      tone: 'bg-orange-50 text-orange-600',
    },
  ];
  if (telecallerKpis) {
    metrics.splice(
      5,
      metrics.length - 5,
      {
        label: 'Leads Contacted',
        value: String(telecallerKpis.contacted),
        icon: Users,
        tone: 'bg-indigo-50 text-indigo-600',
      },
      {
        label: 'Qualified Leads',
        value: String(telecallerKpis.qualified),
        icon: Target,
        tone: 'bg-teal-50 text-teal-600',
      },
      {
        label: 'Follow-ups Completed',
        value: String(telecallerKpis.followups_completed),
        icon: CheckCircle2,
        tone: 'bg-amber-50 text-amber-600',
      },
      {
        label: 'Leads Transferred to Sales',
        value: String(telecallerKpis.transferred),
        icon: UserPlus,
        tone: 'bg-emerald-50 text-emerald-600',
      },
    );
  }
  const funnel = [
    { name: 'Leads Assigned', value: d.kpis.leads },
    { name: 'Contacted', value: d.kpis.contacted },
    { name: 'Connected Calls', value: d.kpis.connected_calls },
    { name: 'Appointments', value: salesKpis?.appointments ?? 0 },
    { name: 'Test Drives', value: salesKpis?.test_drives ?? 0 },
    { name: 'Bookings', value: salesKpis?.bookings ?? 0 },
  ];
  const summary: readonly (readonly [string, number, string])[] = telecallerKpis
    ? [
        ['leads', telecallerKpis.leads, 'Leads Assigned'],
        ['contacted', telecallerKpis.contacted, 'Leads Contacted'],
        ['connected_calls', telecallerKpis.connected_calls, 'Connected Calls'],
        ['qualified', telecallerKpis.qualified, 'Qualified Leads'],
        ['followups_completed', telecallerKpis.followups_completed, 'Follow-ups Completed'],
        ['transferred', telecallerKpis.transferred, 'Leads Transferred to Sales'],
      ]
    : ([
        ['leads', d.kpis.leads, 'Leads Assigned'],
        ['contacted', d.kpis.contacted, 'Contacted'],
        ['connected_calls', d.kpis.connected_calls, 'Connected Calls'],
        ['appointments', salesKpis?.appointments ?? 0, 'Appointments'],
        ['test_drives', salesKpis?.test_drives ?? 0, 'Test Drives'],
        ['bookings', salesKpis?.bookings ?? 0, 'Bookings'],
      ] as const);
  const telecallerQualityMetrics = telecallerKpis
    ? [
        ['Qualified leads', String(telecallerKpis.qualified), 'Leads ready for a Sales handoff'],
        [
          'Qualification rate',
          `${d.kpis.leads ? Math.round((telecallerKpis.qualified / d.kpis.leads) * 100) : 0}%`,
          'Qualified from leads assigned in this period',
        ],
        [
          'Sales handoff rate',
          `${telecallerKpis.qualified ? Math.round((telecallerKpis.transferred / telecallerKpis.qualified) * 100) : 0}%`,
          'Qualified leads successfully transferred to Sales',
        ],
        [
          'Completed follow-ups',
          String(telecallerKpis.followups_completed),
          'Follow-ups closed in this period',
        ],
      ]
    : null;

  return (
    <div className="mx-auto max-w-[1800px] space-y-4">
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
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Select
            value={String(days)}
            onValueChange={(value) => selectPeriod(Number(value) as 7 | 14 | 30)}
          >
            <SelectTrigger className="w-40">
              <CalendarDays className="size-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex h-9 items-center gap-2 rounded-md border bg-background px-2.5 text-xs">
            <CalendarDays className="size-3.5 text-muted-foreground" />
            <Input
              type="date"
              value={rangeStart}
              min={rangeStartFor(30, today)}
              max={rangeStartFor(7, today)}
              onChange={(event) => selectRangeStart(event.target.value)}
              aria-label="Performance period start"
              className="h-7 w-[8.25rem] border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
            />
            <span className="text-muted-foreground">to</span>
            <span className="whitespace-nowrap font-medium text-foreground">{today}</span>
          </div>
        </div>
      </div>
      <KpiGrid metrics={metrics.slice(0, 5)} className="xl:grid-cols-5" />
      <KpiGrid metrics={metrics.slice(5)} className="xl:grid-cols-4" />
      <div className={`grid gap-4 ${telecaller ? 'xl:grid-cols-2' : 'xl:grid-cols-3'}`}>
        <Chart title="Calls by Day">
          <EChart
            kind="line"
            data={d.daily.map((x) => ({ name: x.name, value: x.calls, secondary: x.connected }))}
            seriesNames={['Calls', 'Connected Calls']}
          />
        </Chart>
        {!telecaller && (
          <Chart title="Lead Conversion Funnel">
            <EChart kind="funnel" data={funnel} funnelMode="staged" />
          </Chart>
        )}
        <Chart title={telecaller ? 'Follow-ups and Sales Handoffs' : 'Appointment Trend'}>
          <EChart
            kind="line"
            data={d.daily.map((x) => ({
              name: x.name,
              value: 'followups_completed' in x ? x.followups_completed : x.appointments,
              secondary: 'transferred' in x ? x.transferred : x.test_drives,
            }))}
            seriesNames={
              telecaller
                ? ['Follow-ups Completed', 'Leads Transferred']
                : ['Appointments', 'Test Drives']
            }
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
                  {percent === null
                    ? telecaller
                      ? 'No target for selected dates'
                      : 'Target not set'
                    : `${percent}% of target`}
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>
      {telecallerQualityMetrics ? (
        <Card className="shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Lead Quality &amp; Conversion</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {telecallerQualityMetrics.map(([label, value, helper]) => (
              <div key={label} className="rounded-lg border bg-muted/20 px-4 py-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-xl font-bold tracking-tight">{value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <p className="text-center text-xs text-muted-foreground">
        {telecaller
          ? 'Activity is credited to the person who performed it, by activity date (IST). Leads contacted, qualified and transferred count distinct leads in the period. Targets are shown only for matching dates.'
          : 'Performance is calculated from your authorized records for the selected period.'}
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
