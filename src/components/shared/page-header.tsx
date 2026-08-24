import { ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { PageSpec } from '@/lib/domain';
import { cn } from '@/lib/utils';

export function PageHeader({
  spec,
  className,
  primaryActionHref,
  onPrimaryAction,
}: {
  spec: PageSpec;
  className?: string;
  primaryActionHref?: string;
  onPrimaryAction?: () => void;
}) {
  return (
    <div
      className={cn(
        'mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start',
        className,
      )}
    >
      <div>
        <div className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
          <span className="text-primary">Dashboard</span>
          <ChevronRight className="size-3" />
          <span>{spec.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight md:text-[28px]">{spec.title}</h1>
          {spec.readOnly && <Badge variant="outline">Read only</Badge>}
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{spec.description}</p>
      </div>
      {spec.primaryAction && primaryActionHref ? (
        <Button className="shrink-0" asChild>
          <Link href={primaryActionHref}>
            <Plus className="size-4" />
            {spec.primaryAction}
          </Link>
        </Button>
      ) : spec.primaryAction && onPrimaryAction ? (
        <Button type="button" className="shrink-0" onClick={onPrimaryAction}>
          <Plus className="size-4" />
          {spec.primaryAction}
        </Button>
      ) : null}
    </div>
  );
}
