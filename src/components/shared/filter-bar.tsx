'use client';

import { RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * The one row of filters above a list: search first, then selects and dates,
 * then Reset once something is applied. It sits in the table card's header so
 * the filters and the rows they filter read as one block. The caller debounces
 * the search with `useDebouncedValue` before it reaches the query key.
 */
export function FilterBar({
  children,
  onReset,
  active = false,
  className,
}: {
  children: ReactNode;
  onReset?: () => void;
  /** Whether any filter differs from its default, which shows Reset. */
  active?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 border-b p-4 lg:flex-row lg:flex-wrap lg:items-center',
        className,
      )}
    >
      {children}
      {onReset && active ? (
        <Button type="button" variant="ghost" size="sm" className="lg:ml-auto" onClick={onReset}>
          <RotateCcw className="size-3.5" /> Reset
        </Button>
      ) : null}
    </div>
  );
}

export function FilterSearch({
  value,
  onChange,
  placeholder = 'Search',
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative min-w-0 flex-1 lg:max-w-sm', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        className="pl-9"
        value={value}
        maxLength={160}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}

/**
 * Filters that don't fit one row live behind a Filters button that opens a
 * dialog, so a list never scrolls sideways to reach its last filter. The button
 * shows how many filters are applied, and Clear filters sits beside it (and in
 * the dialog) whenever any is. Filters apply as they change; Done only closes.
 */
export function FilterDialogButton({
  activeCount,
  onClear,
  title = 'Filters',
  description = 'Narrow the list. Changes apply straight away.',
  children,
}: {
  activeCount: number;
  onClear: () => void;
  title?: string;
  description?: string;
  /** The filter fields; laid out two to a row. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-9 shrink-0 gap-1.5 bg-white text-xs"
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal className="size-3.5" />
        Filters
        {activeCount ? (
          <span className="grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
            {activeCount}
          </span>
        ) : null}
      </Button>
      {activeCount ? (
        <Button
          type="button"
          variant="ghost"
          className="h-9 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
          onClick={onClear}
        >
          <X className="size-3.5" /> Clear filters
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">{children}</div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={!activeCount} onClick={onClear}>
              Clear filters
            </Button>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
