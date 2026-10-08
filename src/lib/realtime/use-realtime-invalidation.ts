'use client';

import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  platformRealtimeTopic,
  tenantRealtimeTopic,
  type PlatformRealtimeResource,
  type TenantRealtimeResource,
} from './topics';

export { platformRealtimeTopic, tenantRealtimeTopic } from './topics';
export type { PlatformRealtimeResource, TenantRealtimeResource } from './topics';

type TenantSubscription = {
  resource: TenantRealtimeResource;
  queryKeys: QueryKey[];
  tableQueryKeys?: Record<string, QueryKey[]>;
  /**
   * Aggregates (dashboards, analytics) refetch at most once per this interval,
   * with jitter so every open dashboard in an organization does not hit the
   * server in the same instant. Work lists leave it unset and stay near-instant.
   */
  minIntervalMs?: number;
};

const AGGREGATE_REFETCH_JITTER_MS = 3_000;

type PlatformSubscription = {
  resource: PlatformRealtimeResource;
  queryKeys: QueryKey[];
};

const REALTIME_INVALIDATION_DEBOUNCE_MS = 300;

function stableSubscriptions<T extends TenantSubscription | PlatformSubscription>(items: T[]) {
  return JSON.stringify(items.map((item) => ({ ...item })));
}

export function useTenantRealtimeInvalidation(
  organizationId: string | null | undefined,
  subscriptions: TenantSubscription[],
) {
  const queryClient = useQueryClient();
  const stableKey = stableSubscriptions(subscriptions);
  const stableItems = useMemo(() => JSON.parse(stableKey) as TenantSubscription[], [stableKey]);

  useEffect(() => {
    if (!organizationId) return;
    const supabase = createClient();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const lastRuns = new Map<string, number>();
    const channels = stableItems.map((subscription, index) => {
      const invalidate = (event?: { payload?: { table?: string } }) => {
        const table = event?.payload?.table;
        const queryKeys = !event
          ? [...subscription.queryKeys, ...Object.values(subscription.tableQueryKeys ?? {}).flat()]
          : (table && subscription.tableQueryKeys?.[table]) || subscription.queryKeys;
        const schedule = (timerKey: string, keys: QueryKey[], delay: number) => {
          timers.set(
            timerKey,
            setTimeout(() => {
              timers.delete(timerKey);
              lastRuns.set(timerKey, Date.now());
              for (const queryKey of keys)
                void queryClient.invalidateQueries(
                  { queryKey, refetchType: 'active' },
                  { cancelRefetch: false },
                );
            }, delay),
          );
        };
        const minIntervalMs = subscription.minIntervalMs ?? 0;
        if (minIntervalMs > 0) {
          // Throttled per query key, not per channel: several channels often
          // feed one dashboard, and it should still refetch once per interval.
          for (const queryKey of queryKeys) {
            const timerKey = `aggregate:${JSON.stringify(queryKey)}`;
            if (timers.has(timerKey)) continue;
            const sinceLastRun = Date.now() - (lastRuns.get(timerKey) ?? 0);
            schedule(
              timerKey,
              [queryKey],
              Math.max(REALTIME_INVALIDATION_DEBOUNCE_MS, minIntervalMs - sinceLastRun) +
                Math.random() * AGGREGATE_REFETCH_JITTER_MS,
            );
          }
          return;
        }
        const timerKey = `${subscription.resource}:${index}:${table ?? ''}`;
        // Coalesce bursts without postponing updates indefinitely during history sync.
        if (timers.has(timerKey)) return;
        schedule(timerKey, queryKeys, REALTIME_INVALIDATION_DEBOUNCE_MS);
      };
      const channel = supabase
        .channel(tenantRealtimeTopic(organizationId, subscription.resource), {
          config: { private: true },
        })
        .on('broadcast', { event: 'insert' }, invalidate)
        .on('broadcast', { event: 'update' }, invalidate);
      return { channel, invalidate };
    });
    let cancelled = false;
    void supabase.realtime.setAuth().then(() => {
      if (!cancelled)
        channels.forEach(({ channel, invalidate }) => {
          let joined = false;
          channel.subscribe((status) => {
            if (status !== 'SUBSCRIBED') return;
            // Catch changes missed while the socket was down. The first join is
            // skipped: the page has just fetched, and each channel confirming
            // a moment apart used to chain one reload per channel on open.
            if (joined) invalidate();
            joined = true;
          });
        });
    });
    return () => {
      cancelled = true;
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      channels.forEach(({ channel }) => void supabase.removeChannel(channel));
    };
  }, [organizationId, queryClient, stableItems]);
}

export function usePlatformRealtimeInvalidation(subscriptions: PlatformSubscription[]) {
  const queryClient = useQueryClient();
  const stableKey = stableSubscriptions(subscriptions);
  const stableItems = useMemo(() => JSON.parse(stableKey) as PlatformSubscription[], [stableKey]);

  useEffect(() => {
    const supabase = createClient();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const channels = stableItems.map((subscription, index) => {
      const invalidate = () => {
        const timerKey = `${subscription.resource}:${index}`;
        const pending = timers.get(timerKey);
        if (pending) clearTimeout(pending);
        timers.set(
          timerKey,
          setTimeout(() => {
            timers.delete(timerKey);
            for (const queryKey of subscription.queryKeys)
              void queryClient.invalidateQueries({ queryKey, refetchType: 'active' });
          }, REALTIME_INVALIDATION_DEBOUNCE_MS),
        );
      };
      return supabase
        .channel(platformRealtimeTopic(subscription.resource), { config: { private: true } })
        .on('broadcast', { event: 'insert' }, invalidate)
        .on('broadcast', { event: 'update' }, invalidate);
    });
    let cancelled = false;
    void supabase.realtime.setAuth().then(() => {
      if (!cancelled) channels.forEach((channel) => channel.subscribe());
    });
    return () => {
      cancelled = true;
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      channels.forEach((channel) => void supabase.removeChannel(channel));
    };
  }, [queryClient, stableItems]);
}
