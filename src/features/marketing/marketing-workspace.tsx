'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronLeft,
  ChevronRight,
  IndianRupee,
  MoreHorizontal,
  Pencil,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { MarketingWorkspaceSkeleton } from '@/components/skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  fetchMarketingWorkspace,
  type MarketingCampaignRecord,
  type MarketingPostRecord,
  type MarketingSourceRecord,
  type MarketingWorkspaceResult,
} from './marketing-api';
import { MarketingAdFieldMapping } from './marketing-ad-field-mapping';
import {
  CampaignFormDialog,
  CampaignSpendDialog,
  NewCampaignButton,
} from './marketing-campaign-dialogs';
import { SocialContentCalendar } from './social-content-calendar';
import { SocialPostDraftAction } from './social-post-draft-dialog';
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

type MarketingRecord = MarketingWorkspaceResult['records'][number];

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Money is shown only when it was recorded; a missing figure reads "—", never ₹0. */
function formatMoney(value: number | null | undefined, currency = 'INR') {
  if (value === null || value === undefined) return '—';
  if (!/^[A-Z]{3}$/.test(currency))
    return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: value < 100 ? 2 : 0,
  }).format(value);
}

function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `${value}%`;
}

function isSource(record: MarketingRecord): record is MarketingSourceRecord {
  return 'source' in record;
}

function recordId(record: MarketingRecord) {
  return isSource(record) ? record.source : record.id;
}

type SpendKpis = {
  ad_spend: number | null;
  cost_per_lead: number | null;
  cost_per_booking: number | null;
  click_through_percent: number | null;
  spend_currency: string;
};

function spendMetrics(kpis: SpendKpis, noSpendHelper: string) {
  const recorded = kpis.ad_spend !== null;
  return [
    {
      label: 'Ad spend',
      value: formatMoney(kpis.ad_spend, kpis.spend_currency),
      helper: recorded ? 'Recorded campaign spend' : noSpendHelper,
    },
    {
      label: 'Cost per lead',
      value: formatMoney(kpis.cost_per_lead, kpis.spend_currency),
      helper: recorded ? 'Spend / campaign leads' : noSpendHelper,
    },
    {
      label: 'Cost per booking',
      value: formatMoney(kpis.cost_per_booking, kpis.spend_currency),
      helper: recorded ? 'Spend / campaign bookings' : noSpendHelper,
    },
    {
      label: 'Click-through rate',
      value: formatPercent(kpis.click_through_percent),
      helper: 'Clicks / impressions',
    },
  ];
}

function workspaceMetrics(result: MarketingWorkspaceResult) {
  if (result.campaign_kpis) {
    const kpis = result.campaign_kpis;
    return [
      {
        label: 'Active campaigns',
        value: String(kpis.active_campaigns),
        helper: 'CRM campaign records',
      },
      {
        label: 'Campaign leads',
        value: String(kpis.campaign_leads),
        helper: 'Matched by campaign',
      },
      {
        label: 'Campaign bookings',
        value: String(kpis.campaign_bookings),
        helper: 'From those leads',
      },
      ...spendMetrics(kpis, 'Record spend on a campaign'),
    ];
  }
  if (!result.kpis) return [];
  const kpis = result.kpis;
  return [
    { label: 'Leads generated', value: String(kpis.leads_generated), helper: 'Authorized scope' },
    { label: 'Qualified leads', value: String(kpis.qualified_leads), helper: 'Lead lifecycle' },
    { label: 'Bookings', value: String(kpis.bookings), helper: 'Attributed source leads' },
    { label: 'Conversion', value: `${kpis.conversion_percent}%`, helper: 'Booking / lead' },
    ...spendMetrics(kpis, 'Record spend under Campaigns'),
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

type CampaignAction = { kind: 'edit' | 'spend'; campaign: MarketingCampaignRecord };

function sourceColumns(): ColumnDef<MarketingRecord>[] {
  const source = (record: MarketingRecord) => record as MarketingSourceRecord;
  return [
    {
      id: 'source',
      header: 'Source',
      cell: ({ row }) => <span className="font-medium">{source(row.original).source}</span>,
    },
    { id: 'leads', header: 'Leads', cell: ({ row }) => source(row.original).leads },
    { id: 'qualified', header: 'Qualified', cell: ({ row }) => source(row.original).qualified },
    {
      id: 'test_drives',
      header: 'Test drives',
      cell: ({ row }) => source(row.original).test_drives,
    },
    { id: 'quotations', header: 'Quotations', cell: ({ row }) => source(row.original).quotations },
    { id: 'bookings', header: 'Bookings', cell: ({ row }) => source(row.original).bookings },
    {
      id: 'conversion',
      header: 'Conversion',
      cell: ({ row }) => `${source(row.original).conversion}%`,
    },
    { id: 'spend', header: 'Spend', cell: ({ row }) => formatMoney(source(row.original).spend) },
    {
      id: 'cpl',
      header: 'Cost / lead',
      cell: ({ row }) => formatMoney(source(row.original).cost_per_lead),
    },
  ];
}

function campaignColumns(
  canManage: boolean,
  onAction: (action: CampaignAction) => void,
): ColumnDef<MarketingRecord>[] {
  const campaign = (record: MarketingRecord) => record as MarketingCampaignRecord;
  const columns: ColumnDef<MarketingRecord>[] = [
    {
      id: 'name',
      header: 'Campaign',
      cell: ({ row }) => (
        <span className="block max-w-64 truncate font-medium">{campaign(row.original).name}</span>
      ),
    },
    {
      id: 'platform',
      header: 'Platform',
      cell: ({ row }) =>
        `${marketingLabel(campaign(row.original).platform)} · ${campaign(row.original).canonical_source}`,
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge value={campaign(row.original).status} />,
    },
    {
      id: 'budget',
      header: 'Budget',
      cell: ({ row }) =>
        formatMoney(campaign(row.original).budget_amount, campaign(row.original).currency_code),
    },
    {
      id: 'spend',
      header: 'Spend',
      cell: ({ row }) => {
        const record = campaign(row.original);
        return (
          <span>
            {formatMoney(record.spend, record.currency_code)}
            {record.budget_used_percent !== null ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({record.budget_used_percent}%)
              </span>
            ) : null}
          </span>
        );
      },
    },
    { id: 'leads', header: 'Leads', cell: ({ row }) => campaign(row.original).leads },
    {
      id: 'cpl',
      header: 'Cost / lead',
      cell: ({ row }) =>
        formatMoney(campaign(row.original).cost_per_lead, campaign(row.original).currency_code),
    },
    { id: 'bookings', header: 'Bookings', cell: ({ row }) => campaign(row.original).bookings },
    {
      id: 'cpb',
      header: 'Cost / booking',
      cell: ({ row }) =>
        formatMoney(campaign(row.original).cost_per_booking, campaign(row.original).currency_code),
    },
    {
      id: 'ctr',
      header: 'CTR',
      cell: ({ row }) => formatPercent(campaign(row.original).click_through_percent),
    },
    {
      id: 'spend_source',
      header: 'Spend data',
      cell: ({ row }) => {
        const record = campaign(row.original);
        if (!record.spend_source) return <span className="text-muted-foreground">None yet</span>;
        return (
          <span className="text-xs">
            {record.spend_source === 'PROVIDER_SYNC' ? 'Ads account sync' : 'Entered manually'}
            {record.last_metric_date ? ` · to ${record.last_metric_date}` : ''}
          </span>
        );
      },
    },
  ];
  if (canManage)
    columns.push({
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Actions for ${campaign(row.original).name}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => onAction({ kind: 'spend', campaign: campaign(row.original) })}
            >
              <IndianRupee className="size-4" /> Record spend
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onAction({ kind: 'edit', campaign: campaign(row.original) })}
            >
              <Pencil className="size-4" /> Edit campaign
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    });
  return columns;
}

function postColumns(): ColumnDef<MarketingRecord>[] {
  const post = (record: MarketingRecord) => record as MarketingPostRecord;
  return [
    {
      id: 'content',
      header: 'Post',
      cell: ({ row }) => (
        <span className="block max-w-96 truncate font-medium">
          {post(row.original).content || 'Social post'}
        </span>
      ),
    },
    {
      id: 'platform',
      header: 'Platform',
      cell: ({ row }) => marketingLabel(post(row.original).platform),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge value={post(row.original).status} />,
    },
    {
      id: 'outcome',
      header: 'Outcome',
      cell: ({ row }) => {
        const record = post(row.original);
        return record.published_at
          ? `Published ${formatDate(record.published_at)}`
          : 'Not published';
      },
    },
    {
      id: 'updated',
      header: 'Updated',
      cell: ({ row }) => formatDate(post(row.original).updated_at),
    },
  ];
}

function MarketingTable({
  result,
  query,
  fetching,
  onQueryChange,
  onCampaignAction,
}: {
  result: MarketingWorkspaceResult;
  query: MarketingQuery;
  fetching: boolean;
  onQueryChange: (next: Partial<MarketingQuery>) => void;
  onCampaignAction: (action: CampaignAction) => void;
}) {
  const rows = result.records;
  // Keyed on the view only, so a refetch does not remount cells and close row menus.
  const columns = useMemo(
    () =>
      result.view === 'CAMPAIGNS'
        ? campaignColumns(result.can_manage, onCampaignAction)
        : result.view === 'SOURCES'
          ? sourceColumns()
          : postColumns(),
    [result.view, result.can_manage, onCampaignAction],
  );
  // TanStack Table exposes an imperative row model; React Compiler intentionally skips it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns,
    getRowId: recordId,
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
    { resource: 'marketing', queryKeys: [workspaceKey, ['social-content-calendar']] },
    { resource: 'leads', queryKeys: [workspaceKey] },
    { resource: 'customer-care', queryKeys: [workspaceKey] },
  ]);
  const replaceQuery = useCallback(
    (next: Partial<MarketingQuery>) => {
      replaceQueryString(pathname, toMarketingQueryString({ ...routeQuery, ...next }, initialView));
    },
    [initialView, pathname, routeQuery],
  );
  const [campaignAction, setCampaignAction] = useState<CampaignAction | null>(null);

  if (workspace.isPending) return <MarketingWorkspaceSkeleton />;
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
      {slug === 'lead-sources' ? <MarketingAdFieldMapping /> : null}
      {data.view === 'CAMPAIGNS' && data.campaign_chart && data.campaign_chart.length > 0 ? (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Cost per lead by campaign</CardTitle>
            <CardDescription>Campaigns with recorded spend, highest spend first</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="bar" data={data.campaign_chart} seriesNames={['Cost per lead', '']} />
          </CardContent>
        </Card>
      ) : null}
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
      {routeQuery.view === 'CAMPAIGNS' && data.can_manage ? (
        <div className="flex justify-end">
          <NewCampaignButton />
        </div>
      ) : null}
      {routeQuery.view === 'SOCIAL_POSTS' ? (
        <>
          <div className="flex justify-end">
            <SocialPostDraftAction />
          </div>
          <SocialContentCalendar />
        </>
      ) : null}
      <MarketingTable
        result={data}
        query={routeQuery}
        fetching={workspace.isFetching}
        onQueryChange={replaceQuery}
        onCampaignAction={setCampaignAction}
      />
      <CampaignFormDialog
        campaign={campaignAction?.kind === 'edit' ? campaignAction.campaign : null}
        open={campaignAction?.kind === 'edit'}
        onOpenChange={(open) => (open ? undefined : setCampaignAction(null))}
      />
      <CampaignSpendDialog
        campaign={campaignAction?.kind === 'spend' ? campaignAction.campaign : null}
        open={campaignAction?.kind === 'spend'}
        onOpenChange={(open) => (open ? undefined : setCampaignAction(null))}
      />
    </div>
  );
}
