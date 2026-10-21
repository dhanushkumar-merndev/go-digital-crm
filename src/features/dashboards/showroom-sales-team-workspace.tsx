'use client';

import { TablePagination } from '@/components/shared/table-pagination';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { SectionCard } from '@/components/shared/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import type { PageSpec } from '@/lib/domain';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { useQuery } from '@tanstack/react-query';
import { CircleDot, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { ShowroomSalesTeamSkeleton } from '@/components/skeletons';
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
import { formatNumber } from '@/lib/format';
import { performanceRangeForLastDays, performanceRangeLabel } from '@/lib/performance-date-range';
import { fetchShowroomSalesTeam } from './showroom-sales-team-api';

function percent(value: number, total: number) {
  return total > 0 ? (value / total) * 100 : 0;
}

function roleLabel(value: 'SALES_CONSULTANT' | 'TELECALLER_BDC') {
  return value === 'SALES_CONSULTANT' ? 'Sales consultant' : 'Telecaller / BDC';
}

export function ShowroomSalesTeamWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [range, setRange] = useState(() => performanceRangeForLastDays(7));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const query = useQuery({
    queryKey: ['showroom-sales-team', ...queryScope, range.from, range.to, page, pageSize],
    queryFn: ({ signal }) => fetchShowroomSalesTeam({ range, page, pageSize }, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <ShowroomSalesTeamSkeleton />;
  if (query.isError || !query.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="Showroom team data is unavailable"
          description="This page requires a single authorized branch and manager sales permissions."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );

  const data = query.data;
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
      helper: `Activity in ${performanceRangeLabel(range)}`,
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
      helper: `Scheduled in ${performanceRangeLabel(range)}`,
      icon: CircleDot,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Bookings',
      value: String(data.kpis.bookings),
      helper: `Created in ${performanceRangeLabel(range)}`,
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
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description={`Consultant workload and sales activity at ${data.branch.name}.`}
        actions={
          <>
            <PerformanceDateRangeSelector
              value={range}
              onChange={(nextRange) => {
                setRange(nextRange);
                setPage(1);
              }}
            />
          </>
        }
      />
      <KpiGrid metrics={metrics} />
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
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={data.total}
          onPageChange={setPage}
        />
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

/**
 * The Sales Manager dashboard's team overview (PRD 54.4 §9): the showroom's
 * consultants and telecallers for the last 7 days, busiest first. It is the
 * first page of Sales Teams under the same query key, so either page warms the
 * other.
 */
export function ShowroomTeamOverviewCard() {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [range] = useState(() => performanceRangeForLastDays(7));
  const query = useQuery({
    queryKey: ['showroom-sales-team', ...queryScope, range.from, range.to, 1, 25],
    queryFn: ({ signal }) => fetchShowroomSalesTeam({ range, page: 1, pageSize: 25 }, signal),
    staleTime: 60_000,
  });
  const rows = query.data?.records.slice(0, 8) ?? [];
  return (
    <SectionCard
      title="Team overview"
      description="Last 7 days, top of the showroom"
      actionHref="/showroom-manager/sales-teams"
      actionLabel="Sales teams"
      flush
      contentClassName="overflow-x-auto"
    >
      {query.isPending ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : query.isError || !query.data ? (
        <ErrorState
          className="border-0"
          title="Team overview is unavailable"
          onRetry={() => void query.refetch()}
        />
      ) : rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Active leads</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Test drives</TableHead>
              <TableHead className="text-right">Quotations</TableHead>
              <TableHead className="text-right">Bookings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((member) => (
              <TableRow key={member.user_id}>
                <TableCell className="font-medium">{member.full_name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {member.member_type === 'TELECALLER_BDC' ? 'Telecaller' : 'Sales Consultant'}
                </TableCell>
                <TableCell className="text-right">{formatNumber(member.active_leads)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.calls)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.test_drives)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.quotations)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.bookings)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          bare
          title="No active team members in this showroom"
          description="Members appear once they are assigned to a team here."
        />
      )}
    </SectionCard>
  );
}
