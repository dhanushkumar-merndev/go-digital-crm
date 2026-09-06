'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleCheck, Mail, MessageCircle, Plus, Send, Star } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  createMarketingDripCampaign,
  createMarketingReviewRequest,
  fetchMarketingAutomationScopeOptions,
  fetchMarketingAutomationWorkspace,
  fetchMarketingAutomationPermissions,
  fetchMarketingReviewCustomerOptions,
} from './marketing-automation-api';

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

function CreateDripCampaignDialog({ onComplete }: { onComplete: () => void }) {
  const queryScope = workspaceQueryScope(useWorkspaceSession());
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('');
  const [channel, setChannel] = useState<Channel>('WHATSAPP');
  const [audience, setAudience] = useState('NEW_LEADS');
  const [steps, setSteps] = useState([{ delay: '0', body: '' }]);
  const [requestId, setRequestId] = useState(newRequestId);
  const scopeOptions = useQuery({
    queryKey: ['marketing-automation-scope-options', ...queryScope],
    queryFn: ({ signal }) => fetchMarketingAutomationScopeOptions(signal),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const mutation = useMutation({
    mutationFn: () =>
      createMarketingDripCampaign({
        name: name.trim(),
        description: description.trim() || undefined,
        branchId: selectedScope === 'organization' ? undefined : selectedScope,
        defaultChannel: channel,
        audienceFilter: { lifecycle: audience },
        steps: steps.map((step, index) => ({
          step_order: index + 1,
          delay_hours: Number(step.delay),
          channel,
          message_body: step.body.trim(),
        })),
        requestId,
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Drip campaign saved',
        description:
          'The sequence is stored as a draft and ready for the approved delivery workflow.',
      });
      setOpen(false);
      setName('');
      setDescription('');
      setSteps([{ delay: '0', body: '' }]);
      setRequestId(newRequestId());
      onComplete();
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Campaign could not be saved',
        description: 'Check the sequence, scope and message content, then try again.',
      }),
  });

  const selectedScope =
    scope ||
    (scopeOptions.data?.can_use_organization_scope
      ? 'organization'
      : (scopeOptions.data?.branches[0]?.id ?? ''));

  const valid =
    name.trim().length >= 3 &&
    Boolean(selectedScope) &&
    steps.length > 0 &&
    steps.every(
      (step) =>
        Number.isInteger(Number(step.delay)) &&
        Number(step.delay) >= 0 &&
        Number(step.delay) <= 8760 &&
        step.body.trim().length > 0,
    );

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Create drip campaign
      </Button>
      <Dialog open={open} onOpenChange={(next) => !mutation.isPending && setOpen(next)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create drip campaign</DialogTitle>
            <DialogDescription>
              Build an auditable, provider-independent sequence. It stays a draft until an approved
              delivery workflow activates it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) mutation.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                Campaign name
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={180}
                  placeholder="New lead nurture"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Authorized scope
                <Select value={selectedScope} onValueChange={setScope}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select scope" />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeOptions.data?.can_use_organization_scope ? (
                      <SelectItem value="organization">Organization-wide</SelectItem>
                    ) : null}
                    {scopeOptions.data?.branches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <label className="grid gap-1.5 text-sm font-medium">
              Purpose
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="What should this sequence achieve?"
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                Default channel
                <Select value={channel} onValueChange={(value) => setChannel(value as Channel)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value === 'WHATSAPP' ? 'WhatsApp' : value === 'SMS' ? 'SMS' : 'Email'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Audience
                <Select value={audience} onValueChange={setAudience}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NEW_LEADS">New leads</SelectItem>
                    <SelectItem value="QUALIFIED">Qualified leads</SelectItem>
                    <SelectItem value="BOOKED">Booked customers</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
            <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <Label>Sequence steps</Label>
                <span className="text-xs text-muted-foreground">
                  Delay is from the previous step
                </span>
              </div>
              {steps.map((step, index) => (
                <div
                  key={index}
                  className="grid gap-2 rounded-md border bg-background p-3 sm:grid-cols-[110px_1fr_auto]"
                >
                  <Input
                    aria-label={`Step ${index + 1} delay hours`}
                    type="number"
                    min={0}
                    max={8760}
                    value={step.delay}
                    onChange={(event) =>
                      setSteps((current) =>
                        current.map((value, position) =>
                          position === index ? { ...value, delay: event.target.value } : value,
                        ),
                      )
                    }
                    placeholder="Hours"
                  />
                  <Input
                    aria-label={`Step ${index + 1} message`}
                    value={step.body}
                    maxLength={4000}
                    onChange={(event) =>
                      setSteps((current) =>
                        current.map((value, position) =>
                          position === index ? { ...value, body: event.target.value } : value,
                        ),
                      )
                    }
                    placeholder={`Step ${index + 1} message`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={steps.length === 1}
                    onClick={() =>
                      setSteps((current) => current.filter((_, position) => position !== index))
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={steps.length >= 24}
                onClick={() => setSteps((current) => [...current, { delay: '24', body: '' }])}
              >
                <Plus className="size-3.5" /> Add step
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save campaign draft'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreateReviewRequestDialog({ onComplete }: { onComplete: () => void }) {
  const queryScope = workspaceQueryScope(useWorkspaceSession());
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [channel, setChannel] = useState<Channel | 'MANUAL'>('WHATSAPP');
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
  const mutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('MARKETING_REVIEW_CUSTOMER_REQUIRED');
      return createMarketingReviewRequest({
        option: selected,
        channel,
        messageBody: message.trim(),
        requestId,
      });
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Review request queued',
        description:
          'The request is recorded against the customer and awaits the approved delivery adapter.',
      });
      setOpen(false);
      setSearch('');
      setBookingId('');
      setRequestId(newRequestId());
      onComplete();
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Review request could not be queued',
        description: 'Check the customer booking and try again.',
      }),
  });
  const valid = Boolean(selected) && message.trim().length > 0 && message.trim().length <= 4000;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Send className="size-4" /> Request review
      </Button>
      <Dialog open={open} onOpenChange={(next) => !mutation.isPending && setOpen(next)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Request a Google review</DialogTitle>
            <DialogDescription>
              Queue a consent-aware request against an existing customer and booking. The selected
              provider adapter performs delivery server-side.
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
              <Select value={bookingId} onValueChange={setBookingId}>
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
                onValueChange={(value) => setChannel(value as Channel | 'MANUAL')}
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
                            : 'Manual'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Request message
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={4}
                maxLength={4000}
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || mutation.isPending}>
                {mutation.isPending ? 'Queuing…' : 'Queue request'}
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
  const [tab, setTab] = useState<'DRIP' | 'REVIEWS'>(initialTab);
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
              icon: CircleCheck,
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
              helper: 'Awaiting adapter delivery',
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
            Marketing automation is unavailable. Marketing automation permission and an authorized
            tenant scope are required.
          </AlertDescription>
        </Alert>
      </div>
    );
  const data = workspace.data;
  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <PageHeader
        spec={{
          ...spec,
          title: spec.title || 'Marketing automation',
          description: spec.description || 'Build compliant nurture sequences and review requests.',
          primaryAction: undefined,
        }}
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <TabsList>
          <TabsTrigger value="DRIP">Drip campaigns</TabsTrigger>
          <TabsTrigger value="REVIEWS">Google reviews</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'DRIP' ? (
        <>
          {permissions?.canManage ? (
            <div className="flex justify-end">
              <CreateDripCampaignDialog onComplete={invalidate} />
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
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={5} className="h-44 text-center">
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
                Each request is linked to a real customer and booking, with delivery status supplied
                by the provider workflow.
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
