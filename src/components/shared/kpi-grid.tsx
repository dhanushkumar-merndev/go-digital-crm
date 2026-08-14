import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { Metric } from '@/lib/domain';
import { cn } from '@/lib/utils';

export function KpiGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => {
        const TrendIcon =
          metric.trend === 'up' ? ArrowUpRight : metric.trend === 'down' ? ArrowDownRight : Minus;
        return (
          <Card key={metric.label} className="shadow-none">
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <p className="text-sm font-medium text-muted-foreground">{metric.label}</p>
                {metric.change && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5 text-xs font-semibold',
                      metric.trend === 'down' ? 'text-red-600' : 'text-emerald-600',
                    )}
                  >
                    <TrendIcon className="size-3.5" />
                    {metric.change}
                  </span>
                )}
              </div>
              <p className="mt-3 text-2xl font-bold tracking-tight">{metric.value}</p>
              <p className="mt-1 min-h-4 text-xs text-muted-foreground">
                {metric.helper ?? 'Current selected period'}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
