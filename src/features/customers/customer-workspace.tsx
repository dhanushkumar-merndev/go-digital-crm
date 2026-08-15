'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Search,
  TriangleAlert,
  UsersRound,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric } from '@/lib/domain';
import {
  fetchCustomerWorkspace,
  fetchCustomerWorkspacePermissions,
  type CustomerRecord,
  type CustomerWorkspaceResult,
} from './customer-workspace-api';
import {
  parseCustomerQuery,
  toCustomerQueryString,
  type CustomerQuery,
} from './customer-workspace-query';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase();
}

function toMetrics(kpis: CustomerWorkspaceResult['kpis']): Metric[] {
  return [
    {
      label: 'Customers in scope',
      value: kpis.customers.toLocaleString(),
      helper: 'Distinct customer UUIDs',
    },
    {
      label: 'Active opportunities',
      value: kpis.active_opportunities.toLocaleString(),
      helper: 'Visible non-lost leads',
    },
    {
      label: 'With bookings',
      value: kpis.customers_with_bookings.toLocaleString(),
      helper: 'Customers with visible bookings',
    },
    {
      label: 'Known vehicles',
      value: kpis.vehicles.toLocaleString(),
      helper: 'Multiple vehicles per customer supported',
    },
  ];
}

function CustomerTable({
  role,
  data,
  query,
  isFetching,
  onQueryChange,
}: {
  role: string;
  data: CustomerWorkspaceResult;
  query: CustomerQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<CustomerQuery>) => void;
}) {
  const columns = useMemo<ColumnDef<CustomerRecord>[]>(
    () => [
      {
        accessorKey: 'full_name',
        header: 'Customer',
        cell: ({ row }) => (
          <div>
            <Link
              className="font-semibold text-foreground hover:text-primary hover:underline"
              href={`/${role}/customers/${row.original.id}`}
            >
              {row.original.full_name}
            </Link>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{shortId(row.original.id)}</p>
          </div>
        ),
      },
      {
        accessorKey: 'primary_phone',
        header: 'Phone',
        cell: ({ row }) => (
          <div>
            <span className="font-medium text-blue-700">{row.original.primary_phone ?? '—'}</span>
            <p className="mt-0.5 max-w-48 truncate text-[11px] text-muted-foreground">
              {row.original.primary_email ?? 'No primary email'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'current_lead_status',
        header: 'Current opportunity',
        cell: ({ row }) => (
          <div>
            {row.original.current_lead_status ? (
              <StatusBadge value={row.original.current_lead_status} />
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {row.original.interested_model ?? 'No visible active model'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'branch_name',
        header: 'Scope context',
        cell: ({ row }) => (
          <div className="text-sm">
            <p>{row.original.branch_name ?? '—'}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.assigned_user_name ?? 'No visible owner'}
            </p>
          </div>
        ),
      },
      {
        id: 'history',
        header: 'History',
        cell: ({ row }) => (
          <div className="text-xs leading-5 text-muted-foreground">
            <p>{row.original.lead_count} leads</p>
            <p>{row.original.booking_count} bookings</p>
            <p>{row.original.vehicle_count} vehicles</p>
          </div>
        ),
      },
      {
        accessorKey: 'last_activity_at',
        header: 'Last activity',
        cell: ({ getValue }) => (
          <span className="text-xs text-muted-foreground">{formatDate(String(getValue()))}</span>
        ),
      },
      {
        id: 'action',
        header: '',
        cell: ({ row }) => (
          <Button size="sm" variant="outline" asChild>
            <Link href={`/${role}/customers/${row.original.id}`}>Open 360</Link>
          </Button>
        ),
      },
    ],
    [role],
  );
  // TanStack Table returns an imperative model; React Compiler intentionally skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: data.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: data.total,
  });
  const pages = Math.max(1, Math.ceil(data.total / query.pageSize));

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1 lg:max-w-md">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              placeholder="Search customer UUID, name, phone or email…"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={query.sort}
              onValueChange={(sort) =>
                onQueryChange({ sort: sort as CustomerQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-[185px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated:desc">Last activity: newest</SelectItem>
                <SelectItem value="updated:asc">Last activity: oldest</SelectItem>
                <SelectItem value="created:desc">Customer since: newest</SelectItem>
                <SelectItem value="created:asc">Customer since: oldest</SelectItem>
                <SelectItem value="name:asc">Customer: A–Z</SelectItem>
                <SelectItem value="name:desc">Customer: Z–A</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as CustomerQuery['pageSize'], page: 1 })
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
      </CardHeader>
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
                      <TableCell key={cell.id} className="whitespace-nowrap">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <UsersRound className="mx-auto size-7 text-muted-foreground" />
                    <p className="mt-3 font-medium">No customers match this authorized view</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Low-level roles only see customers linked to leads in their own data scope.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {data.total ? (query.page - 1) * query.pageSize + 1 : 0}–
            {Math.min(query.page * query.pageSize, data.total)} of {data.total}
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

export function CustomerWorkspace({ role }: { role: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState<CustomerQuery>(() => parseCustomerQuery(searchParams));
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const permissions = useQuery({
    queryKey: ['customer-workspace-permissions'],
    queryFn: fetchCustomerWorkspacePermissions,
    staleTime: 60_000,
  });
  const workspace = useQuery({
    queryKey: [
      'customer-workspace',
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      requestQuery,
    ],
    queryFn: () => fetchCustomerWorkspace(requestQuery),
    enabled: Boolean(permissions.data?.canView),
    placeholderData: keepPreviousData,
  });
  const onQueryChange = useCallback(
    (next: Partial<CustomerQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toCustomerQueryString(updated);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );

  if (permissions.isPending || (workspace.isPending && permissions.data?.canView))
    return <PageSkeleton />;
  if (permissions.isError || workspace.isError)
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Customers are not available</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This route requires an active CRM session, customer.view permission, the current data
            scope, and the customer workspace migration. Reference: GDM-CUSTOMERS-QUERY.
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
  if (!workspace.data) return null;

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Customer UUIDs are the long-term source of truth. This list contains only records visible
          in your current tenant, branch, team, or own-record scope.
        </p>
      </div>
      <KpiGrid metrics={toMetrics(workspace.data.kpis)} />
      <Card className="border-blue-100 bg-blue-50/40 shadow-none">
        <CardHeader className="py-4">
          <CardTitle className="text-sm">Reviewed matching only</CardTitle>
          <CardDescription>
            New customers are created from a lead after possible phone/email matches are reviewed;
            this page never silently merges people or treats contact data as a primary key.
          </CardDescription>
        </CardHeader>
      </Card>
      <CustomerTable
        role={role}
        data={workspace.data}
        query={query}
        isFetching={workspace.isFetching}
        onQueryChange={onQueryChange}
      />
    </div>
  );
}
