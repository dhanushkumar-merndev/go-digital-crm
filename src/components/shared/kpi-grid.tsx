import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Layers,
  Minus,
  UsersRound,
  WalletCards,
} from 'lucide-react';
import type { Tone } from '@/features/dashboards/dashboard-tone';
import { Card, CardContent } from '@/components/ui/card';
import type { RoleKey } from '@/config/navigation/types';
import type { Metric } from '@/lib/domain';
import { cn } from '@/lib/utils';
import { MetricCard } from './metric-card';

export type KpiGridVariant = 'metric' | 'classic';

/**
 * Telecaller and Sales Consultant screens were signed off with the classic
 * tile, so a workspace shared with other roles keeps it for those two and
 * gives everyone else the centred metric tile.
 */
export function kpiVariantForRole(role: RoleKey | string): KpiGridVariant {
  return role === 'telecaller' || role === 'sales-consultant' ? 'classic' : 'metric';
}

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

export function KpiGrid({
  metrics,
  className,
  variant = 'metric',
}: {
  metrics: Metric[];
  className?: string;
  variant?: KpiGridVariant;
}) {
  if (variant === 'metric')
    return (
      <div className={cn('grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4', className)}>
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
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', className)}>
      {metrics.map((metric) => {
        const TrendIcon =
          metric.trend === 'up' ? ArrowUpRight : metric.trend === 'down' ? ArrowDownRight : Minus;
        const Icon = metric.icon;
        return (
          <Card key={metric.label} className="overflow-hidden shadow-none">
            <CardContent className="flex min-h-[118px] items-start gap-4 p-4">
              {Icon && (
                <span
                  className={cn(
                    'grid size-11 shrink-0 place-items-center rounded-full',
                    metric.tone ?? 'bg-blue-50 text-blue-600',
                  )}
                >
                  <Icon className="size-5" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-medium text-muted-foreground">
                  {metric.label}
                </p>
                <p className="mt-1.5 text-2xl font-bold tracking-tight">{metric.value}</p>
                <div className="mt-1 flex min-h-5 items-center gap-1.5">
                  {metric.change && (
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold',
                        metric.trend === 'down' ? 'text-red-600' : 'text-emerald-600',
                      )}
                    >
                      <TrendIcon className="size-3" />
                      {metric.change}
                    </span>
                  )}
                  <p className="truncate text-[10px] text-muted-foreground">
                    {metric.helper ?? (metric.change ? undefined : 'Current selected period')}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
