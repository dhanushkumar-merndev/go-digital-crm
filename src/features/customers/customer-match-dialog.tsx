'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Link2, Plus, TriangleAlert, UserRoundSearch } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { fetchPossibleCustomerMatches, resolveLeadCustomer } from './customer-workspace-api';

export type MatchableLead = {
  id: string;
  customer_name: string;
  phone: string;
  email: string | null;
  updated_at: string;
};

export function CustomerMatchDialog({
  lead,
  open,
  canCreate,
  onOpenChange,
  onResolved,
}: {
  lead: MatchableLead | null;
  open: boolean;
  canCreate: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: (customerId: string) => void;
}) {
  const [resolution, setResolution] = useState<'LINK_EXISTING' | 'CREATE_NEW'>('LINK_EXISTING');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const matches = useQuery({
    queryKey: ['possible-customer-matches', lead?.id],
    queryFn: () => fetchPossibleCustomerMatches(lead!.id),
    enabled: open && Boolean(lead),
  });
  const effectiveResolution = matches.data?.length ? resolution : 'CREATE_NEW';
  const mutation = useMutation({
    mutationFn: resolveLeadCustomer,
    onSuccess: (result) => {
      onResolved(result.customer_id);
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review possible customer match</DialogTitle>
          <DialogDescription>
            Phone and email are matching signals only. Review the candidates, then explicitly link
            one or create a separate customer UUID.
          </DialogDescription>
        </DialogHeader>
        {lead && (
          <form
            className="mt-4 grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (effectiveResolution === 'LINK_EXISTING' && !selectedCustomerId) return;
              if (effectiveResolution === 'CREATE_NEW' && !canCreate) return;
              const form = new FormData(event.currentTarget);
              mutation.mutate({
                leadId: lead.id,
                expectedLeadUpdatedAt: lead.updated_at,
                resolution: effectiveResolution,
                reason: String(form.get('reason') ?? ''),
                requestId,
                customerId:
                  effectiveResolution === 'LINK_EXISTING' ? selectedCustomerId : undefined,
                newCustomer:
                  effectiveResolution === 'CREATE_NEW'
                    ? {
                        full_name: String(form.get('fullName') ?? ''),
                        primary_phone: String(form.get('phone') ?? ''),
                        primary_email: String(form.get('email') ?? ''),
                      }
                    : undefined,
              });
            }}
          >
            <Card className="shadow-none">
              <CardContent className="grid gap-1 p-4 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Lead customer</p>
                  <p className="font-semibold">{lead.customer_name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Phone</p>
                  <p className="font-semibold">{lead.phone}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="font-semibold">{lead.email ?? '—'}</p>
                </div>
              </CardContent>
            </Card>

            <section className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Possible existing customers</h3>
                  <p className="text-xs text-muted-foreground">
                    Only exact normalized phone or email matches are shown.
                  </p>
                </div>
                {matches.data && (
                  <Badge variant={matches.data.length ? 'warning' : 'success'}>
                    {matches.data.length} possible {matches.data.length === 1 ? 'match' : 'matches'}
                  </Badge>
                )}
              </div>
              {matches.isPending && (
                <div className="rounded-lg border p-5 text-sm text-muted-foreground">
                  Checking authorized customer records…
                </div>
              )}
              {matches.isError && (
                <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  Possible matches could not be loaded. No customer decision has been saved.
                </div>
              )}
              {matches.data?.map((match) => (
                <button
                  key={match.customer_id}
                  type="button"
                  aria-pressed={
                    resolution === 'LINK_EXISTING' && selectedCustomerId === match.customer_id
                  }
                  onClick={() => {
                    setResolution('LINK_EXISTING');
                    setSelectedCustomerId(match.customer_id);
                  }}
                  className={`flex w-full items-start justify-between gap-4 rounded-lg border p-4 text-left transition-colors ${
                    resolution === 'LINK_EXISTING' && selectedCustomerId === match.customer_id
                      ? 'border-blue-500 bg-blue-50/70'
                      : 'hover:bg-muted/40'
                  }`}
                >
                  <span className="flex gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-700">
                      <UserRoundSearch className="size-4" />
                    </span>
                    <span>
                      <span className="block font-semibold">{match.full_name}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {match.masked_phone ?? 'No phone'} · {match.masked_email ?? 'No email'}
                      </span>
                    </span>
                  </span>
                  <Badge variant="outline">{match.match_reason.replaceAll('_', ' ')}</Badge>
                </button>
              ))}
              {matches.data?.length === 0 && (
                <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                  No exact phone or email match was found. Create a new customer after confirming
                  the lead details.
                </div>
              )}
            </section>

            {canCreate && (
              <section className="grid gap-3">
                <Button
                  type="button"
                  variant={effectiveResolution === 'CREATE_NEW' ? 'default' : 'outline'}
                  className="justify-start"
                  onClick={() => setResolution('CREATE_NEW')}
                >
                  <Plus className="size-4" />
                  Create a separate customer UUID
                </Button>
                {effectiveResolution === 'CREATE_NEW' && (
                  <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
                      Customer name
                      <Input
                        name="fullName"
                        defaultValue={lead.customer_name}
                        minLength={2}
                        maxLength={160}
                        required
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Primary phone
                      <Input
                        name="phone"
                        defaultValue={lead.phone}
                        minLength={7}
                        maxLength={24}
                        inputMode="tel"
                        required
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Primary email
                      <Input
                        name="email"
                        defaultValue={lead.email ?? ''}
                        type="email"
                        maxLength={254}
                      />
                    </label>
                  </div>
                )}
              </section>
            )}

            <label className="grid gap-1.5 text-sm font-medium">
              Decision reason <span className="text-destructive">(required)</span>
              <Input
                name="reason"
                minLength={3}
                maxLength={500}
                required
                placeholder={
                  effectiveResolution === 'LINK_EXISTING'
                    ? 'How you verified this customer match'
                    : 'Why this should remain a separate customer'
                }
              />
            </label>
            {mutation.isError && (
              <p className="text-sm text-destructive">
                The customer decision could not be saved. The lead may have changed or the selected
                record may no longer be a valid possible match. Refresh the lead list and review it
                again.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  matches.isPending ||
                  matches.isError ||
                  mutation.isPending ||
                  (effectiveResolution === 'LINK_EXISTING' && !selectedCustomerId) ||
                  (effectiveResolution === 'CREATE_NEW' && !canCreate)
                }
              >
                {mutation.isPending ? (
                  'Saving…'
                ) : effectiveResolution === 'LINK_EXISTING' ? (
                  <>
                    <Link2 className="size-4" /> Link existing customer
                  </>
                ) : (
                  <>
                    <Plus className="size-4" /> Create and link customer
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
