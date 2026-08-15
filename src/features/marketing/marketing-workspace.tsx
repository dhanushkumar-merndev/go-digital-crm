'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Search, TriangleAlert } from 'lucide-react';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { fetchMarketingWorkspace, type MarketingWorkspaceResult } from './marketing-api';
import {
  marketingInitialView,
  marketingLabel,
  marketingPageSizes,
  marketingSorts,
  marketingViews,
  parseMarketingQuery,
  toMarketingQueryString,
  type MarketingQuery,
} from './marketing-query';

const workspaceKey = ['marketing-workspace'] as const;

type MarketingTableRow = {
  id: string;
  name: string;
  platform: string;
  status: string;
  outcome: string;
  updatedAt: string;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function marketingRows(result: MarketingWorkspaceResult): MarketingTableRow[] {
  return result.records.map((record) => {
    if ('source' in record)
      return {
        id: record.source,
        name: marketingLabel(record.source),
        platform: record.source,
        status: 'Measured',
        outcome: `${record.leads} leads · ${record.bookings} bookings`,
        updatedAt: '',
      };
    if ('name' in record)
      return {
        id: record.id,
        name: record.name,
        platform: `${record.platform} · ${record.canonical_source}`,
        status: record.status,
        outcome:
          record.budget_amount === null
            ? 'No CRM budget recorded'
            : `${record.currency_code} ${record.budget_amount}`,
        updatedAt: record.updated_at,
      };
    return {
      id: record.id,
      name: record.content || 'Social post',
      platform: record.platform,
      status: record.status,
      outcome: record.published_at
        ? `Published ${formatDate(record.published_at)}`
        : 'Not published',
      updatedAt: record.updated_at,
    };
  });
}

function workspaceMetrics(result: MarketingWorkspaceResult) {
  if (!result.kpis) return [];
  const kpis = result.kpis;
  return [
    { label: 'Leads generated', value: String(kpis.leads_generated), helper: 'Authorized scope' },
    { label: 'Qualified leads', value: String(kpis.qualified_leads), helper: 'Lead lifecycle' },
    { label: 'Bookings', value: String(kpis.bookings), helper: 'Attributed source leads' },
    { label: 'Conversion', value: `${kpis.conversion_percent}%`, helper: 'Booking / lead' },
    {
      label: 'Active campaigns',
      value: String(kpis.active_campaigns),
      helper: 'CRM campaign records',
    },
    {
      label: 'Review requests',
      value: String(kpis.review_requests),
      helper: 'Customer Care workflow',
    },
    {
      label: 'Posts published',
      value: String(kpis.posts_published),
      helper: 'Connected provider posts',
    },
  ];
}

function MarketingTable({
  result,
  query,
  fetching,
  onQueryChange,
}: {
  result: MarketingWorkspaceResult;
  query: MarketingQuery;
  fetching: boolean;
  onQueryChange: (next: Partial<MarketingQuery>) => void;
}) {
  const rows = useMemo(() => marketingRows(result), [result]);
  const columns = useMemo<ColumnDef<MarketingTableRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Record',
        cell: ({ getValue }) => <span className="font-medium">{String(getValue())}</span>,
      },
      { accessorKey: 'platform', header: 'Source / platform' },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge value={String(getValue())} />,
      },
      { accessorKey: 'outcome', header: 'Outcome' },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        cell: ({ getValue }) => {
          const value = String(getValue());
          return value ? formatDate(value) : 'Current aggregate';
        },
      },
    ],
    [],
  );
  // TanStack Table exposes an imperative row model; React Compiler intentionally skips it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
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
              placeholder="Source, campaign, platform or post"
            />
          </div>
          <Select
            value={query.sort}
            onValueChange={(value) =>
              onQueryChange({ sort: value as MarketingQuery['sort'], page: 1 })
            }
          >
            <SelectTrigger className="lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {marketingSorts.map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {marketingLabel(sort)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(query.pageSize)}
            onValueChange={(value) =>
              onQueryChange({ pageSize: Number(value) as MarketingQuery['pageSize'], page: 1 })
            }
          >
            <SelectTrigger className="lg:w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {marketingPageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className={`overflow-x-auto transition-opacity ${fetching ? 'opacity-60' : ''}`}>
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
                    <p className="font-medium">No matching marketing records</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Adjust this page’s search or sort options.
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

export function MarketingWorkspace({ spec, slug }: { spec: PageSpec; slug: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialView = marketingInitialView(slug) ?? 'SOURCES';
  const routeQuery = useMemo(
    () => parseMarketingQuery(new URLSearchParams(searchParams.toString()), initialView),
    [initialView, searchParams],
  );
  const debouncedSearch = useDebouncedValue(routeQuery.search, 300);
  const query = useMemo(
    () => ({ ...routeQuery, search: debouncedSearch }),
    [debouncedSearch, routeQuery],
  );
  const workspace = useQuery({
    queryKey: [...workspaceKey, query],
    queryFn: ({ signal }) => fetchMarketingWorkspace(query, signal),
    placeholderData: keepPreviousData,
  });
  useTenantRealtimeInvalidation(workspace.data?.organization_id, [
    { resource: 'marketing', queryKeys: [workspaceKey] },
    { resource: 'leads', queryKeys: [workspaceKey] },
    { resource: 'customer-care', queryKeys: [workspaceKey] },
  ]);
  const replaceQuery = useCallback(
    (next: Partial<MarketingQuery>) => {
      const value = toMarketingQueryString({ ...routeQuery, ...next }, initialView);
      router.replace(value ? `${pathname}?${value}` : pathname, { scroll: false });
    },
    [initialView, pathname, routeQuery, router],
  );

  if (workspace.isPending) return <PageSkeleton />;
  if (workspace.isError || !workspace.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <TriangleAlert className="size-6 text-amber-600" />
            <p className="font-semibold">Marketing is unavailable</p>
            <p className="max-w-xl text-sm text-muted-foreground">
              Marketing permissions and a configured tenant scope are required.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  const data = workspace.data;
  const metrics = workspaceMetrics(data);
  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      {metrics.length > 0 && <KpiGrid metrics={metrics} />}
      {data.source_chart && data.funnel_chart && (
        <div className="grid gap-6 xl:grid-cols-12">
          <Card className="shadow-none xl:col-span-7">
            <CardHeader>
              <CardTitle className="text-base">Source performance</CardTitle>
              <CardDescription>Leads and bookings by canonical source</CardDescription>
            </CardHeader>
            <CardContent>
              <EChart kind="bar" data={data.source_chart} seriesNames={['Leads', 'Bookings']} />
            </CardContent>
          </Card>
          <Card className="shadow-none xl:col-span-5">
            <CardHeader>
              <CardTitle className="text-base">Lead conversion funnel</CardTitle>
              <CardDescription>Lead to booking in your scope</CardDescription>
            </CardHeader>
            <CardContent>
              <EChart kind="funnel" data={data.funnel_chart} />
            </CardContent>
          </Card>
        </div>
      )}
      <Tabs
        value={routeQuery.view}
        onValueChange={(view) => replaceQuery({ view: view as MarketingQuery['view'], page: 1 })}
      >
        <TabsList className="h-auto max-w-full flex-wrap justify-start">
          {marketingViews.map((view) => (
            <TabsTrigger key={view} value={view}>
              {marketingLabel(view)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <MarketingTable
        result={data}
        query={routeQuery}
        fetching={workspace.isFetching}
        onQueryChange={replaceQuery}
      />
    </div>
  );
}
