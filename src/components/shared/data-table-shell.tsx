'use client';

import Link from 'next/link';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
import type { PageQuery, PageResult, PageRow, PageSpec } from '@/lib/domain';
import { StatusBadge } from './status-badge';

export function DataTableShell({
  spec,
  result,
  query,
  onQueryChange,
  role,
  isFetching,
}: {
  spec: PageSpec;
  result: PageResult;
  query: PageQuery;
  onQueryChange: (next: Partial<PageQuery>) => void;
  role: string;
  isFetching: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const tableColumns = useMemo<ColumnDef<PageRow>[]>(
    () =>
      spec.columns.map((column) => ({
        accessorKey: column.key,
        header: ({ column: tableColumn }) => (
          <button
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => {
              const next = tableColumn.getIsSorted() === 'asc' ? 'desc' : 'asc';
              setSorting([{ id: column.key, desc: next === 'desc' }]);
              onQueryChange({ sort: `${column.key}:${next}`, page: 1 });
            }}
          >
            {column.label}
            {tableColumn.getIsSorted() === 'asc' ? (
              <ArrowUp className="size-3" />
            ) : tableColumn.getIsSorted() === 'desc' ? (
              <ArrowDown className="size-3" />
            ) : (
              <ArrowUpDown className="size-3 opacity-40" />
            )}
          </button>
        ),
        cell: ({ getValue, row }) =>
          column.status ? (
            <StatusBadge value={String(getValue())} />
          ) : column.key === spec.columns[0]?.key ? (
            <Link
              href={`/${role}/record/${row.original.id}`}
              className="font-semibold text-foreground hover:text-primary hover:underline"
            >
              {String(getValue())}
            </Link>
          ) : (
            <span className={column.key === 'phone' ? 'font-medium text-blue-700' : ''}>
              {String(getValue())}
            </span>
          ),
      })),
    [spec, role, onQueryChange],
  );
  // TanStack Table intentionally returns an imperative table model; React Compiler skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: result.rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: result.total,
    state: { sorting },
  });
  const pages = Math.max(1, Math.ceil(result.total / query.pageSize));
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1 md:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              placeholder={`Search ${spec.title.toLowerCase()}…`}
            />
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={query.status}
              onValueChange={(status) => onQueryChange({ status, page: 1 })}
            >
              <SelectTrigger className="w-[155px]">
                <SlidersHorizontal className="mr-2 size-4" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="in-progress">In progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
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
        <div className={isFetching ? 'opacity-65 transition-opacity' : 'transition-opacity'}>
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
                  <TableCell colSpan={spec.columns.length} className="h-44 text-center">
                    <p className="font-medium">No matching records</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Clear the filters or try another page-local search.
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
