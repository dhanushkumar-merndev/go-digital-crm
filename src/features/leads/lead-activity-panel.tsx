'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';

const pageSchema = z.object({
  total: z.coerce.number(),
  records: z.array(
    z.object({
      id: z.uuid(),
      label: z.string(),
      status: z.string(),
      occurred_at: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  ),
});

export function LeadActivityPanel({
  leadId,
  kind,
}: {
  leadId: string;
  kind: 'calls' | 'followups' | 'appointments';
}) {
  const session = useWorkspaceSession();
  const scope = workspaceQueryScope(session);
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['lead-activity', ...scope, leadId, kind, page],
    queryFn: async ({ signal }) => {
      const { data, error } = await createClient()
        .rpc('get_lead_activity_page', {
          target_lead_id: leadId,
          target_kind: kind,
          target_page: page,
        })
        .abortSignal(signal);
      if (error) throw error;
      return pageSchema.parse(data);
    },
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    {
      resource: kind === 'calls' ? 'communications' : 'work',
      queryKeys: [['lead-activity', ...scope, leadId]],
    },
  ]);
  const pages = Math.max(1, Math.ceil((query.data?.total ?? 0) / 25));
  return (
    <Card className="overflow-hidden shadow-none">
      {query.isPending ? (
        <p className="p-8 text-sm text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <div className="p-8">
          <p role="alert">Could not load this lead’s activities.</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.data.records.length ? (
        <div className="divide-y">
          {query.data.records.map((row) => (
            <div key={row.id} className="flex items-start justify-between gap-3 px-5 py-4">
              <div>
                <p className="text-sm font-semibold">{row.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {row.occurred_at
                    ? new Date(row.occurred_at).toLocaleString('en-IN')
                    : 'Time not recorded'}
                </p>
                {row.detail && (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {row.detail}
                  </p>
                )}
              </div>
              <StatusBadge value={row.status} />
            </div>
          ))}
        </div>
      ) : (
        <p className="p-10 text-center text-sm text-muted-foreground">
          No {kind === 'followups' ? 'follow-ups' : kind} for this lead.
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t p-3 text-xs text-muted-foreground">
        <span>{query.data?.total ?? 0} records · 25 per page</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || query.isFetching}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span>
            {page}/{pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages || query.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </Card>
  );
}
