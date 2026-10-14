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
import type { TelecallerPerformance } from './sales-consultant-performance-api';

type Day = TelecallerPerformance['daily'][number];
const pageSize = 25;
const measures = [
  { key: 'calls', label: 'Calls', color: '#2563eb' },
  { key: 'connected', label: 'Connected calls', color: '#10b981' },
  { key: 'followups_completed', label: 'Follow-ups completed', color: '#f59e0b' },
  { key: 'transferred', label: 'Leads transferred', color: '#8b5cf6' },
] as const;
const colors = measures.map((measure) => measure.color);

/** Uses the existing daily aggregates; hovering never changes a server query. */
export function TelecallerActivityChart({ rows }: { rows: Day[] }) {
  const { hoveredIndex, setHoveredIndex } = useChartHover();
  const { containerRef, activeRowRef } = useChartTableScroll(hoveredIndex);
  const data = useMemo(() => rows.map((day) => ({ name: day.name, value: 0 })), [rows]);
  const series = useMemo(
    () =>
      measures.map((measure) => ({
        name: measure.label,
        values: rows.map((day) => day[measure.key]),
      })),
    [rows],
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
    [],
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
        <CardDescription>
          Calls, completed follow-ups and Sales handoffs. Hover a date to highlight its daily
          breakdown.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-7">
          <EChart
            kind="line"
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
