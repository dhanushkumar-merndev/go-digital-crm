'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { notificationDetailHref } from '@/lib/navigation/record-links';
import {
  claimFollowupReminder,
  fetchFollowupReminders,
  followupReminderKey,
} from './followup-reminder-api';
import { headerNotificationsKey } from './notification-api';
import { useFollowupReminderStore } from './followup-reminder-store';

/** Mounted once in the persistent application header. Timers run locally;
 * only a bounded minute refresh and the two reminder claims reach Supabase.
 */
export function FollowupReminderManager() {
  const session = useWorkspaceSession();
  const router = useRouter();
  const client = useQueryClient();
  const scope = workspaceQueryScope(session).join(':');
  const { due, scope: storedScope, enqueue, dismiss, reset } = useFollowupReminderStore();
  const attempts = useRef({ scope, keys: new Set<string>() });
  const query = useQuery({
    queryKey: [...followupReminderKey, ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchFollowupReminders(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    { resource: 'work', queryKeys: [followupReminderKey] },
    { resource: 'leads', queryKeys: [followupReminderKey] },
  ]);
  const { refetch } = query;
  useEffect(() => () => reset(), [scope, reset]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);
  useEffect(() => {
    if (!query.data || !session) return;
    const controller = new AbortController();
    if (attempts.current.scope !== scope) attempts.current = { scope, keys: new Set() };
    const attempted = attempts.current.keys;
    const currentKeys = new Set(
      query.data.records.flatMap((item) =>
        ['UPCOMING', 'DUE'].map((phase) => `${item.id}:${item.due_at}:${phase}`),
      ),
    );
    for (const key of attempted) if (!currentKeys.has(key)) attempted.delete(key);
    const toastIds: string[] = [];
    let running = false;
    let timer: ReturnType<typeof setTimeout>;
    const records = query.data.records;
    const offset = new Date(query.data.server_now).getTime() - query.data.receivedAt;
    const tick = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      let nextDelay = 60_000;
      try {
        if (document.visibilityState !== 'visible') return;
        for (const item of records) {
          const remaining = new Date(item.due_at).getTime() - (Date.now() + offset);
          if (remaining > 300_000) {
            nextDelay = Math.min(nextDelay, remaining - 300_000);
            continue;
          }
          if (remaining < -300_000) continue;
          const phase = remaining > 0 ? 'UPCOMING' : 'DUE';
          const key = `${item.id}:${item.due_at}:${phase}`;
          if (remaining > 0) nextDelay = Math.min(nextDelay, remaining);
          if (attempted.has(key)) continue;
          attempted.add(key);
          try {
            const claimed = await claimFollowupReminder(
              item,
              phase,
              AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
            );
            if (controller.signal.aborted) return;
            if (!claimed) continue;
            void client.invalidateQueries({ queryKey: headerNotificationsKey });
            if (phase === 'DUE') enqueue(scope, item);
            else
              toastIds.push(
                toast.add({
                  title: 'Follow-up in 5 minutes',
                  description: item.reason,
                  timeout: 15_000,
                  actionProps: {
                    children: 'Open follow-up',
                    onClick: () =>
                      router.push(notificationDetailHref(session.roleKey, 'followup', item.id)!),
                  },
                }),
              );
          } catch {
            attempted.delete(key);
            nextDelay = Math.min(nextDelay, 15_000);
          }
        }
      } finally {
        running = false;
        if (!controller.signal.aborted)
          timer = setTimeout(() => void tick(), Math.max(250, nextDelay));
      }
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
      toastIds.forEach((id) => toast.close(id));
    };
  }, [query.data, session, scope, client, router, enqueue]);

  const active =
    storedScope === scope
      ? due.find((item) =>
          query.data?.records.some((row) => row.id === item.id && row.due_at === item.due_at),
        )
      : undefined;
  return (
    <Dialog
      open={Boolean(active)}
      onOpenChange={(open) => {
        if (!open && active) dismiss(active.id);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Follow-up due now</DialogTitle>
          <DialogDescription>{active?.reason}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          It’s time to contact the customer. Open the follow-up to call, complete or reschedule it.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => active && dismiss(active.id)}>
            Dismiss
          </Button>
          <Button
            onClick={() => {
              if (active && session) {
                dismiss(active.id);
                router.push(notificationDetailHref(session.roleKey, 'followup', active.id)!);
              }
            }}
          >
            Open follow-up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
