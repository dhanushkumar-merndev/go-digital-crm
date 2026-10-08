'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ArrowRightLeft,
  CarFront,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Percent,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
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
  performanceRangeForLastDays,
  type PerformanceDateRange,
} from '@/lib/performance-date-range';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import {
  fetchSalesHandoffLeads,
  fetchSalesHandoffSummary,
  handoffStageBuckets,
  salesHandoffKeys,
  type HandoffStageBucket,
  type SalesHandoffLead,
  type SalesHandoffSummary,
} from './sales-handoff-api';

/**
 * Who reads the report. A telecaller sees their own handoffs split by
 * consultant; managers add the per-telecaller breakdown; the organization view
 * adds the per-branch breakdown.
 */
export type SalesHandoffPreset = 'TELECALLER' | 'TEAM' | 'SHOWROOM' | 'ORGANIZATION';

/** Stage buckets in pipeline order, with the hue of the matching stage badge. */
const stages: ReadonlyArray<{
  bucket: HandoffStageBucket;
  key: keyof SalesHandoffSummary['kpis'];
  label: string;
  color: string;
}> = [
  { bucket: 'WITH_SALES', key: 'with_sales', label: 'With sales', color: '#10b981' },
  { bucket: 'FOLLOW_UP', key: 'follow_up', label: 'Follow-up', color: '#f59e0b' },
  { bucket: 'TEST_DRIVE', key: 'test_drive', label: 'Test drive', color: '#8b5cf6' },
  { bucket: 'QUOTATION', key: 'quotation', label: 'Quotation', color: '#f97316' },
  { bucket: 'BOOKED', key: 'booked', label: 'Booked', color: '#2563eb' },
  { bucket: 'LOST', key: 'lost', label: 'Lost', color: '#94a3b8' },
];
const stageColors = stages.map((stage) => stage.color);
const pageSizes = [25, 50, 100] as const;

const copy: Record<SalesHandoffPreset, { title: string; description: string }> = {
  TELECALLER: {
    title: 'My leads handed to Sales',
    description:
      'Every lead you qualified and handed to a Sales Consultant, and the stage it is at now.',
  },
  TEAM: {
    title: 'Telecaller to Sales handoffs',
    description:
      'Leads your telecallers handed to Sales Consultants, and how far each consultant has taken them.',
  },
  SHOWROOM: {
    title: 'Telecaller to Sales handoffs',
    description:
      'Leads telecallers handed to Sales Consultants across your showroom, and how far each has gone.',
  },
  ORGANIZATION: {
    title: 'Telecaller to Sales handoffs',
    description:
      'Leads telecallers handed to Sales Consultants in every branch, and how many reached a booking.',
  },
};

const dateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      }).format(new Date(value))
    : '—';

type Pick = { id: string; name: string } | null;

export function SalesHandoffReport({
  preset,
  range: hostRange,
  branchId = null,
  leadBasePath,
}: {
  preset: SalesHandoffPreset;
  /** The host page's period. Omitted, the report shows its own date picker. */
  range?: PerformanceDateRange;
  /** A branch chosen by the host page; the report then hides its own branch filter. */
  branchId?: string | null;
  /** Lead detail route for roles that can open the lead, e.g. `/team-manager/leads`. */
  leadBasePath?: string;
}) {
  const session = useWorkspaceSession();
  const scope = workspaceQueryScope(session);
  const managerView = preset !== 'TELECALLER';
  const [ownRange, setOwnRange] = useState(() => performanceRangeForLastDays(30));
  const range = hostRange ?? ownRange;
  const [branch, setBranch] = useState<Pick>(null);
  const [telecaller, setTelecaller] = useState<Pick>(null);
  const [consultant, setConsultant] = useState<Pick>(null);
  const [stage, setStage] = useState<HandoffStageBucket | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput.trim(), 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(25);
  // A new period or branch from the host page starts the list on page one again.
  const periodKey = `${range.from}:${range.to}:${branchId}`;
  const [pagedPeriod, setPagedPeriod] = useState(periodKey);
  if (pagedPeriod !== periodKey) {
    setPagedPeriod(periodKey);
    setPage(1);
  }

  const filters = {
    branchId: branchId ?? branch?.id ?? null,
    teamId: null,
    telecallerId: telecaller?.id ?? null,
  };
  const leadFilters = {
    ...filters,
    consultantId: consultant?.id ?? null,
    stage,
    search,
    page,
    pageSize,
  };
  const summary = useQuery({
    queryKey: salesHandoffKeys.summary(scope, range, filters),
    queryFn: ({ signal }) => fetchSalesHandoffSummary(range, filters, signal),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const leads = useQuery({
    queryKey: salesHandoffKeys.leads(scope, range, leadFilters),
    queryFn: ({ signal }) => fetchSalesHandoffLeads(range, leadFilters, signal),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  useTenantRealtimeInvalidation(
    session?.organizationId,
    (['leads', 'sales'] as const).map((resource) => ({
      resource,
      queryKeys: [salesHandoffKeys.all],
    })),
  );

  // Any narrowing sends the lead list back to its first page.
  const narrow =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(1);
    };
  const chooseBranch = narrow(setBranch);
  const chooseTelecaller = narrow(setTelecaller);
  const chooseConsultant = narrow(setConsultant);
  const chooseStage = narrow(setStage);

  const { title, description } = copy[preset];
  const data = summary.data;

  return (
    <Card className="shadow-none">
      <CardHeader className="gap-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {hostRange ? null : (
            <PerformanceDateRangeSelector
              value={ownRange}
              onChange={(next) => {
                setOwnRange(next);
                setPage(1);
              }}
              includeAllTime
            />
          )}
        </div>
        <ActiveFilters
          items={[
            branch && !branchId
              ? { label: `Branch: ${branch.name}`, clear: () => chooseBranch(null) }
              : null,
            telecaller
              ? { label: `Telecaller: ${telecaller.name}`, clear: () => chooseTelecaller(null) }
              : null,
            consultant
              ? { label: `Consultant: ${consultant.name}`, clear: () => chooseConsultant(null) }
              : null,
          ]}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.isPending ? (
          <SummarySkeleton />
        ) : summary.isError ? (
          <LoadError onRetry={() => void summary.refetch()} />
        ) : data && data.kpis.transferred === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            No leads were handed to Sales in this period.
          </p>
        ) : data ? (
          <>
            <KpiGrid
              metrics={summaryMetrics(data, preset)}
              className={preset === 'TELECALLER' ? 'xl:grid-cols-3' : 'xl:grid-cols-4'}
            />
            {preset === 'ORGANIZATION' && !branchId && data.by_branch.length > 0 ? (
              <BranchTable
                rows={data.by_branch}
                selected={branch?.id ?? null}
                onSelect={chooseBranch}
              />
            ) : null}
            <div className="grid gap-4 xl:grid-cols-5">
              <Card className="shadow-none xl:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    Where each consultant&apos;s leads are now
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ConsultantStageChart rows={data.by_consultant} />
                </CardContent>
              </Card>
              <div className="xl:col-span-3">
                <ConsultantTable
                  rows={data.by_consultant}
                  selected={consultant?.id ?? null}
                  onSelect={chooseConsultant}
                />
              </div>
            </div>
            {managerView && data.by_telecaller.length > 0 ? (
              <TelecallerTable
                summary={data}
                selected={telecaller?.id ?? null}
                onSelect={chooseTelecaller}
              />
            ) : null}
          </>
        ) : null}

        <div className="space-y-3 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">Handed-over leads</p>
              <p className="text-xs text-muted-foreground">
                Search a customer to see who has their enquiry and what stage it is at.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Customer name or mobile"
                  className="h-8 w-56 pl-8 text-xs"
                  maxLength={100}
                  aria-label="Search handed-over leads"
                />
              </div>
              <Select
                value={stage ?? 'ALL'}
                onValueChange={(value) =>
                  chooseStage(value === 'ALL' ? null : (value as HandoffStageBucket))
                }
              >
                <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All stages</SelectItem>
                  {handoffStageBuckets.map((bucket) => (
                    <SelectItem key={bucket} value={bucket}>
                      {stages.find((item) => item.bucket === bucket)?.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <HandoffLeadTable
            rows={leads.data?.rows ?? []}
            showTelecaller={managerView}
            leadBasePath={leadBasePath}
            loading={leads.isPending}
            error={leads.isError}
            onRetry={() => void leads.refetch()}
          />
          {leads.data && leads.data.total > 0 ? (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={leads.data.total}
              fetching={leads.isFetching}
              onPage={setPage}
              onPageSize={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function summaryMetrics(data: SalesHandoffSummary, preset: SalesHandoffPreset): Metric[] {
  const { kpis } = data;
  const inProgress = kpis.with_sales + kpis.follow_up + kpis.test_drive + kpis.quotation;
  const metrics: Metric[] = [
    {
      label: 'Leads handed to Sales',
      value: String(kpis.transferred),
      icon: ArrowRightLeft,
      tone: 'bg-emerald-50 text-emerald-600',
      helper: `${data.by_consultant.length} consultant${data.by_consultant.length === 1 ? '' : 's'}`,
    },
    {
      label: 'In progress',
      value: String(inProgress),
      icon: CarFront,
      tone: 'bg-violet-50 text-violet-600',
      helper: `${kpis.test_drive} test drive · ${kpis.quotation} quotation`,
    },
    {
      label: 'Booked',
      value: String(kpis.booked),
      icon: CheckCircle2,
      tone: 'bg-blue-50 text-blue-600',
      helper: `${kpis.lost} lost`,
    },
    {
      label: 'Conversion to booking',
      value: `${kpis.conversion_pct}%`,
      icon: Percent,
      tone: 'bg-indigo-50 text-indigo-600',
      helper: kpis.reassigned
        ? `${kpis.reassigned} reassigned by a manager`
        : 'Booked ÷ handed over',
    },
  ];
  // A telecaller's own page already shows how many leads they transferred.
  return preset === 'TELECALLER' ? metrics.slice(1) : metrics;
}

function ConsultantStageChart({ rows }: { rows: SalesHandoffSummary['by_consultant'] }) {
  const data = useMemo(() => rows.map((row) => ({ name: row.consultant, value: 0 })), [rows]);
  const series = useMemo(
    () => stages.map((stage) => ({ name: stage.label, values: rows.map((row) => row[stage.key]) })),
    [rows],
  );
  return <EChart kind="bar" data={data} series={series} stacked colors={stageColors} />;
}

function ConsultantTable({
  rows,
  selected,
  onSelect,
}: {
  rows: SalesHandoffSummary['by_consultant'];
  selected: string | null;
  onSelect: (value: Pick) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sales Consultant</TableHead>
            <TableHead className="text-right">Received</TableHead>
            {stages.map((stage) => (
              <TableHead key={stage.bucket} className="text-right">
                {stage.label}
              </TableHead>
            ))}
            <TableHead className="text-right">Reassigned</TableHead>
            <TableHead className="text-right">Conversion</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.consultant_id}
              data-state={selected === row.consultant_id ? 'selected' : undefined}
              className="cursor-pointer"
              onClick={() =>
                onSelect(
                  selected === row.consultant_id
                    ? null
                    : { id: row.consultant_id, name: row.consultant },
                )
              }
            >
              <TableCell className="font-medium">{row.consultant}</TableCell>
              <TableCell className="text-right font-semibold">{row.transferred}</TableCell>
              {stages.map((stage) => (
                <TableCell key={stage.bucket} className="text-right tabular-nums">
                  {row[stage.key] || '—'}
                </TableCell>
              ))}
              <TableCell className="text-right tabular-nums">{row.reassigned || '—'}</TableCell>
              <TableCell className="text-right font-semibold">{row.conversion_pct}%</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        Click a consultant to list only their leads below. A lead stays with the consultant who
        received it, even if a manager later moved it.
      </p>
    </div>
  );
}

function TelecallerTable({
  summary,
  selected,
  onSelect,
}: {
  summary: SalesHandoffSummary;
  selected: string | null;
  onSelect: (value: Pick) => void;
}) {
  const split = useMemo(() => {
    const byTelecaller = new Map<string, string[]>();
    for (const row of summary.matrix) {
      const key = row.telecaller_id ?? 'unknown';
      byTelecaller.set(key, [
        ...(byTelecaller.get(key) ?? []),
        `${row.consultant} ${row.transferred} (${row.booked} booked)`,
      ]);
    }
    return byTelecaller;
  }, [summary.matrix]);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Telecaller</TableHead>
            <TableHead className="text-right">Handed over</TableHead>
            <TableHead>Given to</TableHead>
            <TableHead className="text-right">In progress</TableHead>
            <TableHead className="text-right">Booked</TableHead>
            <TableHead className="text-right">Lost</TableHead>
            <TableHead className="text-right">Conversion</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.by_telecaller.map((row) => {
            const id = row.telecaller_id;
            return (
              <TableRow
                key={id ?? 'unknown'}
                data-state={id && selected === id ? 'selected' : undefined}
                className={id ? 'cursor-pointer' : undefined}
                onClick={() =>
                  id && onSelect(selected === id ? null : { id, name: row.telecaller })
                }
              >
                <TableCell className="font-medium">{row.telecaller}</TableCell>
                <TableCell className="text-right font-semibold">{row.transferred}</TableCell>
                <TableCell className="max-w-[420px] text-xs text-muted-foreground">
                  {(split.get(id ?? 'unknown') ?? []).join(' · ')}
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.in_progress}</TableCell>
                <TableCell className="text-right tabular-nums">{row.booked}</TableCell>
                <TableCell className="text-right tabular-nums">{row.lost}</TableCell>
                <TableCell className="text-right font-semibold">{row.conversion_pct}%</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        Click a telecaller to see only the leads they handed over.
      </p>
    </div>
  );
}

function BranchTable({
  rows,
  selected,
  onSelect,
}: {
  rows: SalesHandoffSummary['by_branch'];
  selected: string | null;
  onSelect: (value: Pick) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Branch</TableHead>
            <TableHead className="text-right">Handed over</TableHead>
            <TableHead className="text-right">In progress</TableHead>
            <TableHead className="text-right">Booked</TableHead>
            <TableHead className="text-right">Lost</TableHead>
            <TableHead className="text-right">Conversion</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.branch_id}
              data-state={selected === row.branch_id ? 'selected' : undefined}
              className="cursor-pointer"
              onClick={() =>
                onSelect(
                  selected === row.branch_id ? null : { id: row.branch_id, name: row.branch },
                )
              }
            >
              <TableCell className="font-medium">{row.branch}</TableCell>
              <TableCell className="text-right font-semibold">{row.transferred}</TableCell>
              <TableCell className="text-right tabular-nums">{row.in_progress}</TableCell>
              <TableCell className="text-right tabular-nums">{row.booked}</TableCell>
              <TableCell className="text-right tabular-nums">{row.lost}</TableCell>
              <TableCell className="text-right font-semibold">{row.conversion_pct}%</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function HandoffLeadTable({
  rows,
  showTelecaller,
  leadBasePath,
  loading,
  error,
  onRetry,
}: {
  rows: SalesHandoffLead[];
  showTelecaller: boolean;
  leadBasePath?: string;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const columns = useMemo<ColumnDef<SalesHandoffLead>[]>(
    () => [
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) =>
          leadBasePath ? (
            <Link
              href={`${leadBasePath}/${row.original.lead_id}`}
              className="font-medium text-primary hover:underline"
            >
              {row.original.customer_name}
            </Link>
          ) : (
            <span className="font-medium">{row.original.customer_name}</span>
          ),
      },
      { id: 'phone', header: 'Mobile', cell: ({ row }) => row.original.phone },
      ...(showTelecaller
        ? [
            {
              id: 'telecaller',
              header: 'Given by',
              cell: ({ row }) => row.original.telecaller,
            } satisfies ColumnDef<SalesHandoffLead>,
          ]
        : []),
      { id: 'received', header: 'Given to', cell: ({ row }) => row.original.received_by },
      {
        id: 'owner',
        header: 'Now with',
        cell: ({ row }) =>
          row.original.reassigned ? (
            <span className="inline-flex items-center gap-1.5">
              {row.original.current_owner ?? 'Unassigned'}
              <Badge variant="outline" className="text-[10px]">
                Reassigned
              </Badge>
            </span>
          ) : (
            <span className="text-muted-foreground">Same</span>
          ),
      },
      {
        id: 'handed',
        header: 'Handed over',
        cell: ({ row }) => dateTime(row.original.handed_off_at),
      },
      {
        id: 'stage',
        header: 'Stage now',
        cell: ({ row }) => (
          <Badge variant={leadStageVariant(row.original.stage)}>{row.original.stage}</Badge>
        ),
      },
      {
        id: 'followup',
        header: 'Next follow-up',
        cell: ({ row }) => dateTime(row.original.next_followup_at),
      },
      {
        id: 'updated',
        header: 'Last updated',
        cell: ({ row }) => dateTime(row.original.updated_at),
      },
    ],
    [leadBasePath, showTelecaller],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.lead_id,
  });

  if (error) return <LoadError onRetry={onRetry} />;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 5 }, (_, index) => (
              <TableRow key={index}>
                <TableCell colSpan={columns.length}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="py-8 text-center text-muted-foreground"
              >
                No handed-over leads match these filters.
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="whitespace-nowrap text-xs">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  fetching,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: (typeof pageSizes)[number];
  total: number;
  fetching: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: (typeof pageSizes)[number]) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {first}–{last} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSize(Number(value) as (typeof pageSizes)[number])}
        >
          <SelectTrigger className="h-8 w-24 text-xs" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizes.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page <= 1 || fetching}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span>
          {page} / {pages}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page >= pages || fetching}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function ActiveFilters({ items }: { items: Array<{ label: string; clear: () => void } | null> }) {
  const active = items.filter((item) => item !== null);
  if (active.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {active.map((item) => (
        <Badge key={item.label} variant="secondary" className="gap-1 pr-1">
          {item.label}
          <button
            type="button"
            onClick={item.clear}
            className="rounded-sm p-0.5 hover:bg-background"
            aria-label={`Clear ${item.label}`}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[118px] w-full" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-5">
        <Skeleton className="h-80 xl:col-span-2" />
        <Skeleton className="h-80 xl:col-span-3" />
      </div>
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-lg border px-4 py-8 text-center">
      <TriangleAlert className="mx-auto size-5 text-destructive" />
      <p className="mt-2 text-sm font-semibold">Handoff data could not be loaded</p>
      <p className="text-xs text-muted-foreground">Check your connection and try again.</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
