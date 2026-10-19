import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * A titled panel: a ruled header with an optional "view all" link, then the
 * body. The Telecaller and Sales Consultant dashboards build every section this
 * way; managers, admins and operations use it so a card reads the same on every
 * role. `flush` removes the body padding for a table that runs edge to edge.
 */
export function SectionCard({
  title,
  description,
  action,
  actionHref,
  actionLabel,
  flush = false,
  className,
  contentClassName,
  children,
}: {
  title: string;
  description?: string;
  /** Anything custom for the header's right side. Wins over the link. */
  action?: ReactNode;
  actionHref?: string;
  actionLabel?: string;
  flush?: boolean;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn('min-w-0 overflow-hidden border-slate-200/90 shadow-none', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3.5">
        <div className="min-w-0">
          <CardTitle className="text-sm text-[#12213f]">{title}</CardTitle>
          {description ? (
            <p className="mt-1 text-[11px] font-normal text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ??
          (actionHref ? (
            <Link
              href={actionHref}
              className="shrink-0 text-[11px] font-medium text-blue-600 hover:underline"
            >
              {actionLabel ?? 'View all'}
            </Link>
          ) : null)}
      </CardHeader>
      <CardContent className={cn(flush ? 'p-0' : 'p-4', contentClassName)}>{children}</CardContent>
    </Card>
  );
}
