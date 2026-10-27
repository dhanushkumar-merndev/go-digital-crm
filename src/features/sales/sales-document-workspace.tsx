'use client';

import { TablePagination } from '@/components/shared/table-pagination';
import { FilterDialogButton } from '@/components/shared/filter-bar';
import { ErrorState } from '@/components/shared/page-states';
import { formatCurrency } from '@/lib/format';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  CalendarClock,
  CarFront,
  CircleCheck,
  Clock3,
  Eye,
  FileText,
  Files,
  IndianRupee,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  focusRowElementId,
  focusedRowClassName,
  readFocusParam,
  useFocusedRows,
} from '@/lib/navigation/focus-row';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import { useCallback, useMemo, useState } from 'react';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { RefreshFailedNotice } from '@/components/shared/refresh-failed-notice';
import {
  QuotationsSkeleton,
  BookingsSkeleton,
} from '@/components/skeletons/sales-consultant-skeletons';
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
  type SalesDocumentPermissions,
} from './sales-document-api';
import {
  BookingCreateDialog,
  SalesDocumentActionDialog,
  type BookingAction,
  type PricedBookingSource,
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
import { recordDetailHref } from '@/lib/navigation/record-links';

function currency(value: number | null) {
  return value === null ? '—' : formatCurrency(value);
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

// Sentence case, as everywhere else: "Ready for delivery", not "Ready For Delivery".
function label(value: string) {
  const words = value.replaceAll('-', ' ').replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Six tiles, as on every Sales list page.
function quotationMetrics(result: QuotationWorkspaceResult): Metric[] {
  return [
    {
      label: 'Total quotations',
      value: result.total.toLocaleString('en-IN'),
      helper: 'Every status',
      icon: Files,
      tone: 'bg-slate-100 text-slate-600',
    },
    {
      label: 'Open',
      value: result.kpis.open.toLocaleString('en-IN'),
      helper: 'Draft, awaiting approval or sent',
      icon: FileText,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Sent',
      value: result.kpis.sent.toLocaleString('en-IN'),
      helper: 'Waiting on the customer',
      icon: Send,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Approval pending',
      value: result.kpis.approval_required.toLocaleString('en-IN'),
      helper: 'Discount waiting on a manager',
      icon: Clock3,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Converted',
      value: result.kpis.converted.toLocaleString('en-IN'),
      helper: 'Turned into a booking',
      icon: CircleCheck,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Pipeline value',
      value: currency(result.kpis.pipeline_value),
      helper: 'Sent and accepted quotations',
      icon: IndianRupee,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];
}

// Canonical Bookings order. The server's `pending` is the same
// AWAITING_ALLOCATION filter as Stock awaited, so it is one tile, named as the
// tab names it, rather than the same number twice.
function bookingMetrics(result: BookingWorkspaceResult): Metric[] {
  return [
    {
      label: 'Total bookings',
      value: result.kpis.bookings.toLocaleString('en-IN'),
      helper: 'Excluding cancelled',
      icon: Files,
      tone: 'bg-slate-100 text-slate-600',
    },
    {
      label: 'Confirmed',
      value: (result.kpis.confirmed ?? result.kpis.bookings).toLocaleString('en-IN'),
      helper: 'Confirmed customer bookings',
      icon: CircleCheck,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Stock awaited',
      value: (result.kpis.pending ?? result.kpis.awaiting_allocation).toLocaleString('en-IN'),
      helper: 'Waiting for a vehicle to be allocated',
      icon: CalendarClock,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Ready for delivery',
      value: (result.kpis.ready_for_delivery ?? result.kpis.delivery_this_week).toLocaleString(
        'en-IN',
      ),
      helper: 'Vehicle ready for handover',
      icon: CarFront,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Delivered this month',
      value: (result.kpis.delivered_this_month ?? result.kpis.delivered).toLocaleString('en-IN'),
      helper: `${result.kpis.delivered.toLocaleString('en-IN')} delivered in all`,
      icon: CarFront,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Booking value',
      value: currency(result.kpis.booking_value),
      helper: 'Order value of open and delivered bookings',
      icon: IndianRupee,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];
}

function TableFrame<T>({
  role,
  columns,
  records,
  total,
  query,
  kind,
  isFetching,
  onQueryChange,
  bookingOptions,
  focusedRowIds,
  getRowId,
}: {
  role: string;
  columns: ColumnDef<T>[];
  records: T[];
  total: number;
  query: SalesDocumentQuery;
  kind: SalesDocumentKind;
  isFetching: boolean;
  onQueryChange: (next: Partial<SalesDocumentQuery>) => void;
  bookingOptions?: BookingFilterOptions;
  focusedRowIds: ReadonlySet<string>;
  getRowId: (record: T) => string;
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
  const statuses = kind === 'quotations' ? quotationStatusFilters : bookingStatusFilters;
  return (
    <Card className="sales-consultant-list-card shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56 sm:max-w-md">
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
              <FilterDialogButton
                title="Booking filters"
                activeCount={
                  [
                    query.status !== 'all',
                    Boolean(query.model),
                    Boolean(query.branchId),
                    Boolean(query.fromDate || query.toDate),
                  ].filter(Boolean).length
                }
                onClear={() =>
                  onQueryChange({
                    page: 1,
                    status: 'all',
                    model: '',
                    branchId: '',
                    fromDate: '',
                    toDate: '',
                  })
                }
              >
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
                        {status === 'awaiting-allocation' ? 'Stock awaited' : label(status)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {role === 'sales-consultant' ? null : bookingOptions?.branches.length ===
                  1 ? null : (
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
                <label className="grid gap-1 text-xs font-medium text-label">
                  Booked from
                  <Input
                    type="date"
                    className="w-full"
                    value={query.fromDate}
                    onChange={(event) => onQueryChange({ fromDate: event.target.value, page: 1 })}
                    aria-label="Booking date from"
                  />
                </label>
                <label className="grid gap-1 text-xs font-medium text-label">
                  Booked until
                  <Input
                    type="date"
                    className="w-full"
                    value={query.toDate}
                    onChange={(event) => onQueryChange({ toDate: event.target.value, page: 1 })}
                    aria-label="Booking date to"
                  />
                </label>
              </FilterDialogButton>
              <div className="ml-auto flex flex-wrap items-center gap-2">
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
              </div>
            </>
          ) : (
            <div className="ml-auto flex flex-wrap items-center gap-2">
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
                table.getRowModel().rows.map((row) => {
                  const recordId = getRowId(row.original);
                  return (
                    <TableRow
                      key={row.id}
                      id={focusRowElementId(kind, recordId)}
                      className={focusedRowIds.has(recordId) ? focusedRowClassName : undefined}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="align-top">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })
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
        <TablePagination
          page={query.page}
          pageSize={query.pageSize}
          total={total}
          onPageChange={(page) => onQueryChange({ page })}
        />
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
  const workspaceSession = useWorkspaceSession();
  const useSalesHotPath =
    role === 'sales-consultant' &&
    workspaceSession?.roleKey === 'sales-consultant' &&
    Boolean(workspaceSession.organizationId);
  const useWorkspaceBootstrap = Boolean(workspaceSession?.organizationId);
  const queryScope = useMemo(
    () =>
      useWorkspaceBootstrap ? workspaceQueryScope(workspaceSession) : (['legacy', role] as const),
    [role, useWorkspaceBootstrap, workspaceSession],
  );
  const resource = kind === 'quotations' ? 'quotation' : 'booking';
  const bootstrapPermissions: SalesDocumentPermissions | undefined = useWorkspaceBootstrap
    ? {
        organizationId: workspaceSession!.organizationId as string,
        scopeKey: workspaceSession!.scopeKey,
        canManage: hasWorkspacePermission(workspaceSession, `${resource}.manage`),
        canApprove:
          kind === 'quotations' && hasWorkspacePermission(workspaceSession, 'approval.decide'),
      }
    : undefined;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const salesConsultantCache = useSalesConsultantCache();
  // Booking straight from a quotation row needs both rights; the server checks
  // them again in quick_book_lead.
  const canBook =
    hasWorkspacePermission(workspaceSession, 'booking.manage') &&
    hasWorkspacePermission(workspaceSession, 'quotation.manage');
  const [bookingSource, setBookingSource] = useState<PricedBookingSource | null>(null);
  const bookingLeadId = kind === 'bookings' ? searchParams.get('lead') : null;
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
  const directQuotationCreate = kind === 'quotations' && quotationScreen === 'create';
  const directBookingCreate =
    kind === 'bookings' && createOpen && searchParams.get('action') === 'create';
  const directCreate = directQuotationCreate || directBookingCreate;
  const legacyPermissions = useQuery({
    queryKey: ['sales-document-permissions', kind, ...queryScope, role],
    queryFn: () => fetchSalesDocumentPermissions(kind),
    enabled: !useWorkspaceBootstrap,
    staleTime: 60_000,
  });
  const loadedPermissions = bootstrapPermissions ?? legacyPermissions.data;
  // A read-only page (GM, Business Owner) monitors; the role's manage grant is
  // for the pages where they act, so nothing here creates or changes a record.
  const permissions =
    loadedPermissions && spec.readOnly
      ? { ...loadedPermissions, canManage: false }
      : loadedPermissions;
  useTenantRealtimeInvalidation(permissions?.organizationId, [
    {
      resource: 'sales',
      queryKeys: [['sales-document-workspace', ...queryScope, kind]],
    },
  ]);
  const workspace = useQuery({
    queryKey: ['sales-document-workspace', ...queryScope, kind, requestQuery],
    queryFn: ({ signal }) => fetchSalesDocumentWorkspace(kind, requestQuery, signal),
    enabled: Boolean(permissions) && !directCreate,
    placeholderData: keepPreviousData,
  });
  // The quotation RPC counts its tiles after the status tab is applied, so on
  // the Draft tab Sent and Approval pending always read 0. The tiles read the
  // same filters on every status instead; the rows still come from the tab.
  const quotationKpiQuery = useMemo(
    () => ({ ...requestQuery, status: 'all' as const, page: 1 }),
    [requestQuery],
  );
  const quotationKpis = useQuery({
    queryKey: ['sales-document-workspace', ...queryScope, kind, 'kpis', quotationKpiQuery],
    queryFn: ({ signal }) => fetchSalesDocumentWorkspace(kind, quotationKpiQuery, signal),
    enabled:
      kind === 'quotations' &&
      requestQuery.status !== 'all' &&
      Boolean(permissions) &&
      !directCreate,
    placeholderData: keepPreviousData,
  });
  // Arrived from a lead's Quotation or Booking stage badge on My Leads.
  const focusId = readFocusParam(searchParams);
  const focusMatchedIds = useMemo(() => {
    if (!focusId) return [];
    const records = (workspace.data?.records ?? []) as Array<{
      id: string;
      lead_id: string | null;
    }>;
    return records.filter((record) => record.lead_id === focusId).map((record) => record.id);
  }, [focusId, workspace.data]);
  const focusedRowIds = useFocusedRows({
    focusId,
    matchedIds: focusMatchedIds,
    scope: kind,
    pathname,
    searchParams,
  });

  const bookingFilterOptions = useQuery({
    queryKey: ['sales-booking-filter-options', ...queryScope],
    queryFn: ({ signal }) => fetchBookingFilterOptions(signal),
    enabled: kind === 'bookings' && Boolean(permissions) && !directBookingCreate,
    staleTime: 60_000,
  });
  const onQueryChange = (next: Partial<SalesDocumentQuery>) => {
    const updated = { ...query, ...next };
    setQuery(updated);
    replaceQueryString(pathname, toSalesDocumentQueryString(updated, kind));
  };
  const invalidate = useCallback(() => {
    salesConsultantCache.invalidate('quotation.changed');
  }, [salesConsultantCache]);
  // A booking converts its quotation and moves the lead's sales stage, so the
  // lead list and that lead's detail refresh along with both document lists.
  const invalidateBooked = useCallback(
    (leadId: string | null | undefined) => {
      salesConsultantCache.invalidate('quotation.changed');
      salesConsultantCache.invalidate('lead.updated', leadId ? { leadId } : {});
    },
    [salesConsultantCache],
  );

  const quotationColumns = useMemo<ColumnDef<QuotationRecord>[]>(
    () => [
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-40">
            <Link
              href={recordDetailHref(role, row.original) ?? '#'}
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
                Discount {label(row.original.approval_status).toLowerCase()}
              </p>
            )}
          </div>
        ),
      },
      // A consultant's own list would repeat their name on every row.
      ...(role === 'sales-consultant'
        ? []
        : [
            {
              id: 'owner',
              header: 'Owner / scope',
              cell: ({ row }: { row: { original: QuotationRecord } }) => (
                <div>
                  <p className="font-medium">{row.original.assigned_user_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.original.team_name ?? row.original.branch_name}
                  </p>
                </div>
              ),
            },
          ]),
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
            permissions?.canManage && ['DRAFT', 'PENDING_APPROVAL'].includes(record.status);
          const canDecide = permissions?.canApprove && record.approval_status === 'PENDING';
          const canBookNow =
            canBook &&
            Boolean(record.lead_id) &&
            ['DRAFT', 'SENT', 'ACCEPTED'].includes(record.status) &&
            !['PENDING', 'REJECTED'].includes(record.approval_status);
          const hasTransition =
            (permissions?.canManage && ['DRAFT', 'SENT'].includes(record.status)) || canDecide;
          if (!canEdit && !hasTransition && !canBookNow) return null;
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
                {canBookNow && (
                  <DropdownMenuItem
                    onClick={() =>
                      setBookingSource({
                        leadId: record.lead_id!,
                        quotationId: record.id,
                        expectedVersion: record.version,
                        items: null,
                        total: record.total_amount,
                        label: `${record.quotation_number} · ${record.customer_name}`,
                      })
                    }
                  >
                    <CircleCheck className="size-4" /> Book now
                  </DropdownMenuItem>
                )}
                {canBookNow && (canEdit || hasTransition) && <DropdownMenuSeparator />}
                {canEdit && hasTransition && <DropdownMenuSeparator />}
                {permissions?.canManage &&
                  record.status === 'DRAFT' &&
                  record.approval_status !== 'REJECTED' && (
                    <DropdownMenuItem onClick={() => setActionState({ record, action: 'SENT' })}>
                      Mark sent
                    </DropdownMenuItem>
                  )}
                {permissions?.canManage && record.status === 'DRAFT' && (
                  <DropdownMenuItem onClick={() => setActionState({ record, action: 'EXPIRED' })}>
                    Expire quotation
                  </DropdownMenuItem>
                )}
                {permissions?.canManage && record.status === 'SENT' && (
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
    [
      canBook,
      permissions?.canApprove,
      permissions?.canManage,
      role,
      setActionState,
      setEditingQuotation,
      setQuotationScreen,
    ],
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
              href={recordDetailHref(role, row.original) ?? '#'}
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
      // A consultant's own list would repeat their name on every row.
      ...(role === 'sales-consultant'
        ? []
        : [
            {
              id: 'owner',
              header: 'Consultant',
              cell: ({ row }: { row: { original: BookingRecord } }) => (
                <span className="whitespace-nowrap font-medium">
                  {row.original.assigned_user_name}
                </span>
              ),
            },
          ]),
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
              {permissions?.canManage && actions.length > 0 && (
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
    [permissions?.canManage, role, setActionState],
  );

  if (
    (!useWorkspaceBootstrap && legacyPermissions.isPending) ||
    (!directCreate && workspace.isPending && permissions) ||
    (!useSalesHotPath &&
      kind === 'bookings' &&
      !directBookingCreate &&
      bookingFilterOptions.isPending &&
      permissions)
  )
    return kind === 'bookings' ? <BookingsSkeleton /> : <QuotationsSkeleton />;
  if (
    (!useWorkspaceBootstrap && legacyPermissions.isError) ||
    !permissions ||
    (directCreate && !permissions?.canManage) ||
    // A failed background refresh keeps the rows on screen with a notice.
    (!directCreate && !workspace.data) ||
    (!useSalesHotPath && kind === 'bookings' && bookingFilterOptions.isError)
  )
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="Sales documents are not available yet"
          description="Your permission, scope or the quotation/booking migration needs attention."
          reference="GDM-SALES-DOCUMENTS"
          onRetry={() => {
            if (!useWorkspaceBootstrap) void legacyPermissions.refetch();
            void workspace.refetch();
            if (kind === 'bookings') void bookingFilterOptions.refetch();
          }}
        />
      </PageShell>
    );

  if (directQuotationCreate)
    return (
      <QuotationCreateView
        record={editingQuotation}
        initialLeadId={searchParams.get('lead')}
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

  if (directBookingCreate)
    return (
      <div className="mx-auto w-full">
        <PageHeader className="mb-0" spec={{ ...spec, primaryAction: undefined }} />
        <BookingCreateDialog
          open
          onOpenChange={setCreateOpen}
          leadId={bookingLeadId}
          onSaved={() => invalidateBooked(bookingLeadId)}
          onPriceAndBook={
            bookingLeadId
              ? () =>
                  router.push(
                    `/${role}/quotations?action=create&lead=${encodeURIComponent(bookingLeadId)}`,
                  )
              : undefined
          }
        />
      </div>
    );

  if (!workspace.data) return null;
  const result = workspace.data;
  return (
    <div className="mx-auto w-full">
      <RefreshFailedNotice
        className="mb-4"
        show={!directCreate && workspace.isError}
        retrying={workspace.isFetching}
        onRetry={() => void workspace.refetch()}
      />
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        className="mb-6"
        actions={
          <>
            {permissions.canManage && (
              <Button
                className="shrink-0"
                onClick={() =>
                  kind === 'quotations' ? setQuotationScreen('create') : setCreateOpen(true)
                }
              >
                <Plus className="size-4" />
                {kind === 'quotations' ? 'Create quotation' : 'Create booking'}
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-6">
        {/* Summary above the status tabs, as on every other worklist. */}
        <KpiGrid
          metrics={
            kind === 'quotations'
              ? quotationMetrics(
                  ((requestQuery.status === 'all' ? result : quotationKpis.data) ??
                    result) as QuotationWorkspaceResult,
                )
              : bookingMetrics(result as BookingWorkspaceResult)
          }
        />
        {kind === 'quotations' && (
          <div className="flex h-10 gap-2 overflow-x-auto border-b">
            {(
              [
                'all',
                'draft',
                'sent',
                'pending-approval',
                'accepted',
                'converted',
                'expired',
              ] as const
            ).map((status) => {
              const active = query.status === status;
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => onQueryChange({ status, page: 1 })}
                  className={`relative h-full shrink-0 px-3 text-xs font-semibold ${active ? 'text-blue-700' : 'text-heading-soft hover:text-blue-700'}`}
                  style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
                >
                  {status === 'pending-approval' ? 'Approval pending' : label(status)}
                </button>
              );
            })}
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
                  className={`relative h-full shrink-0 px-3 text-xs font-semibold ${active ? 'text-blue-700' : 'text-heading-soft hover:text-blue-700'}`}
                  style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
                >
                  {status === 'awaiting-allocation' ? 'Stock awaited' : label(status)}
                </button>
              );
            })}
          </div>
        )}
        {kind === 'quotations' ? (
          <TableFrame
            role={role}
            kind={kind}
            columns={quotationColumns}
            records={(result as QuotationWorkspaceResult).records}
            total={result.total}
            query={query}
            isFetching={workspace.isFetching}
            onQueryChange={onQueryChange}
            focusedRowIds={focusedRowIds}
            getRowId={(record) => record.id}
          />
        ) : (
          <TableFrame
            role={role}
            kind={kind}
            columns={bookingColumns}
            records={(result as BookingWorkspaceResult).records}
            total={result.total}
            query={query}
            isFetching={workspace.isFetching}
            onQueryChange={onQueryChange}
            bookingOptions={bookingFilterOptions.data}
            focusedRowIds={focusedRowIds}
            getRowId={(record) => record.id}
          />
        )}
      </div>
      {kind === 'bookings' && permissions.canManage && (
        <BookingCreateDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={invalidate} />
      )}
      {bookingSource && (
        <BookingCreateDialog
          key={`${bookingSource.quotationId}:${bookingSource.expectedVersion}`}
          open
          onOpenChange={(open) => !open && setBookingSource(null)}
          priced={bookingSource}
          onSaved={() => invalidateBooked(bookingSource.leadId)}
        />
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
