'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Check,
  Copy,
  Link2,
  MessageSquareText,
  Search,
  Send,
  Star,
} from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  fetchWhatsAppReplyTemplates,
  resolveInboxReviewTemplate,
  sendInboxWhatsAppMessage,
  sendInboxWhatsAppTemplate,
} from '@/features/inbox/inbox-api';
import { personalWhatsAppReason } from '@/features/inbox/personal-whatsapp-api';
import {
  leadWhatsAppErrorMessage,
  openLeadWhatsAppConversation,
  type LeadWhatsAppChannel,
} from '@/features/leads/lead-whatsapp-api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatNationalPhone, toDialableDigits } from '@/lib/phone';
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

/** WhatsApp goes out from the CRM itself, on the same chats the Inbox shows. */
type ShareChannel = LeadWhatsAppChannel | 'SMS' | 'LINK';

const channels: Array<{
  value: ShareChannel;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { value: 'WHATSAPP_PERSONAL', label: 'My WhatsApp', icon: WhatsAppIcon },
  { value: 'WHATSAPP_BUSINESS', label: 'Official WhatsApp', icon: BadgeCheck },
  { value: 'SMS', label: 'SMS', icon: MessageSquareText },
  { value: 'LINK', label: 'Copy link', icon: Link2 },
];

const recordedChannel = (channel: ShareChannel): ReviewChannel =>
  channel === 'SMS' || channel === 'LINK' ? channel : 'WHATSAPP';

const isWhatsApp = (channel: ShareChannel): channel is LeadWhatsAppChannel =>
  channel === 'WHATSAPP_PERSONAL' || channel === 'WHATSAPP_BUSINESS';

// The previous personal send is still settling, or the short send gap is
// running: the same message is retried under the same key, as in the Inbox.
const RETRYABLE_SEND = [
  'NETWORK_UNAVAILABLE',
  'PERSONAL_WHATSAPP_SEND_UNRESOLVED',
  'PERSONAL_WHATSAPP_RATE_LIMITED',
];

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens (or reuses) the lead's chat on the chosen WhatsApp and sends the review
 * message there, so it lands in the Inbox thread. Official WhatsApp outside the
 * 24-hour window accepts only a template, so the admin's review template goes.
 */
async function sendReviewOnWhatsApp(input: {
  organizationId: string;
  leadId: string;
  channel: LeadWhatsAppChannel;
  message: string;
  link: string;
}) {
  const { conversation_id: conversationId } = await openLeadWhatsAppConversation({
    leadId: input.leadId,
    channel: input.channel,
  });
  if (input.channel === 'WHATSAPP_BUSINESS') {
    const state = await fetchWhatsAppReplyTemplates(conversationId);
    if (!state.window_open) {
      const template = await resolveInboxReviewTemplate(conversationId, input.link);
      if (!template.configured) throw new Error('REVIEW_TEMPLATE_NOT_CONFIGURED');
      await sendInboxWhatsAppTemplate({
        organizationId: input.organizationId,
        conversationId,
        expectedLeadId: input.leadId,
        templateId: template.template_id,
        variables: template.variables,
        applicationMessageId: crypto.randomUUID(),
      });
      return 'TEMPLATE' as const;
    }
  }
  const applicationMessageId = crypto.randomUUID();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sendInboxWhatsAppMessage({
        organizationId: input.organizationId,
        conversationId,
        expectedLeadId: input.leadId,
        body: input.message,
        applicationMessageId,
      });
      return 'TEXT' as const;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!RETRYABLE_SEND.includes(code) || attempt >= 4) throw error;
      await wait(1500);
    }
  }
}

function whatsAppFailureMessage(error: unknown) {
  const code = error instanceof Error ? error.message : String(error ?? '');
  if (code === 'REVIEW_TEMPLATE_NOT_CONFIGURED')
    return 'The 24-hour reply window is closed and no review template is set. Ask your admin to choose one under Integrations → WhatsApp, or send it on My WhatsApp.';
  if (code === 'INVALID_REVIEW_LINK')
    return 'Review links can only be sent from the live CRM address.';
  if (code.startsWith('PERSONAL_WHATSAPP_') && code !== 'PERSONAL_WHATSAPP_NOT_CONNECTED')
    return personalWhatsAppReason(code) ?? 'My WhatsApp is unavailable. Try again.';
  if (code === 'WHATSAPP_TEMPLATE_REQUIRED')
    return 'The WhatsApp reply window has closed. Try again to send the review template.';
  if (
    code.includes('PERSONAL_WHATSAPP_NOT_CONNECTED') ||
    code.includes('WHATSAPP_CONNECTION_UNAVAILABLE') ||
    code.includes('LEAD_PHONE_INVALID') ||
    code.includes('MESSAGE_SEND_PERMISSION_REQUIRED')
  )
    return leadWhatsAppErrorMessage(error);
  return 'The review link was not sent. Check the WhatsApp connection and try again.';
}

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
    // The last results stay up while the next search loads, so the list does
    // not collapse to a one-line "Loading…" on every keystroke.
    placeholderData: keepPreviousData,
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
      {/* Fixed height: the dialog is centred, so a list that grew and shrank
          with each search moved the search box up and down while typing. */}
      <div
        className={cn(
          'h-64 divide-y overflow-y-auto rounded-md border transition-opacity',
          leads.isPlaceholderData && 'opacity-60',
        )}
        aria-busy={leads.isFetching}
      >
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
  onSent,
}: {
  created: CreatedReviewRequest;
  channel: ShareChannel;
  onSent: () => void;
}) {
  const session = useWorkspaceSession();
  const link = reviewLinkFor(created.token);
  const [message, setMessage] = useState(() => reviewRequestMessage(created, link));
  const [copied, setCopied] = useState(false);
  const digits = created.phone ? toDialableDigits(created.phone) : '';
  const whatsApp = isWhatsApp(channel) ? channel : null;
  const personal = whatsApp === 'WHATSAPP_PERSONAL';
  const send = useMutation({
    meta: { toast: false },
    mutationFn: () => {
      if (!whatsApp || !session?.organizationId) throw new Error('MESSAGE_SEND_FAILED');
      return sendReviewOnWhatsApp({
        organizationId: session.organizationId,
        leadId: created.lead_id,
        channel: whatsApp,
        message: message.trim(),
        link,
      });
    },
    onSuccess: (mode) => {
      toast.add({
        type: 'success',
        title: 'Review link sent',
        description:
          mode === 'TEMPLATE'
            ? 'Sent as the review template, since the 24-hour window is closed. It is in the Inbox chat.'
            : `Sent from ${personal ? 'My WhatsApp' : 'Official WhatsApp'}. It is in the Inbox chat.`,
      });
      onSent();
    },
  });
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
          rows={5}
          className="break-words"
          value={message}
          maxLength={1000}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
        <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-mono break-all select-all">{link}</span>
      </div>
      {whatsApp === 'WHATSAPP_BUSINESS' ? (
        <p className="text-xs text-muted-foreground">
          If the customer has not messaged in the last 24 hours, WhatsApp allows only an approved
          template, so your admin&apos;s review template goes instead of this text.
        </p>
      ) : null}
      {send.isError ? (
        <p className="text-sm text-destructive">{whatsAppFailureMessage(send.error)}</p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />} {channel === 'LINK' ? 'Copy link' : 'Copy message'}
        </Button>
        {whatsApp ? (
          <Button
            type="button"
            disabled={send.isPending || !message.trim()}
            onClick={() => send.mutate()}
          >
            {personal ? <WhatsAppIcon className="size-4" /> : <Send />}
            {send.isPending
              ? 'Sending…'
              : personal
                ? 'Send on My WhatsApp'
                : 'Send on Official WhatsApp'}
          </Button>
        ) : null}
        {channel === 'SMS' && digits ? (
          <Button asChild>
            <a href={`sms:+${digits}?body=${encodeURIComponent(message)}`}>
              <MessageSquareText /> Open SMS
            </a>
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

/**
 * Sends a customer the review link: pick a lead (unless one is given), pick
 * how it goes out, and the link is created. My WhatsApp and Official WhatsApp
 * send from the CRM into the lead's Inbox chat; SMS and copy are manual, so for
 * those the CRM records only that a link was issued.
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
  const [channel, setChannel] = useState<ShareChannel>('WHATSAPP_PERSONAL');
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
      <DialogContent>
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
          <ShareStep created={create.data} channel={channel} onSent={() => reset(false)} />
        ) : target ? (
          <div className="space-y-4">
            <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Send by">
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
                onClick={() =>
                  create.mutate({ leadId: target.leadId, channel: recordedChannel(channel) })
                }
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
