'use client';

import { Inbox, RotateCcw, TriangleAlert } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Nothing to show: an icon, one line saying why, one line saying what to do,
 * and an optional action. Used inside a table body (`bare`) or as a card.
 */
export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  bare = false,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
  /** Render without a card, e.g. inside a table cell or an existing panel. */
  bare?: boolean;
  className?: string;
}) {
  const body = (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      <span className="grid size-10 place-items-center rounded-full bg-slate-100 text-slate-500">
        <Icon className="size-4" />
      </span>
      <p className="mt-3 text-sm font-medium text-heading">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-xs text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
  return bare ? (
    body
  ) : (
    <Card className="shadow-none">
      <CardContent className="p-0">{body}</CardContent>
    </Card>
  );
}

/**
 * A query that never loaded. The page keeps its header above this, so the user
 * still knows where they are; the reference lets support find the failing
 * boundary without the page showing raw error text.
 */
export function ErrorState({
  title = 'This page could not be loaded',
  description = 'Check your connection and try again. If it keeps failing, share the reference with support.',
  reference,
  onRetry,
  retrying = false,
  action,
  className,
}: {
  title?: string;
  description?: ReactNode;
  reference?: string;
  onRetry?: () => void;
  retrying?: boolean;
  /** A way out beside the retry, e.g. back to the list. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('border-destructive/20 shadow-none', className)}>
      <CardContent className="flex flex-col items-center px-6 py-10 text-center">
        <span className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
          <TriangleAlert className="size-4" />
        </span>
        <p className="mt-3 text-sm font-semibold text-heading">{title}</p>
        <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{description}</p>
        {reference ? (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">Reference: {reference}</p>
        ) : null}
        {onRetry || action ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onRetry}
                disabled={retrying}
              >
                <RotateCcw className="size-3.5" /> {retrying ? 'Retrying…' : 'Try again'}
              </Button>
            ) : null}
            {action}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
