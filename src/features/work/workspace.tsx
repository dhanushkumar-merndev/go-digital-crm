'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  Building2,
  CalendarCheck2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  ClockAlert,
  List,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
import { Badge } from '@/components/ui/badge';
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
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import { FollowupCalendar } from './followup-calendar';
import { AppointmentWorkspaceView } from './appointment-workspace-view';
import {
  fetchWorkWorkspace,
  fetchWorkWorkspacePermissions,
  type AppointmentRecord,
  type FollowupRecord,
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
        label: 'Due today',
        value: result.kpis.today.toLocaleString(),
        icon: CalendarCheck2,
        tone: 'bg-blue-50 text-blue-600',
      },
      {
        label: 'Overdue',
        value: result.kpis.overdue.toLocaleString(),
        helper: 'Open and past due',
        trend: result.kpis.overdue ? 'down' : 'neutral',
        icon: ClockAlert,
        tone: 'bg-red-50 text-red-600',
      },
      {
        label: 'Completed today',
        value: result.kpis.completed_today.toLocaleString(),
        icon: CircleCheckBig,
        tone: 'bg-emerald-50 text-emerald-600',
      },
      {
        label: 'Upcoming',
        value: result.kpis.upcoming.toLocaleString(),
        icon: CalendarDays,
        tone: 'bg-orange-50 text-orange-600',
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
  view,
  onViewChange,
  timezone,
  organizationId,
  scopeKey,
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
  view: 'table' | 'calendar';
  onViewChange: (view: 'table' | 'calendar') => void;
  timezone: string;
  organizationId: string;
  scopeKey: string;
}) {
  const managerial = role === 'team-manager' || role === 'showroom-manager';
  const columns = useMemo<ColumnDef<WorkRecord>[]>(() => {
    if (kind === 'followups') {
      return [
        {
          id: 'due',
          header: 'Time',
          cell: ({ row }) => {
            const followup = row.original as FollowupRecord;
            return (
              <div className={followup.display_status === 'OVERDUE' ? 'text-red-600' : ''}>
                <p className="whitespace-nowrap font-semibold">
                  {new Intl.DateTimeFormat('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(new Date(followup.due_at))}
                </p>
                <p className="mt-0.5 whitespace-nowrap text-[10px]">
                  {new Intl.DateTimeFormat('en-IN', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  }).format(new Date(followup.due_at))}
                </p>
              </div>
            );
          },
        },
        {
          id: 'customer',
          header: 'Customer',
          cell: ({ row }) => {
            const followup = row.original as FollowupRecord;
            return followup.customer_id ? (
              <Link
                href={`/${role}/customers/${followup.customer_id}`}
                className="font-semibold hover:text-blue-700 hover:underline"
              >
                {followup.customer_name}
              </Link>
            ) : (
              <span className="font-semibold">{followup.customer_name}</span>
            );
          },
        },
        {
          id: 'phone',
          header: 'Mobile',
          cell: ({ row }) => (row.original as FollowupRecord).phone ?? '—',
        },
        {
          id: 'model',
          header: 'Model',
          cell: ({ row }) => (row.original as FollowupRecord).interested_model ?? '—',
        },
        {
          id: 'reason',
          header: 'Follow-up type / note',
          cell: ({ row }) => (
            <p className="max-w-64 whitespace-normal leading-5">
              {(row.original as FollowupRecord).reason}
            </p>
          ),
        },
        {
          id: 'priority',
          header: 'Priority',
          cell: ({ row }) => {
            const priority = (row.original as FollowupRecord).priority;
            return (
              <Badge
                variant={
                  priority === 'URGENT' || priority === 'HIGH'
                    ? 'destructive'
                    : priority === 'NORMAL'
                      ? 'warning'
                      : 'success'
                }
                className="rounded px-2 py-0 text-[10px]"
              >
                {priority}
              </Badge>
            );
          },
        },
        {
          id: 'owner',
          header: 'Assigned user',
          cell: ({ row }) => (row.original as FollowupRecord).assigned_user_name,
        },
        ...(managerial
          ? [
              {
                id: 'branch',
                header: 'Branch / team',
                cell: ({ row }: { row: { original: WorkRecord } }) => {
                  const followup = row.original as FollowupRecord;
                  return (
                    <div>
                      <p>{followup.branch_name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {followup.team_name ?? 'No team'}
                      </p>
                    </div>
                  );
                },
              } as ColumnDef<WorkRecord>,
            ]
          : []),
        {
          id: 'status',
          header: 'Status',
          cell: ({ row }) => (
            <StatusBadge value={(row.original as FollowupRecord).display_status} />
          ),
        },
        {
          id: 'actions',
          header: 'Actions',
          cell: ({ row }) => {
            const followup = row.original as FollowupRecord;
            const terminal = followup.status !== 'OPEN';
            const canComplete =
              permissions.canComplete &&
              (followup.assigned_user_id === permissions.userId || permissions.canOverrideComplete);
            return (
              <div className="flex items-center gap-0.5">
                {followup.phone && (
                  <Button variant="ghost" size="icon" className="size-7 text-blue-600" asChild>
                    <a href={`tel:${followup.phone}`} aria-label={`Call ${followup.customer_name}`}>
                      <Phone className="size-3.5" />
                    </a>
                  </Button>
                )}
                {followup.phone && (
                  <Button variant="ghost" size="icon" className="size-7 text-emerald-600" asChild>
                    <a
                      href={toWhatsAppClickToChatUrl(followup.phone)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`WhatsApp ${followup.customer_name}`}
                    >
                      <WhatsAppIcon className="size-3.5" />
                    </a>
                  </Button>
                )}
                {!terminal && canComplete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-emerald-600"
                    onClick={() => onAction('complete', followup)}
                    aria-label="Mark follow-up complete"
                  >
                    <CheckCircle2 className="size-4" />
                  </Button>
                )}
                {!terminal && permissions.canUpdate && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-violet-600"
                    onClick={() => onEdit(followup)}
                    aria-label="Reschedule follow-up"
                  >
                    <CalendarDays className="size-3.5" />
                  </Button>
                )}
                {!terminal && permissions.canCancel && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-7">
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => onAction('cancel', followup)}
                      >
                        Cancel follow-up
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          },
        },
      ];
    }
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
        header: 'Type / model',
        cell: ({ row }) => {
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
        header: 'Scheduled',
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-medium">
            {formatDateTime((row.original as AppointmentRecord).scheduled_at)}
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
            <StatusBadge value={(row.original as AppointmentRecord).status} />
            <span className="text-[11px] text-muted-foreground">
              {(row.original as AppointmentRecord).attendance_status.replaceAll('_', ' ')}
            </span>
          </div>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const record = row.original;
          const terminal = isTerminal(kind, record);
          const canComplete = permissions.canComplete;
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
                    Update appointment
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
          <div className="relative min-w-0 flex-1 xl:w-[360px] xl:flex-none">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              maxLength={160}
              placeholder="Search customer, phone, lead or work ID…"
            />
          </div>
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:flex xl:flex-[4]">
            {kind !== 'followups' && (
              <Select
                value={query.status}
                onValueChange={(status) =>
                  onQueryChange({ status: status as WorkStatusFilter, page: 1 })
                }
              >
                <SelectTrigger className="w-full xl:min-w-[135px] xl:flex-1">
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
            )}
            {kind === 'followups' ? (
              <Select
                value={query.priority}
                onValueChange={(priority) =>
                  onQueryChange({ priority: priority as WorkQuery['priority'], page: 1 })
                }
              >
                <SelectTrigger className="w-full xl:min-w-[130px] xl:flex-1">
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
                <SelectTrigger className="w-full xl:min-w-[150px] xl:flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All appointment types</SelectItem>
                  <SelectItem value="Showroom Visit">Showroom visits</SelectItem>
                  <SelectItem value="Test Drive">Test drives</SelectItem>
                </SelectContent>
              </Select>
            )}
            {managerial ? (
              <Select
                value={query.branchId}
                onValueChange={(branchId) => onQueryChange({ branchId, teamId: 'all', page: 1 })}
              >
                <SelectTrigger className="w-full xl:min-w-[150px] xl:flex-1">
                  <SelectValue placeholder="Branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All assigned branches</SelectItem>
                  {result.filters.branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : kind !== 'followups' ? (
              <div
                className="flex h-10 min-w-0 items-center gap-2 rounded-md border bg-slate-50 px-3 text-xs text-[#263550] xl:min-w-[170px] xl:flex-1"
                title={result.filters.branches[0]?.name ?? 'Assigned dealership'}
              >
                <Building2 className="size-4 shrink-0 text-blue-600" />
                <span className="truncate font-medium">
                  {result.filters.branches[0]?.name ?? 'Assigned dealership'}
                </span>
              </div>
            ) : null}
            {managerial && (
              <Select
                value={query.teamId}
                onValueChange={(teamId) => onQueryChange({ teamId, page: 1 })}
              >
                <SelectTrigger className="w-full xl:min-w-[140px] xl:flex-1">
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
                <SelectTrigger className="w-full xl:min-w-[150px] xl:flex-1">
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
              <SelectTrigger className="w-full xl:min-w-[135px] xl:flex-1">
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
              <SelectTrigger className="w-full xl:w-[105px] xl:shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
              </SelectContent>
            </Select>
            {kind === 'followups' && (
              <div className="flex h-10 shrink-0 items-center rounded-md border bg-slate-50 p-1">
                <button
                  type="button"
                  className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium ${
                    view === 'table'
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => onViewChange('table')}
                >
                  <List className="size-3.5" /> Table
                </button>
                <button
                  type="button"
                  className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium ${
                    view === 'calendar'
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => onViewChange('calendar')}
                >
                  <CalendarDays className="size-3.5" /> Calendar
                </button>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {view === 'calendar' && kind === 'followups' ? (
          <FollowupCalendar
            role={role}
            query={query}
            timezone={timezone}
            organizationId={organizationId}
            scopeKey={scopeKey}
            permissions={permissions}
            isActive
            onEdit={onEdit}
            onAction={onAction}
          />
        ) : (
          <>
            <div className={isFetching ? 'opacity-65 transition-opacity' : 'transition-opacity'}>
              <Table className="min-w-[1180px]">
                <TableHeader>
                  {table.getHeaderGroups().map((group) => (
                    <TableRow key={group.id}>
                      {group.headers.map((header) => (
                        <TableHead
                          key={header.id}
                          className="h-10 whitespace-nowrap bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-[#263550]"
                        >
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
                    table.getRowModel().rows.map((row) => {
                      const overdue =
                        kind === 'followups' &&
                        (row.original as FollowupRecord).display_status === 'OVERDUE';
                      return (
                        <TableRow
                          key={row.id}
                          className={
                            overdue ? 'bg-red-50/65 hover:bg-red-50' : 'hover:bg-slate-50/70'
                          }
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id} className="px-4 py-3 align-middle text-xs">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })
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
          </>
        )}
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
  const [query, setQuery] = useState<WorkQuery>(() => {
    const parsed = parseWorkQuery(searchParams, kind);
    if (kind === 'followups' && !searchParams.has('status') && !searchParams.has('q'))
      return { ...parsed, status: 'today' };
    return parsed;
  });
  const [view, setView] = useState<'table' | 'calendar'>('table');
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
    void queryClient.invalidateQueries({ queryKey: ['followup-calendar'] });
    void queryClient.invalidateQueries({ queryKey: ['followup-calendar-day'] });
    void queryClient.invalidateQueries({ queryKey: ['appointment-calendar'] });
    void queryClient.invalidateQueries({ queryKey: ['appointment-calendar-day'] });
    void queryClient.invalidateQueries({ queryKey: ['appointment-type-summary'] });
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
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        {kind === 'followups' ? (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Link href={`/${role}/dashboard`} className="text-blue-600 hover:underline">
                Dashboard
              </Link>
              <ChevronRight className="size-3" />
              <span>Follow-ups</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
              Follow-up Management
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage and track customer follow-ups to keep every commitment on time.
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Link href={`/${role}/dashboard`} className="text-blue-600 hover:underline">
                Dashboard
              </Link>
              <ChevronRight className="size-3" />
              <span>Appointments</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
              Appointments
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Schedule, manage and track all customer appointments in one place.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {kind === 'appointments' && (
            <div className="flex h-10 items-center rounded-md border bg-slate-50 p-1">
              <button
                type="button"
                className={`flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${
                  view === 'calendar'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setView('calendar')}
              >
                <CalendarDays className="size-3.5" /> Calendar view
              </button>
              <button
                type="button"
                className={`flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${
                  view === 'table'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setView('table')}
              >
                <List className="size-3.5" /> List view
              </button>
            </div>
          )}
          {permissions.data.canCreate && !spec.readOnly && (
            <Button className="shrink-0" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {kind === 'followups' ? 'Schedule follow-up' : 'New appointment'}
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-6">
        {kind === 'followups' && (
          <div className="flex h-10 gap-2 overflow-x-auto border-b">
            {(
              [
                ['today', 'Today'],
                ['upcoming', 'Upcoming'],
                ['overdue', 'Overdue'],
                ['completed', 'Completed'],
                ['cancelled', 'Cancelled'],
              ] as const
            ).map(([value, label]) => {
              const active = query.status === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => onQueryChange({ status: value, page: 1 })}
                  className={`relative h-full shrink-0 px-3 text-xs font-semibold ${
                    active ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700'
                  }`}
                  style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {kind === 'followups' ? (
          <>
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
              view={view}
              onViewChange={setView}
              timezone={timezone}
              organizationId={permissions.data.organizationId}
              scopeKey={permissions.data.scopeKey}
            />
          </>
        ) : (
          <AppointmentWorkspaceView
            role={role}
            result={workspace.data as import('./workspace-api').AppointmentWorkspaceResult}
            query={query}
            onQueryChange={onQueryChange}
            permissions={permissions.data}
            isFetching={workspace.isFetching}
            onEdit={setEditingRecord}
            onAction={(action, record) => setActionState({ action, record })}
            view={view}
            timezone={timezone}
            organizationId={permissions.data.organizationId}
            scopeKey={permissions.data.scopeKey}
          />
        )}
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
