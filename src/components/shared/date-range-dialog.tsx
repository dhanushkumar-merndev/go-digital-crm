'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { istToday } from '@/components/ui/day-picker';
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

export type DateRangeValue = { from: string; to: string };
/** A ready-made range a page offers on top of, or instead of, the default offsets. */
export type DateRangeChoice = { label: string; from: string; to: string };

type DateRangePreset = {
  label: string;
  /** Days from today, in the app's operating timezone; negative is the past. */
  fromOffset: number;
  toOffset: number;
};

// Laid out as a timeline with today in the middle: what was missed on the left,
// what is coming on the right.
const presets: DateRangePreset[] = [
  { label: 'Last 7 days', fromOffset: -6, toOffset: 0 },
  { label: 'Yesterday', fromOffset: -1, toOffset: -1 },
  { label: 'Today', fromOffset: 0, toOffset: 0 },
  { label: 'Tomorrow', fromOffset: 1, toOffset: 1 },
  { label: 'Next 7 days', fromOffset: 0, toOffset: 6 },
];

// For a date that cannot be in the future, such as when a lead was created.
const pastPresets: DateRangePreset[] = [
  { label: 'Last 30 days', fromOffset: -29, toOffset: 0 },
  { label: 'Last 7 days', fromOffset: -6, toOffset: 0 },
  { label: 'Yesterday', fromOffset: -1, toOffset: -1 },
  { label: 'Today', fromOffset: 0, toOffset: 0 },
];

const DAY_MS = 86_400_000;
const dayFormat = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});

// Noon UTC keeps the calendar day stable whatever the browser's timezone.
function asDate(day: string) {
  return new Date(`${day}T12:00:00Z`);
}

function shiftDay(day: string, offset: number) {
  const date = asDate(day);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function rangeSummary(from: string, to: string) {
  if (from && to) {
    const days = Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY_MS) + 1;
    return from === to
      ? `${dayFormat.format(asDate(from))} · 1 day`
      : `${dayFormat.format(asDate(from))} – ${dayFormat.format(asDate(to))} · ${days} days`;
  }
  if (from) return `${dayFormat.format(asDate(from))} onwards`;
  if (to) return `Up to ${dayFormat.format(asDate(to))}`;
  return 'Leave one side empty for an open-ended range.';
}

function DateRangeForm({
  value,
  pastOnly,
  choices,
  clearable,
  onApply,
  onCancel,
}: {
  value: DateRangeValue;
  pastOnly: boolean;
  choices?: DateRangeChoice[];
  clearable: boolean;
  onApply: (range: DateRangeValue) => void;
  onCancel: () => void;
}) {
  const [draftFrom, setDraftFrom] = useState(value.from);
  const [draftTo, setDraftTo] = useState(value.to);
  const today = istToday();
  // The list RPCs reject a range that ends before it starts, which would turn
  // the whole table into an error state; refuse it here instead.
  const inverted = Boolean(draftFrom && draftTo && draftFrom > draftTo);
  const unchanged = draftFrom === value.from && draftTo === value.to;
  // A range that cannot be cleared (a report period) also cannot be open-ended.
  const incomplete = !clearable && (!draftFrom || !draftTo);
  const hasApplied = clearable && Boolean(value.from || value.to);
  const quickRanges: DateRangeChoice[] =
    choices ??
    (pastOnly ? pastPresets : presets).map((preset) => ({
      label: preset.label,
      from: shiftDay(today, preset.fromOffset),
      to: shiftDay(today, preset.toOffset),
    }));

  return (
    <>
      <div className="grid gap-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Quick ranges
        </p>
        {/* A quick range is a complete choice, so it applies on click. */}
        <div
          className={cn(
            'grid gap-1.5',
            choices || pastOnly ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3 sm:grid-cols-5',
          )}
          role="group"
        >
          {quickRanges.map((preset) => {
            const range = { from: preset.from, to: preset.to };
            const active = value.from === range.from && value.to === range.to;
            return (
              <Button
                key={preset.label}
                type="button"
                size="sm"
                variant={active ? 'default' : 'outline'}
                aria-pressed={active}
                className="h-8 whitespace-nowrap px-1 text-[11px]"
                onClick={() => onApply(range)}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Custom range
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-sm font-medium">
            From
            <Input
              type="date"
              value={draftFrom}
              max={draftTo || (pastOnly ? today : undefined)}
              onChange={(event) => setDraftFrom(event.target.value)}
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm font-medium">
            To
            <Input
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              max={pastOnly ? today : undefined}
              onChange={(event) => setDraftTo(event.target.value)}
            />
          </label>
        </div>
        <p
          className={cn('text-xs', inverted ? 'text-destructive' : 'text-muted-foreground')}
          aria-live="polite"
        >
          {inverted
            ? 'The From date must be on or before the To date.'
            : rangeSummary(draftFrom, draftTo)}
        </p>
      </div>
      <DialogFooter className="sm:justify-between">
        {hasApplied ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => onApply({ from: '', to: '' })}
          >
            Clear filter
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={inverted || unchanged || incomplete}
            onClick={() => onApply({ from: draftFrom, to: draftTo })}
          >
            Apply range
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/**
 * A `yyyy-mm-dd` range picker: one-click quick ranges, or a custom pair of
 * dates. `onApply` receives the chosen range and the dialog closes itself.
 */
export function DateRangeDialog({
  open,
  onOpenChange,
  title,
  description,
  value,
  pastOnly = false,
  choices,
  clearable = true,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  value: DateRangeValue;
  /** Offer only ranges that end today or earlier, and cap the pickers at today. */
  pastOnly?: boolean;
  /** Replaces the default quick ranges. */
  choices?: DateRangeChoice[];
  /** False for a period that must always have both ends, such as a report range. */
  clearable?: boolean;
  onApply: (range: DateRangeValue) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Mounted with the dialog, so the draft starts from the applied range
            every time it opens. */}
        <DateRangeForm
          value={value}
          pastOnly={pastOnly}
          choices={choices}
          clearable={clearable}
          onCancel={() => onOpenChange(false)}
          onApply={(range) => {
            onApply(range);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
