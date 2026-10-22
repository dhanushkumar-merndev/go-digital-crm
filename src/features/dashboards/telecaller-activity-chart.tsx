'use client';

import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { EChart } from '@/components/charts/e-chart';
import { useChartHover, useChartTableScroll } from '@/components/charts/use-chart-hover';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SalesPerformance, TelecallerPerformance } from './sales-consultant-performance-api';

const pageSize = 25;

export type ActivityMeasure<Day> = {
  key: Exclude<keyof Day, 'name'> & string;
  label: string;
  color: string;
};

const telecallerMeasures: ActivityMeasure<TelecallerPerformance['daily'][number]>[] = [
  { key: 'calls', label: 'Calls', color: '#2563eb' },
  { key: 'connected', label: 'Connected calls', color: '#10b981' },
  { key: 'followups_completed', label: 'Follow-ups completed', color: '#f59e0b' },
  { key: 'transferred', label: 'Leads transferred', color: '#8b5cf6' },
];

const salesMeasures: ActivityMeasure<SalesPerformance['daily'][number]>[] = [
  { key: 'calls', label: 'Calls', color: '#2563eb' },
  { key: 'connected', label: 'Connected calls', color: '#10b981' },
  { key: 'appointments', label: 'Appointments', color: '#f59e0b' },
  { key: 'test_drives', label: 'Test drives', color: '#8b5cf6' },
];

export function TelecallerActivityChart({ rows }: { rows: TelecallerPerformance['daily'] }) {
  return (
    <DailyActivityChart
      rows={rows}
      measures={telecallerMeasures}
      description="Calls, completed follow-ups and Sales handoffs. Hover a date to highlight its daily breakdown."
    />
  );
}

export function SalesActivityChart({ rows }: { rows: SalesPerformance['daily'] }) {
  return (
    <DailyActivityChart
      rows={rows}
      measures={salesMeasures}
      description="Calls, appointments and test drives. Hover a date to highlight its daily breakdown."
    />
  );
}

/**
 * One chart and its day-by-day table, for any role's daily aggregates. Uses
 * the rows already loaded; hovering never changes a server query.
 */
function DailyActivityChart<Day extends { name: string }>({
  rows,
  measures,
  description,
}: {
  rows: Day[];
  measures: ActivityMeasure<Day>[];
  description: string;
}) {
  const colors = useMemo(() => measures.map((measure) => measure.color), [measures]);
  const valueOf = (day: Day, key: ActivityMeasure<Day>['key']) => Number(day[key] ?? 0);
  // A short read of the period before the detail: how many days had any
  // activity, the busiest one by the first measure, and its daily average.
  const lead = measures[0];
  const activeDays = rows.filter((day) =>
    measures.some((measure) => valueOf(day, measure.key) > 0),
  ).length;
  const busiest = lead
    ? rows.reduce<Day | null>(
        (best, day) => (!best || valueOf(day, lead.key) > valueOf(best, lead.key) ? day : best),
        null,
      )
    : null;
  const leadTotal = lead ? rows.reduce((sum, day) => sum + valueOf(day, lead.key), 0) : 0;
  const { hoveredIndex, setHoveredIndex } = useChartHover();
  const { containerRef, activeRowRef } = useChartTableScroll(hoveredIndex);
  const data = useMemo(() => rows.map((day) => ({ name: day.name, value: 0 })), [rows]);
  const series = useMemo(
    () =>
      measures.map((measure) => ({
        name: measure.label,
        values: rows.map((day) => Number(day[measure.key] ?? 0)),
      })),
    [rows, measures],
  );
  const columns = useMemo<ColumnDef<Day>[]>(
    () => [
      { accessorKey: 'name', header: 'Date' },
      ...measures.map((measure) => ({
        accessorKey: measure.key,
        header: measure.label,
        cell: ({ getValue }: { getValue: () => unknown }) =>
          Number(getValue()).toLocaleString('en-IN'),
      })),
    ],
    [measures],
  );
  // These are already-loaded daily aggregates, not a client-paginated lead dataset.
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const page = table.getState().pagination.pageIndex;
  return (
    <Card className="min-w-0 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Daily activity</CardTitle>
        <CardDescription>{description}</CardDescription>
        {rows.length && lead ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1 pt-2 text-xs text-muted-foreground">
            <span>
              Active days{' '}
              <span className="font-semibold text-heading">
                {activeDays} of {rows.length}
              </span>
            </span>
            {busiest && valueOf(busiest, lead.key) > 0 ? (
              <span>
                Busiest day{' '}
                <span className="font-semibold text-heading">
                  {busiest.name} · {valueOf(busiest, lead.key).toLocaleString('en-IN')}{' '}
                  {lead.label.toLowerCase()}
                </span>
              </span>
            ) : null}
            <span>
              {lead.label} per day{' '}
              <span className="font-semibold text-heading">
                {(leadTotal / rows.length).toFixed(1)}
              </span>
            </span>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-7">
          {/* Grouped bars up to a month: as lines, a day where every call
              connected drew Connected exactly over Calls and hid it. */}
          <EChart
            kind={data.length <= 31 ? 'bar' : 'line'}
            data={data}
            series={series}
            colors={colors}
            legendPosition="bottom"
            className="h-80 w-full sm:h-96"
            onHoverIndex={(index) => {
              setHoveredIndex(index);
              if (index !== null) {
                const nextPage = Math.floor(index / pageSize);
                if (table.getState().pagination.pageIndex !== nextPage) {
                  table.setPageIndex(nextPage);
                }
              }
            }}
          />
        </div>
        <div className="min-w-0 space-y-2 xl:col-span-5">
          <div ref={containerRef} className="rounded-lg border [&>div]:max-h-96">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        className={header.id === 'name' ? 'whitespace-nowrap' : 'text-right'}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    ref={hoveredIndex === row.index ? activeRowRef : undefined}
                    data-hovered={hoveredIndex === row.index || undefined}
                    className="data-[hovered=true]:bg-blue-50 data-[hovered=true]:hover:bg-blue-50 dark:data-[hovered=true]:bg-blue-950/40"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={
                          cell.column.id === 'name'
                            ? 'whitespace-nowrap font-medium'
                            : 'text-right tabular-nums'
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {!rows.length ? (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="py-10 text-center">
                      No daily activity in this period.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          {rows.length > pageSize ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {page * pageSize + 1}–{Math.min((page + 1) * pageSize, rows.length)} of{' '}
                {rows.length} days
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  aria-label="Previous days"
                  disabled={!table.getCanPreviousPage()}
                  onClick={() => {
                    setHoveredIndex(null);
                    table.previousPage();
                  }}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  aria-label="Next days"
                  disabled={!table.getCanNextPage()}
                  onClick={() => {
                    setHoveredIndex(null);
                    table.nextPage();
                  }}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
