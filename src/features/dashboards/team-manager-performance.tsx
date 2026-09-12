'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CarFront, CheckCircle2, Target, TriangleAlert, Trophy } from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { TeamManagerPerformanceSkeleton } from '@/components/skeletons';
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
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { fetchTeamManagerPerformance } from './team-manager-performance-api';

function formatDuration(seconds: number) {
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

export function TeamManagerPerformance({ heading = 'Team Performance' }: { heading?: string }) {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const query = useQuery({
    queryKey: ['team-manager-performance', ...queryScope, days],
    queryFn: ({ signal }) => fetchTeamManagerPerformance(days, signal),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(
    session?.organizationId,
    (['leads', 'communications', 'work', 'sales'] as const).map((resource) => ({
      resource,
      queryKeys: [['team-manager-performance', ...queryScope]],
    })),
  );
  if (query.isPending) return <TeamManagerPerformanceSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <TriangleAlert className="mx-auto size-8 text-destructive" />
          <h1 className="mt-4 font-semibold">Team performance is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm that you manage an active team and have the required CRM permissions.
          </p>
        </CardContent>
      </Card>
    );

  const data = query.data;
  const metrics: Metric[] = [
    {
      label: 'Team conversion',
      value: `${data.kpis.conversion.toFixed(1)}%`,
      helper: 'Bookings from leads created in period',
      icon: Target,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Total bookings',
      value: data.kpis.bookings.toLocaleString(),
      helper: 'Non-cancelled bookings',
      icon: CarFront,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Connected calls',
      value: data.kpis.connected_calls.toLocaleString(),
      helper: `${data.kpis.calls.toLocaleString()} calls logged`,
      icon: CheckCircle2,
      tone: 'bg-green-50 text-green-600',
    },
    {
      label: 'Team test drives',
      value: data.kpis.test_drives.toLocaleString(),
      helper: `${data.kpis.quotations.toLocaleString()} quotations created`,
      icon: Trophy,
      tone: 'bg-orange-50 text-orange-600',
    },
  ];
  const leaders = data.leaderboard.slice(0, 3);

  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-xs">
            <span className="text-primary">Dashboard</span>
            <span className="mx-2 text-muted-foreground">›</span>
            <span className="text-muted-foreground">Team performance</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Compare your managed consultants using their actual, authorized activity.
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
      <div className="grid gap-4 xl:grid-cols-[1.05fr_1.35fr]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Performance trend</CardTitle>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={data.daily.map((day) => ({
                name: day.name,
                value: day.calls,
                secondary: day.test_drives,
              }))}
              seriesNames={['Calls', 'Test drives']}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Top performers</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            {leaders.length ? (
              leaders.map((member, index) => (
                <div key={member.user_id} className="rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="grid size-8 place-items-center rounded-full bg-amber-50 text-xs font-bold text-amber-700">
                      {index + 1}
                    </span>
                    <Badge variant={index === 0 ? 'success' : 'outline'}>
                      {member.conversion.toFixed(1)}%
                    </Badge>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <span className="grid size-9 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                      {initials(member.full_name)}
                    </span>
                    <p className="min-w-0 truncate text-sm font-semibold">{member.full_name}</p>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <span>
                      Leads <b className="ml-1 text-foreground">{member.leads}</b>
                    </span>
                    <span>
                      Bookings <b className="ml-1 text-foreground">{member.bookings}</b>
                    </span>
                    <span>
                      Calls <b className="ml-1 text-foreground">{member.calls}</b>
                    </span>
                    <span>
                      Drives <b className="ml-1 text-foreground">{member.test_drives}</b>
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No active consultants are assigned.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <Card className="overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Consultant leaderboard</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rank</TableHead>
                <TableHead>Consultant</TableHead>
                <TableHead>Leads</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead>Test drives</TableHead>
                <TableHead>Quotations</TableHead>
                <TableHead>Bookings</TableHead>
                <TableHead>Conversion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.leaderboard.map((member, index) => (
                <TableRow key={member.user_id}>
                  <TableCell className="font-semibold">{index + 1}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="grid size-8 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                        {initials(member.full_name)}
                      </span>
                      <span className="font-medium">{member.full_name}</span>
                    </div>
                  </TableCell>
                  <TableCell>{member.leads}</TableCell>
                  <TableCell>{member.calls}</TableCell>
                  <TableCell>{member.connected_calls}</TableCell>
                  <TableCell>{member.test_drives}</TableCell>
                  <TableCell>{member.quotations}</TableCell>
                  <TableCell>{member.bookings}</TableCell>
                  <TableCell>
                    <Badge variant={member.conversion >= 10 ? 'success' : 'outline'}>
                      {member.conversion.toFixed(1)}%
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {!data.leaderboard.length && (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No active consultants are assigned to your managed team.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-center text-xs text-muted-foreground">
        Results include only records assigned to your active managed team. Talk time:{' '}
        {formatDuration(data.kpis.talk_seconds)}.
      </p>
    </div>
  );
}
