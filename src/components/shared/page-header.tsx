import { ChevronRight, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { PageSpec } from '@/lib/domain';

export function PageHeader({ spec }: { spec: PageSpec }) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div>
        <div className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
          <span>Workspace</span>
          <ChevronRight className="size-3" />
          <span>{spec.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight md:text-[28px]">{spec.title}</h1>
          {spec.readOnly && <Badge variant="outline">Read only</Badge>}
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{spec.description}</p>
        <p className="mt-2 text-xs font-medium text-blue-700">{spec.access}</p>
      </div>
      {spec.primaryAction && (
        <Button className="shrink-0">
          <Plus className="size-4" />
          {spec.primaryAction}
        </Button>
      )}
    </div>
  );
}
