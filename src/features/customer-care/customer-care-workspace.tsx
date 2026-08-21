'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Plus, Search, TriangleAlert } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { Metric, PageSpec } from '@/lib/domain';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  createCustomerCareCase,
  fetchCustomerCareDashboard,
  fetchCustomerCarePermissions,
  fetchCustomerCareWorkspace,
  updateCustomerCareCase,
  type CustomerCareRecord,
  type CustomerCareWorkspaceResult,
} from './customer-care-api';
import { CustomerRelationshipDashboard } from './customer-relationship-dashboard';
import {
  customerCareInitialView,
  customerCareLabel,
  customerCarePageSizes,
  customerCareSorts,
  customerCareViews,
  parseCustomerCareQuery,
  toCustomerCareQueryString,
  type CustomerCareQuery,
  type CustomerCareType,
} from './customer-care-query';
import { CreateCustomerCareDialog, CustomerCareCaseSheet } from './customer-care-dialogs';

const workspaceKey = ['customer-care-workspace'] as const;
const dashboardKey = ['customer-care-dashboard'] as const;

function actionError(error: unknown) {
  if (error instanceof Error && error.message === 'CUSTOMER_CARE_VERSION_CONFLICT')
    return 'This case changed in another session. Close and reopen it before retrying.';
  return 'The customer-care action could not be completed. Review the required fields and try again.';
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

function metrics(result: CustomerCareWorkspaceResult): Metric[] {
  return [
    { label: 'Open cases', value: String(result.kpis.open), helper: 'Current authorized scope' },
    { label: 'Follow-ups due', value: String(result.kpis.followups_due), helper: 'Due today' },
    {
      label: 'Feedback pending',
      value: String(result.kpis.feedback_pending),
      helper: 'Awaiting response',
    },
    {
      label: 'Reviews pending',
      value: String(result.kpis.review_pending),
      helper: 'Internal review requests',
    },
    {
      label: 'Open complaints',
      value: String(result.kpis.complaints_open),
      helper: 'Needs resolution',
    },
    { label: 'SLA risk', value: String(result.kpis.sla_risk), helper: 'Past SLA deadline' },
    {
      label: 'Resolved today',
      value: String(result.kpis.resolved_today),
      helper: 'Completed today',
    },
    {
      label: 'Average resolution',
      value: `${result.kpis.average_resolution_hours}h`,
      helper: 'Resolved cases',
    },
  ];
}

function defaultCreateType(view: CustomerCareQuery['view']): CustomerCareType {
  if (view === 'FEEDBACK') return 'FEEDBACK';
  if (view === 'REVIEW_REQUEST') return 'REVIEW_REQUEST';
  if (view === 'COMPLAINT' || view === 'ESCALATED') return 'COMPLAINT';
  return 'DELIVERY_FOLLOWUP';
}

function CustomerCareTable({
  result,
  query,
  isFetching,
  onQueryChange,
  onOpen,
}: {
  result: CustomerCareWorkspaceResult;
  query: CustomerCareQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<CustomerCareQuery>) => void;
  onOpen: (record: CustomerCareRecord) => void;
}) {
  const columns = useMemo<ColumnDef<CustomerCareRecord>[]>(
    () => [
      {
        accessorKey: 'case_number',
        header: 'Case',
        cell: ({ row }) => (
          <button
            className="font-semibold text-blue-700 hover:underline"
            onClick={() => onOpen(row.original)}
          >
            {row.original.case_number}
          </button>
        ),
      },
      { accessorKey: 'customer_name', header: 'Customer' },
      {
        accessorKey: 'case_type',
        header: 'Type',
        cell: ({ getValue }) => customerCareLabel(String(getValue())),
      },
      {
        accessorKey: 'booking_number',
        header: 'Booking',
        cell: ({ getValue }) => String(getValue() ?? '—'),
      },
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
      {
        accessorKey: 'sla_due_at',
        header: 'SLA due',
        cell: ({ getValue }) => formatDate(String(getValue())),
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
              placeholder="Case, customer, phone or booking"
            />
          </div>
          <Select
            value={query.sort}
            onValueChange={(value) =>
              onQueryChange({ sort: value as CustomerCareQuery['sort'], page: 1 })
            }
          >
            <SelectTrigger className="lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {customerCareSorts.map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {customerCareLabel(sort.replace(':', '_'))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(query.pageSize)}
            onValueChange={(value) =>
              onQueryChange({
                pageSize: Number(value) as CustomerCareQuery['pageSize'],
                page: 1,
              })
            }
          >
            <SelectTrigger className="lg:w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {customerCarePageSizes.map((size) => (
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
                    <p className="font-medium">No matching customer-care cases</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Adjust this page’s status or search filters.
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

export function CustomerCareWorkspace({
  spec,
  role,
  slug,
}: {
  spec: PageSpec;
  role: RoleKey;
  slug: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const initialView = customerCareInitialView(slug) ?? 'OPEN';
  const routeQuery = useMemo(
    () => parseCustomerCareQuery(new URLSearchParams(searchParams.toString()), initialView),
    [initialView, searchParams],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<CustomerCareRecord | null>(null);
  const isDashboard = slug === 'dashboard';
  const debouncedSearch = useDebouncedValue(routeQuery.search, 300);
  const query = useMemo(
    () => ({ ...routeQuery, search: debouncedSearch }),
    [debouncedSearch, routeQuery],
  );
  const permissions = useQuery({
    queryKey: ['customer-care-permissions'],
    queryFn: fetchCustomerCarePermissions,
  });
  const workspace = useQuery({
    queryKey: [...workspaceKey, permissions.data?.organizationId, query],
    queryFn: ({ signal }) => fetchCustomerCareWorkspace(query, signal),
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
  });
  const dashboard = useQuery({
    queryKey: [...dashboardKey, permissions.data?.organizationId],
    queryFn: ({ signal }) => fetchCustomerCareDashboard(signal),
    enabled: isDashboard && Boolean(permissions.data),
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'customer-care',
      queryKeys: [workspaceKey, dashboardKey],
    },
    { resource: 'work', queryKeys: [workspaceKey, dashboardKey] },
  ]);

  const replaceQuery = useCallback(
    (next: Partial<CustomerCareQuery>) => {
      const merged = { ...routeQuery, ...next };
      const value = toCustomerCareQueryString(merged, initialView);
      router.replace(value ? `${pathname}?${value}` : pathname, { scroll: false });
    },
    [initialView, pathname, routeQuery, router],
  );

  const createMutation = useMutation({
    mutationFn: createCustomerCareCase,
    onSuccess: async () => {
      setCreateOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKey }),
        queryClient.invalidateQueries({ queryKey: dashboardKey }),
      ]);
    },
  });
  const updateMutation = useMutation({
    mutationFn: updateCustomerCareCase,
    onSuccess: async (result) => {
      setSelected((record) =>
        record && record.id === result.id
          ? { ...record, status: result.status, version: result.version }
          : record,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKey }),
        queryClient.invalidateQueries({ queryKey: dashboardKey }),
      ]);
    },
  });

  if (permissions.isPending || workspace.isPending || (isDashboard && dashboard.isPending))
    return <PageSkeleton />;
  if (
    permissions.isError ||
    workspace.isError ||
    (isDashboard && dashboard.isError) ||
    !permissions.data ||
    !workspace.data ||
    (isDashboard && !dashboard.data)
  )
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <TriangleAlert className="size-6 text-amber-600" />
            <p className="font-semibold">Customer Care is unavailable</p>
            <p className="max-w-xl text-sm text-muted-foreground">
              Customer-care and Customer 360 permissions are required in the current tenant scope.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  const result = workspace.data;
  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          spec={{
            ...spec,
            title: isDashboard ? 'Customer Relationship Dashboard' : spec.title,
            description: isDashboard
              ? 'Monitor customer experience across enquiry, feedback, reviews and complaint resolution.'
              : spec.description,
            primaryAction: undefined,
          }}
        />
        {permissions.data.canManage && (
          <Button className="shrink-0" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Create case
          </Button>
        )}
      </div>
      {isDashboard && dashboard.data ? (
        <CustomerRelationshipDashboard
          summary={dashboard.data}
          records={result.records}
          onOpen={setSelected}
        />
      ) : (
        <>
          <KpiGrid metrics={metrics(result)} />

          <div className="grid gap-6 xl:grid-cols-12">
            <Card className="shadow-none xl:col-span-5">
              <CardHeader>
                <CardTitle className="text-base">Case status</CardTitle>
                <CardDescription>Current scoped case distribution</CardDescription>
              </CardHeader>
              <CardContent>
                <EChart kind="donut" data={result.status_chart} />
              </CardContent>
            </Card>
            <Card className="shadow-none xl:col-span-7">
              <CardHeader>
                <CardTitle className="text-base">Opened and resolved</CardTitle>
                <CardDescription>Daily activity over the last 14 days</CardDescription>
              </CardHeader>
              <CardContent>
                <EChart
                  kind="line"
                  data={result.activity_chart}
                  seriesNames={['Opened', 'Resolved']}
                />
              </CardContent>
            </Card>
          </div>

          <Tabs
            value={query.view}
            onValueChange={(value) =>
              replaceQuery({ view: value as CustomerCareQuery['view'], page: 1 })
            }
          >
            <TabsList className="h-auto max-w-full flex-wrap justify-start">
              {customerCareViews.map((view) => (
                <TabsTrigger key={view} value={view}>
                  {customerCareLabel(view)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <CustomerCareTable
            result={result}
            query={routeQuery}
            isFetching={workspace.isFetching}
            onQueryChange={replaceQuery}
            onOpen={setSelected}
          />
        </>
      )}

      <CreateCustomerCareDialog
        key={defaultCreateType(query.view)}
        open={createOpen}
        initialType={defaultCreateType(query.view)}
        pending={createMutation.isPending}
        error={createMutation.isError ? actionError(createMutation.error) : undefined}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) createMutation.reset();
        }}
        onCreate={async ({ option, ...input }) => {
          await createMutation.mutateAsync({
            ...input,
            customerId: option.customer_id,
            bookingId: option.booking_id,
            vehicleId: option.vehicle_id ?? undefined,
            assignedUserId: permissions.data.userId,
          });
        }}
      />
      <CustomerCareCaseSheet
        key={selected ? `${selected.id}:${selected.version}` : 'empty'}
        record={selected}
        role={role}
        canManage={permissions.data.canManage}
        canEscalate={permissions.data.canEscalate}
        pending={updateMutation.isPending}
        error={updateMutation.isError ? actionError(updateMutation.error) : undefined}
        onClose={() => {
          setSelected(null);
          updateMutation.reset();
        }}
        onUpdate={async (input) => {
          if (!selected) return;
          await updateMutation.mutateAsync({
            caseId: selected.id,
            expectedVersion: selected.version,
            ...input,
          });
        }}
      />
    </div>
  );
}
