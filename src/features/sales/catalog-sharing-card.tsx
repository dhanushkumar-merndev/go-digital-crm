'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { fetchCatalogSharing, setCatalogSharing } from './competitor-comparison-api';

export function CatalogSharingCard() {
  const session = useWorkspaceSession();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: ['vehicle-catalog-sharing', ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchCatalogSharing(signal),
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: () => setCatalogSharing(!query.data!.enabled, query.data!.version),
    onSuccess: async () => {
      setConfirm(false);
      await client.invalidateQueries({
        queryKey: ['vehicle-catalog-sharing', ...workspaceQueryScope(session)],
      });
      client.removeQueries({ queryKey: ['vehicle-comparison', ...workspaceQueryScope(session)] });
      await client.invalidateQueries({
        queryKey: ['comparison-vehicles', ...workspaceQueryScope(session)],
      });
      toast.add({ title: 'Catalog sharing updated', type: 'success' });
    },
    onError: () => {
      toast.add({ title: 'Could not change sharing. Refresh and try again.', type: 'error' });
      void query.refetch();
    },
  });
  if (query.isPending) return <div className="h-20 animate-pulse rounded-lg bg-muted" />;
  if (!query.data || query.isError)
    return (
      <Card>
        <CardContent className="flex items-center justify-between p-4 text-sm">
          Sharing status unavailable
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  const enabled = query.data.enabled;
  return (
    <>
      <Card className="shadow-none">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold">
              Vehicle catalog sharing{' '}
              <Badge variant={enabled ? 'success' : 'secondary'}>
                {enabled ? 'Shared with dealerships' : 'Private'}
              </Badge>
            </p>
            <p className="text-sm text-muted-foreground">
              {enabled
                ? 'All current and future active models are shared. Compare with other participating dealerships.'
                : 'Compare your own models only. Owner consent unlocks shared dealership models.'}
            </p>
          </div>
          {query.data.can_manage ? (
            <Button variant="outline" onClick={() => setConfirm(true)}>
              {enabled ? 'Make private' : 'Enable sharing'}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!mutation.isPending) setConfirm(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {enabled ? 'Make your catalog private?' : 'Share your vehicle catalog?'}
            </DialogTitle>
            <DialogDescription>
              {enabled
                ? 'Your models will disappear from other dealerships’ comparisons. Your organization can then compare only its own models.'
                : 'I agree to share our dealership name and all current and future active vehicle model and variant specifications with other opted-in dealerships for comparison. Updates are shared automatically. This is not public internet access.'}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Specifications include the public ex-showroom price. Leads, customers, bookings, stock,
            insurance/registration pricing and competitor notes stay private. You can withdraw
            sharing anytime; information already viewed cannot be recalled.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </Button>
            <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending
                ? 'Saving…'
                : enabled
                  ? 'Make private'
                  : 'I agree — share all models'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
