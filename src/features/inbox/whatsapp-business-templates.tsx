'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FileText, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import {
  sendInboxWhatsAppTemplate,
  WhatsAppProviderError,
  type WhatsAppReplyTemplate,
  type WhatsAppReplyTemplateState,
} from './inbox-api';

const placeholderPattern = /\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}/g;

// The same order the server sends parameters to Meta in. CRM templates are
// ordered numerically by name; a template synced from Meta arrives in Meta's
// own order (header fields, then body) and keeps it.
function orderedPlaceholders(template: WhatsAppReplyTemplate) {
  if (template.sections) return [...new Set(template.placeholders)];
  return [...new Set(template.placeholders)].sort((left, right) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
}

/** `header:1` -> `1`, `body:first_name` -> `first_name`, `name` -> `name`. */
function fieldName(key: string) {
  return key.replace(/^(header|body):/, '');
}

function placeholderLabel(key: string) {
  const name = fieldName(key);
  const prefix = key.startsWith('header:') ? 'Header ' : '';
  if (/^\d+$/.test(name)) return `${prefix}${prefix ? '' : 'Field '}{{${name}}}`;
  const words = name.replaceAll('_', ' ');
  return `${prefix}${prefix ? words : words.charAt(0).toUpperCase() + words.slice(1)}`;
}

// Meta error codes a dealership can act on. Anything else shows Meta's own text.
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
function metaRejectionReason(error: WhatsAppProviderError) {
  switch (error.providerCode) {
    case 131030:
      return 'This number is not in the allowed recipients of your WhatsApp test number. Add it under WhatsApp Manager → API Setup → To, or use your live business number.';
    case 132001:
      return 'Meta cannot find this template in that language on the connected phone number’s account. Sync templates again; the number may belong to a different WhatsApp Business Account.';
    case 132000:
    case 132012:
      return 'The template fields do not match what Meta approved. Sync templates again and retry.';
    case 131042:
      return 'Meta blocked the send because of a payment issue on the WhatsApp Business Account. Add or fix the payment method in Business Settings.';
    case 131047:
      return 'More than 24 hours have passed since the customer’s last reply. Send a template instead.';
    case 131026:
      return 'This number cannot receive WhatsApp messages (not on WhatsApp, or it blocked your business).';
    case 131049:
      return 'Meta held this marketing message to protect the customer’s experience. Try a utility template or try again later.';
    case 190:
      return 'The WhatsApp access token has expired. Replace the credential on the WhatsApp connection.';
    case 10:
    case 200:
      return 'The WhatsApp token is missing permission to send. Replace the credential with a token that has whatsapp_business_messaging.';
    default:
      return `WhatsApp rejected this template${error.providerCode ? ` (Meta error ${error.providerCode})` : ''}${error.providerDetail ? `: ${error.providerDetail}` : '.'}`;
  }
}

function templateSendError(code: string) {
  switch (code) {
    case 'NETWORK_UNAVAILABLE':
      return 'You appear to be offline. Send again when you are back online.';
    case 'WHATSAPP_TEMPLATE_NOT_APPROVED':
      return 'This template is no longer approved. Pick another one.';
    case 'WHATSAPP_TEMPLATE_VARIABLES_REQUIRED':
      return 'Fill in every template field before sending.';
    case 'WHATSAPP_PROVIDER_REJECTED':
      return 'WhatsApp rejected this template. Check the template name and language in Meta.';
    case 'WHATSAPP_CONNECTION_UNAVAILABLE':
      return 'Official WhatsApp is not connected for this branch.';
    case 'RECIPIENT_NOT_CONFIGURED':
      return 'This conversation has no valid mobile number.';
    case 'LEAD_CONTEXT_CHANGED':
      return 'The working lead changed. Check the selected lead before sending again.';
    case 'PERMISSION_DENIED':
      return 'You cannot send messages from this conversation.';
    default:
      return 'The template could not be sent. Try again.';
  }
}

export function formatWindowExpiry(value: string | null) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

/** Right-panel list of approved templates for an Official WhatsApp conversation. */
export function WhatsAppBusinessTemplatePanel({
  state,
  isPending,
  isError,
  onRetry,
  disabled,
  onPick,
}: {
  state: WhatsAppReplyTemplateState | undefined;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  disabled: boolean;
  onPick: (templateId: string) => void;
}) {
  return (
    <section className="space-y-3 border-t pt-4">
      <div>
        <p className="text-sm font-semibold">Approved templates</p>
        <p className="text-xs text-muted-foreground">
          {state?.window_open
            ? `Reply window open until ${formatWindowExpiry(state.window_expires_at)}. Templates are optional.`
            : 'Start or reopen the chat with a Meta-approved template. Free text unlocks for 24 hours once the customer replies.'}
        </p>
      </div>
      {isPending ? (
        <p className="text-xs text-muted-foreground">Loading templates…</p>
      ) : isError ? (
        <div className="text-xs text-muted-foreground">
          Templates are unavailable.
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : !state?.templates.length ? (
        <p className="text-xs text-muted-foreground">
          No WhatsApp templates are switched on yet. Ask your Client Admin to sync them from Meta
          under Integrations → WhatsApp → WhatsApp templates.
        </p>
      ) : (
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {state.templates.map((template) => (
            <button
              key={template.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(template.id)}
              className="w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <FileText className="size-3.5 shrink-0 text-emerald-600" />
                <span className="truncate">{template.name}</span>
              </span>
              <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {template.body}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function TemplateSendForm({
  state,
  initialTemplateId,
  organizationId,
  conversationId,
  expectedLeadId,
  onSent,
  onCancel,
}: {
  state: WhatsAppReplyTemplateState;
  initialTemplateId: string;
  organizationId: string;
  conversationId: string;
  expectedLeadId: string | null;
  onSent: () => void;
  onCancel: () => void;
}) {
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [values, setValues] = useState<Record<string, string>>({});
  // One key per template choice: a resend after a dropped connection is
  // deduplicated by the server instead of reaching the customer twice.
  const [applicationMessageId, setApplicationMessageId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const template = state.templates.find((item) => item.id === templateId) ?? state.templates[0]!;
  const placeholders = orderedPlaceholders(template);
  const valueOf = (key: string) => values[key] ?? state.suggestions[fieldName(key)] ?? '';
  const missing = placeholders.some((key) => !valueOf(key).trim());
  const fill = (text: string, prefix: string) =>
    text.replace(placeholderPattern, (match, name: string) => {
      const value = valueOf(`${prefix}${name}`).trim();
      return value || match;
    });
  const preview = template.sections
    ? [
        template.sections.header ? fill(template.sections.header, 'header:') : null,
        template.sections.body ? fill(template.sections.body, 'body:') : null,
        template.sections.footer ?? null,
      ]
        .filter(Boolean)
        .join('\n\n')
    : fill(template.body, '');
  const send = useMutation({
    meta: { toast: false },
    mutationFn: () =>
      sendInboxWhatsAppTemplate({
        organizationId,
        conversationId,
        expectedLeadId,
        templateId: template.id,
        variables: Object.fromEntries(placeholders.map((name) => [name, valueOf(name).trim()])),
        applicationMessageId,
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Template sent',
        description: 'You can type freely once the customer replies.',
      });
      onSent();
    },
    onError: (failure) => {
      const code = failure instanceof Error ? failure.message : '';
      if (failure instanceof WhatsAppProviderError) {
        setApplicationMessageId(crypto.randomUUID());
        setError(metaRejectionReason(failure));
        return;
      }
      // Only a dropped connection keeps the key: the request may have landed.
      if (code !== 'NETWORK_UNAVAILABLE') setApplicationMessageId(crypto.randomUUID());
      setError(templateSendError(code));
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!missing && !send.isPending) send.mutate();
      }}
    >
      <label className="grid gap-1.5 text-sm font-medium">
        Template
        <Select
          value={template.id}
          onValueChange={(value) => {
            setTemplateId(value);
            setValues({});
            setError(undefined);
            setApplicationMessageId(crypto.randomUUID());
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {state.templates.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {placeholders.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {placeholders.map((name) => (
            <label key={name} className="grid min-w-0 gap-1.5 text-sm font-medium">
              {placeholderLabel(name)}
              <Input
                value={valueOf(name)}
                maxLength={1024}
                onChange={(event) => {
                  setValues((current) => ({ ...current, [name]: event.target.value }));
                  setError(undefined);
                }}
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="rounded-xl bg-emerald-50 px-3 py-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-800">
          Customer sees
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900">{preview}</p>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Meta template: {template.provider_template_id}
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : missing ? (
        <p className="text-xs text-muted-foreground">Fill in every field to send.</p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={send.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={missing || send.isPending}>
          <Send className="size-4" />
          {send.isPending ? 'Sending…' : 'Send template'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Pick an approved template, fill its fields and send it. */
export function WhatsAppTemplateSendDialog({
  open,
  onOpenChange,
  state,
  initialTemplateId,
  organizationId,
  conversationId,
  expectedLeadId,
  customerName,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: WhatsAppReplyTemplateState | undefined;
  initialTemplateId: string | null;
  organizationId: string;
  conversationId: string;
  expectedLeadId: string | null;
  customerName: string;
  onSent: () => void;
}) {
  const ready = Boolean(state?.templates.length);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send a WhatsApp template</DialogTitle>
          <DialogDescription>
            {state?.window_open
              ? `The reply window with ${customerName} is open, so a template is optional.`
              : `Official WhatsApp needs an approved template to message ${customerName} outside the 24-hour reply window.`}
          </DialogDescription>
        </DialogHeader>
        {ready && state ? (
          // Remounted on every open, so it starts from the chosen template.
          <TemplateSendForm
            key={`${conversationId}:${initialTemplateId ?? ''}`}
            state={state}
            initialTemplateId={initialTemplateId ?? state.templates[0]!.id}
            organizationId={organizationId}
            conversationId={conversationId}
            expectedLeadId={expectedLeadId}
            onCancel={() => onOpenChange(false)}
            onSent={() => {
              onOpenChange(false);
              onSent();
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No WhatsApp templates are switched on yet. Ask your Client Admin to sync them from Meta
            under Integrations → WhatsApp → WhatsApp templates.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
