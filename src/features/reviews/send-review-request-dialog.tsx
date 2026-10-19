'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, MessageSquareText, Search, Star } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatNationalPhone, toDialableDigits, toWhatsAppClickToChatUrl } from '@/lib/phone';
import { cn } from '@/lib/utils';
import {
  createReviewRequest,
  getReviewRequestErrorMessage,
  reviewLinkFor,
  reviewRequestKeys,
  reviewRequestMessage,
  searchReviewLeads,
  type CreatedReviewRequest,
  type ReviewChannel,
} from './review-request-api';

export type ReviewTarget = {
  leadId: string;
  customerName: string;
  phone?: string | null;
};

const channels: Array<{
  value: ReviewChannel;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { value: 'WHATSAPP', label: 'WhatsApp', icon: WhatsAppIcon },
  { value: 'SMS', label: 'SMS', icon: MessageSquareText },
  { value: 'LINK', label: 'Copy link', icon: Link2 },
];

function LeadPicker({ onPick }: { onPick: (target: ReviewTarget) => void }) {
  const session = useWorkspaceSession();
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(term.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [term]);
  const leads = useQuery({
    queryKey: reviewRequestKeys.picker(workspaceQueryScope(session), search),
    queryFn: ({ signal }) => searchReviewLeads(search, signal),
    staleTime: 30_000,
  });
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search your leads by name or phone"
          className="pl-8"
          aria-label="Search your leads"
        />
      </div>
      <div className="max-h-64 divide-y overflow-y-auto rounded-md border">
        {leads.isPending ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : leads.isError ? (
          <p className="p-3 text-sm text-destructive">Your leads could not be loaded.</p>
        ) : leads.data.length ? (
          leads.data.map((lead) => (
            <button
              key={lead.lead_id}
              type="button"
              onClick={() =>
                onPick({
                  leadId: lead.lead_id,
                  customerName: lead.customer_name ?? 'Customer',
                  phone: lead.phone,
                })
              }
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/60"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{lead.customer_name ?? 'Lead'}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[lead.phone && formatNationalPhone(lead.phone), lead.interested_model]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>
          ))
        ) : (
          <p className="p-3 text-sm text-muted-foreground">No leads match.</p>
        )}
      </div>
    </div>
  );
}

function ShareStep({
  created,
  channel,
}: {
  created: CreatedReviewRequest;
  channel: ReviewChannel;
}) {
  const link = reviewLinkFor(created.token);
  const [message, setMessage] = useState(() => reviewRequestMessage(created, link));
  const [copied, setCopied] = useState(false);
  const digits = created.phone ? toDialableDigits(created.phone) : '';
  const copy = () =>
    navigator.clipboard?.writeText(channel === 'LINK' ? link : message).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {created.reused
          ? 'This lead already had an open request, so its link was renewed. The old link no longer works.'
          : 'Link ready. It works once and expires in 14 days.'}
      </p>
      <label className="grid gap-1.5 text-sm font-medium">
        Message
        <Textarea
          rows={4}
          value={message}
          maxLength={1000}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
        <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">{link}</span>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />} {channel === 'LINK' ? 'Copy link' : 'Copy message'}
        </Button>
        {channel === 'WHATSAPP' && digits ? (
          <Button asChild>
            <a
              href={`${toWhatsAppClickToChatUrl(created.phone ?? '')}?text=${encodeURIComponent(message)}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              <WhatsAppIcon className="size-4" /> Open WhatsApp
            </a>
          </Button>
        ) : null}
        {channel === 'SMS' && digits ? (
          <Button asChild>
            <a href={`sms:+${digits}?body=${encodeURIComponent(message)}`}>
              <MessageSquareText /> Open SMS
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Sends a customer the review link: pick a lead (unless one is given), pick
 * how it goes out, and the link is created and handed to WhatsApp, SMS or the
 * clipboard. Sending is manual, so the CRM records that a link was issued, not
 * that a message was delivered.
 */
export function SendReviewRequestDialog({
  open,
  onOpenChange,
  target: initialTarget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: ReviewTarget | null;
}) {
  const client = useQueryClient();
  const [target, setTarget] = useState<ReviewTarget | null>(initialTarget ?? null);
  const [channel, setChannel] = useState<ReviewChannel>('WHATSAPP');
  const create = useMutation({
    meta: { toast: false },
    mutationFn: createReviewRequest,
    onSuccess: () => void client.invalidateQueries({ queryKey: reviewRequestKeys.all }),
  });
  const reset = (next: boolean) => {
    if (!next) {
      create.reset();
      setTarget(initialTarget ?? null);
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="size-4 fill-amber-400 text-amber-400" /> Ask for a review
          </DialogTitle>
          <DialogDescription>
            {target
              ? `${target.customerName}${target.phone ? ` · ${formatNationalPhone(target.phone)}` : ''}`
              : 'Pick one of your leads. The customer rates the visit, writes a line, and is taken to your Google review page.'}
          </DialogDescription>
        </DialogHeader>
        {create.data ? (
          <ShareStep created={create.data} channel={channel} />
        ) : target ? (
          <div className="space-y-4">
            <fieldset className="grid grid-cols-3 gap-2" aria-label="Send by">
              {channels.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={channel === value}
                  onClick={() => setChannel(value)}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs font-medium',
                    channel === value
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'text-muted-foreground hover:border-primary/40',
                  )}
                >
                  <Icon className="size-5" />
                  {label}
                </button>
              ))}
            </fieldset>
            {create.isError ? (
              <p className="text-sm text-destructive">
                {getReviewRequestErrorMessage(create.error)}
              </p>
            ) : null}
            <div className="flex justify-between gap-2">
              {initialTarget ? (
                <span />
              ) : (
                <Button type="button" variant="ghost" onClick={() => setTarget(null)}>
                  Change lead
                </Button>
              )}
              <Button
                type="button"
                disabled={create.isPending}
                onClick={() => create.mutate({ leadId: target.leadId, channel })}
              >
                {create.isPending ? 'Creating link…' : 'Create review link'}
              </Button>
            </div>
          </div>
        ) : (
          <LeadPicker onPick={setTarget} />
        )}
      </DialogContent>
    </Dialog>
  );
}
