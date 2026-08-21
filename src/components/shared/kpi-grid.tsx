import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { Metric } from '@/lib/domain';
import { cn } from '@/lib/utils';

export function KpiGrid({ metrics, className }: { metrics: Metric[]; className?: string }) {
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
                <p className="truncate text-xs font-medium text-muted-foreground">{metric.label}</p>
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
                  <p className="truncate text-[11px] text-muted-foreground">
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
