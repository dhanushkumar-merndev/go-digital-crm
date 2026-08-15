'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  fetchWorkWorkspace,
  fetchWorkWorkspacePermissions,
  type AppointmentRecord,
  type WorkRecord,
  type WorkWorkspacePermissions,
  type WorkWorkspaceResult,
} from './workspace-api';
import { WorkActionDialog, WorkCreateDialog, WorkEditDialog } from './workspace-dialogs';
import {
  appointmentFilters,
  followupFilters,
  parseWorkQuery,
  toWorkQueryString,
  type WorkKind,
  type WorkQuery,
  type WorkStatusFilter,
} from './workspace-query';

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase();
}

function statusLabel(value: string) {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function workMetrics(kind: WorkKind, result: WorkWorkspaceResult): Metric[] {
  if (kind === 'followups' && 'completed_today' in result.kpis) {
    return [
      {
        label: 'Overdue',
        value: result.kpis.overdue.toLocaleString(),
        helper: 'Open and past due',
        trend: result.kpis.overdue ? 'down' : 'neutral',
      },
      { label: 'Due today', value: result.kpis.today.toLocaleString() },
      { label: 'Upcoming', value: result.kpis.upcoming.toLocaleString() },
      {
        label: 'Completed today',
        value: result.kpis.completed_today.toLocaleString(),
      },
    ];
  }
  const kpis = result.kpis as {
    today: number;
    upcoming: number;
    confirmed: number;
    completed: number;
    no_show: number;
    arrived: number;
  };
  return [
    { label: 'Today', value: kpis.today.toLocaleString() },
    { label: 'Upcoming', value: kpis.upcoming.toLocaleString() },
    { label: 'Confirmed', value: kpis.confirmed.toLocaleString() },
    {
      label: 'Attendance',
      value: (kpis.arrived + kpis.completed).toLocaleString(),
      helper: `${kpis.no_show.toLocaleString()} no-show`,
    },
  ];
}

function isTerminal(kind: WorkKind, record: WorkRecord) {
  if (kind === 'followups' && 'due_at' in record) return record.status !== 'OPEN';
  const status = (record as AppointmentRecord).status;
  return status === 'COMPLETED' || status === 'CANCELLED' || status === 'NO_SHOW';
}

function WorkTable({
  kind,
  role,
  result,
  query,
  onQueryChange,
  permissions,
  isFetching,
  onEdit,
  onAction,
}: {
  kind: WorkKind;
  role: string;
  result: WorkWorkspaceResult;
  query: WorkQuery;
  onQueryChange: (next: Partial<WorkQuery>) => void;
  permissions: WorkWorkspacePermissions;
  isFetching: boolean;
  onEdit: (record: WorkRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: WorkRecord) => void;
}) {
  const managerial = role === 'team-manager' || role === 'showroom-manager';
  const columns = useMemo<ColumnDef<WorkRecord>[]>(() => {
    const definitions: ColumnDef<WorkRecord>[] = [
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-44">
            {row.original.customer_id ? (
              <Link
                href={`/${role}/customers/${row.original.customer_id}`}
                className="font-semibold hover:text-primary hover:underline"
              >
                {row.original.customer_name}
              </Link>
            ) : (
              <span className="font-semibold">{row.original.customer_name}</span>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.lead_id ? `Lead ${shortId(row.original.lead_id)}` : 'Customer work'}
            </p>
          </div>
        ),
      },
      {
        id: 'phone',
        header: 'Phone',
        cell: ({ row }) =>
          row.original.phone ? (
            <a
              className="font-medium text-blue-700 hover:underline"
              href={`tel:${row.original.phone}`}
            >
              {row.original.phone}
            </a>
          ) : (
            '—'
          ),
      },
      {
        id: 'work',
        header: kind === 'followups' ? 'Reason' : 'Type / model',
        cell: ({ row }) => {
          if (kind === 'followups' && 'reason' in row.original)
            return (
              <div className="min-w-44">
                <p className="font-medium">{row.original.reason}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {row.original.interested_model ?? 'Model not recorded'}
                </p>
              </div>
            );
          const appointment = row.original as AppointmentRecord;
          return (
            <div className="min-w-36">
              <p className="font-medium">{appointment.appointment_type}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {appointment.interested_model ?? 'Model not recorded'}
              </p>
            </div>
          );
        },
      },
      {
        id: 'scheduled',
        header: kind === 'followups' ? 'Due' : 'Scheduled',
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-medium">
            {formatDateTime(
              kind === 'followups' && 'due_at' in row.original
                ? row.original.due_at
                : (row.original as AppointmentRecord).scheduled_at,
            )}
          </span>
        ),
      },
      {
        id: 'branch',
        header: 'Branch',
        cell: ({ row }) => (
          <div className="min-w-32">
            <p>{row.original.branch_name}</p>
            {managerial && row.original.team_name && (
              <p className="mt-0.5 text-xs text-muted-foreground">{row.original.team_name}</p>
            )}
          </div>
        ),
      },
      {
        id: 'owner',
        header: 'Responsible user',
        cell: ({ row }) => row.original.assigned_user_name,
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <div className="flex min-w-28 flex-col items-start gap-1">
            <StatusBadge
              value={
                kind === 'followups' && 'display_status' in row.original
                  ? row.original.display_status
                  : (row.original as AppointmentRecord).status
              }
            />
            {kind === 'followups' && 'priority' in row.original && (
              <span className="text-[11px] text-muted-foreground">
                {row.original.priority} priority
              </span>
            )}
            {kind === 'appointments' && (
              <span className="text-[11px] text-muted-foreground">
                {(row.original as AppointmentRecord).attendance_status.replaceAll('_', ' ')}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const record = row.original;
          const terminal = isTerminal(kind, record);
          const canComplete =
            permissions.canComplete &&
            (kind === 'appointments' ||
              record.assigned_user_id === permissions.userId ||
              permissions.canOverrideComplete);
          if (terminal || (!permissions.canUpdate && !canComplete && !permissions.canCancel))
            return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label="Work actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {permissions.canUpdate && (
                  <DropdownMenuItem onSelect={() => onEdit(record)}>
                    <Pencil className="size-4" />
                    {kind === 'followups' ? 'Reschedule / reassign' : 'Update appointment'}
                  </DropdownMenuItem>
                )}
                {canComplete && (
                  <DropdownMenuItem onSelect={() => onAction('complete', record)}>
                    Mark complete
                  </DropdownMenuItem>
                )}
                {permissions.canCancel && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => onAction('cancel', record)}
                    >
                      Cancel work item
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ];
    return definitions;
  }, [kind, managerial, onAction, onEdit, permissions, role]);

  // TanStack Table intentionally returns an imperative model; React Compiler skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: result.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: result.total,
  });
  const pages = Math.max(1, Math.ceil(result.total / query.pageSize));
  const statuses = kind === 'followups' ? followupFilters : appointmentFilters;
  const selectedBranchTeams = result.filters.teams.filter(
    (team) => query.branchId === 'all' || team.branch_id === query.branchId,
  );

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="relative min-w-0 flex-1 xl:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              maxLength={160}
              placeholder="Search customer, phone, lead or work ID…"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:flex">
            <Select
              value={query.status}
              onValueChange={(status) =>
                onQueryChange({ status: status as WorkStatusFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-full xl:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status === 'all' ? 'All statuses' : statusLabel(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {kind === 'followups' ? (
              <Select
                value={query.priority}
                onValueChange={(priority) =>
                  onQueryChange({ priority: priority as WorkQuery['priority'], page: 1 })
                }
              >
                <SelectTrigger className="w-full xl:w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  <SelectItem value="LOW">Low priority</SelectItem>
                  <SelectItem value="NORMAL">Normal priority</SelectItem>
                  <SelectItem value="HIGH">High priority</SelectItem>
                  <SelectItem value="URGENT">Urgent</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Select
                value={query.appointmentType}
                onValueChange={(appointmentType) =>
                  onQueryChange({
                    appointmentType: appointmentType as WorkQuery['appointmentType'],
                    page: 1,
                  })
                }
              >
                <SelectTrigger className="w-full xl:w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All appointment types</SelectItem>
                  <SelectItem value="Showroom Visit">Showroom visits</SelectItem>
                  <SelectItem value="Test Drive">Test drives</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Select
              value={query.branchId}
              onValueChange={(branchId) => onQueryChange({ branchId, teamId: 'all', page: 1 })}
            >
              <SelectTrigger className="w-full xl:w-[150px]">
                <SelectValue placeholder="Branch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {result.filters.branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {managerial && (
              <Select
                value={query.teamId}
                onValueChange={(teamId) => onQueryChange({ teamId, page: 1 })}
              >
                <SelectTrigger className="w-full xl:w-[150px]">
                  <SelectValue placeholder="Team" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All teams</SelectItem>
                  {selectedBranchTeams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {managerial && (
              <Select
                value={query.ownerId}
                onValueChange={(ownerId) => onQueryChange({ ownerId, page: 1 })}
              >
                <SelectTrigger className="w-full xl:w-[160px]">
                  <SelectValue placeholder="Responsible user" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {result.filters.owners.map((owner) => (
                    <SelectItem key={owner.id} value={owner.id}>
                      {owner.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select
              value={query.sort}
              onValueChange={(sort) => onQueryChange({ sort: sort as WorkQuery['sort'], page: 1 })}
            >
              <SelectTrigger className="w-full xl:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="scheduled:asc">Soonest first</SelectItem>
                <SelectItem value="scheduled:desc">Latest first</SelectItem>
                <SelectItem value="updated:desc">Recently updated</SelectItem>
                <SelectItem value="customer:asc">Customer A–Z</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
              }
            >
              <SelectTrigger className="w-full xl:w-[105px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className={isFetching ? 'opacity-65 transition-opacity' : 'transition-opacity'}>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id} className="whitespace-nowrap">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="align-top">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <p className="font-medium">No matching work items</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Clear the page-local filters or schedule a new item if permitted.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {result.total ? (query.page - 1) * query.pageSize + 1 : 0}–
            {Math.min(query.page * query.pageSize, result.total)} of {result.total}
          </p>
          <div className="flex items-center gap-2">
            <span className="mr-2 text-xs text-muted-foreground">
              Page {query.page} of {pages}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={query.page <= 1}
              onClick={() => onQueryChange({ page: query.page - 1 })}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={query.page >= pages}
              onClick={() => onQueryChange({ page: query.page + 1 })}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function WorkWorkspace({
  kind,
  role,
  spec,
}: {
  kind: WorkKind;
  role: string;
  spec: PageSpec;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState<WorkQuery>(() => parseWorkQuery(searchParams, kind));
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<WorkRecord | null>(null);
  const [actionState, setActionState] = useState<{
    action: 'complete' | 'cancel';
    record: WorkRecord;
  } | null>(null);
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
    [],
  );
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const queryClient = useQueryClient();
  const permissions = useQuery({
    queryKey: ['work-workspace-permissions', kind],
    queryFn: () => fetchWorkWorkspacePermissions(kind),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'work',
      queryKeys: [['work-workspace', kind, permissions.data?.organizationId]],
    },
  ]);
  const workspace = useQuery({
    queryKey: [
      'work-workspace',
      kind,
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      timezone,
      requestQuery,
    ],
    queryFn: () => fetchWorkWorkspace(kind, requestQuery, timezone),
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
  });
  const onQueryChange = useCallback(
    (next: Partial<WorkQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toWorkQueryString(updated);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['work-workspace', kind, permissions.data?.organizationId],
    });
    void queryClient.invalidateQueries({ queryKey: ['lead-workspace'] });
    void queryClient.invalidateQueries({ queryKey: ['customer-360'] });
  }, [kind, permissions.data?.organizationId, queryClient]);

  if (permissions.isPending || (workspace.isPending && permissions.data)) return <PageSkeleton />;
  if (permissions.isError || workspace.isError || !permissions.data || !workspace.data)
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Work items are not available yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your access scope or the work workspace migration needs attention. Reference:
            GDM-WORK-QUERY.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              void permissions.refetch();
              void workspace.refetch();
            }}
          >
            <RotateCcw className="size-4" />
            Try again
          </Button>
        </CardContent>
      </Card>
    );

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        {permissions.data.canCreate && (
          <Button className="shrink-0 sm:mt-7" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {kind === 'followups' ? 'Schedule follow-up' : 'New appointment'}
          </Button>
        )}
      </div>
      <div className="space-y-6">
        <KpiGrid metrics={workMetrics(kind, workspace.data)} />
        <WorkTable
          kind={kind}
          role={role}
          result={workspace.data}
          query={query}
          onQueryChange={onQueryChange}
          permissions={permissions.data}
          isFetching={workspace.isFetching}
          onEdit={setEditingRecord}
          onAction={(action, record) => setActionState({ action, record })}
        />
      </div>
      {permissions.data.canCreate && (
        <WorkCreateDialog
          kind={kind}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={invalidate}
        />
      )}
      {editingRecord && (
        <WorkEditDialog
          key={`${editingRecord.id}:${editingRecord.version}`}
          kind={kind}
          record={editingRecord}
          open
          onOpenChange={(open) => !open && setEditingRecord(null)}
          onUpdated={() => {
            setEditingRecord(null);
            invalidate();
          }}
        />
      )}
      {actionState && (
        <WorkActionDialog
          key={`${actionState.action}:${actionState.record.id}:${actionState.record.version}`}
          kind={kind}
          action={actionState.action}
          record={actionState.record}
          open
          onOpenChange={(open) => !open && setActionState(null)}
          onCompleted={() => {
            setActionState(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}
