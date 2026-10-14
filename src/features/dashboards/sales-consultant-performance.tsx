'use client';
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
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { SalesConsultantPerformanceSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Metric } from '@/lib/domain';
import { performanceRangeForLastDays } from '@/lib/performance-date-range';
import {
  AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { usePersistedQuery } from '@/lib/query/persisted-query';
import type { z } from 'zod';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { salesConsultantKeys } from '@/features/sales-consultant/sales-consultant-cache';
import {
  fetchTelecallerPerformance,
  fetchSalesPerformance,
  salesPerformanceSchema,
  telecallerPerformanceSchema,
  type SalesPerformance,
  type TelecallerPerformance,
} from './sales-consultant-performance-api';
import { SalesHandoffReport } from './sales-handoff-report';
import { TelecallerActivityChart } from './telecaller-activity-chart';

const duration = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export function SalesConsultantPerformance({ role = 'sales-consultant' }: { role?: string }) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const [range, setRange] = useState(() => performanceRangeForLastDays(7));
  const query = usePersistedQuery<SalesPerformance | TelecallerPerformance>({
    queryKey: [
      ...salesConsultantKeys.performance(queryScope),
      role,
      'activity-v2',
      range.from,
      range.to,
    ],
    queryFn: async ({ signal }) =>
      role === 'telecaller'
        ? fetchTelecallerPerformance(range, signal)
        : fetchSalesPerformance(range, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: {
      version: 1,
      // The key carries the role, so each role's copy is checked by its own schema.
      schema: (role === 'telecaller'
        ? telecallerPerformanceSchema
        : salesPerformanceSchema) as z.ZodType<SalesPerformance | TelecallerPerformance>,
    },
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
      minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
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
        helper: `${d.kpis.leads ? Math.round((telecallerKpis.qualified / d.kpis.leads) * 100) : 0}% of leads assigned`,
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
        helper: `${telecallerKpis.qualified ? Math.round((telecallerKpis.transferred / telecallerKpis.qualified) * 100) : 0}% of qualified leads`,
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
  // The KPI cards already show every count; this card only adds progress
  // against a target, so a metric without one is left out.
  const targeted = summary.filter(([key]) => d.targets[key]);

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
          <PerformanceDateRangeSelector value={range} onChange={setRange} includeAllTime />
        </div>
      </div>
      <KpiGrid metrics={metrics.slice(0, 5)} className="xl:grid-cols-5" />
      <KpiGrid metrics={metrics.slice(5)} className="xl:grid-cols-4" />
      {telecaller ? (
        <TelecallerActivityChart
          key={`${range.from}:${range.to}`}
          rows={(d as TelecallerPerformance).daily}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
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
      )}
      {targeted.length > 0 ? (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Target Progress</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {targeted.map(([key, value, label]) => {
              const target = d.targets[key];
              const percent = Math.round((value / target) * 100);
              return (
                <div key={key} className="border-r pr-4 last:border-0">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-2 text-lg font-bold">
                    {value} / {target}
                  </p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full bg-blue-600"
                      style={{ width: `${Math.min(percent, 100)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs font-medium text-muted-foreground">
                    {percent}% of target
                  </p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}
      {telecaller ? <SalesHandoffReport preset="TELECALLER" range={range} /> : null}
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
