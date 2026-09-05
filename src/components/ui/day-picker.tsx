'use client';

import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A compact "which day am I looking at" control for per-day activity views.
 * Wraps the browser's native date input (a real calendar picker on every
 * platform) instead of shipping a bespoke calendar-grid dependency, and adds
 * Prev/Today/Next affordances so stepping through days doesn't require
 * reopening the picker each time.
 */
export function DayPicker({
  value,
  onChange,
  max,
  className,
}: {
  /** yyyy-mm-dd, or '' when no day is selected (falls back to the default view). */
  value: string;
  onChange: (value: string) => void;
  /** yyyy-mm-dd upper bound; defaults to today. */
  max?: string;
  className?: string;
}) {
  const today = max ?? istToday();
  const shift = (days: number) => {
    const base = value || today;
    const next = new Date(`${base}T00:00:00`);
    next.setDate(next.getDate() + days);
    const nextValue = toDateInputValue(next);
    if (nextValue > today) return;
    onChange(nextValue);
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 shrink-0 bg-white"
        onClick={() => shift(-1)}
        aria-label="Previous day"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <label className="relative flex h-9 min-w-0 flex-1 items-center rounded-lg border border-input bg-white px-2.5 text-xs font-semibold text-[#17233d] focus-within:ring-2 focus-within:ring-ring sm:w-44 sm:flex-none">
        <CalendarDays className="mr-1.5 size-3.5 shrink-0 text-muted-foreground" />
        <input
          type="date"
          value={value}
          max={today}
          onChange={(event) => onChange(event.target.value)}
          className="w-full min-w-0 bg-transparent outline-none [color-scheme:light]"
        />
        {value && (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              onChange('');
            }}
            className="ml-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-slate-100 hover:text-slate-700"
            aria-label="Clear selected day"
          >
            <X className="size-3.5" />
          </button>
        )}
      </label>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 shrink-0 bg-white"
        onClick={() => shift(1)}
        disabled={value === today || value === ''}
        aria-label="Next day"
      >
        <ChevronRight className="size-4" />
      </Button>
      {value !== today && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 bg-white text-xs"
          onClick={() => onChange(today)}
        >
          Today
        </Button>
      )}
    </div>
  );
}

export function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Today's date in the app's operating timezone (Asia/Kolkata), as yyyy-mm-dd. */
export function istToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
