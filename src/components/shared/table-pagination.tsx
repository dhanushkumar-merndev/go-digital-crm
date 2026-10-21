'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

export const tablePageSizes = [25, 50, 100] as const;
export type TablePageSize = (typeof tablePageSizes)[number];

/**
 * The footer under every server-paginated list: what is showing, how many rows
 * a page holds, and previous / next. Lists used to write this seven ways
 * ("25 / page", "25 rows", "Page 2 / 5", "· cursor pagination"), and some had
 * no size picker or no pager at all.
 *
 * `total` may be unknown for cursor-paginated logs: pass `hasNextPage` instead
 * and the count line drops the "of N".
 */
export function TablePagination({
  page,
  pageSize,
  total,
  hasNextPage,
  onPageChange,
  onPageSizeChange,
  pageSizes = tablePageSizes,
  className,
}: {
  page: number;
  pageSize: number;
  total?: number;
  hasNextPage?: boolean;
  onPageChange: (page: number) => void;
  /** Omit only where the server fixes the page size. */
  onPageSizeChange?: (pageSize: TablePageSize) => void;
  pageSizes?: readonly number[];
  className?: string;
}) {
  const known = typeof total === 'number';
  const pages = known ? Math.max(1, Math.ceil(total / pageSize)) : undefined;
  const first = known && total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = known ? Math.min(page * pageSize, total) : page * pageSize;
  const canNext = known ? page < (pages ?? 1) : Boolean(hasNextPage);
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-t px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <p>
        {known
          ? `Showing ${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)}`
          : `Page ${formatNumber(page)}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange ? (
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value) as TablePageSize)}
          >
            <SelectTrigger className="h-8 w-[104px] text-xs" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {pages ? (
          <span>
            Page {formatNumber(page)} of {formatNumber(pages)}
          </span>
        ) : null}
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-4" />
          <span className="sr-only">Previous page</span>
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="size-4" />
          <span className="sr-only">Next page</span>
        </Button>
      </div>
    </div>
  );
}
