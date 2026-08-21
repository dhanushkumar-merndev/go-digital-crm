'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Flag,
  MapPin,
  MessageSquareText,
  MoreHorizontal,
  Play,
  Plus,
  RotateCcw,
  Route,
  Search,
  TrendingUp,
  TriangleAlert,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
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
  fetchTestDrivePermissions,
  fetchTestDriveWorkspace,
  type TestDriveAnchorKind,
  type TestDrivePermissions,
  type TestDriveRecord,
  type TestDriveWorkspaceResult,
} from './test-drive-workspace-api';
import {
  TestDriveAnchorDialog,
  TestDriveCancelDialog,
  TestDriveFeedbackDialog,
  TestDriveFinalizeDialog,
} from './test-drive-workspace-dialogs';
import { TestDriveActiveView } from './test-drive-active-view';
import { TestDriveCreateView } from './test-drive-create-view';
import {
  parseTestDriveQuery,
  testDriveViews,
  toTestDriveQueryString,
  type TestDriveQuery,
} from './test-drive-workspace-query';

function label(value: string) {
  return value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateTime(value: string | null) {
  if (!value) return 'Not recorded';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

function expectedEnd(record: TestDriveRecord) {
  return dateTime(
    new Date(
      new Date(record.scheduled_at).getTime() + record.expected_duration_minutes * 60_000,
    ).toISOString(),
  );
}

function testDriveMetrics(result: TestDriveWorkspaceResult): Metric[] {
  const conversion = result.kpis.completed_this_month
    ? Math.round((result.kpis.converted / result.kpis.completed_this_month) * 100)
    : 0;
  return [
    {
      label: 'Today',
      value: result.kpis.today.toLocaleString(),
      helper: 'Scheduled for today',
      icon: Route,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Active',
      value: result.kpis.active.toLocaleString(),
      helper: 'On the road right now',
      icon: Play,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Completed this month',
      value: result.kpis.completed_this_month.toLocaleString(),
      icon: CheckCircle2,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Conversion after Test Drive',
      value: `${conversion}%`,
      helper: 'Completed drives with a quotation',
      icon: TrendingUp,
      tone: 'bg-cyan-50 text-cyan-600',
    },
  ];
}

type TestDriveActionState =
  | { kind: 'cancel'; record: TestDriveRecord }
  | { kind: 'anchor'; anchorKind: TestDriveAnchorKind; record: TestDriveRecord }
  | { kind: 'finalize'; record: TestDriveRecord }
  | { kind: 'feedback'; record: TestDriveRecord };

function TestDriveTable({
  result,
  query,
  role,
  permissions,
  isFetching,
  onQueryChange,
  onAction,
  onOpen,
}: {
  result: TestDriveWorkspaceResult;
  query: TestDriveQuery;
  role: string;
  permissions: TestDrivePermissions;
  isFetching: boolean;
  onQueryChange: (next: Partial<TestDriveQuery>) => void;
  onAction: (action: TestDriveActionState) => void;
  onOpen: (record: TestDriveRecord) => void;
}) {
  const columns = useMemo<ColumnDef<TestDriveRecord>[]>(
    () => [
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="flex min-w-40 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-600">
              {row.original.customer_name
                .split(' ')
                .filter(Boolean)
                .slice(0, 2)
                .map((part) => part[0]?.toUpperCase())
                .join('') || '—'}
            </span>
            <div>
              <Link
                href={`/${role}/customers/${row.original.customer_id}`}
                className="font-semibold hover:text-primary hover:underline"
              >
                {row.original.customer_name}
              </Link>
              <p className="text-xs text-muted-foreground">{row.original.phone ?? 'No phone'}</p>
            </div>
          </div>
        ),
      },
      {
        id: 'vehicle',
        header: 'Vehicle',
        cell: ({ row }) => (
          <div className="min-w-48">
            <p className="font-medium">
              {[row.original.brand_name, row.original.model_name].filter(Boolean).join(' ') ||
                'Vehicle not specified'}
            </p>
            <p className="text-xs text-muted-foreground">
              {[row.original.variant_name, row.original.color].filter(Boolean).join(' · ') ||
                'Variant not specified'}
            </p>
          </div>
        ),
      },
      {
        id: 'registration',
        header: 'Test-drive unit',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.vehicle_registration ?? 'No registration'}</p>
            <p className="max-w-36 truncate text-xs text-muted-foreground">
              {row.original.vin ?? row.original.chassis_number ?? 'No VIN'}
            </p>
          </div>
        ),
      },
      {
        id: 'schedule',
        header: 'Schedule',
        cell: ({ row }) => (
          <div className="min-w-44">
            <p className="font-medium">{dateTime(row.original.scheduled_at)}</p>
            <p className="text-xs text-muted-foreground">
              Expected end {expectedEnd(row.original)}
            </p>
          </div>
        ),
      },
      {
        id: 'owner',
        header: 'Consultant / scope',
        cell: ({ row }) => (
          <div className="min-w-36">
            <p className="font-medium">{row.original.assigned_user_name}</p>
            <p className="text-xs text-muted-foreground">
              {row.original.team_name ?? row.original.branch_name}
            </p>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <div className="space-y-1">
            <StatusBadge value={row.original.status} />
            {row.original.started_at && (
              <p className="text-xs text-muted-foreground">
                {row.original.completed_at ? 'Ended' : 'Started'}{' '}
                {dateTime(row.original.completed_at ?? row.original.started_at)}
              </p>
            )}
          </div>
        ),
      },
      {
        id: 'gps',
        header: 'GPS',
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            className={row.original.start_anchor ? 'text-emerald-600' : 'text-muted-foreground'}
            onClick={() => onOpen(row.original)}
            aria-label="Open test-drive tracking"
          >
            <MapPin className="size-4" />
          </Button>
        ),
      },
      {
        id: 'outcome',
        header: 'Outcome',
        cell: ({ row }) => (
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {row.original.feedback_id
                ? `${row.original.overall_rating ?? '—'} / 5 feedback`
                : 'Feedback pending'}
            </p>
            <p className="text-xs text-muted-foreground">
              {row.original.quotation_status
                ? `Quotation ${label(row.original.quotation_status)}`
                : 'Quotation pending'}
            </p>
          </div>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const record = row.original;
          const canProgress =
            permissions.canProgressOwn && record.assigned_user_id === permissions.userId;
          const canCancel = permissions.canManage && record.status === 'READY';
          const canStart = canProgress && record.status === 'READY';
          const canReach = canProgress && record.status === 'ACTIVE' && !record.reached_at;
          const canEnd = canProgress && record.status === 'ACTIVE';
          const canFinalize =
            canProgress &&
            record.status === 'COMPLETED' &&
            !record.route_finalized_at &&
            Boolean(record.start_anchor && record.end_anchor);
          const canFeedback =
            canProgress &&
            record.status === 'COMPLETED' &&
            Boolean(record.route_finalized_at) &&
            !record.feedback_id;
          if (!canCancel && !canStart && !canReach && !canEnd && !canFinalize && !canFeedback)
            return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Test-drive actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canStart && (
                  <DropdownMenuItem
                    onClick={() => onAction({ kind: 'anchor', anchorKind: 'start', record })}
                  >
                    <Play className="size-4" /> Start test drive
                  </DropdownMenuItem>
                )}
                {canReach && (
                  <DropdownMenuItem
                    onClick={() => onAction({ kind: 'anchor', anchorKind: 'reached', record })}
                  >
                    <MapPin className="size-4" /> Record destination reached
                  </DropdownMenuItem>
                )}
                {canEnd && (
                  <DropdownMenuItem
                    onClick={() => onAction({ kind: 'anchor', anchorKind: 'end', record })}
                  >
                    <Flag className="size-4" /> Complete test drive
                  </DropdownMenuItem>
                )}
                {canFinalize && (
                  <DropdownMenuItem onClick={() => onAction({ kind: 'finalize', record })}>
                    <CheckCircle2 className="size-4" /> Finalize route summary
                  </DropdownMenuItem>
                )}
                {canFeedback && (
                  <DropdownMenuItem onClick={() => onAction({ kind: 'feedback', record })}>
                    <MessageSquareText className="size-4" /> Add feedback
                  </DropdownMenuItem>
                )}
                {(canStart || canReach || canEnd || canFinalize || canFeedback) && canCancel && (
                  <DropdownMenuSeparator />
                )}
                {canCancel && (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onAction({ kind: 'cancel', record })}
                  >
                    <X className="size-4" /> Cancel test drive
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [onAction, onOpen, permissions, role],
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
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(240px,1.2fr)_minmax(180px,1fr)_minmax(190px,1fr)_170px_170px_120px]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={query.search}
              maxLength={160}
              placeholder="Search customer, mobile, registration…"
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
            />
          </div>
          <Input
            value={query.model}
            maxLength={120}
            placeholder="All models"
            onChange={(event) => onQueryChange({ model: event.target.value, page: 1 })}
          />
          <Select
            value={query.sort}
            onValueChange={(sort) =>
              onQueryChange({ sort: sort as TestDriveQuery['sort'], page: 1 })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="scheduled:asc">Schedule earliest</SelectItem>
              <SelectItem value="scheduled:desc">Schedule latest</SelectItem>
              <SelectItem value="updated:desc">Recently updated</SelectItem>
              <SelectItem value="customer:asc">Customer A–Z</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="date"
            aria-label="From date"
            value={query.fromDate}
            max={query.toDate || undefined}
            onChange={(event) => onQueryChange({ fromDate: event.target.value, page: 1 })}
          />
          <Input
            type="date"
            aria-label="To date"
            value={query.toDate}
            min={query.fromDate || undefined}
            onChange={(event) => onQueryChange({ toDate: event.target.value, page: 1 })}
          />
          <Select
            value={String(query.pageSize)}
            onValueChange={(value) =>
              onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
            }
          >
            <SelectTrigger className="w-full min-w-[120px] whitespace-nowrap">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="25">25 rows</SelectItem>
              <SelectItem value="50">50 rows</SelectItem>
              <SelectItem value="100">100 rows</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className={isFetching ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}>
          <Table>
            <TableHeader className="bg-slate-50/80">
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
                  <TableRow key={row.id} className="hover:bg-slate-50/80">
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
                    <p className="font-medium">No matching test drives</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Clear the page-local filters or select another status tab.
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

export function TestDriveWorkspace({ spec, role }: { spec: PageSpec; role: string }) {
  void spec;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(() => parseTestDriveQuery(searchParams));
  const [screen, setScreen] = useState<'list' | 'create' | 'detail'>(() =>
    searchParams.get('action') === 'create' ? 'create' : 'list',
  );
  const [selectedRecord, setSelectedRecord] = useState<TestDriveRecord | null>(null);
  const [actionState, setActionState] = useState<TestDriveActionState | null>(null);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const debouncedModel = useDebouncedValue(query.model, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch, model: debouncedModel }),
    [debouncedModel, debouncedSearch, query],
  );
  const permissions = useQuery({
    queryKey: ['test-drive-permissions'],
    queryFn: fetchTestDrivePermissions,
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'work',
      queryKeys: [['test-drive-workspace', permissions.data?.organizationId]],
    },
    {
      resource: 'sales',
      queryKeys: [['test-drive-workspace', permissions.data?.organizationId]],
    },
  ]);
  const workspace = useQuery({
    queryKey: [
      'test-drive-workspace',
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      requestQuery,
    ],
    queryFn: ({ signal }) => fetchTestDriveWorkspace(requestQuery, 'Asia/Kolkata', signal),
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
  });
  const onQueryChange = useCallback(
    (next: Partial<TestDriveQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toTestDriveQueryString(updated);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['test-drive-workspace', permissions.data?.organizationId],
    });
    void queryClient.invalidateQueries({ queryKey: ['test-drive-lead-options'] });
    void queryClient.invalidateQueries({ queryKey: ['test-drive-vehicle-options'] });
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
          <h2 className="mt-4 font-semibold">Test drives are not available yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your access scope or the test-drive workspace migration needs attention. Reference:
            GDM-TEST-DRIVES.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              void permissions.refetch();
              void workspace.refetch();
            }}
          >
            <RotateCcw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );

  if (screen === 'create')
    return (
      <TestDriveCreateView
        onCancel={() => setScreen('list')}
        onSaved={() => {
          invalidate();
          setScreen('list');
        }}
      />
    );
  if (screen === 'detail' && selectedRecord) {
    const current =
      workspace.data.records.find((item) => item.id === selectedRecord.id) ?? selectedRecord;
    return (
      <>
        <TestDriveActiveView
          record={current}
          onBack={() => setScreen('list')}
          onAnchor={(anchorKind) => setActionState({ kind: 'anchor', anchorKind, record: current })}
        />
        {actionState?.kind === 'anchor' && (
          <TestDriveAnchorDialog
            key={`${actionState.record.id}:${actionState.record.version}:${actionState.anchorKind}`}
            kind={actionState.anchorKind}
            record={actionState.record}
            open
            onOpenChange={(open) => !open && setActionState(null)}
            onSaved={() => {
              setActionState(null);
              invalidate();
              setScreen('list');
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="text-primary">Dashboard</span>
            <span className="text-muted-foreground">›</span>
            <span className="text-muted-foreground">Test Drives</span>
          </div>
          <h1 className="text-2xl font-bold">Test Drive List</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage and track every test drive scheduled with your customers.
          </p>
        </div>
        {permissions.data.canManage && (
          <Button className="shrink-0 sm:mt-7" onClick={() => setScreen('create')}>
            <Plus className="size-4" /> Book Test Drive
          </Button>
        )}
      </div>
      <div className="space-y-6">
        <div className="flex h-10 gap-2 overflow-x-auto border-b">
          {testDriveViews.map((view) => {
            const active = query.view === view;
            return (
              <button
                key={view}
                type="button"
                onClick={() => onQueryChange({ view, page: 1 })}
                className={`relative h-full shrink-0 px-3 text-xs font-semibold ${
                  active ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700'
                }`}
                style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
              >
                {label(view)}
              </button>
            );
          })}
        </div>
        <KpiGrid metrics={testDriveMetrics(workspace.data)} />
        <TestDriveTable
          result={workspace.data}
          query={query}
          role={role}
          permissions={permissions.data}
          isFetching={workspace.isFetching}
          onQueryChange={onQueryChange}
          onAction={setActionState}
          onOpen={(record) => {
            setSelectedRecord(record);
            setScreen('detail');
          }}
        />
      </div>
      {actionState?.kind === 'cancel' && (
        <TestDriveCancelDialog
          key={`${actionState.record.id}:${actionState.record.version}:cancel`}
          record={actionState.record}
          open
          onOpenChange={(open) => !open && setActionState(null)}
          onSaved={() => {
            setActionState(null);
            invalidate();
          }}
        />
      )}
      {actionState?.kind === 'anchor' && (
        <TestDriveAnchorDialog
          key={`${actionState.record.id}:${actionState.record.version}:${actionState.anchorKind}`}
          kind={actionState.anchorKind}
          record={actionState.record}
          open
          onOpenChange={(open) => !open && setActionState(null)}
          onSaved={() => {
            setActionState(null);
            invalidate();
          }}
        />
      )}
      {actionState?.kind === 'finalize' && (
        <TestDriveFinalizeDialog
          key={`${actionState.record.id}:${actionState.record.version}:finalize`}
          record={actionState.record}
          open
          onOpenChange={(open) => !open && setActionState(null)}
          onSaved={() => {
            setActionState(null);
            invalidate();
          }}
        />
      )}
      {actionState?.kind === 'feedback' && (
        <TestDriveFeedbackDialog
          key={`${actionState.record.id}:${actionState.record.version}:feedback`}
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
