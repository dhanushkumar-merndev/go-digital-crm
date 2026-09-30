'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Shown above a list whose background refresh failed while earlier rows are
 * still on screen. A page falls back to its full error state only when it has
 * never loaded; one failed refetch on a slow connection must not blank a
 * working table, and must not pretend the rows are current either.
 */
export function RefreshFailedNotice({
  show,
  onRetry,
  retrying = false,
  className,
  description = 'These results could not be refreshed and may be out of date.',
}: {
  show: boolean;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
  description?: string;
}) {
  if (!show) return null;
  return (
    <Alert
      variant="destructive"
      role="status"
      className={cn('flex items-center gap-3 [&>svg~*]:pl-0', className)}
    >
      <TriangleAlert className="static! size-4 shrink-0" />
      <AlertDescription className="flex-1">{description}</AlertDescription>
      <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
        <RotateCcw className="size-3.5" /> Retry
      </Button>
    </Alert>
  );
}
