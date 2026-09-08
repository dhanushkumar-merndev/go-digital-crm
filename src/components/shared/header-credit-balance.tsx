'use client';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { Coins } from 'lucide-react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';

export function HeaderCreditBalance() {
  const session = useWorkspaceSession();
  const query = useQuery({
    queryKey: ['header-credit-balance', ...workspaceQueryScope(session)],
    enabled: Boolean(session?.organizationId),
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const { data, error } = await createClient().rpc('get_my_credit_balance').abortSignal(signal);
      if (error) throw error;
      return z.object({ ai: z.coerce.number(), tracking: z.coerce.number() }).parse(data);
    },
  });
  if (!session?.organizationId) return null;
  return (
    <Badge
      variant="outline"
      className="gap-1.5 whitespace-nowrap"
      title={
        query.isError
          ? 'Credit balance unavailable'
          : 'Organization balance · AI ' +
            (query.data?.ai ?? '…') +
            ' · Tracking ' +
            (query.data?.tracking ?? '…')
      }
    >
      <Coins className="size-3.5" />
      AI {query.isError ? '—' : (query.data?.ai.toLocaleString() ?? '…')}
    </Badge>
  );
}
