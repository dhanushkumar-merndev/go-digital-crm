'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
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
  taskStatusFilters,
  toTaskQueryString,
  type TaskQuery,
} from './task-workspace-query';

function formatDate(value: string | null) {
  if (!value) return 'No due date';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function titleCase(value: string) {
  return value.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function metrics(result: TaskWorkspaceResult): Metric[] {
  return [
    {
      label: 'Overdue',
      value: result.kpis.overdue.toLocaleString(),
      helper: 'Needs attention now',
      trend: result.kpis.overdue ? 'down' : 'neutral',
    },
    { label: 'Due today', value: result.kpis.today.toLocaleString() },
    { label: 'Upcoming', value: result.kpis.upcoming.toLocaleString() },
    { label: 'Completed today', value: result.kpis.completed_today.toLocaleString() },
  ];
}

function TaskTable({
  result,
  query,
  role,
  permissions,
  isFetching,
  onQueryChange,
  onEdit,
  onAction,
}: {
  result: TaskWorkspaceResult;
  query: TaskQuery;
  role: string;
  permissions: TaskPermissions;
  isFetching: boolean;
  onQueryChange: (next: Partial<TaskQuery>) => void;
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
                href={`/${role}/customers/${row.original.customer_id}`}
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
          const overdue =
            row.original.due_at &&
            ['OPEN', 'IN_PROGRESS'].includes(row.original.status) &&
            new Date(row.original.due_at).getTime() < Date.now();
          return (
            <div>
              <p className={overdue ? 'font-medium text-red-700' : 'font-medium'}>
                {formatDate(row.original.due_at)}
              </p>
              {overdue && <p className="text-xs text-red-600">Overdue</p>}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Task actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {permissions.canUpdate && (
                  <DropdownMenuItem onClick={() => onEdit(row.original)}>
                    <Pencil className="size-4" /> Edit task
                  </DropdownMenuItem>
                )}
                {permissions.canUpdate && (permissions.canComplete || permissions.canCancel) && (
                  <DropdownMenuSeparator />
                )}
                {permissions.canComplete && (
                  <DropdownMenuItem onClick={() => onAction('complete', row.original)}>
                    <Check className="size-4" /> Complete
                  </DropdownMenuItem>
                )}
                {permissions.canCancel && (
                  <DropdownMenuItem onClick={() => onAction('cancel', row.original)}>
                    <X className="size-4" /> Cancel
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
    <Card className="shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative w-full xl:max-w-md">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search task, customer or phone"
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={query.status}
              onValueChange={(status) =>
                onQueryChange({ status: status as TaskQuery['status'], page: 1 })
              }
            >
              <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                {taskStatusFilters.map((status) => (
                  <SelectItem key={status} value={status}>{titleCase(status)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.priority}
              onValueChange={(priority) =>
                onQueryChange({ priority: priority as TaskQuery['priority'], page: 1 })
              }
            >
              <SelectTrigger className="w-full sm:w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {taskPriorityFilters.map((priority) => (
                  <SelectItem key={priority} value={priority}>{titleCase(priority)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(sort) => onQueryChange({ sort: sort as TaskQuery['sort'], page: 1 })}
            >
              <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
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
              <SelectTrigger className="w-full sm:w-28"><SelectValue /></SelectTrigger>
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
        <div className={isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
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
            <span className="mr-2 text-xs text-muted-foreground">Page {query.page} of {pages}</span>
            <Button
              variant="outline" size="icon" className="size-8"
              disabled={query.page <= 1}
              onClick={() => onQueryChange({ page: query.page - 1 })}
              aria-label="Previous page"
            ><ChevronLeft className="size-4" /></Button>
            <Button
              variant="outline" size="icon" className="size-8"
              disabled={query.page >= pages}
              onClick={() => onQueryChange({ page: query.page + 1 })}
              aria-label="Next page"
            ><ChevronRight className="size-4" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function TaskWorkspace({ spec, role }: { spec: PageSpec; role: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(() => parseTaskQuery(searchParams));
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TaskRecord | null>(null);
  const [actionState, setActionState] = useState<{
    action: 'complete' | 'cancel';
    record: TaskRecord;
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
  const permissions = useQuery({
    queryKey: ['task-workspace-permissions'],
    queryFn: fetchTaskPermissions,
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'work',
      queryKeys: [['task-workspace', permissions.data?.organizationId]],
    },
  ]);
  const workspace = useQuery({
    queryKey: [
      'task-workspace',
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      timezone,
      requestQuery,
    ],
    queryFn: ({ signal }) => fetchTaskWorkspace(requestQuery, timezone, signal),
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
  });
  const onQueryChange = useCallback(
    (next: Partial<TaskQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toTaskQueryString(updated);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['task-workspace', permissions.data?.organizationId],
    });
    void queryClient.invalidateQueries({ queryKey: ['customer-360'] });
  }, [permissions.data?.organizationId, queryClient]);

  if (permissions.isPending || (workspace.isPending && permissions.data)) return <PageSkeleton />;
  if (permissions.isError || workspace.isError || !permissions.data || !workspace.data)
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
            className="mt-5" variant="outline"
            onClick={() => {
              void permissions.refetch();
              void workspace.refetch();
            }}
          ><RotateCcw className="size-4" /> Try again</Button>
        </CardContent>
      </Card>
    );

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        {permissions.data.canCreate && (
          <Button className="shrink-0 sm:mt-7" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Create task
          </Button>
        )}
      </div>
      <div className="space-y-6">
        <KpiGrid metrics={metrics(workspace.data)} />
        <TaskTable
          result={workspace.data}
          query={query}
          role={role}
          permissions={permissions.data}
          isFetching={workspace.isFetching}
          onQueryChange={onQueryChange}
          onEdit={setEditing}
          onAction={(action, record) => setActionState({ action, record })}
        />
      </div>
      {permissions.data.canCreate && (
        <TaskFormDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={invalidate} />
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
