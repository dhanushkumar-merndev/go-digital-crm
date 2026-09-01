'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useWorkspaceSession } from '@/components/providers/workspace-session-provider';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';

export function SessionExpiryGuard() {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    if (!session?.sessionExpiresAt || !hasSupabaseConfig()) return;

    const expiresAt = Date.parse(session.sessionExpiresAt);
    if (!Number.isFinite(expiresAt)) return;

    let expiring = false;
    const expireSession = () => {
      if (expiring || Date.now() < expiresAt) return;
      expiring = true;
      queryClient.clear();
      void createClient()
        .auth.signOut({ scope: 'local' })
        .finally(() => {
          router.replace('/login?reason=session-expired');
          router.refresh();
        });
    };

    const timer = window.setTimeout(expireSession, Math.max(0, expiresAt - Date.now()));
    const checkVisibleSession = () => {
      if (document.visibilityState === 'visible') expireSession();
    };
    document.addEventListener('visibilitychange', checkVisibleSession);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', checkVisibleSession);
    };
  }, [queryClient, router, session?.sessionExpiresAt]);

  return null;
}
