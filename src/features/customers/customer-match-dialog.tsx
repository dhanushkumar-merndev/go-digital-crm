'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Link2, Plus, TriangleAlert } from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { createUuid } from '@/lib/uuid';
import { fetchPossibleCustomerMatches, resolveLeadCustomer } from './customer-workspace-api';

// resolve_lead_customer requires a 3-500 character reason on every decision, so
// the no-candidate path states the fact instead of dropping the audit value.
const NO_MATCH_REASON = 'No exact phone or email match was found for this lead.';
// Linking is the common case for a repeat enquiry, so its reason starts filled
// in. It is still an editable, audited statement, never a silent default.
const LINK_REASON = 'Same phone number; confirmed this is the same customer.';
const CREATE_NEW_CHOICE = 'CREATE_NEW';

function formatEnquiryDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function ChoiceIndicator({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${
        selected ? 'border-blue-600' : 'border-slate-300'
      }`}
    >
      {selected ? <span className="size-2 rounded-full bg-blue-600" /> : null}
    </span>
  );
}

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
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  // Null until the user picks. Defaulting to "create" is how one phone number
  // ended up as four customers: the candidates were shown but never chosen.
  const [choice, setChoice] = useState<string | null>(null);
  const [requestId] = useState(createUuid);
  const matches = useQuery({
    queryKey: ['possible-customer-matches', ...queryScope, lead?.id],
    queryFn: ({ signal }) => fetchPossibleCustomerMatches(lead!.id, signal),
    enabled: open && Boolean(lead),
  });
  // With no candidate there is nothing to review and nothing that could be
  // merged, so the screen stops asking the telecaller to justify a choice they
  // were never offered. AGENTS.md 11 governs the case where a match exists.
  const nothingToReview = matches.data?.length === 0;
  const effectiveChoice = nothingToReview ? CREATE_NEW_CHOICE : choice;
  const effectiveResolution: 'LINK_EXISTING' | 'CREATE_NEW' | null =
    effectiveChoice === null
      ? null
      : effectiveChoice === CREATE_NEW_CHOICE
        ? 'CREATE_NEW'
        : 'LINK_EXISTING';
  const selectedCustomerId =
    effectiveResolution === 'LINK_EXISTING' ? (effectiveChoice as string) : '';
  const selectedMatch = matches.data?.find((match) => match.customer_id === selectedCustomerId);
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
          <DialogTitle>
            {nothingToReview ? 'Create customer' : 'Review possible customer match'}
          </DialogTitle>
          <DialogDescription>
            {nothingToReview
              ? 'No existing customer shares this phone or email, so this enquiry starts a new customer UUID. Confirm the details below.'
              : 'Phone and email are matching signals only. Review the candidates, then explicitly link one or create a separate customer UUID.'}
          </DialogDescription>
        </DialogHeader>
        {lead && (
          <form
            className="mt-4 grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!effectiveResolution) return;
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
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Email</p>
                  {lead.email ? (
                    // Long addresses overflowed the card; cap at 15ch and show
                    // the full address on hover or keyboard focus.
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p tabIndex={0} className="max-w-[15ch] truncate font-semibold">
                          {lead.email}
                        </p>
                      </TooltipTrigger>
                      <TooltipContent side="top">{lead.email}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <p className="font-semibold">—</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <section className={`grid gap-3 ${nothingToReview ? 'hidden' : ''}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Is this one of these customers?</h3>
                  <p className="text-xs text-muted-foreground">
                    They share this lead&apos;s phone or email. Link the enquiry to the right one so
                    all their leads stay in one Customer 360.
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
              <div role="radiogroup" aria-label="Customer decision" className="grid gap-2">
                {matches.data?.map((match) => {
                  const selected = choice === match.customer_id;
                  const latestDate = formatEnquiryDate(match.latest_enquiry_at);
                  return (
                    <button
                      key={match.customer_id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setChoice(match.customer_id)}
                      className={`flex w-full items-start justify-between gap-4 rounded-lg border p-4 text-left transition-colors ${
                        selected ? 'border-blue-500 bg-blue-50/70' : 'hover:bg-muted/40'
                      }`}
                    >
                      <span className="flex min-w-0 gap-3">
                        <ChoiceIndicator selected={selected} />
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-blue-700">
                            Link to this customer
                          </span>
                          <span className="block truncate font-semibold">{match.full_name}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {match.masked_phone ?? 'No phone'} · {match.masked_email ?? 'No email'}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {match.lead_count} {match.lead_count === 1 ? 'lead' : 'leads'}
                            {match.latest_interested_model
                              ? ` · latest: ${match.latest_interested_model}`
                              : ''}
                            {latestDate ? ` · ${latestDate}` : ''}
                          </span>
                        </span>
                      </span>
                      <Badge variant="outline" className="shrink-0">
                        {match.match_reason.replaceAll('_', ' ')}
                      </Badge>
                    </button>
                  );
                })}
                {canCreate && matches.data && matches.data.length > 0 ? (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={choice === CREATE_NEW_CHOICE}
                    onClick={() => setChoice(CREATE_NEW_CHOICE)}
                    className={`flex w-full items-start gap-3 rounded-lg border border-dashed p-4 text-left transition-colors ${
                      choice === CREATE_NEW_CHOICE
                        ? 'border-blue-500 bg-blue-50/70'
                        : 'hover:bg-muted/40'
                    }`}
                  >
                    <ChoiceIndicator selected={choice === CREATE_NEW_CHOICE} />
                    <span>
                      <span className="block font-semibold">Create a separate customer</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Only when this is a different person who shares the number, such as a family
                        member or an office line.
                      </span>
                    </span>
                  </button>
                ) : null}
              </div>
              {matches.data?.length === 0 && (
                <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                  No exact phone or email match was found. Create a new customer after confirming
                  the lead details.
                </div>
              )}
            </section>

            {canCreate && effectiveResolution === 'CREATE_NEW' && (
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

            {nothingToReview ? (
              <>
                <input type="hidden" name="reason" value={NO_MATCH_REASON} />
                <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Recorded on the customer decision audit trail as: {NO_MATCH_REASON}
                </p>
              </>
            ) : (
              <label
                className={`grid gap-1.5 text-sm font-medium ${effectiveResolution ? '' : 'hidden'}`}
              >
                Decision reason <span className="text-destructive">(required)</span>
                <Input
                  // Remount on a change of decision so the prefilled link
                  // reason never carries over into a create-new decision.
                  key={effectiveResolution ?? 'none'}
                  name="reason"
                  defaultValue={effectiveResolution === 'LINK_EXISTING' ? LINK_REASON : ''}
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
            )}
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
                  !effectiveResolution ||
                  (effectiveResolution === 'LINK_EXISTING' && !selectedCustomerId) ||
                  (effectiveResolution === 'CREATE_NEW' && !canCreate)
                }
              >
                {mutation.isPending ? (
                  'Saving…'
                ) : !effectiveResolution ? (
                  'Choose a customer above'
                ) : effectiveResolution === 'LINK_EXISTING' ? (
                  <>
                    <Link2 className="size-4" /> Link to {selectedMatch?.full_name ?? 'customer'}
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
