'use client';

import { ErrorState } from '@/components/shared/page-states';
import type { PageSpec } from '@/lib/domain';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { CheckCircle2, Clock3, PhoneCall, PhoneMissed } from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { TeamCallMonitorSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { performanceRangeForLastDays, performanceRangeLabel } from '@/lib/performance-date-range';
import {
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { usePersistedQuery } from '@/lib/query/persisted-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Metric } from '@/lib/domain';
import {
  fetchTeamManagerPerformance,
  teamMemberRole,
  teamPerformanceSchema,
} from './team-manager-performance-api';

function duration(seconds: number) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(
    Math.floor((seconds % 3600) / 60),
  ).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function TeamCallMonitor({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [range, setRange] = useState(() => performanceRangeForLastDays(7));
  const query = usePersistedQuery({
    queryKey: ['team-call-monitor', ...queryScope, range.from, range.to],
    queryFn: ({ signal }) => fetchTeamManagerPerformance(range, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: teamPerformanceSchema },
  });
  if (query.isPending) return <TeamCallMonitorSkeleton />;
  if (query.isError || !query.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="Team calls are unavailable"
          description="Confirm that you manage an active team and can view calls."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );
  const data = query.data;
  const connectionRate = data.kpis.calls
    ? Math.round((data.kpis.connected_calls / data.kpis.calls) * 100)
    : 0;
  const notConnected = Math.max(0, data.kpis.calls - data.kpis.connected_calls);
  // Per connected call, as on the Calls page, so the two averages agree.
  const average = data.kpis.connected_calls
    ? Math.round(data.kpis.talk_seconds / data.kpis.connected_calls)
    : 0;
  const hasDailyConnected = data.daily.some((day) => day.connected_calls !== undefined);
  // The same six tiles, in the same order, as every role's Calls page.
  const metrics: Metric[] = [
    {
      label: 'Calls',
      value: data.kpis.calls.toLocaleString('en-IN'),
      helper: performanceRangeLabel(range),
      icon: PhoneCall,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Connected',
      value: data.kpis.connected_calls.toLocaleString('en-IN'),
      helper: 'Customer answered',
      icon: CheckCircle2,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Connection rate',
      value: `${connectionRate}%`,
      helper: 'Connected of all calls',
      icon: PhoneCall,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Not connected',
      value: notConnected.toLocaleString('en-IN'),
      helper: 'No answer, busy or failed',
      icon: PhoneMissed,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Talk time',
      value: duration(data.kpis.talk_seconds),
      helper: 'Total connected time',
      icon: Clock3,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Average duration',
      value: duration(average),
      helper: 'Per connected call',
      icon: Clock3,
      tone: 'bg-blue-50 text-blue-600',
    },
  ];
  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description="Your team's call activity and connection quality in the selected period."
        actions={<PerformanceDateRangeSelector value={range} onChange={setRange} />}
      />
      <KpiGrid metrics={metrics} />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Team calls by day</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Bars side by side, as on every Calls page: as lines, Connected sat
              on top of Calls on a day every call connected. */}
          <EChart
            kind={data.daily.length <= 31 ? 'bar' : 'line'}
            className="h-64"
            data={data.daily.map((day) => ({ name: day.name, value: day.calls }))}
            series={[
              { name: 'Calls', values: data.daily.map((day) => day.calls) },
              ...(hasDailyConnected
                ? [
                    {
                      name: 'Connected',
                      values: data.daily.map((day) => day.connected_calls ?? 0),
                    },
                  ]
                : []),
            ]}
            colors={['#2563eb', '#14b8a6']}
          />
        </CardContent>
      </Card>
      <Card className="overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Calls by team member</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead>Connection rate</TableHead>
                <TableHead>Talk time</TableHead>
                <TableHead>Average duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.leaderboard.map((member) => {
                const rate = member.calls
                  ? Math.round((member.connected_calls / member.calls) * 100)
                  : 0;
                return (
                  <TableRow key={member.user_id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="grid size-8 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                          {initials(member.full_name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-medium">{member.full_name}</span>
                          {teamMemberRole(member) ? (
                            <span className="block text-[11px] text-muted-foreground">
                              {teamMemberRole(member)}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{member.calls}</TableCell>
                    <TableCell>{member.connected_calls}</TableCell>
                    <TableCell>
                      <Badge variant={rate >= 60 ? 'success' : 'outline'}>{rate}%</Badge>
                    </TableCell>
                    <TableCell>{duration(member.talk_seconds)}</TableCell>
                    <TableCell>
                      {duration(
                        member.connected_calls
                          ? Math.round(member.talk_seconds / member.connected_calls)
                          : 0,
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!data.leaderboard.length && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No active members are assigned to this team.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
