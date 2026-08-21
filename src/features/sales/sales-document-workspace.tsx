'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  CalendarClock,
  CarFront,
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  FileText,
  IndianRupee,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
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
  fetchSalesDocumentPermissions,
  fetchSalesDocumentWorkspace,
  fetchBookingFilterOptions,
  type BookingFilterOptions,
  type BookingRecord,
  type BookingWorkspaceResult,
  type QuotationRecord,
  type QuotationWorkspaceResult,
} from './sales-document-api';
import {
  BookingCreateDialog,
  SalesDocumentActionDialog,
  type BookingAction,
  type QuotationAction,
} from './sales-document-dialogs';
import { QuotationCreateView } from './quotation-create-view';
import {
  bookingStatusFilters,
  parseSalesDocumentQuery,
  quotationStatusFilters,
  toSalesDocumentQueryString,
  type SalesDocumentKind,
  type SalesDocumentQuery,
} from './sales-document-query';

function currency(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function dateOnly(value: string | null) {
  if (!value) return 'Not scheduled';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${value}T00:00:00Z`),
  );
}

function label(value: string) {
  return value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function quotationMetrics(result: QuotationWorkspaceResult): Metric[] {
  return [
    {
      label: 'Open Quotations',
      value: result.kpis.open.toLocaleString(),
      icon: FileText,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Sent',
      value: result.kpis.sent.toLocaleString(),
      icon: Send,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Approval required',
      value: result.kpis.approval_required.toLocaleString(),
      helper: 'Distinct manager decision required',
      icon: Clock3,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Pipeline value',
      value: currency(result.kpis.pipeline_value),
      helper: `${result.kpis.converted.toLocaleString()} converted`,
      icon: IndianRupee,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];
}

function bookingMetrics(result: BookingWorkspaceResult): Metric[] {
  return [
    {
      label: 'Pending bookings',
      value: (result.kpis.pending ?? result.kpis.awaiting_allocation).toLocaleString(),
      helper: 'Awaiting stock allocation',
      icon: CalendarClock,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Confirmed',
      value: (result.kpis.confirmed ?? result.kpis.bookings).toLocaleString(),
      helper: 'Confirmed customer bookings',
      icon: CircleCheck,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Delivery ready',
      value: (result.kpis.ready_for_delivery ?? result.kpis.delivery_this_week).toLocaleString(),
      helper: 'Vehicle ready for handover',
      icon: CarFront,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Delivered this month',
      value: (result.kpis.delivered_this_month ?? result.kpis.delivered).toLocaleString(),
      helper: 'Completed in the current month',
      icon: CarFront,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];
}

function TableFrame<T>({
  columns,
  records,
  total,
  query,
  kind,
  isFetching,
  onQueryChange,
  bookingOptions,
}: {
  columns: ColumnDef<T>[];
  records: T[];
  total: number;
  query: SalesDocumentQuery;
  kind: SalesDocumentKind;
  isFetching: boolean;
  onQueryChange: (next: Partial<SalesDocumentQuery>) => void;
  bookingOptions?: BookingFilterOptions;
}) {
  // TanStack Table intentionally owns an imperative row model.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: total,
  });
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const statuses = kind === 'quotations' ? quotationStatusFilters : bookingStatusFilters;
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b p-4">
        <div
          className={
            kind === 'bookings'
              ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-6'
              : 'flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between'
          }
        >
          <div className="relative w-full xl:max-w-md">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder={
                kind === 'quotations'
                  ? 'Search quotation, customer or phone'
                  : 'Search booking, quotation, customer or phone'
              }
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
            />
          </div>
          {kind === 'bookings' ? (
            <>
              <Select
                value={query.model || 'all'}
                onValueChange={(model) =>
                  onQueryChange({ model: model === 'all' ? '' : model, page: 1 })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All models" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All models</SelectItem>
                  {bookingOptions?.models.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={query.status}
                onValueChange={(status) =>
                  onQueryChange({ status: status as SalesDocumentQuery['status'], page: 1 })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status === 'awaiting-allocation' ? 'Stock Awaited' : label(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {bookingOptions?.branches.length === 1 ? (
                <div className="flex h-9 items-center truncate rounded-md border bg-muted/30 px-3 text-sm">
                  {bookingOptions.branches[0]?.name}
                </div>
              ) : (
                <Select
                  value={query.branchId || 'all'}
                  onValueChange={(branchId) =>
                    onQueryChange({ branchId: branchId === 'all' ? '' : branchId, page: 1 })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="All authorized branches" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All authorized branches</SelectItem>
                    {bookingOptions?.branches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Input
                type="date"
                value={query.fromDate}
                onChange={(event) => onQueryChange({ fromDate: event.target.value, page: 1 })}
                aria-label="Booking date from"
              />
              <Input
                type="date"
                value={query.toDate}
                onChange={(event) => onQueryChange({ toDate: event.target.value, page: 1 })}
                aria-label="Booking date to"
              />
            </>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={query.status}
                onValueChange={(status) =>
                  onQueryChange({ status: status as SalesDocumentQuery['status'], page: 1 })
                }
              >
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((status) => (
                    <SelectItem key={status} value={status}>
                      {label(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={query.sort}
                onValueChange={(sort) =>
                  onQueryChange({ sort: sort as SalesDocumentQuery['sort'], page: 1 })
                }
              >
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated:desc">Recently updated</SelectItem>
                  <SelectItem value="updated:asc">Oldest updated</SelectItem>
                  <SelectItem value="amount:desc">Highest value</SelectItem>
                  <SelectItem value="amount:asc">Lowest value</SelectItem>
                  <SelectItem value="customer:asc">Customer A–Z</SelectItem>
                  <SelectItem value="customer:desc">Customer Z–A</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={String(query.pageSize)}
                onValueChange={(value) =>
                  onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
                }
              >
                <SelectTrigger className="w-full sm:w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="25">25 rows</SelectItem>
                  <SelectItem value="50">50 rows</SelectItem>
                  <SelectItem value="100">100 rows</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {kind === 'bookings' && (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Select
              value={query.sort}
              onValueChange={(sort) =>
                onQueryChange({ sort: sort as SalesDocumentQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="delivery:asc">Earliest delivery</SelectItem>
                <SelectItem value="delivery:desc">Latest delivery</SelectItem>
                <SelectItem value="updated:desc">Recently booked</SelectItem>
                <SelectItem value="amount:desc">Highest value</SelectItem>
                <SelectItem value="customer:asc">Customer A–Z</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
              }
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
            <Button
              variant="outline"
              disabled={
                !query.search &&
                query.status === 'all' &&
                !query.model &&
                !query.branchId &&
                !query.fromDate &&
                !query.toDate
              }
              onClick={() =>
                onQueryChange({
                  page: 1,
                  search: '',
                  status: 'all',
                  model: '',
                  branchId: '',
                  fromDate: '',
                  toDate: '',
                })
              }
            >
              Clear filters
            </Button>
          </div>
        )}
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
                    <p className="font-medium">No matching {kind}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Clear the page-local filters to broaden this scoped result.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {total ? (query.page - 1) * query.pageSize + 1 : 0}–
            {Math.min(query.page * query.pageSize, total)} of {total}
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

export function SalesDocumentWorkspace({
  kind,
  role,
  spec,
}: {
  kind: SalesDocumentKind;
  role: string;
  spec: PageSpec;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(() => parseSalesDocumentQuery(searchParams, kind));
  const [createOpen, setCreateOpen] = useState(() => searchParams.get('action') === 'create');
  const [quotationScreen, setQuotationScreen] = useState<'list' | 'create'>(() =>
    kind === 'quotations' && searchParams.get('action') === 'create' ? 'create' : 'list',
  );
  const [editingQuotation, setEditingQuotation] = useState<QuotationRecord | null>(null);
  const [actionState, setActionState] = useState<{
    record: QuotationRecord | BookingRecord;
    action: QuotationAction | BookingAction;
  } | null>(null);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const permissions = useQuery({
    queryKey: ['sales-document-permissions', kind],
    queryFn: () => fetchSalesDocumentPermissions(kind),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'sales',
      queryKeys: [['sales-document-workspace', kind, permissions.data?.organizationId]],
    },
  ]);
  const workspace = useQuery({
    queryKey: [
      'sales-document-workspace',
      kind,
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      requestQuery,
    ],
    queryFn: ({ signal }) => fetchSalesDocumentWorkspace(kind, requestQuery, signal),
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
  });
  const bookingFilterOptions = useQuery({
    queryKey: [
      'sales-booking-filter-options',
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
    ],
    queryFn: ({ signal }) => fetchBookingFilterOptions(signal),
    enabled: kind === 'bookings' && Boolean(permissions.data),
    staleTime: 60_000,
  });
  const onQueryChange = useCallback(
    (next: Partial<SalesDocumentQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toSalesDocumentQueryString(updated, kind);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [kind, pathname, query, router],
  );
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['sales-document-workspace', kind, permissions.data?.organizationId],
    });
    void queryClient.invalidateQueries({ queryKey: ['customer-360'] });
    void queryClient.invalidateQueries({ queryKey: ['booking-quotation-options'] });
  }, [kind, permissions.data?.organizationId, queryClient]);

  const quotationColumns = useMemo<ColumnDef<QuotationRecord>[]>(
    () => [
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-40">
            <Link
              href={`/${role}/customers/${row.original.customer_id}`}
              className="font-semibold hover:text-primary hover:underline"
            >
              {row.original.customer_name}
            </Link>
            <p className="text-xs text-muted-foreground">{row.original.phone ?? 'No phone'}</p>
          </div>
        ),
      },
      {
        id: 'reference',
        header: 'Quotation',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.quotation_number}</p>
            <p className="text-xs text-muted-foreground">Version {row.original.current_version}</p>
          </div>
        ),
      },
      {
        accessorKey: 'interested_model',
        header: 'Vehicle',
        cell: ({ getValue }) => getValue<string | null>() ?? 'Not specified',
      },
      {
        accessorKey: 'total_amount',
        header: 'Amount',
        cell: ({ getValue }) => (
          <span className="font-semibold">{currency(getValue<number>())}</span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <div className="space-y-1">
            <StatusBadge value={row.original.status} />
            {row.original.approval_status !== 'NOT_REQUIRED' && (
              <p className="text-xs text-muted-foreground">
                Approval {label(row.original.approval_status)}
              </p>
            )}
          </div>
        ),
      },
      {
        id: 'owner',
        header: 'Owner / scope',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.assigned_user_name}</p>
            <p className="text-xs text-muted-foreground">
              {row.original.team_name ?? row.original.branch_name}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap text-sm">{dateTime(getValue<string>())}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const record = row.original;
          const canEdit =
            permissions.data?.canManage && ['DRAFT', 'PENDING_APPROVAL'].includes(record.status);
          const canDecide = permissions.data?.canApprove && record.approval_status === 'PENDING';
          const hasTransition =
            (permissions.data?.canManage && ['DRAFT', 'SENT'].includes(record.status)) || canDecide;
          if (!canEdit && !hasTransition) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Quotation actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit && (
                  <DropdownMenuItem
                    onClick={() => {
                      setEditingQuotation(record);
                      setQuotationScreen('create');
                    }}
                  >
                    <Pencil className="size-4" /> Edit and version
                  </DropdownMenuItem>
                )}
                {canEdit && hasTransition && <DropdownMenuSeparator />}
                {permissions.data?.canManage &&
                  record.status === 'DRAFT' &&
                  record.approval_status !== 'REJECTED' && (
                    <DropdownMenuItem onClick={() => setActionState({ record, action: 'SENT' })}>
                      Mark sent
                    </DropdownMenuItem>
                  )}
                {permissions.data?.canManage && record.status === 'DRAFT' && (
                  <DropdownMenuItem onClick={() => setActionState({ record, action: 'EXPIRED' })}>
                    Expire quotation
                  </DropdownMenuItem>
                )}
                {permissions.data?.canManage && record.status === 'SENT' && (
                  <>
                    <DropdownMenuItem
                      onClick={() => setActionState({ record, action: 'ACCEPTED' })}
                    >
                      Mark accepted
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setActionState({ record, action: 'REJECTED' })}
                    >
                      Mark rejected
                    </DropdownMenuItem>
                  </>
                )}
                {canDecide && (
                  <>
                    <DropdownMenuItem
                      onClick={() => setActionState({ record, action: 'APPROVED' })}
                    >
                      Approve discount
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setActionState({ record, action: 'APPROVAL_REJECTED' })}
                    >
                      Reject discount
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [permissions.data?.canApprove, permissions.data?.canManage, role],
  );

  const bookingColumns = useMemo<ColumnDef<BookingRecord>[]>(
    () => [
      {
        id: 'reference',
        header: 'Booking ID',
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-semibold text-blue-700">
            {row.original.booking_number}
          </span>
        ),
      },
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-36">
            <Link
              href={`/${role}/customers/${row.original.customer_id}`}
              className="font-semibold hover:text-primary hover:underline"
            >
              {row.original.customer_name}
            </Link>
            <p className="text-xs text-muted-foreground">{row.original.phone ?? 'No phone'}</p>
          </div>
        ),
      },
      {
        accessorKey: 'interested_model',
        header: 'Model',
        cell: ({ getValue }) => getValue<string | null>() ?? 'Not specified',
      },
      {
        accessorKey: 'vehicle_variant',
        header: 'Variant',
        cell: ({ getValue }) => getValue<string | null>() ?? '—',
      },
      {
        accessorKey: 'colour',
        header: 'Colour',
        cell: ({ getValue }) => getValue<string | null>() ?? '—',
      },
      {
        accessorKey: 'booking_amount',
        header: 'Booking amount',
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap font-semibold">{currency(getValue<number>())}</span>
        ),
      },
      {
        id: 'owner',
        header: 'Consultant',
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-medium">{row.original.assigned_user_name}</span>
        ),
      },
      {
        accessorKey: 'created_at',
        header: 'Booking date',
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">{dateTime(getValue<string>())}</span>
        ),
      },
      {
        accessorKey: 'expected_delivery_date',
        header: 'Expected delivery',
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">{dateOnly(getValue<string | null>())}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge value={getValue<string>()} />,
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => {
          const record = row.original;
          const actions: BookingAction[] =
            record.status === 'CONFIRMED'
              ? ['AWAITING_ALLOCATION', 'CANCELLED']
              : record.status === 'AWAITING_ALLOCATION'
                ? ['ALLOCATED', 'CANCELLED']
                : record.status === 'ALLOCATED'
                  ? ['READY_FOR_DELIVERY']
                  : record.status === 'READY_FOR_DELIVERY'
                    ? ['DELIVERED']
                    : [];
          return (
            <div className="flex items-center gap-1">
              <Button asChild variant="ghost" size="icon" className="size-8 text-blue-600">
                <Link
                  href={`/${role}/customers/${record.customer_id}`}
                  aria-label="View customer 360"
                >
                  <Eye className="size-4" />
                </Link>
              </Button>
              {permissions.data?.canManage && actions.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label="Booking actions"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {actions.map((action) => (
                      <DropdownMenuItem
                        key={action}
                        onClick={() => setActionState({ record, action })}
                      >
                        {label(action)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        },
      },
    ],
    [permissions.data?.canManage, role],
  );

  if (
    permissions.isPending ||
    (workspace.isPending && permissions.data) ||
    (kind === 'bookings' && bookingFilterOptions.isPending && permissions.data)
  )
    return <PageSkeleton />;
  if (
    permissions.isError ||
    workspace.isError ||
    (kind === 'bookings' && bookingFilterOptions.isError) ||
    !permissions.data ||
    !workspace.data
  )
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Sales documents are not available yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your permission, scope or the quotation/booking migration needs attention. Reference:
            GDM-SALES-DOCUMENTS.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              void permissions.refetch();
              void workspace.refetch();
              if (kind === 'bookings') void bookingFilterOptions.refetch();
            }}
          >
            <RotateCcw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );

  if (kind === 'quotations' && quotationScreen === 'create')
    return (
      <QuotationCreateView
        record={editingQuotation}
        onBack={() => {
          setEditingQuotation(null);
          setQuotationScreen('list');
        }}
        onSaved={() => {
          setEditingQuotation(null);
          invalidate();
          setQuotationScreen('list');
        }}
      />
    );

  const result = workspace.data;
  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader className="mb-0" spec={{ ...spec, primaryAction: undefined }} />
        {permissions.data.canManage && (
          <Button
            className="shrink-0 sm:mt-7"
            onClick={() =>
              kind === 'quotations' ? setQuotationScreen('create') : setCreateOpen(true)
            }
          >
            <Plus className="size-4" />
            {kind === 'quotations' ? 'Create quotation' : 'Create booking'}
          </Button>
        )}
      </div>
      <div className="space-y-6">
        {kind === 'quotations' && (
          <div className="flex h-10 gap-2 overflow-x-auto border-b">
            {(['draft', 'sent', 'pending-approval', 'accepted', 'expired'] as const).map(
              (status) => {
                const active = query.status === status;
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => onQueryChange({ status, page: 1 })}
                    className={`relative h-full shrink-0 px-3 text-xs font-semibold ${active ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700'}`}
                    style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
                  >
                    {status === 'pending-approval' ? 'Approval Pending' : label(status)}
                  </button>
                );
              },
            )}
          </div>
        )}
        {kind === 'bookings' && (
          <div className="flex h-10 gap-2 overflow-x-auto border-b">
            {bookingStatusFilters.map((status) => {
              const active = query.status === status;
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => onQueryChange({ status, page: 1 })}
                  className={`relative h-full shrink-0 px-3 text-xs font-semibold ${active ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700'}`}
                  style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
                >
                  {status === 'awaiting-allocation' ? 'Stock Awaited' : label(status)}
                </button>
              );
            })}
          </div>
        )}
        <KpiGrid
          metrics={
            kind === 'quotations'
              ? quotationMetrics(result as QuotationWorkspaceResult)
              : bookingMetrics(result as BookingWorkspaceResult)
          }
        />
        {kind === 'quotations' ? (
          <TableFrame
            kind={kind}
            columns={quotationColumns}
            records={(result as QuotationWorkspaceResult).records}
            total={result.total}
            query={query}
            isFetching={workspace.isFetching}
            onQueryChange={onQueryChange}
          />
        ) : (
          <TableFrame
            kind={kind}
            columns={bookingColumns}
            records={(result as BookingWorkspaceResult).records}
            total={result.total}
            query={query}
            isFetching={workspace.isFetching}
            onQueryChange={onQueryChange}
            bookingOptions={bookingFilterOptions.data}
          />
        )}
      </div>
      {kind === 'bookings' && permissions.data.canManage && (
        <BookingCreateDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={invalidate} />
      )}
      {actionState && (
        <SalesDocumentActionDialog
          key={`${actionState.record.id}:${actionState.record.version}:${actionState.action}`}
          record={actionState.record}
          action={actionState.action}
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
