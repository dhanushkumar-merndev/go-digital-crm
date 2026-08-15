'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Package,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  fetchAllocationPage,
  fetchInventoryBranches,
  fetchInventoryDashboard,
  fetchInventoryPermissions,
  fetchMovementPage,
  fetchStockCheckPage,
  fetchStockUnitPage,
  type AllocationPage,
  type AllocationRow,
  type InventoryBranch,
  type InventoryDashboard,
  type InventoryPermissions,
  type MovementPage,
  type MovementRow,
  type StockCheckPage,
  type StockUnit,
  type StockUnitPage,
} from './inventory-api';
import { StockIntakeDialog, StockUnitDetailSheet } from './inventory-dialogs';
import {
  inventoryViewForRoute,
  parseInventoryQuery,
  toInventoryQueryString,
  type InventoryFilter,
  type InventoryQuery,
  type InventorySort,
  type InventoryView,
} from './inventory-query';

type StockCheckRow = StockCheckPage['records'][number];
type InventoryPage = StockUnitPage | StockCheckPage | AllocationPage | MovementPage;

const branchChartSeries: [string, string] = ['Total stock', 'Available'];

const filterOptions: Record<
  Exclude<InventoryView, 'dashboard'>,
  Array<[InventoryFilter, string]>
> = {
  units: [
    ['all', 'All statuses'],
    ['incoming', 'Incoming'],
    ['available', 'Available'],
    ['reserved', 'Reserved'],
    ['allocated', 'Allocated'],
    ['in-transit', 'In transit'],
    ['hold', 'On hold'],
    ['ready-for-delivery', 'Ready for delivery'],
    ['delivered', 'Delivered'],
  ],
  ageing: [
    ['all', 'All statuses'],
    ['incoming', 'Incoming'],
    ['available', 'Available'],
    ['reserved', 'Reserved'],
    ['allocated', 'Allocated'],
    ['in-transit', 'In transit'],
    ['hold', 'On hold'],
    ['ready-for-delivery', 'Ready for delivery'],
  ],
  'stock-check': [
    ['all', 'All availability'],
    ['available', 'Available'],
    ['limited', 'Limited'],
    ['incoming', 'Incoming'],
    ['unavailable', 'Unavailable'],
  ],
  allocations: [
    ['all', 'All allocations'],
    ['active', 'Active / review'],
    ['pending', 'Pending'],
    ['suggested', 'Suggested'],
    ['reserved', 'Reserved'],
    ['allocated', 'Allocated'],
    ['on-hold', 'On hold'],
    ['released', 'Released'],
    ['cancelled', 'Cancelled'],
  ],
  movements: [
    ['all', 'All movements'],
    ['intake', 'Intake'],
    ['detail-update', 'Detail update'],
    ['status-change', 'Status change'],
    ['branch-transfer', 'Branch transfer'],
    ['allocation', 'Allocation'],
    ['allocation-release', 'Allocation release'],
  ],
};

const sortOptions: Record<Exclude<InventoryView, 'dashboard'>, Array<[InventorySort, string]>> = {
  units: [
    ['received:desc', 'Received: newest'],
    ['received:asc', 'Received: oldest'],
    ['age:desc', 'Age: oldest stock'],
    ['vin:asc', 'VIN: A–Z'],
    ['model:asc', 'Model: A–Z'],
    ['status:asc', 'Status: A–Z'],
    ['updated:desc', 'Updated: newest'],
  ],
  ageing: [
    ['age:desc', 'Age: oldest stock'],
    ['received:desc', 'Received: newest'],
    ['received:asc', 'Received: oldest'],
    ['vin:asc', 'VIN: A–Z'],
    ['model:asc', 'Model: A–Z'],
    ['status:asc', 'Status: A–Z'],
    ['updated:desc', 'Updated: newest'],
  ],
  'stock-check': [
    ['model:asc', 'Model: A–Z'],
    ['available:desc', 'Available: high to low'],
    ['incoming:desc', 'Incoming: high to low'],
    ['branch:asc', 'Branch: A–Z'],
  ],
  allocations: [
    ['allocated:desc', 'Allocated: newest'],
    ['allocated:asc', 'Allocated: oldest'],
    ['booking:asc', 'Booking: A–Z'],
    ['vin:asc', 'VIN: A–Z'],
  ],
  movements: [
    ['moved:desc', 'Moved: newest'],
    ['moved:asc', 'Moved: oldest'],
    ['vin:asc', 'VIN: A–Z'],
    ['type:asc', 'Type: A–Z'],
  ],
};

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function pageMetrics(page: InventoryPage): Metric[] {
  if ('total_stock' in page.kpis)
    return [
      { label: 'In stock', value: page.kpis.total_stock.toLocaleString('en-IN') },
      { label: 'Available', value: page.kpis.available.toLocaleString('en-IN') },
      { label: 'Reserved', value: page.kpis.reserved.toLocaleString('en-IN') },
      { label: 'Allocated', value: page.kpis.allocated.toLocaleString('en-IN') },
      {
        label: 'Ageing >60 days',
        value: page.kpis.ageing_60_plus.toLocaleString('en-IN'),
      },
      { label: 'On hold', value: page.kpis.on_hold.toLocaleString('en-IN') },
    ];
  if ('available_units' in page.kpis)
    return [
      { label: 'Available units', value: page.kpis.available_units.toLocaleString('en-IN') },
      { label: 'Limited choices', value: page.kpis.limited_groups.toLocaleString('en-IN') },
      { label: 'Incoming units', value: page.kpis.incoming_units.toLocaleString('en-IN') },
      {
        label: 'Unavailable choices',
        value: page.kpis.unavailable_groups.toLocaleString('en-IN'),
      },
    ];
  if ('movements_today' in page.kpis)
    return [
      { label: 'Movements today', value: page.kpis.movements_today.toLocaleString('en-IN') },
      { label: 'Branch transfers', value: page.kpis.transfers.toLocaleString('en-IN') },
      { label: 'Stock intakes', value: page.kpis.intakes.toLocaleString('en-IN') },
      { label: 'Status changes', value: page.kpis.status_changes.toLocaleString('en-IN') },
    ];
  return [
    { label: 'Review queue', value: page.kpis.active.toLocaleString('en-IN') },
    { label: 'Reserved', value: page.kpis.reserved.toLocaleString('en-IN') },
    { label: 'Allocated', value: page.kpis.allocated.toLocaleString('en-IN') },
    { label: 'Released', value: page.kpis.released.toLocaleString('en-IN') },
  ];
}

function dashboardMetrics(data: InventoryDashboard): Metric[] {
  return [
    { label: 'In stock', value: data.kpis.total_stock.toLocaleString('en-IN') },
    { label: 'Available', value: data.kpis.available.toLocaleString('en-IN') },
    { label: 'Reserved', value: data.kpis.reserved.toLocaleString('en-IN') },
    { label: 'Allocated', value: data.kpis.allocated.toLocaleString('en-IN') },
    { label: 'In transit', value: data.kpis.in_transit.toLocaleString('en-IN') },
    { label: 'Ageing >60 days', value: data.kpis.ageing_stock.toLocaleString('en-IN') },
    {
      label: 'Ready for delivery',
      value: data.kpis.ready_for_delivery.toLocaleString('en-IN'),
    },
    { label: 'Low-stock variants', value: data.kpis.low_stock_models.toLocaleString('en-IN') },
  ];
}

function Dashboard({ data, role }: { data: InventoryDashboard; role: string }) {
  const attention = [
    {
      label: 'Ageing over 90 days',
      value: data.attention.ageing_90_plus,
      href: `/${role}/stock-ageing?age=90-plus`,
    },
    {
      label: 'Units on hold',
      value: data.attention.on_hold,
      href: `/${role}/vehicle-inventory?status=hold`,
    },
    {
      label: 'Incoming units',
      value: data.attention.incoming,
      href: `/${role}/vehicle-inventory?status=incoming`,
    },
    {
      label: 'Allocations awaiting review',
      value: data.attention.allocation_pending,
      href: `/${role}/stock-allocation?status=active`,
    },
  ];
  return (
    <div className="space-y-6">
      <KpiGrid metrics={dashboardMetrics(data)} />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Requires attention</CardTitle>
          <CardDescription>
            Current operational exceptions within your branch scope.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {attention.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="rounded-lg border p-4 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">{item.label}</p>
                <CircleAlert className="size-4 text-amber-600" />
              </div>
              <p className="mt-3 text-2xl font-bold">{item.value.toLocaleString('en-IN')}</p>
            </Link>
          ))}
        </CardContent>
      </Card>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Stock by model</CardTitle>
            <CardDescription>Largest model groups in active physical stock.</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="donut" data={data.model_distribution} className="h-[300px]" />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Branch availability</CardTitle>
            <CardDescription>
              Total active stock compared with immediately available units.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EChart
              kind="bar"
              data={data.branch_distribution}
              seriesNames={branchChartSeries}
              className="h-[300px]"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Filters({
  view,
  query,
  branches,
  onQueryChange,
}: {
  view: Exclude<InventoryView, 'dashboard'>;
  query: InventoryQuery;
  branches: InventoryBranch[];
  onQueryChange: (next: Partial<InventoryQuery>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="relative min-w-0 lg:max-w-lg">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query.search}
          onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
          className="pl-9"
          maxLength={100}
          placeholder={
            view === 'stock-check'
              ? 'Search model, variant, colour, fuel or transmission…'
              : view === 'movements'
                ? 'Search VIN, model, movement reason or actor…'
                : view === 'allocations'
                  ? 'Search VIN, booking, model or variant…'
                  : 'Search VIN, chassis, engine, model, variant or colour…'
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={query.filter}
          onValueChange={(filter) => onQueryChange({ filter: filter as InventoryFilter, page: 1 })}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {filterOptions[view].map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.branchId || 'all'}
          onValueChange={(branchId) =>
            onQueryChange({ branchId: branchId === 'all' ? '' : branchId, page: 1 })
          }
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All authorized branches" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All authorized branches</SelectItem>
            {branches.map((branch) => (
              <SelectItem key={branch.id} value={branch.id}>
                {branch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(view === 'units' || view === 'ageing') && (
          <Select
            value={query.age}
            onValueChange={(age) => onQueryChange({ age: age as InventoryQuery['age'], page: 1 })}
          >
            <SelectTrigger className="w-[155px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stock ages</SelectItem>
              <SelectItem value="0-30">0–30 days</SelectItem>
              <SelectItem value="31-60">31–60 days</SelectItem>
              <SelectItem value="61-90">61–90 days</SelectItem>
              <SelectItem value="90-plus">Over 90 days</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Select
          value={query.sort}
          onValueChange={(sort) => onQueryChange({ sort: sort as InventorySort, page: 1 })}
        >
          <SelectTrigger className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions[view].map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(query.pageSize)}
          onValueChange={(value) =>
            onQueryChange({ pageSize: Number(value) as InventoryQuery['pageSize'], page: 1 })
          }
        >
          <SelectTrigger className="w-[105px]">
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
  );
}

function ServerTable<T>({
  data,
  columns,
  total,
  query,
  isFetching,
  emptyTitle,
  emptyDescription,
  onQueryChange,
}: {
  data: T[];
  columns: ColumnDef<T>[];
  total: number;
  query: InventoryQuery;
  isFetching: boolean;
  emptyTitle: string;
  emptyDescription: string;
  onQueryChange: (next: Partial<InventoryQuery>) => void;
}) {
  // TanStack Table returns an imperative model; React Compiler intentionally skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: total,
  });
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  return (
    <Card className="overflow-hidden shadow-none">
      <CardContent className="p-0">
        <div className={`overflow-x-auto transition-opacity ${isFetching ? 'opacity-65' : ''}`}>
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
                      <TableCell key={cell.id} className="whitespace-nowrap align-top">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <Package className="mx-auto size-6 text-muted-foreground" />
                    <p className="mt-2 font-medium">{emptyTitle}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{emptyDescription}</p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
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

function StockUnitTable({
  page,
  query,
  isFetching,
  onQueryChange,
  onOpen,
}: {
  page: StockUnitPage;
  query: InventoryQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<InventoryQuery>) => void;
  onOpen: (stockUnitId: string) => void;
}) {
  const columns = useMemo<ColumnDef<StockUnit>[]>(
    () => [
      {
        id: 'identity',
        header: 'VIN / chassis',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.vin}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{row.original.chassis_number}</p>
          </div>
        ),
      },
      {
        id: 'vehicle',
        header: 'Model & variant',
        cell: ({ row }) => (
          <div>
            <p>
              {row.original.brand_name} {row.original.model_name}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{row.original.variant_name}</p>
          </div>
        ),
      },
      {
        id: 'details',
        header: 'Colour / engine',
        cell: ({ row }) => (
          <div>
            <p>{row.original.color ?? '—'}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.engine_number ?? 'No engine number'}
            </p>
          </div>
        ),
      },
      { accessorKey: 'branch_name', header: 'Branch' },
      {
        id: 'age',
        header: 'Stock age',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.days_in_stock} days</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDate(row.original.received_at)}
            </p>
          </div>
        ),
      },
      {
        id: 'allocation',
        header: 'Allocation',
        cell: ({ row }) =>
          row.original.allocation_status ? (
            <div>
              <StatusBadge value={row.original.allocation_status} />
              <p className="mt-1 text-xs text-muted-foreground">
                {row.original.booking_number ?? 'No booking reference'}
              </p>
            </div>
          ) : (
            <span className="text-muted-foreground">Unallocated</span>
          ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge value={getValue<string>()} />,
      },
      {
        id: 'action',
        header: '',
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => onOpen(row.original.id)}>
            Open
          </Button>
        ),
      },
    ],
    [onOpen],
  );
  return (
    <ServerTable
      data={page.records}
      columns={columns}
      total={page.total}
      query={query}
      isFetching={isFetching}
      emptyTitle="No stock units match this view"
      emptyDescription="Try another status, branch, stock age or page-local search."
      onQueryChange={onQueryChange}
    />
  );
}

function StockCheckTable({
  page,
  query,
  isFetching,
  onQueryChange,
}: {
  page: StockCheckPage;
  query: InventoryQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<InventoryQuery>) => void;
}) {
  const columns = useMemo<ColumnDef<StockCheckRow>[]>(
    () => [
      {
        id: 'vehicle',
        header: 'Model & variant',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">
              {row.original.brand_name} {row.original.model_name}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{row.original.variant_name}</p>
          </div>
        ),
      },
      {
        id: 'specification',
        header: 'Specification',
        cell: ({ row }) => (
          <div>
            <p>{row.original.color ?? 'Any colour'}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {[row.original.fuel, row.original.transmission].filter(Boolean).join(' · ') || '—'}
            </p>
          </div>
        ),
      },
      { accessorKey: 'branch_name', header: 'Branch' },
      {
        accessorKey: 'available',
        header: 'Available',
        cell: ({ getValue }) => <span className="font-semibold">{getValue<number>()}</span>,
      },
      { accessorKey: 'incoming', header: 'Incoming' },
      { accessorKey: 'reserved', header: 'Reserved' },
      { accessorKey: 'allocated', header: 'Allocated' },
      {
        accessorKey: 'availability',
        header: 'Availability',
        cell: ({ getValue }) => <StatusBadge value={getValue<string>()} />,
      },
    ],
    [],
  );
  return (
    <ServerTable
      data={page.records}
      columns={columns}
      total={page.total}
      query={query}
      isFetching={isFetching}
      emptyTitle="No matching stock availability"
      emptyDescription="This view intentionally returns aggregate availability without VIN details."
      onQueryChange={onQueryChange}
    />
  );
}

function AllocationTable({
  page,
  query,
  isFetching,
  onQueryChange,
  onOpen,
}: {
  page: AllocationPage;
  query: InventoryQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<InventoryQuery>) => void;
  onOpen: (stockUnitId: string) => void;
}) {
  const columns = useMemo<ColumnDef<AllocationRow>[]>(
    () => [
      {
        id: 'booking',
        header: 'Booking',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.booking_number ?? 'No booking'}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{row.original.allocation_method}</p>
          </div>
        ),
      },
      {
        id: 'vehicle',
        header: 'VIN / vehicle',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.vin}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.brand_name} {row.original.model_name} · {row.original.variant_name}
            </p>
          </div>
        ),
      },
      { accessorKey: 'branch_name', header: 'Branch' },
      {
        id: 'states',
        header: 'Allocation / stock',
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge value={row.original.status} />
            <span className="text-xs text-muted-foreground">
              Stock: {row.original.stock_status}
            </span>
          </div>
        ),
      },
      {
        id: 'actor',
        header: 'Allocated by',
        cell: ({ row }) => row.original.allocated_by_name ?? 'System',
      },
      {
        accessorKey: 'allocated_at',
        header: 'Allocated at',
        cell: ({ getValue }) => formatDate(getValue<string>()),
      },
      {
        id: 'action',
        header: '',
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => onOpen(row.original.stock_unit_id)}>
            Open unit
          </Button>
        ),
      },
    ],
    [onOpen],
  );
  return (
    <ServerTable
      data={page.records}
      columns={columns}
      total={page.total}
      query={query}
      isFetching={isFetching}
      emptyTitle="No allocations match this view"
      emptyDescription="Try another allocation state, branch or page-local search."
      onQueryChange={onQueryChange}
    />
  );
}

function MovementTable({
  page,
  query,
  isFetching,
  onQueryChange,
  onOpen,
}: {
  page: MovementPage;
  query: InventoryQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<InventoryQuery>) => void;
  onOpen: (stockUnitId: string) => void;
}) {
  const columns = useMemo<ColumnDef<MovementRow>[]>(
    () => [
      {
        accessorKey: 'moved_at',
        header: 'Moved at',
        cell: ({ getValue }) => formatDate(getValue<string>()),
      },
      {
        id: 'vehicle',
        header: 'VIN / vehicle',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.vin}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.brand_name} {row.original.model_name} · {row.original.variant_name}
            </p>
          </div>
        ),
      },
      {
        id: 'route',
        header: 'Movement',
        cell: ({ row }) => (
          <div>
            <StatusBadge value={row.original.movement_type} />
            <p className="mt-1 text-xs text-muted-foreground">
              {row.original.from_branch_name ?? 'External / intake'} →{' '}
              {row.original.to_branch_name ?? 'No branch change'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'reason',
        header: 'Reason',
        cell: ({ getValue }) => (
          <span className="block max-w-xs truncate">{getValue<string | null>() ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'moved_by_name',
        header: 'Actor',
        cell: ({ getValue }) => getValue<string | null>() ?? 'System',
      },
      {
        id: 'action',
        header: '',
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => onOpen(row.original.stock_unit_id)}>
            Open unit
          </Button>
        ),
      },
    ],
    [onOpen],
  );
  return (
    <ServerTable
      data={page.records}
      columns={columns}
      total={page.total}
      query={query}
      isFetching={isFetching}
      emptyTitle="No stock movements match this view"
      emptyDescription="Try another movement type, branch or page-local search."
      onQueryChange={onQueryChange}
    />
  );
}

function ListWorkspace({
  view,
  query,
  permissions,
  branches,
  onQueryChange,
  onOpen,
}: {
  view: Exclude<InventoryView, 'dashboard'>;
  query: InventoryQuery;
  permissions: InventoryPermissions;
  branches: InventoryBranch[];
  onQueryChange: (next: Partial<InventoryQuery>) => void;
  onOpen: (stockUnitId: string) => void;
}) {
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const page = useQuery({
    queryKey: [
      'inventory-page',
      view,
      permissions.organizationId,
      permissions.scopeKey,
      requestQuery,
    ],
    queryFn: ({ signal }): Promise<InventoryPage> => {
      if (view === 'stock-check') return fetchStockCheckPage(requestQuery, signal);
      if (view === 'allocations') return fetchAllocationPage(requestQuery, signal);
      if (view === 'movements') return fetchMovementPage(requestQuery, signal);
      return fetchStockUnitPage(requestQuery, signal);
    },
    placeholderData: keepPreviousData,
  });

  if (page.isPending) return <PageSkeleton />;
  if (page.isError || !page.data)
    return (
      <Alert variant="destructive">
        <TriangleAlert className="size-4" />
        <div>
          <AlertTitle>Inventory records are unavailable</AlertTitle>
          <AlertDescription>
            The selected query may be outside your branch scope or the Inventory migration needs
            attention. Reference: GDM-INVENTORY-PAGE.
          </AlertDescription>
        </div>
      </Alert>
    );

  return (
    <div className="space-y-6">
      <KpiGrid metrics={pageMetrics(page.data)} />
      <Card className="shadow-none">
        <CardHeader className="border-b p-4">
          <Filters view={view} query={query} branches={branches} onQueryChange={onQueryChange} />
        </CardHeader>
      </Card>
      {view === 'stock-check' ? (
        <StockCheckTable
          page={page.data as StockCheckPage}
          query={query}
          isFetching={page.isFetching}
          onQueryChange={onQueryChange}
        />
      ) : view === 'allocations' ? (
        <AllocationTable
          page={page.data as AllocationPage}
          query={query}
          isFetching={page.isFetching}
          onQueryChange={onQueryChange}
          onOpen={onOpen}
        />
      ) : view === 'movements' ? (
        <MovementTable
          page={page.data as MovementPage}
          query={query}
          isFetching={page.isFetching}
          onQueryChange={onQueryChange}
          onOpen={onOpen}
        />
      ) : (
        <StockUnitTable
          page={page.data as StockUnitPage}
          query={query}
          isFetching={page.isFetching}
          onQueryChange={onQueryChange}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

export function InventoryWorkspace({
  spec,
  role,
  slug,
}: {
  spec: PageSpec;
  role: string;
  slug: string;
}) {
  const view = inventoryViewForRoute(role, slug);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedView = view ?? 'units';
  const [query, setQuery] = useState<InventoryQuery>(() =>
    parseInventoryQuery(searchParams, selectedView),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [intakeReceivedAt, setIntakeReceivedAt] = useState('');
  const [selectedStockUnitId, setSelectedStockUnitId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const permissions = useQuery({
    queryKey: ['inventory-permissions'],
    queryFn: fetchInventoryPermissions,
    staleTime: 60_000,
  });
  const branches = useQuery({
    queryKey: ['inventory-branches', permissions.data?.organizationId, permissions.data?.scopeKey],
    queryFn: fetchInventoryBranches,
    enabled: permissions.isSuccess,
    staleTime: 60_000,
  });
  const dashboard = useQuery({
    queryKey: ['inventory-dashboard', permissions.data?.organizationId, permissions.data?.scopeKey],
    queryFn: fetchInventoryDashboard,
    enabled: permissions.isSuccess && selectedView === 'dashboard' && permissions.data.canView,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'inventory',
      queryKeys: [['inventory-page'], ['inventory-dashboard'], ['inventory-unit-detail']],
    },
  ]);

  const onQueryChange = useCallback(
    (next: Partial<InventoryQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toInventoryQueryString(updated, selectedView);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, query, router, selectedView],
  );
  const openUnit = useCallback((stockUnitId: string) => setSelectedStockUnitId(stockUnitId), []);
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['inventory-page'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] });
    if (selectedStockUnitId)
      void queryClient.invalidateQueries({
        queryKey: ['inventory-unit-detail', selectedStockUnitId],
      });
  }, [queryClient, selectedStockUnitId]);

  if (!view)
    return (
      <Alert variant="destructive">
        <TriangleAlert className="size-4" />
        <div>
          <AlertTitle>Unsupported inventory route</AlertTitle>
          <AlertDescription>
            This route has no completed Inventory workspace preset.
          </AlertDescription>
        </div>
      </Alert>
    );
  if (permissions.isPending || branches.isPending) return <PageSkeleton />;
  const permissionDenied =
    permissions.isSuccess &&
    (selectedView === 'stock-check'
      ? !permissions.data.canStockCheck && !permissions.data.canView
      : !permissions.data.canView);
  if (permissions.isError || branches.isError || permissionDenied)
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Inventory is not available</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your session, permission, branch scope, or the required Inventory migration needs
            attention. Reference: GDM-INVENTORY-ACCESS.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              void permissions.refetch();
              void branches.refetch();
            }}
          >
            <RotateCcw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );
  if (!permissions.data || !branches.data) return null;

  const canOpenUnits = permissions.data.canView && selectedView !== 'stock-check';
  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        {!spec.readOnly && permissions.data.canCreate && selectedView !== 'stock-check' && (
          <Button
            className="shrink-0 sm:mt-7"
            onClick={() => {
              const now = new Date();
              const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
              setIntakeReceivedAt(local.toISOString().slice(0, 16));
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" /> Intake stock unit
          </Button>
        )}
      </div>
      {selectedView === 'stock-check' && (
        <Alert className="mb-6">
          <Package className="size-4" />
          <div>
            <AlertTitle>Availability-only view</AlertTitle>
            <AlertDescription>
              Counts are branch-scoped and intentionally omit VIN, chassis and allocation identity.
            </AlertDescription>
          </div>
        </Alert>
      )}
      {selectedView === 'movements' && permissions.data.canMove && (
        <Alert className="mb-6">
          <ArrowLeftRight className="size-4" />
          <div>
            <AlertTitle>Branch transfers use the stock detail</AlertTitle>
            <AlertDescription>
              Open an eligible unit from this history or Vehicle Inventory to transfer it with a
              reason and version check.
            </AlertDescription>
          </div>
        </Alert>
      )}
      {selectedView === 'dashboard' ? (
        dashboard.isPending ? (
          <PageSkeleton />
        ) : dashboard.isError || !dashboard.data ? (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <div>
              <AlertTitle>Inventory dashboard is unavailable</AlertTitle>
              <AlertDescription>
                The scoped KPI bundle could not be loaded. Reference: GDM-INVENTORY-DASHBOARD.
              </AlertDescription>
            </div>
          </Alert>
        ) : (
          <Dashboard data={dashboard.data} role={role} />
        )
      ) : (
        <ListWorkspace
          view={selectedView}
          query={query}
          permissions={permissions.data}
          branches={branches.data}
          onQueryChange={onQueryChange}
          onOpen={canOpenUnits ? openUnit : () => undefined}
        />
      )}
      {permissions.data.canCreate && (
        <StockIntakeDialog
          key={intakeReceivedAt || 'stock-intake'}
          organizationId={permissions.data.organizationId}
          branches={branches.data}
          open={createOpen}
          initialReceivedAt={intakeReceivedAt}
          onOpenChange={setCreateOpen}
          onCreated={invalidate}
        />
      )}
      {canOpenUnits && (
        <StockUnitDetailSheet
          key={selectedStockUnitId ?? 'no-stock-unit'}
          stockUnitId={selectedStockUnitId}
          branches={branches.data}
          permissions={permissions.data}
          onOpenChange={(open) => !open && setSelectedStockUnitId(null)}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}
