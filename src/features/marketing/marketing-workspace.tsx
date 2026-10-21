'use client';

import { TablePagination } from '@/components/shared/table-pagination';
import { useCallback, useMemo, useState } from 'react';
import { sortLabel } from '@/lib/format';
import { usePathname, useSearchParams } from 'next/navigation';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { IndianRupee, MoreHorizontal, Pencil, Search } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { SectionCard } from '@/components/shared/section-card';
import { MarketingWorkspaceSkeleton } from '@/components/skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
    // Campaigns is where spend is recorded and shows these tiles either way;
    // elsewhere four "—" tiles only repeated that page, so they wait for data.
    ...(kpis.ad_spend !== null ? spendMetrics(kpis, 'Record spend under Campaigns') : []),
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
                  {sortLabel(sort)}
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

// Tiles about marketing's own work (posts, review invites) mean nothing on the
// GM's sales view of the same sources.
const marketingOnlyMetrics = new Set(['Active campaigns', 'Review requests', 'Posts published']);

function marketingPageLayout(slug: string) {
  return {
    charts: slug === 'dashboard' || slug === 'performance' || slug === 'lead-source-performance',
    table: slug !== 'dashboard' && slug !== 'performance',
    mapping: slug === 'lead-sources',
    salesOnly: slug === 'lead-source-performance',
  };
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
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="Marketing is unavailable"
          description="Marketing permissions and a configured tenant scope are required."
          onRetry={() => void workspace.refetch()}
          retrying={workspace.isFetching}
        />
      </PageShell>
    );

  const data = workspace.data;
  // Each sidebar page shows its own slice of the same data instead of one
  // screen behind three entries: the dashboard and Performance read the charts,
  // Lead sources / Campaigns / Social posts work the table. The sidebar is the
  // navigation, so the in-page tabs that repeated it are gone.
  const layout = marketingPageLayout(slug);
  const metrics = workspaceMetrics(data).filter(
    (metric) => !layout.salesOnly || !marketingOnlyMetrics.has(metric.label),
  );
  return (
    <PageShell>
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      {metrics.length > 0 && <KpiGrid metrics={metrics} />}
      {layout.mapping ? <MarketingAdFieldMapping /> : null}
      {layout.charts && data.view === 'CAMPAIGNS' ? (
        <SectionCard
          title="Cost per lead by campaign"
          description="Campaigns with recorded spend, highest spend first"
        >
          {data.campaign_chart && data.campaign_chart.length > 0 ? (
            <EChart kind="bar" data={data.campaign_chart} seriesNames={['Cost per lead', '']} />
          ) : (
            <EmptyState
              bare
              title="No campaign spend recorded yet"
              description="Record spend on a campaign to compare cost per lead."
            />
          )}
        </SectionCard>
      ) : null}
      {layout.charts && data.source_chart && data.funnel_chart && (
        <div className="grid gap-4 xl:grid-cols-12">
          <SectionCard
            title="Source performance"
            description="Leads and bookings by canonical source"
            className="xl:col-span-7"
          >
            <EChart kind="bar" data={data.source_chart} seriesNames={['Leads', 'Bookings']} />
          </SectionCard>
          <SectionCard
            title="Lead conversion funnel"
            description="Lead to booking in your scope"
            className="xl:col-span-5"
          >
            <EChart kind="funnel" data={data.funnel_chart} />
          </SectionCard>
        </div>
      )}
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
      {layout.table ? (
        <MarketingTable
          result={data}
          query={routeQuery}
          fetching={workspace.isFetching}
          onQueryChange={replaceQuery}
          onCampaignAction={setCampaignAction}
        />
      ) : null}
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
    </PageShell>
  );
}
