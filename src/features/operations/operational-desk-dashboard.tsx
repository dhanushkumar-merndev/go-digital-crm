'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, FileStack, FolderOpen, TriangleAlert } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { SectionCard } from '@/components/shared/section-card';
import { StatusBadge } from '@/components/shared/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { RoleKey } from '@/config/navigation/types';
import type { Metric, PageSpec } from '@/lib/domain';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { fetchOperationalCaseWorkspace } from './operational-case-api';
import {
  operationalCaseCasesHref,
  operationalCaseRoute,
  operationalCaseStatusLabel,
} from './operational-case-query';

const deskTitles = {
  FINANCE: 'Finance',
  INSURANCE: 'Insurance',
  RTO: 'RTO',
  EXCHANGE: 'Exchange',
  DELIVERY: 'Delivery',
} as const;

/**
 * A desk's dashboard (PRD 54.7 §4): where the queue stands, the cases that need
 * someone now and how the desk's cases split by status. One call, the same one
 * the case list makes, sorted by due date; the counts cover the whole scope.
 */
export function OperationalDeskDashboard({ spec, role }: { spec: PageSpec; role: RoleKey }) {
  const route = operationalCaseRoute(role, 'dashboard');
  if (!route) throw new Error('INVALID_OPERATIONAL_CASE_ROUTE');
  const department = route.department;
  const session = useWorkspaceSession();
  const queryKey = ['operational-desk-dashboard', ...workspaceQueryScope(session), department];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      fetchOperationalCaseWorkspace(
        department,
        {
          page: 1,
          pageSize: 25,
          status: 'OPEN',
          search: '',
          fromDate: '',
          toDate: '',
          sort: 'due:asc',
        },
        signal,
      ),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    { resource: 'operations', queryKeys: [queryKey] },
  ]);
  const casesHref = operationalCaseCasesHref(role, department);
  const header = (
    <PageHeader
      spec={{ ...spec, title: `${deskTitles[department]} dashboard`, primaryAction: undefined }}
      description="Where the desk's queue stands and the cases that need someone now."
    />
  );

  if (query.isPending)
    return (
      <PageShell>
        {header}
        <div className="grid gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </PageShell>
    );
  if (query.isError || !query.data)
    return (
      <PageShell>
        {header}
        <ErrorState
          title={`${deskTitles[department]} dashboard is unavailable`}
          description="Confirm your desk permission and branch scope."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );

  const { kpis, records } = query.data;
  const statusCounts = Object.entries(query.data.status_counts ?? {})
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([status, count]) => ({ name: operationalCaseStatusLabel(status), value: count }));
  const metrics: Metric[] = [
    {
      label: 'Open cases',
      value: formatNumber(kpis.open),
      helper: 'In your scope',
      icon: FolderOpen,
      tone: 'blue',
      href: casesHref,
    },
    {
      label: 'Overdue',
      value: formatNumber(kpis.overdue),
      helper: 'Past due, not closed',
      icon: TriangleAlert,
      tone: 'rose',
    },
    {
      label: 'Due today',
      value: formatNumber(kpis.due_today),
      helper: 'Open cases due today',
      icon: CalendarClock,
      tone: 'amber',
    },
    {
      label: 'Pending documents',
      value: formatNumber(kpis.pending_documents),
      helper: 'Documents still to collect',
      icon: FileStack,
      tone: 'violet',
    },
    {
      label: 'Completed this month',
      value: formatNumber(kpis.completed_this_month),
      helper: 'Closed since the 1st',
      icon: CheckCircle2,
      tone: 'emerald',
    },
  ];
  // Overdue as of when the cases were read, so a render never depends on the clock.
  const now = query.dataUpdatedAt;

  return (
    <PageShell>
      {header}
      <KpiGrid metrics={metrics} />
      <div className="grid gap-4 xl:grid-cols-12">
        <SectionCard
          title="Requires attention"
          description="Open cases, earliest due first"
          actionHref={casesHref}
          actionLabel="All cases"
          className="xl:col-span-7"
          flush
          contentClassName="overflow-x-auto"
        >
          {records.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Booking</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.slice(0, 8).map((record) => {
                  const overdue = record.due_at ? new Date(record.due_at).getTime() < now : false;
                  return (
                    <TableRow key={record.id}>
                      <TableCell className="font-medium">{record.customer_name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {record.booking_number ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {record.assigned_user_name ?? 'Unassigned'}
                      </TableCell>
                      <TableCell
                        className={overdue ? 'text-xs font-medium text-rose-600' : 'text-xs'}
                      >
                        {record.due_at ? formatDateTime(record.due_at) : 'No due date'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={record.status} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              bare
              title="Nothing open"
              description="New cases appear here as bookings reach this desk."
            />
          )}
        </SectionCard>
        <SectionCard
          title="Cases by status"
          description="Every case in your scope"
          className="xl:col-span-5"
        >
          {statusCounts.length ? (
            <EChart kind="donut" data={statusCounts} className="h-72" />
          ) : (
            <p className="grid h-72 place-items-center text-sm text-muted-foreground">
              No cases yet.
            </p>
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}
