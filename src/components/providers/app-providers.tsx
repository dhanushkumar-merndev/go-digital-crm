'use client';

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast, Toaster } from '@/components/ui/toast';
import { QUERY_GC_TIME_MS, QUERY_STALE_TIME_MS } from '@/lib/query/cache-policy';
import { clearPersistedQueries } from '@/lib/query/persisted-query';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';
import { installRandomUuidFallback } from '@/lib/uuid';
import { TooltipProvider } from '@/components/ui/tooltip';

export function AppProviders({ children }: { children: React.ReactNode }) {
  // Run during render rather than an effect: client children can allocate a
  // request UUID on their first render.
  installRandomUuidFallback();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Only failures are toasted globally. A success is visible in the page
        // itself, and a generic "Saved successfully" on every send or save was
        // noise. Individual mutations can set `meta: { toast: false }` to show
        // their own error instead, but failures are never left silent.
        mutationCache: new MutationCache({
          onError: (error, _variables, _context, mutation) => {
            const meta = mutation.options.meta as
              { toast?: boolean; errorToastDescription?: boolean } | undefined;
            if (meta?.toast === false) return;
            toast.add({
              type: 'error',
              priority: 'high',
              title: 'Could not save changes',
              description:
                meta?.errorToastDescription && error instanceof Error
                  ? error.message
                  : 'Please review the details and try again.',
            });
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: QUERY_STALE_TIME_MS,
            gcTime: QUERY_GC_TIME_MS,
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
            retry: 1,
          },
        },
      }),
  );

  const activeUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type === 'observerAdded') {
          const queryKeyStr = JSON.stringify(event.query.queryKey);
          if (event.query.state.data) {
            console.log(`[Cache] ⚡ Tanstack Cache hit: ${queryKeyStr}`);
          }
        } else if (event.type === 'updated' && event.action?.type === 'success') {
          console.log(`[Cache] 🔄 Data fetched/updated: ${JSON.stringify(event.query.queryKey)}`);
        }
      });
      return () => unsubscribe();
    }
  }, [queryClient]);

  useEffect(() => {
    if (!hasSupabaseConfig()) return;

    const supabase = createClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const nextUserId = session?.user.id ?? null;
      const userChanged = activeUserId.current !== undefined && activeUserId.current !== nextUserId;

      if (event === 'SIGNED_OUT' || userChanged) {
        queryClient.clear();
        void clearPersistedQueries();
      }
      activeUserId.current = nextUserId;
    });

    return () => subscription.unsubscribe();
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250} skipDelayDuration={100}>
        {children}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
