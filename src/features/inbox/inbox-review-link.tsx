'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import {
  createReviewRequest,
  getReviewRequestErrorMessage,
  reviewLinkFor,
  reviewRequestKeys,
  reviewRequestMessage,
} from '@/features/reviews/review-request-api';
import {
  resolveInboxReviewTemplate,
  sendInboxWhatsAppTemplate,
  type InboxConversation,
} from './inbox-api';

function failureMessage(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'REVIEW_TEMPLATE_NOT_CONFIGURED')
    return 'The 24-hour reply window is closed and no review template is set. Ask your admin to choose one under Integrations → WhatsApp.';
  if (code === 'INVALID_REVIEW_LINK')
    return 'Review links can only be sent from the live CRM address.';
  if (code.startsWith('REVIEW_')) return getReviewRequestErrorMessage(error);
  return 'The review link was not sent. Try again in a moment.';
}

/**
 * One click to ask the customer in this chat for a Google review. The link is
 * the same signed, single-use form as "Ask for a review" on My Leads. It goes as
 * a normal message on personal WhatsApp or inside Official WhatsApp's 24-hour
 * window; outside it, as the template the Client Admin chose for reviews.
 */
export function InboxReviewLinkButton({
  conversation,
  leadId,
  organizationId,
  personal,
  windowOpen,
  disabled,
  onSendText,
  onTemplateSent,
}: {
  conversation: InboxConversation;
  leadId: string;
  organizationId: string;
  personal: boolean;
  /** Official WhatsApp only; undefined while the window check loads. */
  windowOpen: boolean | undefined;
  disabled: boolean;
  /** Queues text in the chat's outbox, the same path as a typed reply. */
  onSendText: (body: string) => void;
  onTemplateSent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cache = useQueryClient();
  const asText = personal || windowOpen === true;
  const send = useMutation({
    meta: { toast: false },
    mutationFn: async () => {
      const created = await createReviewRequest({ leadId, channel: 'WHATSAPP' });
      const link = reviewLinkFor(created.token);
      if (asText) {
        onSendText(reviewRequestMessage(created, link));
        return 'TEXT' as const;
      }
      const template = await resolveInboxReviewTemplate(conversation.id, link);
      if (!template.configured) throw new Error('REVIEW_TEMPLATE_NOT_CONFIGURED');
      await sendInboxWhatsAppTemplate({
        organizationId,
        conversationId: conversation.id,
        expectedLeadId: conversation.lead_id,
        templateId: template.template_id,
        variables: template.variables,
        applicationMessageId: crypto.randomUUID(),
      });
      onTemplateSent();
      return 'TEMPLATE' as const;
    },
    onSuccess: (mode) => {
      setOpen(false);
      void cache.invalidateQueries({ queryKey: reviewRequestKeys.all });
      toast.add({
        type: 'success',
        title: 'Review link sent',
        description:
          mode === 'TEXT'
            ? `Sent to ${conversation.customer_name} in this chat.`
            : `Sent as the review template, since the 24-hour window is closed.`,
      });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Review link not sent',
        description: failureMessage(error),
      }),
  });
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || send.isPending || (!personal && windowOpen === undefined)}
        onClick={() => setOpen(true)}
      >
        <Star className="size-3.5" /> Send review link
      </Button>
      <Dialog open={open} onOpenChange={(next) => !send.isPending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send a review link to {conversation.customer_name}?</DialogTitle>
            <DialogDescription>
              {asText
                ? 'A thank-you message with a single-use review link is sent in this chat.'
                : 'The 24-hour reply window is closed, so the review template your admin chose is sent instead of a free message.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={send.isPending}>
              Cancel
            </Button>
            <Button onClick={() => send.mutate()} disabled={send.isPending}>
              {send.isPending ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
