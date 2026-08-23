'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import { QUERY_GC_TIME_MS, QUERY_STALE_TIME_MS } from '@/lib/query/cache-policy';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
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
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
