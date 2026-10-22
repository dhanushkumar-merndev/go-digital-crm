'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  CircleCheck,
  CirclePause,
  Mail,
  MessageCircle,
  Plus,
  Send,
  Star,
} from 'lucide-react';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { MarketingAutomationSkeleton } from '@/components/skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  createMarketingReviewRequest,
  fetchMarketingAutomationWorkspace,
  fetchMarketingAutomationPermissions,
  fetchMarketingReviewCustomerOptions,
  fetchMarketingReviewTemplateOptions,
  type MarketingReviewTemplate,
} from './marketing-automation-api';
import { SmsFallbackCampaignDialog } from './sms-fallback-campaign-dialog';
import { DripCampaignEditor } from './drip-campaign-editor';

const workspaceKey = ['marketing-automation-workspace'] as const;
const channels = ['WHATSAPP', 'SMS', 'EMAIL'] as const;
type Channel = (typeof channels)[number];

function newRequestId() {
  return globalThis.crypto.randomUUID();
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function ChannelIcon({ channel }: { channel: Channel | 'MANUAL' }) {
  if (channel === 'EMAIL') return <Mail className="size-4" />;
  return <MessageCircle className="size-4" />;
}

const reviewErrorMessages: Record<string, string> = {
  REVIEW_TEMPLATE_REQUIRED: 'Choose an approved template for this channel.',
  REVIEW_TEMPLATE_NOT_AVAILABLE:
    'That template is no longer approved or connected for this booking’s branch.',
  REVIEW_TEMPLATE_VARIABLE_REQUIRED:
    'Every template field needs a value. A field such as review link is empty for this booking.',
  REVIEW_RECIPIENT_MISSING: 'The customer has no phone or email for this channel.',
  REVIEW_CUSTOMER_OPTED_OUT: 'The customer opted out of messages on this channel.',
  REVIEW_CHANNEL_NOT_CONNECTED: 'This channel is not connected for the booking’s branch.',
};

/** Why a request failed or is waiting to retry, in words a marketer can act on. */
const reviewFailureLabels: Record<string, string> = {
  REVIEW_TEMPLATE_REQUIRED: 'Queued without a template; request it again',
  REVIEW_TEMPLATE_NOT_APPROVED: 'Template no longer approved',
  REVIEW_RECIPIENT_MISSING: 'No phone or email on file',
  REVIEW_RECIPIENT_INVALID: 'Phone or email is invalid',
  REVIEW_CUSTOMER_OPTED_OUT: 'Customer opted out',
  REVIEW_WHATSAPP_NOT_CONNECTED: 'WhatsApp not connected',
  REVIEW_WHATSAPP_REJECTED: 'WhatsApp rejected the template message',
  REVIEW_WHATSAPP_INVALID_PARAMETER:
    'WhatsApp refused a field value (too long or wrong type); shorten it and resend',
  REVIEW_WHATSAPP_TEMPLATE_MISMATCH: 'Template changed in WhatsApp Manager; sync templates',
  REVIEW_WHATSAPP_RATE_LIMITED: 'WhatsApp rate limit; retrying',
  REVIEW_WHATSAPP_DELIVERY_FAILED: 'WhatsApp could not deliver it',
  REVIEW_EMAIL_REJECTED: 'Email provider rejected it',
  REVIEW_SMS_REJECTED: 'SMS provider rejected it',
};

function reviewErrorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return reviewErrorMessages[code] ?? 'Check the customer booking and try again.';
}

// Fields are `body:1` / `header:name` for WhatsApp and `FIRST_NAME` for SMS / email.
function fieldLabel(field: string) {
  const [part, name] = field.includes(':') ? field.split(':') : ['', field];
  return part ? `${part === 'header' ? 'Header' : 'Body'} {{${name}}}` : `{{${name}}}`;
}

function templatePreview(template: MarketingReviewTemplate, values: Record<string, string>) {
  const fill = (text: string | null, prefix: string) =>
    (text ?? '').replace(/\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}/g, (match, name: string) => {
      const value = values[`${prefix}${name}`]?.trim();
      return value || match;
    });
  if (template.channel !== 'WHATSAPP') return fill(template.body, '');
  return [fill(template.header, 'header:'), fill(template.body, 'body:'), template.footer]
    .filter(Boolean)
    .join('\n\n');
}

function CreateReviewRequestDialog({ onComplete }: { onComplete: () => void }) {
  const queryScope = workspaceQueryScope(useWorkspaceSession());
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [channel, setChannel] = useState<Channel | 'MANUAL'>('WHATSAPP');
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState(
    'Thank you for choosing us. We would value your Google review.',
  );
  const [requestId, setRequestId] = useState(newRequestId);
  const debouncedSearch = useDebouncedValue(search, 300);
  const options = useQuery({
    queryKey: ['marketing-review-customer-options', ...queryScope, debouncedSearch],
    queryFn: ({ signal }) => fetchMarketingReviewCustomerOptions(debouncedSearch, signal),
    enabled: open,
  });
  const selected = options.data?.find((option) => option.booking_id === bookingId);
  const templateOptions = useQuery({
    queryKey: ['marketing-review-template-options', ...queryScope, selected?.branch_id],
    queryFn: ({ signal }) => fetchMarketingReviewTemplateOptions(selected!.branch_id, signal),
    enabled: open && Boolean(selected),
  });
  const templates = (templateOptions.data?.templates ?? []).filter(
    (template) => template.channel === channel,
  );
  const template = templates.find((option) => option.id === templateId);
  const resetTemplate = () => {
    setTemplateId('');
    setValues({});
  };
  const mutation = useMutation({
    meta: { toast: false },
    mutationFn: () => {
      if (!selected) throw new Error('MARKETING_REVIEW_CUSTOMER_REQUIRED');
      return createMarketingReviewRequest({
        option: selected,
        channel,
        messageBody: channel === 'MANUAL' ? message.trim() : '',
        requestId,
        templateId: channel === 'MANUAL' ? undefined : templateId,
        templateVariables: channel === 'MANUAL' ? undefined : values,
      });
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: channel === 'MANUAL' ? 'Recorded as sent manually' : 'Review request queued',
        description:
          channel === 'MANUAL'
            ? 'Logged against the customer. The CRM did not send this message.'
            : 'It is sent within a minute; the status updates when the provider confirms.',
      });
      setOpen(false);
      setSearch('');
      setBookingId('');
      resetTemplate();
      setRequestId(newRequestId());
      onComplete();
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Review request could not be queued',
        description: reviewErrorMessage(error),
      }),
  });
  const valid =
    Boolean(selected) &&
    (channel === 'MANUAL'
      ? message.trim().length > 0 && message.trim().length <= 4000
      : Boolean(template) && template!.fields.every((field) => values[field]?.trim()));
  const channelConnected =
    channel === 'MANUAL' || templateOptions.data?.channels[channel] !== false;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Send className="size-4" /> Request review
      </Button>
      <Dialog open={open} onOpenChange={(next) => !mutation.isPending && setOpen(next)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Request a Google review</DialogTitle>
            <DialogDescription>
              Sent with an approved template on the customer’s channel. Manual records a message you
              send yourself.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) mutation.mutate();
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium">
              Find customer or booking
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Customer, phone or booking number"
                maxLength={160}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Customer and booking
              <Select
                value={bookingId}
                onValueChange={(value) => {
                  setBookingId(value);
                  resetTemplate();
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an accessible booking" />
                </SelectTrigger>
                <SelectContent>
                  {(options.data ?? []).map((option) => (
                    <SelectItem key={option.booking_id} value={option.booking_id}>
                      {option.customer_name} · {option.booking_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {selected ? (
              <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                {selected.phone || 'No phone'} · Review request will be linked to{' '}
                {selected.booking_number}
              </p>
            ) : null}
            <label className="grid gap-1.5 text-sm font-medium">
              Channel
              <Select
                value={channel}
                onValueChange={(value) => {
                  setChannel(value as Channel | 'MANUAL');
                  resetTemplate();
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...channels, 'MANUAL'].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === 'WHATSAPP'
                        ? 'WhatsApp'
                        : value === 'SMS'
                          ? 'SMS'
                          : value === 'EMAIL'
                            ? 'Email'
                            : 'Manual (I send it myself)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {channel === 'MANUAL' ? (
              <label className="grid gap-1.5 text-sm font-medium">
                Message you sent
                <Textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={4}
                  maxLength={4000}
                />
              </label>
            ) : !selected ? null : (
              <>
                {!channelConnected ? (
                  <Alert>
                    <AlertDescription>
                      {channel === 'WHATSAPP' ? 'WhatsApp' : channel} is not connected for this
                      booking’s branch.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <label className="grid gap-1.5 text-sm font-medium">
                  Approved template
                  <Select
                    value={templateId}
                    onValueChange={(value) => {
                      setTemplateId(value);
                      setValues({});
                    }}
                    disabled={templateOptions.isPending || templates.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          templateOptions.isPending
                            ? 'Loading templates…'
                            : templates.length
                              ? 'Choose a template'
                              : 'No approved templates for this channel'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name}
                          {option.language ? ` (${option.language})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                {!templateOptions.isPending && templates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {channel === 'WHATSAPP'
                      ? 'Create a review template in WhatsApp Manager, then sync and enable it under Integrations.'
                      : 'Add an approved provider template for this channel under Templates.'}
                  </p>
                ) : null}
                {template?.fields.map((field) => (
                  <div className="grid gap-1.5" key={field}>
                    <span className="text-sm font-medium">{fieldLabel(field)}</span>
                    <div className="flex gap-2">
                      <Input
                        aria-label={fieldLabel(field)}
                        value={values[field] ?? ''}
                        maxLength={1000}
                        placeholder="Text, or insert a customer field"
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [field]: event.target.value }))
                        }
                      />
                      <Select
                        value=""
                        onValueChange={(token) =>
                          setValues((current) => ({
                            ...current,
                            [field]: `${current[field] ?? ''}{{${token}}}`,
                          }))
                        }
                      >
                        <SelectTrigger className="w-40 shrink-0" aria-label="Insert field">
                          <SelectValue placeholder="Insert field" />
                        </SelectTrigger>
                        <SelectContent>
                          {(templateOptions.data?.tokens ?? []).map((token) => (
                            <SelectItem key={token} value={token}>
                              {token.replaceAll('_', ' ')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
                {template ? (
                  <div className="grid gap-1.5">
                    <span className="text-sm font-medium">Preview</span>
                    <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
                      {templatePreview(template, values)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Fields in braces are filled from the customer and booking when queued.
                    </p>
                  </div>
                ) : null}
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || mutation.isPending}>
                {mutation.isPending
                  ? 'Saving…'
                  : channel === 'MANUAL'
                    ? 'Record as sent'
                    : 'Send request'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function MarketingAutomationWorkspace({
  spec,
  initialTab = 'DRIP',
}: {
  spec: PageSpec;
  initialTab?: 'DRIP' | 'REVIEWS';
}) {
  const session = useWorkspaceSession();
  const useWorkspaceBootstrap = Boolean(session?.organizationId);
  const queryScope = useMemo(() => workspaceQueryScope(session), [session]);
  const bootstrapPermissions = useWorkspaceBootstrap
    ? { canManage: hasWorkspacePermission(session, 'marketing.automation.manage') }
    : undefined;
  // Drip campaigns and Reviews are separate sidebar pages; the page is the tab.
  const tab = initialTab;
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: [...workspaceKey, ...queryScope],
    queryFn: ({ signal }) => fetchMarketingAutomationWorkspace(signal),
  });
  const legacyPermissions = useQuery({
    queryKey: ['marketing-automation-permissions', ...queryScope],
    queryFn: fetchMarketingAutomationPermissions,
    enabled: !useWorkspaceBootstrap,
    staleTime: 5 * 60_000,
  });
  const permissions = bootstrapPermissions ?? legacyPermissions.data;
  useTenantRealtimeInvalidation(workspace.data?.organization_id, [
    { resource: 'marketing', queryKeys: [[...workspaceKey, ...queryScope]] },
  ]);
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: [...workspaceKey, ...queryScope] });
  const dripMetrics = useMemo(
    () =>
      workspace.data
        ? [
            {
              label: 'Campaigns',
              value: String(workspace.data.drip_kpis.total),
              helper: 'Authorized scope',
              icon: CalendarClock,
              tone: 'bg-blue-50 text-blue-600',
            },
            {
              label: 'Active',
              value: String(workspace.data.drip_kpis.active),
              helper: 'Delivery-enabled sequences',
              icon: Send,
              tone: 'bg-emerald-50 text-emerald-600',
            },
            {
              label: 'Paused',
              value: String(workspace.data.drip_kpis.paused),
              helper: 'Requires review',
              icon: CirclePause,
              tone: 'bg-amber-50 text-amber-600',
            },
            {
              label: 'Sequence steps',
              value: String(workspace.data.drip_kpis.steps),
              helper: 'Across campaigns',
              icon: MessageCircle,
              tone: 'bg-violet-50 text-violet-600',
            },
          ]
        : [],
    [workspace.data],
  );
  const reviewMetrics = useMemo(
    () =>
      workspace.data
        ? [
            {
              label: 'Queued',
              value: String(workspace.data.review_kpis.queued),
              helper: 'Sending within a minute',
              icon: CalendarClock,
              tone: 'bg-amber-50 text-amber-600',
            },
            {
              label: 'Sent today',
              value: String(workspace.data.review_kpis.sent_today),
              helper: 'Provider-confirmed sends',
              icon: Send,
              tone: 'bg-blue-50 text-blue-600',
            },
            {
              label: 'Delivered',
              value: String(workspace.data.review_kpis.delivered),
              helper: 'Delivery status received',
              icon: CircleCheck,
              tone: 'bg-emerald-50 text-emerald-600',
            },
            {
              label: 'Completed',
              value: String(workspace.data.review_kpis.completed),
              helper: 'Recorded customer response',
              icon: Star,
              tone: 'bg-violet-50 text-violet-600',
            },
          ]
        : [],
    [workspace.data],
  );

  if (workspace.isPending) return <MarketingAutomationSkeleton />;
  if (workspace.isError || !workspace.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Alert variant="destructive">
          <AlertDescription>
            {workspace.error && 'code' in workspace.error && workspace.error.code === '42501'
              ? 'Marketing automation permission and an authorized tenant scope are required.'
              : 'Unable to load marketing automation. Refresh the page to try again.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  const data = workspace.data;
  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{
          ...spec,
          title: spec.title || 'Marketing automation',
          description: spec.description || 'Build compliant nurture sequences and review requests.',
          primaryAction: undefined,
        }}
      />
      {tab === 'DRIP' ? (
        <>
          {permissions?.canManage ? (
            <div className="flex flex-wrap justify-end gap-2">
              <SmsFallbackCampaignDialog onComplete={invalidate} />
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" /> Create drip campaign
              </Button>
            </div>
          ) : null}
          <KpiGrid metrics={dripMetrics} />
          <Card className="shadow-none">
            <CardHeader className="border-b">
              <CardTitle className="text-base">Drip campaigns</CardTitle>
              <CardDescription>
                Saved sequences are scoped to the selected branch or organization. Delivery remains
                server-side.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Steps</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.campaigns.length ? (
                      data.campaigns.map((campaign) => (
                        <TableRow key={campaign.id}>
                          <TableCell>
                            <p className="font-medium">{campaign.name}</p>
                            {campaign.description ? (
                              <p className="max-w-md truncate text-xs text-muted-foreground">
                                {campaign.description}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5">
                              <ChannelIcon channel={campaign.default_channel} />
                              {campaign.default_channel}
                            </span>
                          </TableCell>
                          <TableCell>{campaign.step_count}</TableCell>
                          <TableCell>
                            <StatusBadge value={campaign.status} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDate(campaign.updated_at)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setCampaignId(campaign.id)}
                              aria-label={`${permissions?.canManage ? 'Edit' : 'View'} ${campaign.name}`}
                            >
                              {permissions?.canManage ? 'Edit' : 'View'}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="h-44 text-center">
                          <p className="font-medium">No drip campaigns yet</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Create a scoped sequence to begin the review and approval flow.
                          </p>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
          <DripCampaignEditor
            campaignId={campaignId}
            creating={creating}
            canManage={Boolean(permissions?.canManage)}
            onClose={() => {
              setCampaignId(null);
              setCreating(false);
            }}
            onComplete={invalidate}
          />
        </>
      ) : (
        <>
          {permissions?.canManage ? (
            <div className="flex justify-end">
              <CreateReviewRequestDialog onComplete={invalidate} />
            </div>
          ) : null}
          <KpiGrid metrics={reviewMetrics} />
          <Card className="shadow-none">
            <CardHeader className="border-b">
              <CardTitle className="text-base">Google review requests</CardTitle>
              <CardDescription>
                Each request is linked to a real customer and booking. Status comes from the
                provider: sent, then delivered when WhatsApp confirms it.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Booking</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.reviews.length ? (
                      data.reviews.map((review) => (
                        <TableRow key={review.id}>
                          <TableCell>
                            <p className="font-medium">{review.customer_name}</p>
                            <p className="text-xs text-muted-foreground">
                              {review.customer_phone || 'No phone'}
                            </p>
                          </TableCell>
                          <TableCell>{review.booking_number || '—'}</TableCell>
                          <TableCell>
                            <span className="inline-flex items-center gap-1.5">
                              <ChannelIcon channel={review.channel} />
                              {review.channel}
                            </span>
                          </TableCell>
                          <TableCell>
                            <StatusBadge value={review.status} />
                            {review.safe_error_code &&
                            (review.status === 'FAILED' ||
                              review.status === 'QUEUED' ||
                              review.status === 'CANCELLED') ? (
                              <p className="mt-1 max-w-56 text-xs text-muted-foreground">
                                {reviewFailureLabels[review.safe_error_code] ??
                                  review.safe_error_code.replaceAll('_', ' ').toLowerCase()}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDate(review.created_at)}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={5} className="h-44 text-center">
                          <p className="font-medium">No review requests yet</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Queue a request after the customer experience is complete.
                          </p>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
