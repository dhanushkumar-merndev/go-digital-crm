import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type FilterMetric = {
  label: string;
  value: number;
  icon: LucideIcon;
  chip: string;
  rate: number;
  helper: string;
  good: boolean;
  neutral?: boolean;
  footnote?: string;
};

/**
 * A KPI tile that is also the list's filter: pressing it selects the matching
 * tab. Leads, Follow-ups and Tasks share it so the summary reads the same on
 * every list.
 */
export function FilterMetricCard({
  card,
  active,
  onSelect,
}: {
  card: FilterMetric;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = card.icon;
  // The rate is a share of the list, not a change over time, so it carries no
  // trend arrow: a red "down" arrow on SLA risk read as things getting worse.
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className="group min-w-0 rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Card
        data-kpi
        className={cn(
          'h-full min-w-0 shadow-none transition-all group-hover:-translate-y-0.5 group-hover:border-blue-200 group-hover:shadow-sm',
          active ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200/90',
        )}
      >
        <CardContent className="p-4">
          <div className="flex items-center gap-2.5">
            <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', card.chip)}>
              <Icon className="size-4" />
            </span>
            <p className="min-w-0 text-[11px] font-semibold leading-4 text-heading-soft">
              {card.label}
            </p>
          </div>
          <p className="mt-3 text-center text-[26px] font-bold leading-none tracking-tight text-heading">
            {card.value.toLocaleString('en-IN')}
          </p>
          <p
            className={cn(
              'mt-3 flex flex-wrap items-center justify-center gap-1 text-[10px] font-semibold',
              card.neutral
                ? 'text-muted-foreground'
                : card.good
                  ? 'text-emerald-600'
                  : 'text-rose-600',
            )}
          >
            {card.rate}%<span className="font-normal text-muted-foreground">{card.helper}</span>
          </p>
          {card.footnote && (
            <p className="mt-1 text-center text-[10px] text-muted-foreground">{card.footnote}</p>
          )}
        </CardContent>
      </Card>
    </button>
  );
}
