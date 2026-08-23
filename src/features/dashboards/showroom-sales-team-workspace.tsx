'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CircleDot, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { fetchShowroomSalesTeam } from './showroom-sales-team-api';

function percent(value: number, total: number) {
  return total > 0 ? (value / total) * 100 : 0;
}

function roleLabel(value: 'SALES_CONSULTANT' | 'TELECALLER_BDC') {
  return value === 'SALES_CONSULTANT' ? 'Sales consultant' : 'Telecaller / BDC';
}

export function ShowroomSalesTeamWorkspace() {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [days, setDays] = useState<7 | 30>(7);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const query = useQuery({
    queryKey: ['showroom-sales-team', ...queryScope, days, page, pageSize],
    queryFn: ({ signal }) => fetchShowroomSalesTeam({ days, page, pageSize }, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <h1 className="font-semibold">Showroom team data is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page requires a single authorized branch and manager sales permissions.
          </p>
        </CardContent>
      </Card>
    );

  const data = query.data;
  const pages = Math.max(1, Math.ceil(data.total / pageSize));
  const metrics: Metric[] = [
    {
      label: 'Total consultants',
      value: String(data.kpis.consultants),
      helper: data.branch.name,
      icon: UsersRound,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Active in period',
      value: String(data.kpis.active_in_period),
      helper: `Activity in last ${days} days`,
      icon: CircleDot,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Leads assigned',
      value: String(data.kpis.active_leads),
      helper: 'Open assigned leads',
      icon: UsersRound,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Test drives',
      value: String(data.kpis.test_drives),
      helper: `Scheduled in last ${days} days`,
      icon: CircleDot,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Bookings',
      value: String(data.kpis.bookings),
      helper: `Created in last ${days} days`,
      icon: CircleDot,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Team conversion',
      value: `${data.kpis.conversion.toFixed(1)}%`,
      helper: 'Bookings / open leads',
      icon: CircleDot,
      tone: 'bg-rose-50 text-rose-600',
    },
  ];
  const workload = [
    ['0–10 leads', data.workload.up_to_10],
    ['11–20 leads', data.workload.up_to_20],
    ['21–30 leads', data.workload.up_to_30],
    ['30+ leads', data.workload.over_30],
  ] as const;

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-2 text-xs">
            <span className="text-primary">Dashboard</span>
            <span className="mx-2 text-muted-foreground">›</span>
            <span className="text-muted-foreground">Sales teams</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Showroom Sales Team</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Monitor consultant workload and real sales activity at {data.branch.name}.
          </p>
        </div>
        <Select
          value={String(days)}
          onValueChange={(value) => {
            setDays(Number(value) as 7 | 30);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <KpiGrid metrics={metrics} className="xl:grid-cols-6" />
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">Consultant performance</CardTitle>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => {
              setPageSize(Number(value) as 25 | 50 | 100);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="25">25 rows</SelectItem>
              <SelectItem value="50">50 rows</SelectItem>
              <SelectItem value="100">100 rows</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Consultant</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Open leads</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Test drives</TableHead>
                <TableHead>Quotes</TableHead>
                <TableHead>Bookings</TableHead>
                <TableHead>Conversion</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.records.map((record) => {
                const conversion = percent(record.bookings, record.active_leads);
                const target = record.sales_target
                  ? percent(record.sales_value, record.sales_target)
                  : null;
                const active =
                  record.calls + record.test_drives + record.quotations + record.bookings > 0;
                return (
                  <TableRow key={record.user_id}>
                    <TableCell>{record.rank}</TableCell>
                    <TableCell className="font-medium">{record.full_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {roleLabel(record.member_type)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={active ? 'success' : 'outline'}>
                        {active ? 'Activity in period' : 'No activity in period'}
                      </Badge>
                    </TableCell>
                    <TableCell>{record.active_leads}</TableCell>
                    <TableCell>{record.calls}</TableCell>
                    <TableCell>{record.test_drives}</TableCell>
                    <TableCell>{record.quotations}</TableCell>
                    <TableCell>{record.bookings}</TableCell>
                    <TableCell>{conversion.toFixed(1)}%</TableCell>
                    <TableCell>{target === null ? 'Not set' : `${target.toFixed(0)}%`}</TableCell>
                  </TableRow>
                );
              })}
              {!data.records.length && (
                <TableRow>
                  <TableCell
                    colSpan={11}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    No active consultants are assigned to this showroom.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className="flex items-center justify-between border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Showing {data.total ? (page - 1) * pageSize + 1 : 0}–
            {Math.min(page * pageSize, data.total)} of {data.total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              aria-label="Previous page"
              className="size-8"
              disabled={page === 1}
              onClick={() => setPage((current) => current - 1)}
              size="icon"
              variant="outline"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page} of {pages}
            </span>
            <Button
              aria-label="Next page"
              className="size-8"
              disabled={page >= pages}
              onClick={() => setPage((current) => current + 1)}
              size="icon"
              variant="outline"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Team distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <EChart
              kind="donut"
              data={data.distribution.map((item) => ({
                name: roleLabel(item.name as 'SALES_CONSULTANT' | 'TELECALLER_BDC'),
                value: item.value,
              }))}
            />
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Active team membership by role.
            </p>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Workload balance (open leads)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {workload.map(([label, value]) => (
              <div key={label}>
                <div className="mb-2 flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="font-semibold">{value}</span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${percent(value, data.kpis.consultants)}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
