'use client';

import { CalendarDays, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import {
  performanceRangeDays,
  performanceRangeForLastDays,
  performanceToday,
  type PerformanceDateRange,
} from '@/lib/performance-date-range';
import { DateRangeDialog, type DateRangeChoice } from '@/components/shared/date-range-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type PerformanceDateRangeSelectorProps = {
  value: PerformanceDateRange;
  onChange: (range: PerformanceDateRange) => void;
  includeAllTime?: boolean;
  className?: string;
};

const ALL_TIME_FROM = '2000-01-01';

const dayMonth = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const dayMonthYear = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

// Noon UTC keeps the calendar day stable whatever the browser's timezone.
const asDate = (day: string) => new Date(`${day}T12:00:00Z`);

function shiftMonth(day: string, months: number) {
  const date = asDate(day);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(firstDay: string) {
  const date = asDate(shiftMonth(firstDay, 1));
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function performanceChoices(includeAllTime: boolean): DateRangeChoice[] {
  const today = performanceToday();
  const yesterday = performanceRangeForLastDays(2).from;
  const thisMonth = `${today.slice(0, 7)}-01`;
  const lastMonth = shiftMonth(thisMonth, -1);
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: yesterday, to: yesterday },
    { label: 'Last 7 days', ...performanceRangeForLastDays(7) },
    { label: 'Last 14 days', ...performanceRangeForLastDays(14) },
    { label: 'Last 30 days', ...performanceRangeForLastDays(30) },
    { label: 'This month', from: thisMonth, to: today },
    { label: 'Last month', from: lastMonth, to: lastDayOfMonth(lastMonth) },
    ...(includeAllTime ? [{ label: 'All time', from: ALL_TIME_FROM, to: today }] : []),
  ];
}

function rangeText(range: PerformanceDateRange) {
  if (range.from === range.to) return dayMonthYear.format(asDate(range.from));
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return `${(sameYear ? dayMonth : dayMonthYear).format(asDate(range.from))} – ${dayMonthYear.format(asDate(range.to))}`;
}

/**
 * The report period for every performance page: one button that says which
 * dates are on screen, opening quick ranges and a From/To calendar pair.
 */
export function PerformanceDateRangeSelector({
  value,
  onChange,
  includeAllTime = false,
  className,
}: PerformanceDateRangeSelectorProps) {
  const [open, setOpen] = useState(false);
  const choices = performanceChoices(includeAllTime);
  const preset = choices.find((choice) => choice.from === value.from && choice.to === value.to);
  const days = performanceRangeDays(value);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={cn('h-9 gap-2 bg-background px-3 text-xs font-semibold', className)}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <CalendarDays className="size-4 text-muted-foreground" />
        <span>{preset?.label ?? `${days} days`}</span>
        {preset?.label !== 'All time' ? (
          <span className="font-normal text-muted-foreground">{rangeText(value)}</span>
        ) : null}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </Button>
      <DateRangeDialog
        open={open}
        onOpenChange={setOpen}
        title="Report period"
        description="Every number and chart on this page covers these dates (IST)."
        value={value}
        pastOnly
        clearable={false}
        choices={choices}
        onApply={(range) => onChange({ from: range.from, to: range.to })}
      />
    </>
  );
}
