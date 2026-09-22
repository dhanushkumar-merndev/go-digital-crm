'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  CalendarCheck2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  ClipboardList,
  ClockAlert,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SummaryToggle } from '@/components/domain/summary-toggle';
import { TasksSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { useSalesConsultantCache } from '@/features/sales-consultant/sales-consultant-cache';
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
import { cn } from '@/lib/utils';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import type { PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  fetchTaskPermissions,
  fetchTaskWorkspace,
  type TaskPermissions,
  type TaskRecord,
  type TaskWorkspaceResult,
} from './task-workspace-api';
import { TaskActionDialog, TaskFormDialog } from './task-workspace-dialogs';
import {
  parseTaskQuery,
  taskPriorityFilters,
  toTaskQueryString,
  type TaskQuery,
  type TaskStatusFilter,
} from './task-workspace-query';
import { recordDetailHref } from '@/lib/navigation/record-links';

function formatDate(value: string | null) {
  if (!value) return 'No due date';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function titleCase(value: string) {
  return value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type TaskCreateContext = {
  leadId: string;
  customerName: string;
  phone: string | null;
  interestedModel: string | null;
};

function taskCreateContextFromUrl(params: URLSearchParams): TaskCreateContext | null {
  if (params.get('action') !== 'create') return null;
  const leadId = params.get('lead')?.trim() ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leadId))
    return null;
  const bounded = (value: string | null, maximum: number) =>
    value?.trim().slice(0, maximum) || null;
  return {
    leadId,
    customerName: bounded(params.get('customer'), 160) ?? 'Selected customer',
    phone: bounded(params.get('phone'), 40),
    interestedModel: bounded(params.get('model'), 120),
  };
}

function percentOf(part: number, whole: number) {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * The task KPIs, in the same card language as the follow-up workspace and the
 * Sales Consultant dashboard.
 *
 * The rate under each count is a share of the consultant's own workload, not a
 * period-over-period trend — this response carries no yesterday figure, and a
 * number nobody can check is worse than no number. `neutral` keeps a share that
 * is neither good nor bad out of the green/red vocabulary.
 */
function taskMetricCards(
  kpis: TaskWorkspaceResult['kpis'],
  statusCounts: TaskWorkspaceResult['status_counts'],
) {
  const open = kpis.today + kpis.overdue + kpis.upcoming;
  const dueTodayTotal = kpis.completed_today + kpis.today;
  const clearedRate = percentOf(kpis.completed_today, dueTodayTotal);
  // The total card mirrors the All tab, so its open share comes from
  // status_counts too. `kpis` ignores the search box while status_counts
  // honours it; mixing the two would push the share past 100% as soon as
  // someone typed in search.
  const openInView = statusCounts.open + statusCounts.in_progress;
  return [
    {
      status: 'all' as const,
      label: 'Total tasks',
      value: statusCounts.all,
      icon: ClipboardList,
      chip: 'bg-violet-50 text-violet-600',
      rate: percentOf(openInView, statusCounts.all),
      helper: 'still to do',
      rising: true,
      good: true,
      neutral: true,
      footnote: `${statusCounts.completed.toLocaleString()} completed \u00b7 ${statusCounts.cancelled.toLocaleString()} cancelled`,
    },
    {
      status: 'today' as const,
      label: 'Due today',
      value: kpis.today,
      icon: CalendarCheck2,
      chip: 'bg-blue-50 text-blue-600',
      rate: percentOf(kpis.today, open),
      helper: 'of tasks still to do',
      rising: true,
      good: true,
    },
    {
      status: 'overdue' as const,
      label: 'Overdue',
      value: kpis.overdue,
      icon: ClockAlert,
      chip: 'bg-rose-50 text-rose-600',
      rate: percentOf(kpis.overdue, open),
      helper: 'missed against open workload',
      rising: kpis.overdue > 0,
      good: kpis.overdue === 0,
    },
    {
      status: 'completed' as const,
      label: 'Completed today',
      value: kpis.completed_today,
      icon: CircleCheckBig,
      chip: 'bg-emerald-50 text-emerald-600',
      rate: clearedRate,
      helper: dueTodayTotal ? 'of today\u2019s tasks cleared' : 'nothing was due today',
      rising: clearedRate >= 50,
      good: clearedRate >= 50,
      neutral: dueTodayTotal === 0,
      // The Completed tab lists every completed task; this card counts only
      // today's. Naming the tab total stops that reading as a contradiction.
      footnote: `${statusCounts.completed.toLocaleString()} completed all time`,
    },
    {
      status: 'upcoming' as const,
      label: 'Upcoming',
      value: kpis.upcoming,
      icon: CalendarDays,
      chip: 'bg-orange-50 text-orange-600',
      rate: percentOf(kpis.upcoming, open),
      helper: 'of tasks still to do',
      rising: true,
      good: true,
    },
  ];
}

function TaskMetricCard({
  card,
  active,
  onSelect,
}: {
  card: ReturnType<typeof taskMetricCards>[number];
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = card.icon;
  const TrendIcon = card.rising ? TrendingUp : TrendingDown;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className="group min-w-0 rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Card
        className={cn(
          'h-full min-w-0 shadow-none transition-all group-hover:-translate-y-0.5 group-hover:border-blue-200 group-hover:shadow-sm',
          active ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200/90',
        )}
      >
        <CardContent className="p-4">
          <div className="flex items-center gap-2.5">
            <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', card.chip)}>
              <Icon className="size-4" />
            </span>
            <p className="min-w-0 text-[11px] font-semibold leading-4 text-[#263550]">
              {card.label}
            </p>
          </div>
          <p className="mt-3 text-center text-[26px] font-bold leading-none tracking-tight text-[#12213f]">
            {card.value.toLocaleString()}
          </p>
          <p
            className={cn(
              'mt-3 flex flex-wrap items-center justify-center gap-1 text-[10px] font-semibold',
              card.neutral
                ? 'text-muted-foreground'
                : card.good
                  ? 'text-emerald-600'
                  : 'text-rose-600',
            )}
          >
            <TrendIcon className="size-3" /> {card.rate}%
            <span className="font-normal text-muted-foreground">{card.helper}</span>
          </p>
          {card.footnote && (
            <p className="mt-1 text-center text-[10px] text-muted-foreground">{card.footnote}</p>
          )}
        </CardContent>
      </Card>
    </button>
  );
}

/**
 * Task tabs follow the work's own order: the three time views first, then the
 * lifecycle states an open task moves through. Unlike the follow-up tabs these
 * overlap on purpose — an OPEN task past its due date is counted under both
 * Open and Overdue — so the counts describe each tab rather than partitioning
 * the total.
 */
function TaskStatusTabs({
  statusCounts,
  status,
  onStatusChange,
  summaryOpen,
  onSummaryToggle,
}: {
  statusCounts: TaskWorkspaceResult['status_counts'];
  status: TaskStatusFilter;
  onStatusChange: (status: TaskStatusFilter) => void;
  summaryOpen: boolean;
  onSummaryToggle: () => void;
}) {
  const tabs: Array<{ label: string; value: TaskStatusFilter; count: number }> = [
    { label: 'All', value: 'all', count: statusCounts.all },
    { label: 'Today', value: 'today', count: statusCounts.today },
    { label: 'Upcoming', value: 'upcoming', count: statusCounts.upcoming },
    { label: 'Overdue', value: 'overdue', count: statusCounts.overdue },
    { label: 'In Progress', value: 'in-progress', count: statusCounts.in_progress },
    { label: 'Completed', value: 'completed', count: statusCounts.completed },
    { label: 'Cancelled', value: 'cancelled', count: statusCounts.cancelled },
  ];
  return (
    <div className="flex h-10 border-b">
      <div
        role="tablist"
        aria-label="Task quick views"
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = status === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onStatusChange(tab.value)}
              style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
              className={`relative flex h-full shrink-0 items-center gap-1.5 px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset ${
                active ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700'
              }`}
            >
              <span>{tab.label}</span>
              <span
                className={`grid min-w-5 place-items-center rounded px-1 py-0.5 text-[10px] leading-none ${
                  active ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {tab.count.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
      <SummaryToggle
        open={summaryOpen}
        onToggle={onSummaryToggle}
        controls="task-summary-kpis"
        label="task summary"
      />
    </div>
  );
}

function isOverdueTask(record: TaskRecord) {
  return Boolean(
    record.due_at &&
    ['OPEN', 'IN_PROGRESS'].includes(record.status) &&
    new Date(record.due_at).getTime() < Date.now(),
  );
}

function TaskTable({
  result,
  query,
  role,
  permissions,
  isFetching,
  searchInput,
  onQueryChange,
  onSearchChange,
  onEdit,
  onAction,
}: {
  result: TaskWorkspaceResult;
  query: TaskQuery;
  role: string;
  permissions: TaskPermissions;
  isFetching: boolean;
  searchInput: string;
  onQueryChange: (next: Partial<TaskQuery>) => void;
  onSearchChange: (value: string) => void;
  onEdit: (record: TaskRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: TaskRecord) => void;
}) {
  const columns = useMemo<ColumnDef<TaskRecord>[]>(
    () => [
      {
        id: 'task',
        header: 'Task',
        cell: ({ row }) => (
          <div className="min-w-52">
            <p className="font-semibold">{row.original.title}</p>
            <p className="line-clamp-2 max-w-xs text-xs text-muted-foreground">
              {row.original.description ?? 'No description'}
            </p>
          </div>
        ),
      },
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-40">
            {row.original.customer_id ? (
              <Link
                href={recordDetailHref(role, row.original) ?? '#'}
                className="font-medium hover:text-primary hover:underline"
              >
                {row.original.customer_name ?? 'Customer'}
              </Link>
            ) : (
              <span className="text-muted-foreground">General task</span>
            )}
            <p className="text-xs text-muted-foreground">
              {row.original.interested_model ?? row.original.phone ?? 'No opportunity detail'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'due_at',
        header: 'Due',
        cell: ({ row }) => {
          const overdue = isOverdueTask(row.original);
          return (
            <div>
              <p className={overdue ? 'font-medium text-red-700' : 'font-medium'}>
                {formatDate(row.original.due_at)}
              </p>
              {overdue && query.status === 'all' && <p className="text-xs text-red-600">Overdue</p>}
            </div>
          );
        },
      },
      {
        accessorKey: 'priority',
        header: 'Priority',
        cell: ({ getValue }) => <StatusBadge value={getValue<string>()} />,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge value={getValue<string>()} />,
      },
      {
        id: 'scope',
        header: 'Owner / scope',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.assigned_user_name ?? 'Unassigned'}</p>
            <p className="text-xs text-muted-foreground">
              {row.original.team_name ?? row.original.branch_name}
            </p>
          </div>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          if (!['OPEN', 'IN_PROGRESS'].includes(row.original.status)) return null;
          if (!permissions.canUpdate && !permissions.canComplete && !permissions.canCancel)
            return null;
          return (
            <div className="flex items-center justify-end gap-1">
              {permissions.canUpdate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => onEdit(row.original)}
                  title="Edit task"
                >
                  <Pencil className="size-3.5" />
                </Button>
              )}
              {permissions.canComplete && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 whitespace-nowrap border-emerald-200 px-2 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50"
                  onClick={() => onAction('complete', row.original)}
                >
                  <CheckCircle2 className="size-3.5" /> Complete
                </Button>
              )}
              {permissions.canCancel && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 whitespace-nowrap border-rose-200 px-2 text-[11px] font-semibold text-rose-700 hover:bg-rose-50"
                  onClick={() => onAction('cancel', row.original)}
                >
                  <XCircle className="size-3.5" /> Cancel
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [onAction, onEdit, permissions, role],
  );
  // TanStack Table intentionally owns an imperative row model.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: result.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: result.total,
  });
  const pages = Math.max(1, Math.ceil(result.total / query.pageSize));
  return (
    <Card className="sales-consultant-list-card overflow-hidden shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="relative min-w-0 flex-1 xl:w-[360px] xl:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search task, customer or phone"
              value={searchInput}
              maxLength={160}
              aria-label="Search tasks"
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 xl:flex">
            <Select
              value={query.priority}
              onValueChange={(priority) =>
                onQueryChange({ priority: priority as TaskQuery['priority'], page: 1 })
              }
            >
              <SelectTrigger className="w-full xl:flex-1" aria-label="Filter by priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {taskPriorityFilters.map((priority) => (
                  <SelectItem key={priority} value={priority}>
                    {priority === 'all' ? 'All priorities' : titleCase(priority)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(sort) => onQueryChange({ sort: sort as TaskQuery['sort'], page: 1 })}
            >
              <SelectTrigger className="w-full xl:flex-1" aria-label="Sort tasks">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="due:asc">Due soonest</SelectItem>
                <SelectItem value="due:desc">Due latest</SelectItem>
                <SelectItem value="updated:desc">Recently updated</SelectItem>
                <SelectItem value="priority:desc">Highest priority</SelectItem>
                <SelectItem value="customer:asc">Customer A–Z</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
              }
            >
              <SelectTrigger className="w-full xl:w-[105px] xl:shrink-0" aria-label="Rows per page">
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
        <div
          aria-busy={isFetching}
          className={isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}
        >
          <Table className="min-w-[1120px]">
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
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={
                      isOverdueTask(row.original)
                        ? 'bg-red-50/65 hover:bg-red-50'
                        : 'hover:bg-slate-50/70'
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="px-4 py-3 align-middle text-xs">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <p className="font-medium">No matching tasks</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Clear the page-local filters or create a lead-linked task.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
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

export function TaskWorkspace({ role }: { spec: PageSpec; role: string }) {
  const workspaceSession = useWorkspaceSession();
  const useWorkspaceBootstrap = Boolean(workspaceSession?.organizationId);
  const queryScope = useMemo(
    () =>
      useWorkspaceBootstrap ? workspaceQueryScope(workspaceSession) : (['legacy', role] as const),
    [role, useWorkspaceBootstrap, workspaceSession],
  );
  const bootstrapPermissions: TaskPermissions | undefined = useWorkspaceBootstrap
    ? {
        organizationId: workspaceSession!.organizationId as string,
        scopeKey: workspaceSession!.scopeKey,
        canCreate: hasWorkspacePermission(workspaceSession, 'task.create'),
        canUpdate: hasWorkspacePermission(workspaceSession, 'task.update'),
        canComplete: hasWorkspacePermission(workspaceSession, 'task.complete'),
        canCancel: hasWorkspacePermission(workspaceSession, 'task.cancel'),
      }
    : undefined;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialCreateContext = useMemo(
    () => taskCreateContextFromUrl(searchParams),
    [searchParams],
  );
  const salesConsultantCache = useSalesConsultantCache();
  const [query, setQuery] = useState<TaskQuery>(() => {
    const parsed = parseTaskQuery(searchParams);
    if (!searchParams.has('status') && !searchParams.has('q'))
      return { ...parsed, status: 'today' };
    return parsed;
  });
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [searchInput, setSearchInput] = useState(query.search);
  const [createOpen, setCreateOpen] = useState(() => Boolean(initialCreateContext));
  const [createContext, setCreateContext] = useState<TaskCreateContext | null>(
    () => initialCreateContext,
  );
  const [editing, setEditing] = useState<TaskRecord | null>(null);
  const [actionState, setActionState] = useState<{
    action: 'complete' | 'cancel';
    record: TaskRecord;
  } | null>(null);
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
    [],
  );
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  useEffect(() => {
    const queryString = toTaskQueryString(requestQuery);
    if (queryString === searchParams.toString()) return;
    replaceQueryString(pathname, queryString);
  }, [pathname, requestQuery, searchParams]);
  const legacyPermissions = useQuery({
    queryKey: ['task-workspace-permissions', ...queryScope, role],
    queryFn: fetchTaskPermissions,
    enabled: !useWorkspaceBootstrap,
    staleTime: 60_000,
  });
  const permissions = bootstrapPermissions ?? legacyPermissions.data;
  useTenantRealtimeInvalidation(permissions?.organizationId, [
    {
      resource: 'work',
      queryKeys: [['task-workspace', ...queryScope]],
    },
  ]);
  const workspace = useQuery({
    queryKey: ['task-workspace', ...queryScope, timezone, requestQuery],
    queryFn: ({ signal }) => fetchTaskWorkspace(requestQuery, timezone, signal),
    enabled: Boolean(permissions),
    placeholderData: keepPreviousData,
  });
  const onQueryChange = (next: Partial<TaskQuery>) => {
    const updated = { ...query, ...next };
    setQuery(updated);
  };
  const onSearchChange = (value: string) => {
    setSearchInput(value);
    setQuery((current) => (current.page === 1 ? current : { ...current, page: 1 }));
  };
  const invalidate = useCallback(() => {
    salesConsultantCache.invalidate('task.changed');
  }, [salesConsultantCache]);

  if (
    (!useWorkspaceBootstrap && legacyPermissions.isPending) ||
    (workspace.isPending && permissions)
  )
    return <TasksSkeleton />;
  if (
    (!useWorkspaceBootstrap && legacyPermissions.isError) ||
    workspace.isError ||
    !permissions ||
    !workspace.data
  )
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Tasks are not available yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your access scope or the tasks migration needs attention. Reference: GDM-TASKS.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              if (!useWorkspaceBootstrap) void legacyPermissions.refetch();
              void workspace.refetch();
            }}
          >
            <RotateCcw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );

  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Link href={`/${role}/dashboard`} className="text-blue-600 hover:underline">
              Dashboard
            </Link>
            <ChevronRight className="size-3" />
            <span>Tasks</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">Tasks</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Plan lead-linked work, prioritize due items and record completion outcomes.
          </p>
        </div>
        {/*
          Tasks are raised against the lead they belong to, from the lead row's
          Create task action, which arrives here as ?action=create&lead=... and
          opens the same dialog with the lead already attached. A standalone
          button here produced tasks with no lead, so it is deliberately absent.
        */}
      </div>
      <div className="space-y-6">
        <div
          id="task-summary-kpis"
          hidden={!summaryOpen}
          className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
        >
          {taskMetricCards(workspace.data.kpis, workspace.data.status_counts).map((card) => (
            <TaskMetricCard
              key={card.status}
              card={card}
              active={query.status === card.status}
              onSelect={() =>
                onQueryChange({
                  status: query.status === card.status ? 'all' : card.status,
                  page: 1,
                })
              }
            />
          ))}
        </div>
        <TaskStatusTabs
          statusCounts={workspace.data.status_counts}
          status={query.status}
          onStatusChange={(status) => onQueryChange({ status, page: 1 })}
          summaryOpen={summaryOpen}
          onSummaryToggle={() => setSummaryOpen((open) => !open)}
        />
        <TaskTable
          result={workspace.data}
          query={query}
          role={role}
          permissions={permissions}
          isFetching={workspace.isFetching}
          searchInput={searchInput}
          onQueryChange={onQueryChange}
          onSearchChange={onSearchChange}
          onEdit={setEditing}
          onAction={(action, record) => setActionState({ action, record })}
        />
      </div>
      {permissions.canCreate && createOpen && (
        <TaskFormDialog
          initialLead={createContext}
          open
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) setCreateContext(null);
          }}
          onSaved={() => {
            setCreateContext(null);
            invalidate();
          }}
        />
      )}
      {editing && (
        <TaskFormDialog
          key={`${editing.id}:${editing.version}`}
          record={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
      {actionState && (
        <TaskActionDialog
          key={`${actionState.action}:${actionState.record.id}:${actionState.record.version}`}
          action={actionState.action}
          record={actionState.record}
          open
          onOpenChange={(open) => !open && setActionState(null)}
          onSaved={() => {
            setActionState(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}
