'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { syncProviderLeads } from './integration-workspace-api';

// Pulls leads the webhook missed, e.g. while the Meta app is unpublished.
// Synced leads run through the same dispatcher as webhook leads.
export function MetaLeadSyncCard({
  organizationId,
  connectionId,
}: {
  organizationId: string;
  connectionId: string;
}) {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => syncProviderLeads(organizationId, connectionId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['integration-workspace'] }),
  });
  const result = sync.data;

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium">Sync leads</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Pull the last 7 days of leads from this Page&apos;s lead forms. Leads already received
            are skipped.
          </p>
        </div>
        <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
          <Download className="size-4" />
          {sync.isPending ? 'Syncing…' : 'Sync leads'}
        </Button>
      </div>
      {result && (
        <p className="text-sm">
          {result.queued > 0
            ? `${result.queued} new lead${result.queued === 1 ? '' : 's'} queued; they appear in the CRM within a minute.`
            : 'No new leads.'}{' '}
          <span className="text-muted-foreground">
            {result.found} found across {result.forms} form{result.forms === 1 ? '' : 's'}
            {result.already_received > 0 && `, ${result.already_received} already received`}
            {result.truncated && '; limit reached, sync again for more'}.
          </span>
        </p>
      )}
      {sync.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {sync.error instanceof Error ? sync.error.message : 'Leads could not be synced.'}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
