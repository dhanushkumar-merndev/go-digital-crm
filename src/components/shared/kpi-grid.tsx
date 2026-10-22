import {
  Activity,
  CircleAlert,
  CircleCheck,
  Clock3,
  Layers,
  UsersRound,
  WalletCards,
} from 'lucide-react';
import type { Tone } from '@/features/dashboards/dashboard-tone';
import type { Metric } from '@/lib/domain';
import { cn } from '@/lib/utils';
import { MetricCard } from './metric-card';

/**
 * A tile without its own icon gets one from what its label says, so every
 * tile on a page carries a chip and the colour means the same thing everywhere:
 * red needs action, amber is waiting, green is done.
 */
const fallbackIcons: Array<[RegExp, Metric['icon'], Tone]> = [
  [/fail|error|overdue|risk|locked|rejected|missing|breach|critical/i, CircleAlert, 'rose'],
  [/pending|progress|queue|due|awaiting|review|processing|draft/i, Clock3, 'amber'],
  [
    /ready|complete|active|success|approved|enabled|healthy|connected|issued/i,
    CircleCheck,
    'emerald',
  ],
  [/credit|spend|cost|value|revenue|amount|price/i, WalletCards, 'violet'],
  [/user|owner|admin|member|consultant|team|staff/i, UsersRound, 'cyan'],
  [/total|all|overall/i, Layers, 'blue'],
];

function withFallbackIcon(metric: Metric): Metric {
  if (metric.icon) return metric;
  const [, icon, tone] = fallbackIcons.find(([pattern]) => pattern.test(metric.label)) ?? [
    null,
    Activity,
    'blue' as Tone,
  ];
  return { ...metric, icon, tone: metric.tone ?? tone };
}

/**
 * Columns that divide the card count, so a row never ends with one card on its
 * own. The grid used to be four wide whatever it held, and pages forced 5, 6 or
 * 7 with a className, which left orphans below that breakpoint. At two columns
 * an odd last card spans the row instead of sitting half-empty.
 */
export function kpiGridColumns(count: number) {
  const pairTail =
    '[&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1';
  switch (count) {
    case 1:
      return 'grid-cols-1';
    case 2:
      return 'grid-cols-1 sm:grid-cols-2';
    case 3:
      return 'grid-cols-1 sm:grid-cols-3';
    case 4:
      return 'grid-cols-2 lg:grid-cols-4';
    case 5:
      return `grid-cols-2 lg:grid-cols-5 ${pairTail}`;
    case 6:
      return 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6';
    case 7:
      return `grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 ${pairTail} xl:[&>*:last-child:nth-child(odd)]:col-span-1`;
    case 8:
      return 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-8';
    case 9:
      return 'grid-cols-1 sm:grid-cols-3';
    case 10:
      return 'grid-cols-2 lg:grid-cols-5';
    case 12:
      return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6';
    default:
      return 'grid-cols-2 lg:grid-cols-4';
  }
}

/**
 * Every KPI row in the app. One tile for every role, so the same number reads
 * the same way on a Telecaller's page and a manager's.
 */
export function KpiGrid({ metrics, className }: { metrics: Metric[]; className?: string }) {
  return (
    <div className={cn('grid gap-2.5', kpiGridColumns(metrics.length), className)}>
      {metrics.map(withFallbackIcon).map((metric) => (
        <MetricCard
          key={metric.label}
          label={metric.label}
          value={metric.value}
          icon={metric.icon}
          tone={metric.tone}
          caption={metric.helper}
          change={metric.change}
          trend={metric.trend}
          href={metric.href}
        />
      ))}
    </div>
  );
}
