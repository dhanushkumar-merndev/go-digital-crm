import { ArrowRight, CircleAlert, Clock3, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { PageSpec } from '@/lib/domain';
import { cn } from '@/lib/utils';

export function AttentionList({ items }: { items: NonNullable<PageSpec['attention']> }) {
  const icon = { high: CircleAlert, medium: Clock3, low: Info };
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Requires attention</CardTitle>
          <Button variant="ghost" size="sm">
            View all
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item) => {
          const Icon = icon[item.severity];
          return (
            <button
              key={item.title}
              className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
            >
              <div
                className={cn(
                  'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg',
                  item.severity === 'high'
                    ? 'bg-red-50 text-red-600'
                    : item.severity === 'medium'
                      ? 'bg-amber-50 text-amber-600'
                      : 'bg-blue-50 text-blue-600',
                )}
              >
                <Icon className="size-4" />
              </div>
              <div>
                <p className="text-sm font-semibold">{item.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
