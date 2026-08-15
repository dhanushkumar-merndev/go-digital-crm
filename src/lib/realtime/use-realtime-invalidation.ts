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
};

type PlatformSubscription = {
  resource: PlatformRealtimeResource;
  queryKeys: QueryKey[];
};

function stableSubscriptions<T extends TenantSubscription | PlatformSubscription>(items: T[]) {
  return JSON.stringify(
    items.map((item) => ({ resource: item.resource, queryKeys: item.queryKeys })),
  );
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
    const channels = stableItems.map((subscription) => {
      const invalidate = () => {
        for (const queryKey of subscription.queryKeys)
          void queryClient.invalidateQueries({ queryKey });
      };
      return supabase
        .channel(tenantRealtimeTopic(organizationId, subscription.resource), {
          config: { private: true },
        })
        .on('broadcast', { event: 'insert' }, invalidate)
        .on('broadcast', { event: 'update' }, invalidate);
    });
    let cancelled = false;
    void supabase.realtime.setAuth().then(() => {
      if (!cancelled) channels.forEach((channel) => channel.subscribe());
    });
    return () => {
      cancelled = true;
      channels.forEach((channel) => void supabase.removeChannel(channel));
    };
  }, [organizationId, queryClient, stableItems]);
}

export function usePlatformRealtimeInvalidation(subscriptions: PlatformSubscription[]) {
  const queryClient = useQueryClient();
  const stableKey = stableSubscriptions(subscriptions);
  const stableItems = useMemo(() => JSON.parse(stableKey) as PlatformSubscription[], [stableKey]);

  useEffect(() => {
    const supabase = createClient();
    const channels = stableItems.map((subscription) => {
      const invalidate = () => {
        for (const queryKey of subscription.queryKeys)
          void queryClient.invalidateQueries({ queryKey });
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
      channels.forEach((channel) => void supabase.removeChannel(channel));
    };
  }, [queryClient, stableItems]);
}
