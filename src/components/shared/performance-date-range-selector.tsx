'use client';

import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import {
  performanceRangeDays,
  performanceRangeForLastDays,
  performanceToday,
  type PerformanceDateRange,
} from '@/lib/performance-date-range';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type PerformanceDateRangeSelectorProps = {
  value: PerformanceDateRange;
  onChange: (range: PerformanceDateRange) => void;
  includeAllTime?: boolean;
  className?: string;
};

const quickRanges = [7, 14, 30] as const;

export function PerformanceDateRangeSelector({
  value,
  onChange,
  includeAllTime = false,
  className,
}: PerformanceDateRangeSelectorProps) {
  const [custom, setCustom] = useState(false);
  const days = performanceRangeDays(value);
  const selectedQuickRange = !custom && quickRanges.includes(days as (typeof quickRanges)[number]);
  const allTime = includeAllTime && value.from === '2000-01-01' && value.to === performanceToday();

  const selectRange = (next: string) => {
    if (next === 'custom') {
      setCustom(true);
      return;
    }

    setCustom(false);
    if (next === 'all') {
      onChange({ from: '2000-01-01', to: performanceToday() });
      return;
    }
    onChange(performanceRangeForLastDays(Number(next)));
  };

  const updateBoundary = (boundary: 'from' | 'to', next: string) => {
    if (!next) return;
    const nextRange = { ...value, [boundary]: next };
    if (nextRange.from > nextRange.to) {
      if (boundary === 'from') nextRange.to = next;
      else nextRange.from = next;
    }
    onChange(nextRange);
  };

  return (
    <div className={`flex flex-wrap items-center justify-end gap-2 ${className ?? ''}`}>
      <Select
        value={allTime ? 'all' : custom || !selectedQuickRange ? 'custom' : String(days)}
        onValueChange={selectRange}
      >
        <SelectTrigger className="w-44">
          <CalendarDays className="size-4" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="7">Last 7 days</SelectItem>
          <SelectItem value="14">Last 14 days</SelectItem>
          <SelectItem value="30">Last 30 days</SelectItem>
          <SelectItem value="custom">Custom range</SelectItem>
          {includeAllTime ? <SelectItem value="all">All time</SelectItem> : null}
        </SelectContent>
      </Select>
      {(custom || (!selectedQuickRange && !allTime)) && (
        <div className="flex items-center gap-1.5 rounded-lg border bg-background p-1.5">
          <Input
            aria-label="Performance range start date"
            className="h-8 w-[138px] border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            max={value.to}
            type="date"
            value={value.from}
            onChange={(event) => updateBoundary('from', event.target.value)}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            aria-label="Performance range end date"
            className="h-8 w-[138px] border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            max={performanceToday()}
            min={value.from}
            type="date"
            value={value.to}
            onChange={(event) => updateBoundary('to', event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
