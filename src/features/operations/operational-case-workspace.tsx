'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Plus, RotateCcw, Search, TriangleAlert } from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { RoleKey } from '@/config/navigation/types';
import type { PageSpec } from '@/lib/domain';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  createOperationalCase,
  downloadOperationalCaseDocument,
  fetchOperationalCaseBookingOptions,
  fetchOperationalCaseDetail,
  fetchOperationalCasePermissions,
  fetchOperationalCaseWorkspace,
  setDeliveryChecklistItem,
  updateOperationalCase,
  uploadOperationalCaseDocument,
  type DeliveryChecklistItem,
  type OperationalCaseRecord,
  type OperationalCaseWorkspaceResult,
} from './operational-case-api';
import {
  operationalCasePageSizes,
  operationalCaseRoute,
  operationalCaseSorts,
  operationalCaseStatusLabel,
  operationalCaseStatuses,
  parseOperationalCaseQuery,
  toOperationalCaseQueryString,
  type OperationalCaseQuery,
} from './operational-case-query';
import {
  CreateOperationalCaseDialog,
  OperationalCaseDetailSheet,
} from './operational-case-dialogs';
import { ConnectedOperationalOverview } from './connected-operational-overview';

const commonViews = ['ALL', 'OPEN', 'DOCUMENTS', 'ACTION_DUE', 'COMPLETED'] as const;

function safeActionMessage(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { message?: string }).message === 'OPERATIONAL_CASE_VERSION_CONFLICT'
  )
    return 'This case changed in another session. Close and reopen it before retrying.';
  return 'The case action could not be completed. Review the required fields and try again.';
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function metrics(result: OperationalCaseWorkspaceResult) {
  return [
    { label: 'Open cases', value: String(result.kpis.open), helper: 'Current authorized scope' },
    {
      label: 'Pending documents',
      value: String(result.kpis.pending_documents),
      helper: 'Needs evidence',
    },
    { label: 'Overdue', value: String(result.kpis.overdue), helper: 'Due time has passed' },
    { label: 'Due today', value: String(result.kpis.due_today), helper: 'Action required today' },
    {
      label: 'Completed this month',
      value: String(result.kpis.completed_this_month),
      helper: 'Terminal cases',
    },
  ];
}

function OperationalCaseTable({
  result,
  query,
  isFetching,
  onQueryChange,
  onOpen,
}: {
  result: OperationalCaseWorkspaceResult;
  query: OperationalCaseQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<OperationalCaseQuery>) => void;
  onOpen: (record: OperationalCaseRecord) => void;
}) {
  const columns = useMemo<ColumnDef<OperationalCaseRecord>[]>(
    () => [
      {
        accessorKey: 'id',
        header: 'Case',
        cell: ({ row }) => (
          <button
            className="font-semibold text-blue-700 hover:underline"
            onClick={() => onOpen(row.original)}
          >
            #{row.original.id.slice(0, 8).toUpperCase()}
          </button>
        ),
      },
      {
        accessorKey: 'booking_number',
        header: 'Booking',
        cell: ({ getValue }) => String(getValue() ?? '—'),
      },
      { accessorKey: 'customer_name', header: 'Customer' },
      {
        accessorKey: 'assigned_user_name',
        header: 'Assigned to',
        cell: ({ getValue }) => String(getValue() ?? 'Unassigned'),
      },
      {
        accessorKey: 'priority',
        header: 'Priority',
        cell: ({ getValue }) => <StatusBadge value={String(getValue())} />,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge value={String(getValue())} />,
      },
      { accessorKey: 'document_count', header: 'Documents' },
      {
        accessorKey: 'due_at',
        header: 'Due',
        cell: ({ getValue }) => formatDate((getValue() as string | null) ?? null),
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ getValue }) => formatDate(String(getValue())),
      },
    ],
    [onOpen],
  );
  // TanStack Table exposes an imperative row model; React Compiler intentionally skips it.
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
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1 lg:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={query.search}
              maxLength={160}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              placeholder="Search this department"
            />
          </div>
          <Input
            className="lg:w-40"
            type="date"
            value={query.fromDate}
            onChange={(event) => onQueryChange({ fromDate: event.target.value, page: 1 })}
            aria-label="Updated from"
          />
          <Input
            className="lg:w-40"
            type="date"
            value={query.toDate}
            onChange={(event) => onQueryChange({ toDate: event.target.value, page: 1 })}
            aria-label="Updated to"
          />
          <Select
            value={query.sort}
            onValueChange={(value) =>
              onQueryChange({ sort: value as OperationalCaseQuery['sort'], page: 1 })
            }
          >
            <SelectTrigger className="lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operationalCaseSorts.map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {operationalCaseStatusLabel(sort.replace(':', '_'))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(query.pageSize)}
            onValueChange={(value) =>
              onQueryChange({
                pageSize: Number(value) as OperationalCaseQuery['pageSize'],
                page: 1,
              })
            }
          >
            <SelectTrigger className="lg:w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operationalCasePageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className={`overflow-x-auto transition-opacity ${isFetching ? 'opacity-60' : ''}`}>
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
                      <TableCell key={cell.id} className="whitespace-nowrap">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-40 text-center">
                    <p className="font-medium">No matching cases</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Adjust this page’s status, date or search filters.
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
            <span className="text-xs text-muted-foreground">
              Page {query.page} of {pages}
            </span>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              disabled={query.page <= 1}
              onClick={() => onQueryChange({ page: query.page - 1 })}
            >
              <ChevronLeft className="size-4" />
              <span className="sr-only">Previous page</span>
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              disabled={query.page >= pages}
              onClick={() => onQueryChange({ page: query.page + 1 })}
            >
              <ChevronRight className="size-4" />
              <span className="sr-only">Next page</span>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function OperationalCaseWorkspace({
  spec,
  role,
  slug,
}: {
  spec: PageSpec;
  role: RoleKey;
  slug: string;
}) {
  const route = operationalCaseRoute(role, slug);
  if (!route) throw new Error('INVALID_OPERATIONAL_CASE_ROUTE');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(() =>
    parseOperationalCaseQuery(searchParams, route.initialStatus),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [bookingSearch, setBookingSearch] = useState('');
  const [selected, setSelected] = useState<OperationalCaseRecord>();
  const [actionError, setActionError] = useState<string>();
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const debouncedBookingSearch = useDebouncedValue(bookingSearch, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );

  const permissions = useQuery({
    queryKey: ['operational-case-permissions', route.department],
    queryFn: () => fetchOperationalCasePermissions(route.department),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'operations',
      queryKeys: [['operational-cases', permissions.data?.organizationId]],
    },
  ]);
  const workspace = useQuery({
    queryKey: [
      'operational-cases',
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      route.department,
      requestQuery,
    ],
    queryFn: ({ signal }) => fetchOperationalCaseWorkspace(route.department, requestQuery, signal),
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
  });
  const options = useQuery({
    queryKey: ['operational-case-booking-options', route.department, debouncedBookingSearch],
    queryFn: ({ signal }) =>
      fetchOperationalCaseBookingOptions(route.department, debouncedBookingSearch, signal),
    enabled: createOpen && Boolean(permissions.data?.canManage || permissions.data?.canRequest),
  });
  const detail = useQuery({
    queryKey: ['operational-case-detail', route.department, selected?.id, selected?.version],
    queryFn: () => fetchOperationalCaseDetail(route.department, selected!.id),
    enabled: Boolean(selected),
  });

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['operational-cases', permissions.data?.organizationId],
      }),
      queryClient.invalidateQueries({ queryKey: ['operational-case-detail', route.department] }),
      queryClient.invalidateQueries({
        queryKey: ['operational-case-booking-options', route.department],
      }),
      queryClient.invalidateQueries({ queryKey: ['customer-360'] }),
    ]);
  }, [permissions.data?.organizationId, queryClient, route.department]);

  const createMutation = useMutation({
    mutationFn: createOperationalCase,
    onSuccess: async () => {
      setActionError(undefined);
      setCreateOpen(false);
      await invalidate();
    },
    onError: (error) => setActionError(safeActionMessage(error)),
  });
  const updateMutation = useMutation({
    mutationFn: updateOperationalCase,
    onSuccess: async () => {
      setActionError(undefined);
      await invalidate();
      setSelected(undefined);
    },
    onError: (error) => setActionError(safeActionMessage(error)),
  });
  const checklistMutation = useMutation({
    mutationFn: setDeliveryChecklistItem,
    onSuccess: invalidate,
    onError: (error) => setActionError(safeActionMessage(error)),
  });
  const uploadMutation = useMutation({
    mutationFn: uploadOperationalCaseDocument,
    onSuccess: invalidate,
    onError: () =>
      setActionError(
        'The private document could not be uploaded. Use PDF/JPEG/PNG/WebP up to 25 MB and retry.',
      ),
  });
  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    checklistMutation.isPending ||
    uploadMutation.isPending;

  const onQueryChange = useCallback(
    (next: Partial<OperationalCaseQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const nextQuery = toOperationalCaseQueryString(updated, route.initialStatus);
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
    },
    [pathname, query, route.initialStatus, router],
  );

  if (permissions.isPending || (workspace.isPending && permissions.data)) return <PageSkeleton />;
  if (permissions.isError || workspace.isError || !permissions.data || !workspace.data)
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Operational cases are not available yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your department permission, scope, or workspace migration needs attention. Reference:
            GDM-OPERATIONS.
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

  const canCreate =
    permissions.data.canManage ||
    (route.department === 'EXCHANGE' && permissions.data.canRequest && route.canOriginateRequest);
  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        {canCreate ? (
          <Button
            className="shrink-0 sm:mt-7"
            onClick={() => {
              setActionError(undefined);
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" /> Create case
          </Button>
        ) : null}
      </div>
      <div className="space-y-6">
        <KpiGrid metrics={metrics(workspace.data)} />
        <ConnectedOperationalOverview
          department={route.department}
          result={workspace.data}
          onOpen={(record) => {
            setActionError(undefined);
            setSelected(record);
          }}
        />
        <Tabs value={query.status} onValueChange={(status) => onQueryChange({ status, page: 1 })}>
          <div className="overflow-x-auto pb-1">
            <TabsList>
              {commonViews.map((status) => (
                <TabsTrigger key={status} value={status}>
                  {operationalCaseStatusLabel(status)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-muted-foreground">Workflow status</span>
          <Select
            value={query.status}
            onValueChange={(status) => onQueryChange({ status, page: 1 })}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {commonViews.map((status) => (
                <SelectItem key={status} value={status}>
                  {operationalCaseStatusLabel(status)}
                </SelectItem>
              ))}
              {operationalCaseStatuses[route.department].map((status) => (
                <SelectItem key={status} value={status}>
                  {operationalCaseStatusLabel(status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <OperationalCaseTable
          result={workspace.data}
          query={query}
          isFetching={workspace.isFetching}
          onQueryChange={onQueryChange}
          onOpen={(record) => {
            setActionError(undefined);
            setSelected(record);
          }}
        />
      </div>
      {canCreate ? (
        <CreateOperationalCaseDialog
          key={`${route.department}:${createOpen}`}
          open={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) setActionError(undefined);
          }}
          department={route.department}
          options={options.data ?? []}
          search={bookingSearch}
          onSearchChange={setBookingSearch}
          busy={busy}
          error={actionError}
          onSubmit={async (input) => {
            await createMutation.mutateAsync({
              department: route.department,
              bookingId: input.bookingId,
              priority: input.priority,
              dueAt: input.dueAt,
              notes: input.notes,
              requestId: input.requestId,
            });
          }}
        />
      ) : null}
      <OperationalCaseDetailSheet
        key={detail.data ? `${detail.data.id}:${detail.data.version}` : (selected?.id ?? 'none')}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(undefined);
            setActionError(undefined);
          }
        }}
        detail={detail.data}
        canManage={permissions.data.canManage}
        canUpload={permissions.data.canUpload}
        canDownload={permissions.data.canDownload}
        busy={busy}
        error={actionError ?? (detail.isError ? 'The case detail could not be loaded.' : undefined)}
        onUpdate={async (input) => {
          if (!detail.data) return;
          await updateMutation.mutateAsync({
            department: route.department,
            caseId: detail.data.id,
            expectedVersion: detail.data.version,
            status: input.status,
            patch: input.patch,
            reason: input.reason,
            requestId: input.requestId,
          });
        }}
        onChecklist={async (item: DeliveryChecklistItem, completed, requestId) => {
          await checklistMutation.mutateAsync({
            itemId: item.id,
            expectedVersion: item.version,
            completed,
            requestId,
          });
        }}
        onUpload={async (file) => {
          if (!detail.data || !permissions.data) return;
          if (
            file.size < 1 ||
            file.size > 25 * 1024 * 1024 ||
            !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)
          ) {
            setActionError('Use a PDF, JPEG, PNG or WebP file no larger than 25 MB.');
            return;
          }
          await uploadMutation.mutateAsync({
            organizationId: permissions.data.organizationId,
            record: detail.data,
            file,
          });
        }}
        onDownload={async (id) => {
          try {
            const download = await downloadOperationalCaseDocument(id);
            window.location.assign(download.download_url);
          } catch {
            setActionError('The private download link could not be created.');
          }
        }}
      />
    </div>
  );
}
