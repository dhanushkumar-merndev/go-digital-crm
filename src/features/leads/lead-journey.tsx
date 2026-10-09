'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import {
  ArrowRightLeft,
  CalendarCheck,
  CalendarClock,
  CarFront,
  FileText,
  Flame,
  History,
  MessageSquareText,
  NotebookPen,
  Phone,
  ReceiptIndianRupee,
  RotateCcw,
  Sparkles,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react';
import { z } from 'zod';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { createClient } from '@/lib/supabase/client';

const journeyEventSchema = z.object({
  id: z.uuid(),
  occurred_at: z.string(),
  kind: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  actor_name: z.string().nullable(),
  status: z.string().nullable(),
  extra: z
    .object({ notes: z.string().optional(), ai_summary: z.string().optional() })
    .catchall(z.unknown())
    .default({}),
});

const journeyPageSchema = z.object({
  lead_id: z.uuid(),
  events: z.array(journeyEventSchema),
  next_cursor: z.object({ occurred_at: z.string(), id: z.uuid() }).nullable(),
});

export type LeadJourneyEvent = z.infer<typeof journeyEventSchema>;
type JourneyCursor = { occurred_at: string; id: string } | null;

async function fetchLeadJourney(leadId: string, cursor: JourneyCursor, signal?: AbortSignal) {
  const request = createClient().rpc('get_lead_journey', {
    target_lead_id: leadId,
    target_cursor_at: cursor?.occurred_at ?? null,
    target_cursor_id: cursor?.id ?? null,
    target_limit: 50,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return journeyPageSchema.parse(data);
}

const iconByKind: Record<string, { icon: LucideIcon; tone: string }> = {
  CALL: { icon: Phone, tone: 'text-emerald-600' },
  STAGE: { icon: ArrowRightLeft, tone: 'text-blue-600' },
  TEMPERATURE: { icon: Flame, tone: 'text-orange-500' },
  ASSIGNMENT: { icon: UserRoundCheck, tone: 'text-indigo-600' },
  FOLLOWUP: { icon: CalendarClock, tone: 'text-amber-600' },
  APPOINTMENT: { icon: CalendarCheck, tone: 'text-teal-600' },
  TEST_DRIVE: { icon: CarFront, tone: 'text-violet-600' },
  QUOTATION: { icon: FileText, tone: 'text-orange-600' },
  BOOKING: { icon: ReceiptIndianRupee, tone: 'text-primary' },
  MESSAGE: { icon: MessageSquareText, tone: 'text-emerald-600' },
  NOTE: { icon: NotebookPen, tone: 'text-slate-600' },
};

function formatWhen(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

/**
 * Everything that happened on one enquiry, newest first: calls with who and
 * when, stage and temperature changes, assignments, follow-ups, visits, test
 * drives, quotations, bookings and notes. Permission-filtered by the RPC.
 */
export function LeadJourney({ leadId }: { leadId: string }) {
  const session = useWorkspaceSession();
  const journey = useInfiniteQuery({
    queryKey: ['lead-journey', ...workspaceQueryScope(session), leadId],
    queryFn: ({ pageParam, signal }) => fetchLeadJourney(leadId, pageParam, signal),
    initialPageParam: null as JourneyCursor,
    getNextPageParam: (page) => page.next_cursor,
    staleTime: 60_000,
  });

  if (journey.isPending)
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  if (journey.isError)
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          This lead&apos;s timeline could not be loaded.
        </p>
        <Button size="sm" variant="outline" onClick={() => void journey.refetch()}>
          <RotateCcw className="size-4" /> Try again
        </Button>
      </div>
    );

  const events = journey.data.pages.flatMap((page) => page.events);
  if (!events.length)
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Nothing has happened on this lead yet.
      </p>
    );

  return (
    <div className="p-5">
      <ol>
        {events.map((event, index) => {
          const { icon: Icon, tone } = iconByKind[event.kind] ?? {
            icon: History,
            tone: 'text-blue-600',
          };
          return (
            <li
              key={`${event.kind}-${event.id}-${event.occurred_at}`}
              className="relative flex gap-3 pb-5 last:pb-0"
            >
              {index < events.length - 1 && (
                <span className="absolute left-4 top-8 h-[calc(100%-20px)] w-px bg-border" />
              )}
              <span
                className={`z-10 grid size-8 shrink-0 place-items-center rounded-full border bg-background ${tone}`}
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 pt-0.5">
                <p className="text-sm font-semibold">{event.title}</p>
                {event.detail && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{event.detail}</p>
                )}
                {event.extra.notes && (
                  <p className="mt-1.5 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs leading-5">
                    {event.extra.notes}
                  </p>
                )}
                {event.extra.ai_summary && (
                  <p className="mt-1.5 flex gap-1.5 rounded-md border border-violet-200 bg-violet-50/50 px-2.5 py-1.5 text-xs leading-5 text-slate-700">
                    <Sparkles className="mt-0.5 size-3 shrink-0 text-violet-600" />
                    {event.extra.ai_summary}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {formatWhen(event.occurred_at)}
                  {event.actor_name ? ` · ${event.actor_name}` : ''}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {journey.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            size="sm"
            variant="outline"
            disabled={journey.isFetchingNextPage}
            onClick={() => void journey.fetchNextPage()}
          >
            {journey.isFetchingNextPage ? 'Loading…' : 'Load older activity'}
          </Button>
        </div>
      )}
    </div>
  );
}
