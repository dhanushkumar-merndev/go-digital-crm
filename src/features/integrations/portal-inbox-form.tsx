'use client';

import { useQuery } from '@tanstack/react-query';
import { Mail, X } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  maskMailbox,
  normalizeSenderDomain,
  parsePortalEmailLeads,
  PORTAL_MAX_KEYWORDS_PER_RULE,
  PORTAL_MAX_KEYWORD_LENGTH,
  PORTAL_MAX_SENDER_DOMAINS,
  portalCaptureLabels,
  portalCaptureModes,
  portalEmailFieldLabels,
  portalEmailFields,
  portalEmailHtmlToText,
  portalEmailPresets,
  portalLeadSource,
  portalPollIntervals,
  portalRequiredFields,
  type PortalCaptureMode,
  type PortalEmailField,
  type PortalEmailRule,
  type PortalInboxProviderKey,
  type PortalPollInterval,
} from '@/lib/providers/portal-email-parser';
import type { IntegrationRecord } from './integration-workspace-api';
import { fetchPortalInboxMailboxes, type PortalInboxMailboxInput } from './portal-inbox-api';

const hostPresets = {
  gmail: { label: 'Gmail / Google Workspace', host: 'imap.gmail.com' },
  zoho: { label: 'Zoho Mail (India)', host: 'imap.zoho.in' },
  custom: { label: 'Other IMAP mailbox', host: '' },
} as const;
type HostPreset = keyof typeof hostPresets;

/** One editable row per CRM field; an empty keyword list means "not read". */
type RuleDraft = { keywords: string; capture: PortalCaptureMode };

export type PortalInboxDraft = {
  mailboxMode: 'NEW' | 'SHARED';
  sourceConnectionId: string;
  hostPreset: HostPreset;
  imapHost: string;
  imapPort: 993 | 143;
  address: string;
  password: string;
  senderInput: string;
  senderDomains: string[];
  pollInterval: PortalPollInterval;
  rules: Record<PortalEmailField, RuleDraft>;
  sample: string;
};

function ruleDrafts(rules: readonly PortalEmailRule[]) {
  return Object.fromEntries(
    portalEmailFields.map((field) => {
      const rule = rules.find((item) => item.field === field);
      return [
        field,
        { keywords: rule?.keywords.join(', ') ?? '', capture: rule?.capture ?? 'REST_OF_LINE' },
      ];
    }),
  ) as Record<PortalEmailField, RuleDraft>;
}

export function isEmailInboxConnection(record: IntegrationRecord | null) {
  return record?.connection_config.ingest_mode === 'EMAIL_INBOX';
}

export function initialPortalInboxDraft(
  providerKey: PortalInboxProviderKey,
  existing: IntegrationRecord | null,
): PortalInboxDraft {
  const preset = portalEmailPresets[providerKey];
  const config = isEmailInboxConnection(existing) ? existing!.connection_config : null;
  const host = config?.imap_host ?? hostPresets.gmail.host;
  const hostPreset = (Object.keys(hostPresets) as HostPreset[]).find(
    (key) => key !== 'custom' && hostPresets[key].host === host,
  );
  return {
    mailboxMode: config?.mailbox_source_connection_id ? 'SHARED' : 'NEW',
    sourceConnectionId: config?.mailbox_source_connection_id ?? '',
    hostPreset: hostPreset ?? 'custom',
    imapHost: host,
    imapPort: config?.imap_port === 143 ? 143 : 993,
    address: config ? (existing?.external_account_id ?? '') : '',
    password: '',
    senderInput: '',
    senderDomains: config?.sender_domains ?? preset.senderDomains,
    pollInterval: config?.poll_interval_minutes ?? 10,
    rules: ruleDrafts(config?.parse_rules ?? preset.rules),
    sample: '',
  };
}

function splitKeywords(value: string) {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((keyword) => keyword.trim().slice(0, PORTAL_MAX_KEYWORD_LENGTH))
        .filter(Boolean),
    ),
  ].slice(0, PORTAL_MAX_KEYWORDS_PER_RULE);
}

export function portalRulesFromDraft(draft: PortalInboxDraft): PortalEmailRule[] {
  return portalEmailFields
    .map((field) => ({
      field,
      keywords: splitKeywords(draft.rules[field].keywords),
      capture: draft.rules[field].capture,
    }))
    .filter((rule) => rule.keywords.length > 0);
}

/** A blank password keeps the stored one only for the same, self-owned mailbox. */
export function portalHasStoredPassword(
  existing: IntegrationRecord | null,
  draft: PortalInboxDraft,
) {
  return (
    isEmailInboxConnection(existing) &&
    !existing?.connection_config.mailbox_source_connection_id &&
    draft.address.trim().toLowerCase() === existing?.external_account_id
  );
}

/** The mailbox part of the connect request, or a message saying what is missing. */
export function portalMailboxFromDraft(
  draft: PortalInboxDraft,
  hasStoredPassword: boolean,
): PortalInboxMailboxInput | string {
  if (draft.mailboxMode === 'SHARED')
    return draft.sourceConnectionId
      ? { mode: 'SHARED', sourceConnectionId: draft.sourceConnectionId }
      : 'Choose the connection whose inbox to share.';
  const address = draft.address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return 'Enter the mailbox email address.';
  if (!draft.imapHost.trim()) return 'Enter the IMAP server.';
  if (!draft.password.trim() && !hasStoredPassword) return 'Enter the mailbox app password.';
  return {
    mode: 'NEW',
    imapHost: draft.imapHost.trim().toLowerCase(),
    imapPort: draft.imapPort,
    address,
    password: draft.password.trim() || undefined,
  };
}

export function portalDraftProblem(draft: PortalInboxDraft): string | null {
  if (!draft.senderDomains.length) return 'Add at least one portal sender address.';
  const rules = portalRulesFromDraft(draft);
  const missing = portalRequiredFields.filter(
    (field) => !rules.some((rule) => rule.field === field),
  );
  if (missing.length)
    return `Add keywords for ${missing.map((field) => portalEmailFieldLabels[field]).join(' and ')}.`;
  return null;
}

function previewText(sample: string) {
  return /<(html|body|table|td|div|p|br)\b/i.test(sample) ? portalEmailHtmlToText(sample) : sample;
}

export function PortalInboxFields({
  providerKey,
  existing,
  draft,
  onChange,
  teams,
  defaultTeamId,
  onDefaultTeamIdChange,
  routingBranchName,
}: {
  providerKey: PortalInboxProviderKey;
  existing: IntegrationRecord | null;
  draft: PortalInboxDraft;
  onChange: (draft: PortalInboxDraft) => void;
  teams: Array<{ id: string; name: string }>;
  defaultTeamId: string;
  onDefaultTeamIdChange: (value: string) => void;
  routingBranchName: string | null;
}) {
  const source = portalLeadSource[providerKey];
  const update = (patch: Partial<PortalInboxDraft>) => onChange({ ...draft, ...patch });
  const mailboxes = useQuery({
    queryKey: ['portal-inbox-mailboxes', existing?.organization_id ?? 'new'],
    queryFn: fetchPortalInboxMailboxes,
  });
  const shareable = (mailboxes.data ?? []).filter((mailbox) => mailbox.id !== existing?.id);
  const legacyWebhook = Boolean(existing) && !isEmailInboxConnection(existing);
  const hasStoredPassword = portalHasStoredPassword(existing, draft);
  const previewRecords = useMemo(
    () =>
      draft.sample.trim()
        ? parsePortalEmailLeads(previewText(draft.sample), portalRulesFromDraft(draft))
        : null,
    [draft],
  );
  const preview = previewRecords?.[0] ?? null;
  const previewLeadCount = previewRecords?.filter((record) => record.ok).length ?? 0;

  const addSender = () => {
    const domain = normalizeSenderDomain(draft.senderInput);
    if (!domain || draft.senderDomains.includes(domain)) return;
    update({
      senderDomains: [...draft.senderDomains, domain].slice(0, PORTAL_MAX_SENDER_DOMAINS),
      senderInput: '',
    });
  };
  const pendingDomain = normalizeSenderDomain(draft.senderInput);

  return (
    <div className="grid gap-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Mail className="size-4" />
          <span>{source} leads from your email inbox</span>
        </div>
        <p className="text-xs text-muted-foreground">
          The CRM checks the inbox on your schedule, reads only emails from the {source} sender,
          picks out the customer details using the keywords below and creates the lead. Emails are
          read without being marked as read.
        </p>
      </div>
      {legacyWebhook && (
        <p className="rounded-md border border-amber-500/30 bg-amber-50 p-3 text-xs text-amber-900">
          This connection receives leads by webhook today. Saving switches it to the email inbox.
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
          Mailbox
          <Select
            value={draft.mailboxMode === 'SHARED' ? draft.sourceConnectionId : 'NEW'}
            onValueChange={(value) =>
              update(
                value === 'NEW'
                  ? { mailboxMode: 'NEW', sourceConnectionId: '' }
                  : { mailboxMode: 'SHARED', sourceConnectionId: value },
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="NEW">Connect a mailbox</SelectItem>
              {shareable.map((mailbox) => (
                <SelectItem key={mailbox.id} value={mailbox.id}>
                  Same inbox as {portalLeadSource[mailbox.provider_key]} —{' '}
                  {maskMailbox(mailbox.address)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[11px] font-normal text-muted-foreground">
            {draft.mailboxMode === 'SHARED'
              ? 'Uses that connection’s mailbox and app password. Changing the password there updates this one too.'
              : 'Already connected another portal to this inbox? Pick it here instead of entering the password again.'}
          </span>
        </label>
        {draft.mailboxMode === 'NEW' && (
          <>
            <label className="grid gap-1.5 text-sm font-medium">
              Mail provider
              <Select
                value={draft.hostPreset}
                onValueChange={(value) => {
                  const preset = value as HostPreset;
                  update({
                    hostPreset: preset,
                    imapHost: hostPresets[preset].host || draft.imapHost,
                    imapPort: 993,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(hostPresets) as HostPreset[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {hostPresets[key].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {draft.hostPreset === 'custom' ? (
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  IMAP server
                  <Input
                    value={draft.imapHost}
                    onChange={(event) => update({ imapHost: event.target.value })}
                    placeholder="imap.example.com"
                    autoComplete="off"
                    maxLength={253}
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Port
                  <Select
                    value={String(draft.imapPort)}
                    onValueChange={(value) => update({ imapPort: value === '143' ? 143 : 993 })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="993">993</SelectItem>
                      <SelectItem value="143">143</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            ) : (
              <div className="grid gap-1.5 text-sm font-medium">
                IMAP server
                <p className="flex h-10 items-center rounded-md border bg-background px-3 text-sm font-normal text-muted-foreground">
                  {draft.imapHost}:993
                </p>
              </div>
            )}
            <label className="grid gap-1.5 text-sm font-medium">
              Mailbox email
              <Input
                type="email"
                value={draft.address}
                onChange={(event) => update({ address: event.target.value })}
                placeholder="leads@yourdealership.com"
                autoComplete="off"
                maxLength={254}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              App password
              <PasswordInput
                value={draft.password}
                onChange={(event) => update({ password: event.target.value })}
                autoComplete="new-password"
                maxLength={256}
                placeholder={hasStoredPassword ? `${'•'.repeat(12)} (stored securely)` : undefined}
              />
            </label>
            <p className="text-[11px] text-muted-foreground sm:col-span-2">
              {hasStoredPassword
                ? 'Leave the password blank to keep the stored one.'
                : draft.hostPreset === 'gmail'
                  ? 'Use a Google App Password, not the Gmail login password: Google Account → Security → 2-Step Verification → App passwords. IMAP must be on in Gmail settings.'
                  : 'Use an app-specific password if your mail provider offers one.'}{' '}
              It is encrypted on the server and never shown again.
            </p>
          </>
        )}
      </section>

      <section className="grid gap-2">
        <span className="text-sm font-medium">{source} sender address</span>
        <div className="flex gap-2">
          <Input
            value={draft.senderInput}
            onChange={(event) => update({ senderInput: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addSender();
              }
            }}
            placeholder={`customer@${portalEmailPresets[providerKey].senderDomains[0]}`}
            autoComplete="off"
            maxLength={254}
          />
          <Button
            type="button"
            variant="outline"
            onClick={addSender}
            disabled={!pendingDomain || draft.senderDomains.length >= PORTAL_MAX_SENDER_DOMAINS}
          >
            Add
          </Button>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {pendingDomain
            ? `Every email from ${pendingDomain} (and its subdomains) will be read.`
            : 'Type any email address the portal sends from; only its domain is kept.'}
        </span>
        <div className="flex flex-wrap gap-2">
          {draft.senderDomains.map((domain) => (
            <Badge key={domain} variant="outline" className="gap-1 pr-1">
              {domain}
              <button
                type="button"
                className="rounded-sm p-0.5 hover:bg-muted"
                aria-label={`Remove ${domain}`}
                onClick={() =>
                  update({ senderDomains: draft.senderDomains.filter((item) => item !== domain) })
                }
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5 text-sm font-medium">
          Check the inbox every
          <div className="flex gap-2" role="group" aria-label="Inbox check interval">
            {portalPollIntervals.map((minutes) => (
              <Button
                key={minutes}
                type="button"
                size="sm"
                variant={draft.pollInterval === minutes ? 'default' : 'outline'}
                aria-pressed={draft.pollInterval === minutes}
                onClick={() => update({ pollInterval: minutes })}
              >
                {minutes} min
              </Button>
            ))}
          </div>
        </div>
        <label className="grid gap-1.5 text-sm font-medium">
          Assign to Telecaller team
          <Select value={defaultTeamId} onValueChange={onDefaultTeamIdChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Auto round robin across active telecallers</SelectItem>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[11px] font-normal text-muted-foreground">
            {routingBranchName
              ? `Leads from this inbox go to ${routingBranchName}.`
              : 'With several branches in scope, pick a team to choose which branch gets these leads.'}
          </span>
        </label>
      </section>

      <section className="grid gap-2">
        <div>
          <span className="text-sm font-medium">Keywords</span>
          <p className="text-[11px] text-muted-foreground">
            The word in the email just before each value, e.g. <q>Mobile</q> in{' '}
            <q>Mobile: 98765 43210</q>. Separate alternatives with commas; the first match wins.
          </p>
        </div>
        <div className="overflow-x-auto rounded-md border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">CRM field</TableHead>
                <TableHead>Keywords</TableHead>
                <TableHead className="w-40">Take</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {portalEmailFields.map((field) => (
                <TableRow key={field}>
                  <TableCell className="text-sm font-medium">
                    {portalEmailFieldLabels[field]}
                    {portalRequiredFields.includes(field) && (
                      <span className="text-destructive"> *</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      value={draft.rules[field].keywords}
                      onChange={(event) =>
                        update({
                          rules: {
                            ...draft.rules,
                            [field]: { ...draft.rules[field], keywords: event.target.value },
                          },
                        })
                      }
                      placeholder={
                        portalRequiredFields.includes(field) ? 'Required' : 'Not read when empty'
                      }
                      aria-label={`${portalEmailFieldLabels[field]} keywords`}
                      maxLength={600}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={draft.rules[field].capture}
                      onValueChange={(value) =>
                        update({
                          rules: {
                            ...draft.rules,
                            [field]: { ...draft.rules[field], capture: value as PortalCaptureMode },
                          },
                        })
                      }
                    >
                      <SelectTrigger aria-label={`${portalEmailFieldLabels[field]} capture`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {portalCaptureModes.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {portalCaptureLabels[mode]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="grid gap-2">
        <label className="grid gap-1.5 text-sm font-medium">
          Preview with a sample email
          <Textarea
            value={draft.sample}
            onChange={(event) => update({ sample: event.target.value })}
            placeholder={`Open a ${source} lead email, select all of it, and paste it here.`}
            rows={5}
            maxLength={50_000}
          />
          <span className="text-[11px] font-normal text-muted-foreground">
            Checked in your browser only; the sample is not saved or sent anywhere.
          </span>
        </label>
        {preview && (
          <div className="overflow-x-auto rounded-md border bg-background">
            <Table>
              <TableBody>
                {portalEmailFields
                  .filter((field) => draft.rules[field].keywords.trim())
                  .map((field) => (
                    <TableRow key={field}>
                      <TableCell className="w-36 text-sm text-muted-foreground">
                        {portalEmailFieldLabels[field]}
                      </TableCell>
                      <TableCell className="text-sm font-medium">
                        {preview.fields[field] ?? '—'}
                      </TableCell>
                      <TableCell className="w-28 text-right">
                        {preview.fields[field] ? (
                          <Badge variant="success">Found</Badge>
                        ) : (
                          <Badge
                            variant={
                              portalRequiredFields.includes(field) ? 'destructive' : 'secondary'
                            }
                          >
                            Not found
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              {previewRecords && previewRecords.length > 1
                ? `This email lists ${previewRecords.length} customers (the first is shown); ${previewLeadCount} would become ${previewLeadCount === 1 ? 'a lead' : 'leads'}. Each needs a name and a mobile number.`
                : preview.ok
                  ? 'This email would create a lead.'
                  : 'This email would be skipped: a lead needs a name and a mobile number.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
