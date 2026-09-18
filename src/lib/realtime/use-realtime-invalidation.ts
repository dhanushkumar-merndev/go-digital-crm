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
};

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
    const channels = stableItems.map((subscription, index) => {
      const invalidate = (event?: { payload?: { table?: string } }) => {
        const table = event?.payload?.table;
        const queryKeys = !event
          ? [...subscription.queryKeys, ...Object.values(subscription.tableQueryKeys ?? {}).flat()]
          : (table && subscription.tableQueryKeys?.[table]) || subscription.queryKeys;
        const timerKey = `${subscription.resource}:${index}:${table ?? ''}`;
        const pending = timers.get(timerKey);
        // Coalesce bursts without postponing updates indefinitely during history sync.
        if (pending) return;
        timers.set(
          timerKey,
          setTimeout(() => {
            timers.delete(timerKey);
            for (const queryKey of queryKeys)
              void queryClient.invalidateQueries(
                { queryKey, refetchType: 'active' },
                { cancelRefetch: false },
              );
          }, REALTIME_INVALIDATION_DEBOUNCE_MS),
        );
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
        channels.forEach(({ channel, invalidate }) =>
          channel.subscribe((status) => {
            // Catch changes missed before subscribing or during a reconnect.
            if (status === 'SUBSCRIBED') invalidate();
          }),
        );
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
