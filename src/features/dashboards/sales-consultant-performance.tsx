'use client';
import type { PageSpec } from '@/lib/domain';
import { PageHeader } from '@/components/shared/page-header';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
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
import { SalesActivityChart, TelecallerActivityChart } from './telecaller-activity-chart';

const duration = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/** Whether every step is at most the one before it, so a funnel shape is honest. */
function funnelNarrows(stages: Array<{ value: number }>) {
  return stages.every((stage, index) => index === 0 || stage.value <= stages[index - 1]!.value);
}

export function SalesConsultantPerformance({
  spec,
  role = 'sales-consultant',
}: {
  spec: PageSpec;
  role?: string;
}) {
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
  const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
  // One row of eight, the same frame for both roles: who was assigned and
  // reached, the call effort, the two outcomes that role owns, the conversion
  // between them, and the target. Talk time, connection rate, response time and
  // follow-ups ride on the tile they explain instead of taking a tile each.
  const outcome = telecallerKpis
    ? { key: 'transferred', value: telecallerKpis.transferred, label: 'transfers' }
    : { key: 'bookings', value: salesKpis?.bookings ?? 0, label: 'bookings' };
  const outcomeTarget = d.targets[outcome.key];
  const metrics: Metric[] = [
    {
      label: 'Leads assigned',
      value: String(d.kpis.leads),
      helper: 'In the selected period',
      icon: UserPlus,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Contacted',
      value: String(d.kpis.contacted),
      helper: salesKpis
        ? `${percent(d.kpis.contacted, d.kpis.leads)}% · first reply ${duration(salesKpis.average_response_seconds)}`
        : `${percent(d.kpis.contacted, d.kpis.leads)}% of leads assigned`,
      icon: Users,
      tone: 'bg-indigo-50 text-indigo-600',
    },
    {
      label: 'Calls',
      value: String(d.kpis.calls),
      helper: `${duration(d.kpis.talk_seconds)} talk time`,
      icon: Phone,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Connected calls',
      value: String(d.kpis.connected_calls),
      helper: `${percent(d.kpis.connected_calls, d.kpis.calls)}% connection rate`,
      icon: CheckCircle2,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    ...(telecallerKpis
      ? [
          {
            label: 'Qualified',
            value: String(telecallerKpis.qualified),
            helper: `${telecallerKpis.followups_completed} follow-ups completed`,
            icon: Target,
            tone: 'bg-teal-50 text-teal-600',
          },
          {
            label: 'Transferred to sales',
            value: String(telecallerKpis.transferred),
            helper: `${percent(telecallerKpis.transferred, telecallerKpis.qualified)}% of qualified`,
            icon: UserPlus,
            tone: 'bg-emerald-50 text-emerald-600',
          },
        ]
      : [
          {
            label: 'Test drives',
            value: String(salesKpis?.test_drives ?? 0),
            helper: `${salesKpis?.appointments ?? 0} appointments`,
            icon: Target,
            tone: 'bg-cyan-50 text-cyan-600',
          },
          {
            label: 'Bookings',
            value: String(salesKpis?.bookings ?? 0),
            // Bookings and test drives in one period are not one cohort, so no ratio.
            helper: 'Created in the selected period',
            icon: CarFront,
            tone: 'bg-green-50 text-green-600',
          },
        ]),
    {
      label: 'Conversion',
      value: `${percent(outcome.value, d.kpis.leads)}%`,
      helper: `${outcome.label} per lead assigned`,
      icon: CalendarDays,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Target achievement',
      value: outcomeTarget ? `${percent(outcome.value, outcomeTarget)}%` : '—',
      helper: outcomeTarget
        ? `${outcome.value} of ${outcomeTarget} ${outcome.label}`
        : `No ${outcome.label} target set`,
      icon: Clock3,
      tone: 'bg-rose-50 text-rose-600',
    },
  ];
  // Lead steps only: connected calls count calls, not leads, so they are a tile.
  const funnel = [
    { name: 'Leads assigned', value: d.kpis.leads },
    { name: 'Contacted', value: d.kpis.contacted },
    { name: 'Appointments', value: salesKpis?.appointments ?? 0 },
    { name: 'Test drives', value: salesKpis?.test_drives ?? 0 },
    { name: 'Bookings', value: salesKpis?.bookings ?? 0 },
  ];
  const summary: readonly (readonly [string, number, string])[] = telecallerKpis
    ? [
        ['leads', telecallerKpis.leads, 'Leads assigned'],
        ['contacted', telecallerKpis.contacted, 'Leads contacted'],
        ['connected_calls', telecallerKpis.connected_calls, 'Connected calls'],
        ['qualified', telecallerKpis.qualified, 'Qualified leads'],
        ['followups_completed', telecallerKpis.followups_completed, 'Follow-ups completed'],
        ['transferred', telecallerKpis.transferred, 'Transferred to sales'],
      ]
    : ([
        ['leads', d.kpis.leads, 'Leads assigned'],
        ['contacted', d.kpis.contacted, 'Contacted'],
        ['connected_calls', d.kpis.connected_calls, 'Connected calls'],
        ['appointments', salesKpis?.appointments ?? 0, 'Appointments'],
        ['test_drives', salesKpis?.test_drives ?? 0, 'Test drives'],
        ['bookings', salesKpis?.bookings ?? 0, 'Bookings'],
      ] as const);
  const rateOf = (label: string, part: number, whole: number) => ({
    label,
    part,
    whole,
    percent: whole ? Math.round((part / whole) * 100) : 0,
  });
  // Each step against the one it follows from, so every bar answers "of those,
  // how many went further".
  const rates = telecallerKpis
    ? {
        description: 'How your leads moved in the period',
        rows: [
          rateOf('Contacted of leads assigned', d.kpis.contacted, d.kpis.leads),
          rateOf('Connected of calls made', d.kpis.connected_calls, d.kpis.calls),
          rateOf('Qualified of leads contacted', telecallerKpis.qualified, d.kpis.contacted),
          rateOf(
            'Transferred of leads qualified',
            telecallerKpis.transferred,
            telecallerKpis.qualified,
          ),
          rateOf('Transferred of leads assigned', telecallerKpis.transferred, d.kpis.leads),
        ],
      }
    : {
        description: 'Each step per lead assigned in the period',
        rows: [
          rateOf('Contacted', d.kpis.contacted, d.kpis.leads),
          rateOf('Connected of calls made', d.kpis.connected_calls, d.kpis.calls),
          rateOf('Appointments', salesKpis?.appointments ?? 0, d.kpis.leads),
          rateOf('Test drives', salesKpis?.test_drives ?? 0, d.kpis.leads),
          rateOf('Bookings', salesKpis?.bookings ?? 0, d.kpis.leads),
        ],
      };
  // Progress against a target only; a metric without one is left out.
  const targeted = summary.filter(([key]) => d.targets[key]);

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description="Your activity, conversion and target achievement."
        actions={
          <>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <PerformanceDateRangeSelector value={range} onChange={setRange} includeAllTime />
            </div>
          </>
        }
      />
      <KpiGrid metrics={metrics} />
      {telecaller ? (
        <TelecallerActivityChart
          key={`${range.from}:${range.to}`}
          rows={(d as TelecallerPerformance).daily}
        />
      ) : (
        <SalesActivityChart
          key={`${range.from}:${range.to}`}
          rows={(d as SalesPerformance).daily}
        />
      )}
      <div className={cn('grid gap-4', telecaller ? 'xl:grid-cols-2' : 'xl:grid-cols-3')}>
        {!telecaller &&
          // Each step counts what happened in the period, not one group of leads
          // moving down, so a later step can be larger (bookings from leads
          // assigned earlier). A funnel would draw 14 bookings under 9 test
          // drives; bars show the counts as they are.
          (funnelNarrows(funnel) ? (
            <Chart title="Lead conversion funnel" description="Leads at each step in the period">
              <EChart
                kind="funnel"
                data={funnel}
                funnelMode="staged"
                funnelStages={funnel.length}
                funnelLabels="side"
              />
            </Chart>
          ) : (
            <Chart
              title="Sales steps in the period"
              description="Each step's count for these dates; bookings can come from leads assigned earlier"
            >
              <EChart
                kind="bar"
                data={funnel}
                series={[{ name: 'Count', values: funnel.map((stage) => stage.value) }]}
              />
            </Chart>
          ))}
        <Chart title="Conversion rates" description={rates.description}>
          <div className="space-y-4 pt-1">
            {rates.rows.map((rate) => (
              <div key={rate.label}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-medium text-heading-soft">{rate.label}</span>
                  <span>
                    <span className="font-semibold text-heading">{rate.percent}%</span>
                    <span className="ml-1.5 text-muted-foreground">
                      {rate.part} of {rate.whole}
                    </span>
                  </span>
                </div>
                <Progress className="mt-1.5 h-1.5" value={Math.min(rate.percent, 100)} />
              </div>
            ))}
          </div>
        </Chart>
        <Chart
          title="Target progress"
          description={
            targeted.length
              ? 'Your targets for this period'
              : 'Targets set by your manager appear here'
          }
        >
          {targeted.length ? (
            <div className="space-y-4 pt-1">
              {targeted.map(([key, value, label]) => {
                const target = d.targets[key];
                const percent = Math.round((value / target) * 100);
                return (
                  <div key={key}>
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="font-medium text-heading-soft">{label}</span>
                      <span>
                        <span className="font-semibold text-heading">{percent}%</span>
                        <span className="ml-1.5 text-muted-foreground">
                          {value} of {target}
                        </span>
                      </span>
                    </div>
                    <Progress className="mt-1.5 h-1.5" value={Math.min(percent, 100)} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center">
              <Target className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium text-heading">No targets for this period</p>
              <p className="max-w-64 text-xs text-muted-foreground">
                When your manager sets targets for these dates, your progress against each one shows
                here.
              </p>
            </div>
          )}
        </Chart>
      </div>
      {telecaller ? <SalesHandoffReport preset="TELECALLER" range={range} /> : null}
      <p className="text-center text-xs text-muted-foreground">
        {telecaller
          ? 'Activity is credited to the person who performed it, by activity date (IST). Leads contacted, qualified and transferred count distinct leads in the period. Targets are shown only for matching dates.'
          : 'Performance is calculated from your authorized records for the selected period.'}
      </p>
    </div>
  );
}
function Chart({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}
