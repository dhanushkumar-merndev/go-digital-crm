'use client';

import { TablePagination } from '@/components/shared/table-pagination';
import { ErrorState } from '@/components/shared/page-states';
import { useCallback, useMemo, useState } from 'react';
import { formatCurrency, sortLabel } from '@/lib/format';
import { usePathname, useSearchParams } from 'next/navigation';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { RefreshFailedNotice } from '@/components/shared/refresh-failed-notice';
import { OperationalCaseWorkspaceSkeleton } from '@/components/skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { salesConsultantKeys } from '@/features/sales-consultant/sales-consultant-cache';
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
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import type { RoleKey } from '@/config/navigation/types';
import type { PageSpec } from '@/lib/domain';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { optionQueryOptions } from '@/lib/query/option-query';
import { retryRpcRead } from '@/lib/supabase/read-rpc';
import {
  createOperationalCase,
  downloadOperationalCaseDocument,
  fetchOperationalCaseBookingOptions,
  fetchOperationalCaseDetail,
  fetchOperationalCasePermissions,
  fetchOperationalCaseWorkspace,
  saveDeliveryChecklist,
  updateOperationalCase,
  uploadOperationalCaseDocument,
  type OperationalCaseRecord,
  type OperationalCaseWorkspaceResult,
} from './operational-case-api';
import {
  operationalCasePageSizes,
  operationalCaseRoute,
  operationalCaseSorts,
  operationalCaseStatusLabel,
  operationalCaseStatuses,
  operationalCaseTabs,
  parseOperationalCaseQuery,
  toOperationalCaseQueryString,
  type OperationalCaseQuery,
} from './operational-case-query';
import {
  CreateOperationalCaseDialog,
  OperationalCaseDetailSheet,
} from './operational-case-dialogs';
import { ConnectedOperationalOverview } from './connected-operational-overview';

const commonViews = ['ALL', 'OPEN', 'DOCUMENTS', 'ACTION_DUE', 'DUE_TODAY', 'COMPLETED'] as const;

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

// Each tile opens the tab whose rows it counts.
function metrics(result: OperationalCaseWorkspaceResult, pathname: string) {
  const tab = (status: string) => `${pathname}?status=${status}`;
  return [
    {
      label: 'Open cases',
      value: String(result.kpis.open),
      helper: 'Current authorized scope',
      href: tab('OPEN'),
    },
    {
      label: 'Pending documents',
      value: String(result.kpis.pending_documents),
      helper: 'Needs evidence',
      href: tab('DOCUMENTS'),
    },
    {
      label: 'Overdue',
      value: String(result.kpis.overdue),
      helper: 'Due time has passed',
      href: tab('ACTION_DUE'),
    },
    {
      label: 'Due today',
      value: String(result.kpis.due_today),
      helper: 'Action required today',
      href: tab('DUE_TODAY'),
    },
    {
      label: 'Completed this month',
      value: String(result.kpis.completed_this_month),
      helper: 'Terminal cases',
      href: tab('COMPLETED'),
    },
  ];
}

function detailText(record: OperationalCaseRecord, key: string) {
  const value = record.details[key];
  return typeof value === 'string' && value.trim() ? value : '—';
}

function detailAmount(record: OperationalCaseRecord, key: string) {
  const value = Number(record.details[key]);
  return record.details[key] === undefined ||
    record.details[key] === null ||
    !Number.isFinite(value)
    ? '—'
    : formatCurrency(value);
}

function detailDate(record: OperationalCaseRecord, key: string) {
  const value = record.details[key];
  return typeof value === 'string' ? formatDate(value) : '—';
}

function detailColumn(
  id: string,
  header: string,
  read: (record: OperationalCaseRecord) => string,
): ColumnDef<OperationalCaseRecord> {
  return { id, header, cell: ({ row }) => read(row.original) };
}

/**
 * The columns each desk works from (AGENTS.md 52.7 CaseWorkspace presets): the
 * shared case, owner and status columns stay, and these say what the desk is
 * actually waiting on. Values come from the row's `details`, already returned
 * by the page RPC, so a preset adds no query.
 */
const departmentColumns: Record<
  OperationalCaseWorkspaceResult['department'],
  ColumnDef<OperationalCaseRecord>[]
> = {
  FINANCE: [
    detailColumn('lender', 'Lender', (record) => detailText(record, 'lender')),
    detailColumn('approved_amount', 'Approved', (record) =>
      detailAmount(record, 'approved_amount'),
    ),
    detailColumn('disbursed_at', 'Disbursed', (record) => detailDate(record, 'disbursed_at')),
  ],
  INSURANCE: [
    detailColumn('insurer', 'Insurer', (record) => detailText(record, 'insurer')),
    detailColumn('policy_number', 'Policy no.', (record) => detailText(record, 'policy_number')),
    detailColumn('policy_end', 'Policy ends', (record) => detailDate(record, 'policy_end')),
  ],
  RTO: [
    detailColumn('registration_number', 'Registration no.', (record) =>
      detailText(record, 'registration_number'),
    ),
    detailColumn('submitted_at', 'Submitted', (record) => detailDate(record, 'submitted_at')),
  ],
  EXCHANGE: [
    detailColumn('estimated_value', 'Expected', (record) =>
      detailAmount(record, 'estimated_value'),
    ),
    detailColumn('quoted_value', 'Evaluated', (record) => {
      const evaluation = record.details.evaluation as { quoted_value?: unknown } | undefined;
      const value = Number(evaluation?.quoted_value);
      return evaluation?.quoted_value == null || !Number.isFinite(value)
        ? '—'
        : formatCurrency(value);
    }),
    detailColumn('accepted_value', 'Accepted', (record) => detailAmount(record, 'accepted_value')),
  ],
  DELIVERY: [
    detailColumn('scheduled_at', 'Delivery date', (record) => detailDate(record, 'scheduled_at')),
    detailColumn('checklist', 'Checklist', (record) => {
      const total = Number(record.details.checklist_total ?? 0);
      const done = Number(record.details.checklist_completed ?? 0);
      return total ? `${done} of ${total}` : '—';
    }),
  ],
};

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
      ...departmentColumns[result.department],
      { accessorKey: 'document_count', header: 'Documents' },
      {
        accessorKey: 'due_at',
        header: 'Due',
        cell: ({ getValue }) => formatDate((getValue() as string | null) ?? null),
      },
    ],
    [onOpen, result.department],
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
                  {sortLabel(sort)}
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
        <TablePagination
          page={query.page}
          pageSize={query.pageSize}
          total={result.total}
          onPageChange={(page) => onQueryChange({ page })}
        />
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const workspaceSession = useWorkspaceSession();
  const [query, setQuery] = useState(() =>
    parseOperationalCaseQuery(searchParams, route.initialStatus),
  );
  // A KPI tile is a link to a tab of this same page. The URL changes without a
  // remount, so adopt its status here; this page's own replaceQueryString
  // writes already match `query` and change nothing.
  const urlStatus = parseOperationalCaseQuery(searchParams, route.initialStatus).status;
  const [seenUrlStatus, setSeenUrlStatus] = useState(urlStatus);
  if (urlStatus !== seenUrlStatus) {
    setSeenUrlStatus(urlStatus);
    if (urlStatus !== query.status) setQuery({ ...query, status: urlStatus, page: 1 });
  }
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

  const permissionQuery = useQuery({
    queryKey: [
      'operational-case-permissions',
      ...workspaceQueryScope(workspaceSession),
      route.department,
    ],
    queryFn: () => fetchOperationalCasePermissions(route.department),
    enabled: !workspaceSession,
    staleTime: 60_000,
  });
  const viewPermission = `${route.department.toLowerCase()}.view`;
  const managePermission = `${route.department.toLowerCase()}.manage`;
  const bootstrapPermissions =
    workspaceSession?.organizationId && hasWorkspacePermission(workspaceSession, viewPermission)
      ? {
          organizationId: workspaceSession.organizationId,
          userId: workspaceSession.userId,
          scopeKey: workspaceSession.scopeKey,
          canManage: hasWorkspacePermission(workspaceSession, managePermission),
          canRequest:
            route.department === 'EXCHANGE'
              ? hasWorkspacePermission(workspaceSession, 'exchange.request')
              : hasWorkspacePermission(workspaceSession, managePermission),
          canUpload: hasWorkspacePermission(workspaceSession, 'document.upload'),
          canDownload: hasWorkspacePermission(workspaceSession, 'document.download'),
        }
      : undefined;
  const permissions = {
    data: bootstrapPermissions ?? permissionQuery.data,
    isPending: !workspaceSession && permissionQuery.isPending,
    isError: workspaceSession ? !bootstrapPermissions : permissionQuery.isError,
    refetch: permissionQuery.refetch,
  };
  const queryScope = workspaceQueryScope(workspaceSession);
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'operations',
      queryKeys: [['operational-cases', ...queryScope]],
    },
  ]);
  const workspace = useQuery({
    queryKey: ['operational-cases', ...queryScope, route.department, requestQuery],
    queryFn: ({ signal }) => fetchOperationalCaseWorkspace(route.department, requestQuery, signal),
    retry: retryRpcRead,
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
  });
  const options = useQuery({
    ...optionQueryOptions({
      queryKey: [
        'operational-case-booking-options',
        ...queryScope,
        route.department,
        debouncedBookingSearch,
      ],
      queryFn: ({ signal }) =>
        fetchOperationalCaseBookingOptions(route.department, debouncedBookingSearch, signal),
      enabled: createOpen && Boolean(permissions.data?.canManage || permissions.data?.canRequest),
    }),
    retry: retryRpcRead,
  });
  const detail = useQuery({
    queryKey: [
      'operational-case-detail',
      ...queryScope,
      route.department,
      selected?.id,
      selected?.version,
    ],
    queryFn: ({ signal }) => fetchOperationalCaseDetail(route.department, selected!.id, signal),
    retry: retryRpcRead,
    enabled: Boolean(selected),
  });

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['operational-cases', ...queryScope],
      }),
      queryClient.invalidateQueries({ queryKey: ['operational-case-detail', ...queryScope] }),
      queryClient.invalidateQueries({
        queryKey: ['operational-case-booking-options', ...queryScope, route.department],
      }),
      queryClient.invalidateQueries({ queryKey: salesConsultantKeys.customer360(queryScope) }),
    ]);
  }, [queryClient, queryScope, route.department]);

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
    mutationFn: saveDeliveryChecklist,
    onSuccess: async () => {
      setActionError(undefined);
      await invalidate();
    },
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
      replaceQueryString(pathname, toOperationalCaseQueryString(updated, route.initialStatus));
    },
    [pathname, query, route.initialStatus],
  );

  if (permissions.isPending || (workspace.isPending && permissions.data))
    return <OperationalCaseWorkspaceSkeleton />;
  // A failed background refresh keeps the rows already on screen (with a
  // notice); the full error state is only for a page that never loaded.
  if (permissions.isError || !permissions.data || !workspace.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="Operational cases are not available yet"
          description="Your department permission, scope, or workspace migration needs attention."
          reference="GDM-OPERATIONS"
          onRetry={() => {
            void permissions.refetch();
            void workspace.refetch();
          }}
        />
      </PageShell>
    );

  // Sales Consultant Exchange keeps its original view set.
  const caseTabs =
    role === 'sales-consultant'
      ? commonViews.map((status) => ({ status, label: operationalCaseStatusLabel(status) }))
      : operationalCaseTabs[route.department];
  const canCreate =
    permissions.data.canManage ||
    (route.department === 'EXCHANGE' && permissions.data.canRequest && route.canOriginateRequest);
  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        actions={
          canCreate ? (
            <Button
              className="shrink-0"
              onClick={() => {
                setActionError(undefined);
                setCreateOpen(true);
              }}
            >
              <Plus className="size-4" /> Create case
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-5">
        <RefreshFailedNotice
          show={workspace.isError}
          retrying={workspace.isFetching}
          onRetry={() => void workspace.refetch()}
        />
        <KpiGrid metrics={metrics(workspace.data, pathname)} />
        <ConnectedOperationalOverview
          department={route.department}
          result={workspace.data}
          onOpen={(record) => {
            setActionError(undefined);
            setSelected(record);
          }}
        />
        {/* Queue tabs and the fine-grained status picker share one row above the table. */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs value={query.status} onValueChange={(status) => onQueryChange({ status, page: 1 })}>
            <div className="overflow-x-auto pb-1">
              <TabsList>
                {caseTabs.map((tab) => (
                  <TabsTrigger key={tab.status} value={tab.status}>
                    {tab.label}
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
          options={options.data}
          optionsPending={options.isPending}
          optionsFetching={options.isFetching}
          optionsError={options.isError}
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
        key={selected?.id ?? 'none'}
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
        onChecklistSave={async (items, requestId) => {
          if (!detail.data) return;
          await checklistMutation.mutateAsync({ deliveryId: detail.data.id, items, requestId });
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
