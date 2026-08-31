'use client';

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast, Toaster } from '@/components/ui/toast';
import { QUERY_GC_TIME_MS, QUERY_STALE_TIME_MS } from '@/lib/query/cache-policy';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';
import { TooltipProvider } from '@/components/ui/tooltip';

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Every user-triggered mutation gets the same concise feedback as the
        // sign-in screen. Individual mutations can set `meta: { toast: false
        // }` when a custom confirmation is genuinely needed, but silent
        // mutation failures are never left as an inline red block on a form.
        mutationCache: new MutationCache({
          onSuccess: (_data, _variables, _context, mutation) => {
            if ((mutation.options.meta as { toast?: boolean } | undefined)?.toast === false) return;
            toast.add({
              type: 'success',
              title: 'Saved successfully',
              description: 'Your changes have been applied.',
            });
          },
          onError: (_error, _variables, _context, mutation) => {
            if ((mutation.options.meta as { toast?: boolean } | undefined)?.toast === false) return;
            toast.add({
              type: 'error',
              priority: 'high',
              title: 'Could not save changes',
              description: 'Please review the details and try again.',
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

      if (event === 'SIGNED_OUT' || userChanged) queryClient.clear();
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
