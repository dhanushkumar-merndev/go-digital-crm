'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, Clock3, PhoneCall, TriangleAlert } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Metric } from '@/lib/domain';
import { fetchTeamManagerPerformance } from './team-manager-performance-api';

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

export function TeamCallMonitor() {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const query = useQuery({
    queryKey: ['team-call-monitor', ...queryScope, days],
    queryFn: ({ signal }) => fetchTeamManagerPerformance(days, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <TriangleAlert className="mx-auto size-8 text-destructive" />
          <h1 className="mt-4 font-semibold">Team calls are unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm that you manage an active team and can view calls.
          </p>
        </CardContent>
      </Card>
    );
  const data = query.data;
  const connectionRate = data.kpis.calls
    ? Math.round((data.kpis.connected_calls / data.kpis.calls) * 100)
    : 0;
  const average = data.kpis.calls ? Math.round(data.kpis.talk_seconds / data.kpis.calls) : 0;
  const metrics: Metric[] = [
    {
      label: 'Calls',
      value: data.kpis.calls.toLocaleString(),
      helper: `Last ${days} days`,
      icon: PhoneCall,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Connected',
      value: data.kpis.connected_calls.toLocaleString(),
      helper: `${connectionRate}% connection rate`,
      icon: CheckCircle2,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Talk time',
      value: duration(data.kpis.talk_seconds),
      helper: 'Connected and logged calls',
      icon: Clock3,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Average duration',
      value: duration(average),
      helper: 'Per logged call',
      icon: Clock3,
      tone: 'bg-orange-50 text-orange-600',
    },
  ];
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-xs">
            <span className="text-primary">Dashboard</span>
            <span className="mx-2 text-muted-foreground">›</span>
            <span className="text-muted-foreground">Team Calls</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Team Call Monitor</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Monitor your team&apos;s call activity and connection quality in the selected period.
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
      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />
      <div className="grid gap-4 xl:grid-cols-[1.1fr_.9fr]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Team calls by day</CardTitle>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={data.daily.map((day) => ({
                name: day.name,
                value: day.calls,
                secondary: day.bookings,
              }))}
              seriesNames={['Calls', 'Bookings from team']}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Call quality snapshot</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-emerald-50/50 p-4">
              <p className="text-xs text-muted-foreground">Connected calls</p>
              <p className="mt-2 text-2xl font-bold">{data.kpis.connected_calls}</p>
              <p className="mt-1 text-xs text-emerald-700">{connectionRate}% of logged calls</p>
            </div>
            <div className="rounded-lg border bg-blue-50/50 p-4">
              <p className="text-xs text-muted-foreground">Calls not connected</p>
              <p className="mt-2 text-2xl font-bold">
                {Math.max(0, data.kpis.calls - data.kpis.connected_calls)}
              </p>
              <p className="mt-1 text-xs text-blue-700">Review outcome in call records</p>
            </div>
            <div className="rounded-lg border p-4 sm:col-span-2">
              <p className="text-xs text-muted-foreground">Team activity context</p>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {data.kpis.test_drives} test drives and {data.kpis.quotations} quotations were
                created by the same authorized team in this period.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Consultant call performance</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Consultant</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead>Connection rate</TableHead>
                <TableHead>Talk time</TableHead>
                <TableHead>Bookings</TableHead>
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
                        <span className="font-medium">{member.full_name}</span>
                      </div>
                    </TableCell>
                    <TableCell>{member.calls}</TableCell>
                    <TableCell>{member.connected_calls}</TableCell>
                    <TableCell>
                      <Badge variant={rate >= 60 ? 'success' : 'outline'}>{rate}%</Badge>
                    </TableCell>
                    <TableCell>{duration(member.talk_seconds)}</TableCell>
                    <TableCell>{member.bookings}</TableCell>
                  </TableRow>
                );
              })}
              {!data.leaderboard.length && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No active consultants are assigned to this team.
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
