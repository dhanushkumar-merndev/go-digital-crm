'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Download, FileDown, Search } from 'lucide-react';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  fetchReportExports,
  fetchReportPermissions,
  presignReportDownload,
  requestReportExport,
  type ReportExportRecord,
} from './report-export-api';
import {
  parseReportExportQuery,
  reportKinds,
  reportLabel,
  reportPageSizes,
  toReportExportQueryString,
  type ReportExportQuery,
  type ReportKind,
} from './report-export-query';

const exportsKey = ['report-exports'] as const;

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function metrics(page: Awaited<ReturnType<typeof fetchReportExports>>): Metric[] {
  return [
    { label: 'Ready exports', value: String(page.kpis.ready), helper: 'Available for 30 days' },
    { label: 'In progress', value: String(page.kpis.processing), helper: 'Queued or processing' },
    { label: 'Failed', value: String(page.kpis.failed), helper: 'Retry a new request' },
    {
      label: 'Last 30 days',
      value: String(page.kpis.requested_30d),
      helper: 'Authorized requests',
    },
  ];
}

export function ReportExportWorkspace({ spec }: { spec: PageSpec }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(() => parseReportExportQuery(searchParams).search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const query = useMemo(
    () => ({ ...parseReportExportQuery(searchParams), search: debouncedSearch }),
    [debouncedSearch, searchParams],
  );
  const setQuery = useCallback(
    (next: Partial<ReportExportQuery>) => {
      const result = { ...parseReportExportQuery(new URLSearchParams(searchParams)), ...next };
      const serialized = toReportExportQueryString(result);
      router.replace(serialized ? `${pathname}?${serialized}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  const page = useQuery({
    queryKey: [...exportsKey, query],
    queryFn: ({ signal }) => fetchReportExports(query, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchInterval: (state) =>
      state.state.data?.records.some((row) =>
        ['QUEUED', 'PROCESSING', 'RETRY'].includes(row.status),
      )
        ? 15_000
        : false,
  });
  const permissions = useQuery({
    queryKey: ['report-permissions'],
    queryFn: fetchReportPermissions,
    staleTime: 60_000,
  });
  const requestExport = useMutation({
    mutationFn: (key: ReportKind) => requestReportExport(key),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: exportsKey }),
  });
  const download = useMutation({
    mutationFn: presignReportDownload,
    onSuccess: ({ download_url }) => window.open(download_url, '_blank', 'noopener,noreferrer'),
  });
  const columns = useMemo<ColumnDef<ReportExportRecord>[]>(
    () => [
      {
        accessorKey: 'report_key',
        header: 'Report',
        cell: ({ getValue }) => (
          <span className="font-medium">{reportLabel(String(getValue()))}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge value={String(getValue())} />,
      },
      {
        accessorKey: 'requested_by_name',
        header: 'Requested by',
        cell: ({ getValue }) => String(getValue() ?? 'You'),
      },
      {
        accessorKey: 'created_at',
        header: 'Requested',
        cell: ({ getValue }) => formatDate(String(getValue())),
      },
      {
        accessorKey: 'expires_at',
        header: 'Expires',
        cell: ({ getValue }) => formatDate(getValue() as string | null),
      },
      {
        id: 'download',
        header: '',
        cell: ({ row }) =>
          row.original.status === 'READY' && row.original.object_file_id ? (
            <Button
              variant="outline"
              size="sm"
              disabled={download.isPending}
              onClick={() => download.mutate(row.original.object_file_id!)}
            >
              <Download className="size-4" />
              Download
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              {row.original.safe_error_code ? 'Could not generate' : '—'}
            </span>
          ),
      },
    ],
    [download],
  );
  // TanStack Table exposes an imperative row model; React Compiler intentionally skips it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: page.data?.records ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: page.data?.total ?? 0,
  });
  if (page.isLoading || permissions.isLoading) return <PageSkeleton />;
  if (page.isError || permissions.isError || !page.data)
    return (
      <div className="p-6 text-sm text-destructive">
        Reports could not be loaded. Refresh and try again.
      </div>
    );
  const pages = Math.max(1, Math.ceil(page.data.total / query.pageSize));
  return (
    <div className="space-y-6">
      <PageHeader spec={spec} />
      <KpiGrid metrics={metrics(page.data)} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Export activity</CardTitle>
            <CardDescription>
              Aggregate exports only; files are private and expire after 30 days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="donut" data={page.data.status_chart} className="h-64" />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Request an export</CardTitle>
            <CardDescription>
              Exports run in the background and never expose provider credentials or detailed
              customer data.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {reportKinds.map((kind) => (
              <Button
                key={kind}
                variant="outline"
                className="justify-start"
                disabled={!permissions.data?.canExport || requestExport.isPending}
                onClick={() => requestExport.mutate(kind)}
              >
                <FileDown className="size-4" />
                {reportLabel(kind)}
              </Button>
            ))}
            {!permissions.data?.canExport && (
              <p className="col-span-2 text-xs text-muted-foreground">
                Your role can view report history but cannot request an export.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={searchInput}
                maxLength={80}
                onChange={(event) => {
                  setSearchInput(event.target.value);
                  setQuery({ search: event.target.value, page: 1 });
                }}
                placeholder="Search report or status"
              />
            </div>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                setQuery({ pageSize: Number(value) as ReportExportQuery['pageSize'], page: 1 })
              }
            >
              <SelectTrigger className="sm:w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {reportPageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} rows
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className={`p-0 ${page.isFetching ? 'opacity-60' : ''}`}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {table.getRowModel().rows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-28 text-center text-muted-foreground"
                    >
                      No report exports in this scope.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t p-3 text-sm">
            <span>
              Page {query.page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button
                size="icon"
                variant="outline"
                disabled={query.page <= 1}
                onClick={() => setQuery({ page: query.page - 1 })}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="outline"
                disabled={query.page >= pages}
                onClick={() => setQuery({ page: query.page + 1 })}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
