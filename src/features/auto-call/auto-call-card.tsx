'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  autoCallErrorMessage,
  fetchMyAutoCalls,
  fetchMyAutoCallStatus,
  myAutoCallStatusKey,
  aiCallOutcomeLabels,
  pausedReasonLabels,
  setMyAutoCall,
  type AiCallOutcome,
} from './auto-call-api';

const blockedLabels: Record<string, string> = {
  AUTO_CALL_DISABLED: 'Your Client Admin has not allowed Auto call yet.',
  AUTO_IVR_FLOW_NOT_PUBLISHED: 'No question flow is published yet.',
  AI_SCRIPT_MISSING: 'The AI call script is not written yet.',
  PIOPIY_NOT_CONNECTED: 'TeleCMI PIOPIY is not connected yet.',
};

const outcomeLabels: Record<string, string> = {
  ANSWERED: 'Answered',
  NO_INPUT: 'Picked up, no keys',
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  FAILED: 'Failed',
};

function RecentAutoCalls({
  open,
  onOpenChange,
  summary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: string[];
}) {
  const [page, setPage] = useState(1);
  const calls = useQuery({
    queryKey: ['my-auto-calls', page],
    queryFn: ({ signal }) => fetchMyAutoCalls(page, 25, signal),
    enabled: open,
    placeholderData: (previous) => previous,
  });
  const pages = calls.data ? Math.max(1, Math.ceil(calls.data.total / calls.data.page_size)) : 1;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Auto calls</SheetTitle>
          <SheetDescription>
            Every call placed to your leads by Auto call, by the AI agent or the keypad menu.
          </SheetDescription>
        </SheetHeader>
        <div className="mx-4 grid gap-0.5 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {summary.map((line) => (
            <p key={line} className="text-muted-foreground first:text-foreground">
              {line}
            </p>
          ))}
        </div>
        <div className="grid gap-3 p-4">
          {calls.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : calls.isError ? (
            <p className="text-sm text-destructive">Auto calls could not be loaded.</p>
          ) : calls.data.records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No auto calls yet.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Keys</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {calls.data.records.map((record) => (
                    <TableRow key={record.call_id}>
                      <TableCell>
                        <Link
                          href={`/telecaller/calls/${record.call_id}/auto-call`}
                          className="font-medium text-primary hover:underline"
                        >
                          {record.customer_name}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {record.interested_model ?? '—'} · try {record.attempt_no}
                        </p>
                      </TableCell>
                      <TableCell>
                        {record.verified ? (
                          <Badge variant="success">Verified</Badge>
                        ) : (
                          <Badge variant={record.outcome === 'ANSWERED' ? 'violet' : 'secondary'}>
                            {(record.ai_outcome
                              ? aiCallOutcomeLabels[record.ai_outcome as AiCallOutcome]
                              : null) ??
                              outcomeLabels[record.outcome ?? ''] ??
                              (record.status === 'IN_CALL' || record.status === 'DIALING'
                                ? 'Calling'
                                : record.status.replaceAll('_', ' ').toLowerCase())}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{record.mode === 'AI_AGENT' ? 'AI' : record.answers}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(record.created_at).toLocaleString('en-IN', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Page {page} of {pages}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= pages}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The telecaller's Auto call switch, a compact control in the lead pages'
 * header. The status and today's counts sit in its tooltip and in the Auto
 * calls sheet, which opens from the label.
 */
export function AutoCallToggle() {
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const status = useQuery({
    queryKey: myAutoCallStatusKey,
    queryFn: ({ signal }) => fetchMyAutoCallStatus(signal),
    refetchInterval: (query) =>
      query.state.data?.available && query.state.data.enabled ? 15_000 : false,
  });
  const toggle = useMutation({
    meta: { toast: false },
    mutationFn: setMyAutoCall,
    onSuccess: async (_, enabled) => {
      await queryClient.invalidateQueries({ queryKey: myAutoCallStatusKey });
      toast.add({
        type: 'success',
        title: enabled ? 'Auto call is on' : 'Auto call is off',
        description: enabled
          ? 'Your new leads will be called one by one.'
          : 'A call already ringing will finish; no new calls start.',
      });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Auto call was not changed',
        description: autoCallErrorMessage(error, 'Try again in a moment.'),
      }),
  });

  if (status.isPending) return <Skeleton className="h-9 w-36" />;
  if (!status.data?.available) return null;
  const data = status.data;
  const state = data.paused_reason
    ? {
        tone: 'bg-amber-500',
        label: `Paused: ${pausedReasonLabels[data.paused_reason] ?? data.paused_reason}`,
      }
    : !data.enabled
      ? { tone: 'bg-slate-300', label: 'Off' }
      : !data.in_window
        ? { tone: 'bg-slate-400', label: `Waits for ${data.calling_window_start}` }
        : { tone: 'bg-emerald-500', label: 'On' };
  const summary = [
    `Auto call: ${state.label}`,
    data.blocked_reason
      ? blockedLabels[data.blocked_reason]
      : data.current_call
        ? `Calling ${data.current_call.customer_name}…`
        : `${data.mode === 'AI_AGENT' ? 'An AI agent calls' : 'Calls'} your uncontacted new leads one by one, ${data.calling_window_start}–${data.calling_window_end}.`,
    `${data.waiting_count} waiting · today ${data.today.calls} called, ${data.today.answered} answered, ${data.today.no_answer} no answer`,
  ];

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-9 items-center gap-2 rounded-md border bg-background pr-2.5 shadow-xs">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="flex h-full items-center gap-2 rounded-l-md pl-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PhoneCall className="size-4" />
              Auto call
              <span className={cn('size-2 rounded-full', state.tone)} aria-hidden />
              <span className="sr-only">{state.label}</span>
            </button>
            <Switch
              checked={data.enabled}
              disabled={toggle.isPending || (!data.enabled && Boolean(data.blocked_reason))}
              onCheckedChange={(checked) => toggle.mutate(checked)}
              aria-label="Auto call"
            />
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          {summary.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </TooltipContent>
      </Tooltip>
      <RecentAutoCalls open={historyOpen} onOpenChange={setHistoryOpen} summary={summary} />
    </>
  );
}
