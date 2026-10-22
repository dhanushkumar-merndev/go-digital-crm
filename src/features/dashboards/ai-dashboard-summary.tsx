'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DashboardAiSummaryError,
  generateDashboardAiSummary,
} from './sales-consultant-dashboard-api';

const timeFormat = (value: string, timezone: string) =>
  new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(value));

function errorText(error: unknown) {
  if (error instanceof DashboardAiSummaryError && error.code === 'INSUFFICIENT_CREDITS')
    return 'Your dealership has no AI credits left. Ask your admin to add credits.';
  return 'The summary could not be generated. No credit was used. Try again.';
}

/**
 * The AI summary card on the Sales Consultant and Telecaller dashboards. The
 * rule-based text from the page's own numbers shows until the user asks for an
 * AI summary; generating spends one dealership AI credit (a saved one is free),
 * and the header balance is refreshed so the spend is visible straight away.
 */
export function AiDashboardSummary({
  title,
  defaultSummary,
  timezone,
}: {
  title: string;
  defaultSummary: string;
  timezone: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const summary = useMutation({
    meta: { toast: false },
    mutationFn: (forceRefresh: boolean) =>
      generateDashboardAiSummary({ forceRefresh, requestId: crypto.randomUUID() }),
    onSuccess: (result) => {
      if (result.credits_charged > 0)
        void queryClient.invalidateQueries({ queryKey: ['header-credit-balance'] });
    },
  });
  const summaryText = summary.data?.summary ?? defaultSummary;
  const charged = summary.data?.credits_charged ?? 0;

  return (
    <div className="mt-auto border-t border-dashed pt-3">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-violet-100 bg-violet-50/50 p-3 text-left transition-colors hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        aria-label={`Open ${title}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-violet-100 text-violet-700">
              <Sparkles className="size-3.5" />
            </span>
            <div>
              <p className="text-xs font-semibold text-heading-soft">{title}</p>
              <p className="text-[10px] text-muted-foreground">Open for the full summary</p>
            </div>
          </div>
          <Badge variant="info" className="text-[10px]">
            {summary.data
              ? summary.data.provider === 'AI'
                ? 'AI summary'
                : 'From your numbers'
              : 'AI ready'}
          </Badge>
        </div>
        <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-[#334155]">{summaryText}</p>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Generated from your current dashboard numbers. A generated summary is saved until you
              regenerate it; opening a saved one is free.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-lg bg-slate-50 p-3 text-sm leading-6 text-heading-soft">
            {summaryText}
          </p>
          {summary.isError ? (
            <p className="text-sm text-rose-600">{errorText(summary.error)}</p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {summary.data
                ? `Generated ${timeFormat(summary.data.generated_at, timezone)} · ${
                    charged ? `${charged} AI credit used` : 'no credit used'
                  }`
                : 'Generating uses 1 AI credit'}
            </span>
            <Button
              type="button"
              onClick={() => summary.mutate(Boolean(summary.data))}
              disabled={summary.isPending}
            >
              <Sparkles className="size-4" />
              {summary.isPending
                ? 'Generating…'
                : summary.data
                  ? 'Regenerate · 1 credit'
                  : 'Generate · 1 credit'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
