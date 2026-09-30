'use client';

import { useQuery } from '@tanstack/react-query';
import { PhoneCall, PhoneOff, PhoneIncoming } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { formatNationalPhone } from '@/lib/phone';
import { RefreshFailedNotice } from '@/components/shared/refresh-failed-notice';
import { retryRpcRead } from '@/lib/supabase/read-rpc';
import {
  fetchActiveCall,
  isLiveCallStatus,
  liveCallQueryKeyRoot,
  type LiveCall,
} from './live-call-api';

const ENDED_CALL_VISIBLE_MS = 3_000;

function elapsedLabel(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

type Presentation = {
  title: string;
  detail: string;
  tone: 'waiting' | 'live' | 'ended' | 'failed';
  icon: typeof PhoneCall;
  pulse: boolean;
};

function present(call: LiveCall): Presentation {
  switch (call.status) {
    case 'PENDING':
      return {
        title: 'Starting call',
        detail: 'Waiting for the dealership line to pick this up.',
        tone: 'waiting',
        icon: PhoneCall,
        pulse: true,
      };
    case 'RINGING':
      if (call.agent_answered_at)
        return {
          title: 'Calling customer',
          // The employee is already on their leg; TeleCMI is now ringing the
          // customer. Showing "Ringing you" here is what made the bar look stuck.
          detail: 'You are on the line. Waiting for the customer to answer.',
          tone: 'waiting',
          icon: PhoneCall,
          pulse: true,
        };
      return {
        title: 'Ringing you',
        // Leg A is always the employee: the dealership line calls them first
        // and only bridges the customer once they answer.
        detail: 'Answer on your dealership line to connect the customer.',
        tone: 'waiting',
        icon: PhoneIncoming,
        pulse: true,
      };
    case 'IN_PROGRESS':
      return {
        title: 'Connected',
        detail: 'The customer is on the line.',
        tone: 'live',
        icon: PhoneCall,
        pulse: true,
      };
    case 'CANCELLED':
      return {
        title: 'Call cancelled',
        detail: 'Nothing was logged against this lead.',
        tone: 'ended',
        icon: PhoneOff,
        pulse: false,
      };
    case 'COMPLETED':
      return {
        title: 'Call ended',
        detail: 'Saved to the lead timeline.',
        tone: 'ended',
        icon: PhoneOff,
        pulse: false,
      };
    default:
      if (call.outcome === 'NO_ANSWER')
        return {
          title: 'No answer',
          detail: 'The customer did not pick up.',
          tone: 'failed',
          icon: PhoneOff,
          pulse: false,
        };
      if (call.outcome === 'BUSY')
        return {
          title: 'Line busy',
          detail: 'The customer was on another call.',
          tone: 'failed',
          icon: PhoneOff,
          pulse: false,
        };
      if (!call.agent_answered_at && !call.answered_at)
        return {
          title: 'Missed on your line',
          // TeleCMI only dials the customer after the employee answers, so an
          // unanswered leg A means the customer's phone never rang.
          detail: 'You did not answer, so the customer was not dialled.',
          tone: 'failed',
          icon: PhoneOff,
          pulse: false,
        };
      return {
        title: 'Call failed',
        detail: 'The dealership line could not complete the call.',
        tone: 'failed',
        icon: PhoneOff,
        pulse: false,
      };
  }
}

const toneStyles: Record<Presentation['tone'], { shell: string; dot: string; text: string }> = {
  waiting: { shell: 'border-amber-200 bg-amber-50', dot: 'bg-amber-500', text: 'text-amber-950' },
  live: {
    shell: 'border-emerald-200 bg-emerald-50',
    dot: 'bg-emerald-500',
    text: 'text-emerald-950',
  },
  ended: { shell: 'border-slate-200 bg-white', dot: 'bg-slate-400', text: 'text-slate-900' },
  failed: { shell: 'border-rose-200 bg-rose-50', dot: 'bg-rose-500', text: 'text-rose-950' },
};

/**
 * The one place a telecaller sees what their phone is doing. A toast could only
 * say "a call was requested" and then went stale; this follows the call through
 * to its outcome, driven by TeleCMI's webhooks arriving as realtime broadcasts
 * on public.calls.
 */
export function LiveCallBar() {
  const workspaceSession = useWorkspaceSession();
  const organizationId = workspaceSession?.organizationId ?? null;
  const queryScope = workspaceQueryScope(workspaceSession);
  const queryKey = [...liveCallQueryKeyRoot, ...queryScope];

  const activeCall = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchActiveCall(signal),
    enabled: Boolean(organizationId),
    retry: retryRpcRead,
    // The broadcast is the trigger; this only bounds how stale the bar can get
    // if one is ever dropped, and it is a single indexed row.
    refetchInterval: (query) =>
      query.state.data && isLiveCallStatus(query.state.data.status) ? 10_000 : false,
    staleTime: 0,
    gcTime: 60_000,
  });

  useTenantRealtimeInvalidation(organizationId, [
    { resource: 'communications', queryKeys: [queryKey] },
  ]);

  const call = activeCall.data ?? null;
  const [now, setNow] = useState(() => Date.now());
  const live = call ? isLiveCallStatus(call.status) : false;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // An ended call is shown just long enough to read the outcome, then cleared.
  // Keyed on call and status so a later call, or a status correction on the
  // same call (a late CDR turning FAILED into COMPLETED), shows again.
  const endedKey = call && !live ? `${call.call_id}:${call.status}:${call.outcome ?? ''}` : null;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!endedKey) return;
    const timer = setTimeout(() => setDismissedKey(endedKey), ENDED_CALL_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [endedKey]);

  if (activeCall.isError)
    return (
      <div className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-50 flex justify-center px-4 lg:pl-[252px]">
        <RefreshFailedNotice
          show
          className="pointer-events-auto max-w-md bg-background"
          description="Live call status is unavailable. Retry to see the latest status."
          onRetry={() => void activeCall.refetch()}
          retrying={activeCall.isFetching}
        />
      </div>
    );
  if (!call) return null;
  if (endedKey && dismissedKey === endedKey) return null;

  const view = present(call);
  const tone = toneStyles[view.tone];
  const Icon = view.icon;

  // While connected, count the conversation from the answer; while ringing,
  // how long it has been ringing. Once ended, the provider's own billed
  // duration is the honest number.
  //
  // PENDING deliberately shows no clock. Nothing is happening on the line yet --
  // we are waiting on the provider to acknowledge -- and a running mm:ss there
  // reads as call duration, so it kept counting after a call was already cut.
  const startedFrom = call.answered_at ?? call.started_at;
  const runningSeconds = (now - new Date(startedFrom).getTime()) / 1000;
  const timer =
    call.status === 'COMPLETED' && call.duration_seconds !== null
      ? elapsedLabel(call.duration_seconds)
      : live && call.status !== 'PENDING'
        ? elapsedLabel(runningSeconds)
        : null;

  return (
    <div
      role="status"
      aria-live="polite"
      // Sits just under the 4rem sticky AppHeader rather than over it, and is
      // offset past the desktop sidebar so it centres on the actual content.
      className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-50 flex justify-center px-4 lg:pl-[252px]"
    >
      <div
        className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border p-3 shadow-lg ${tone.shell}`}
      >
        <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-white/70">
          <Icon className={`size-4 ${tone.text}`} />
          <span
            className={`absolute -right-0.5 -top-0.5 size-2.5 rounded-full ${tone.dot} ${
              view.pulse ? 'animate-pulse' : ''
            }`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-semibold ${tone.text}`}>
            {view.title} · {call.customer_name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {call.phone ? `${formatNationalPhone(call.phone)} · ` : ''}
            {view.detail}
          </p>
        </div>
        {timer ? (
          <span className={`shrink-0 font-mono text-sm tabular-nums ${tone.text}`}>{timer}</span>
        ) : null}
      </div>
    </div>
  );
}
