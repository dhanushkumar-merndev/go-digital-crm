'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Check,
  CircleSlash,
  Mail,
  MessageCircle,
  Plus,
  Send,
  Smartphone,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  cancelCustomerDripEnrollment,
  createCustomerDripEnrollment,
  customerDripPanelKey,
  customerDripTemplatesKey,
  dripChannelLabel,
  dripChannels,
  DRIP_MAX_BODY_LENGTH,
  DRIP_MAX_STEPS,
  fetchCustomerDripPanel,
  fetchCustomerDripTemplates,
  getDripErrorMessage,
  type DripChannel,
  type DripEnrollment,
  type DripMessage,
  type DripStepDraft,
  type DripTemplateOption,
  customerDripTemplateOptionsKey,
  fetchCustomerDripTemplateOptions,
} from './customer-drip-api';

const channelIcon: Record<DripChannel, typeof Mail> = {
  WHATSAPP: MessageCircle,
  SMS: Smartphone,
  EMAIL: Mail,
};

/**
 * Delays are entered per step and relative to the step before it, because that
 * is how a consultant describes a sequence out loud: "then two days later".
 */
const delayChoices = [
  { hours: 0, label: 'Immediately' },
  { hours: 4, label: '4 hours later' },
  { hours: 24, label: '1 day later' },
  { hours: 48, label: '2 days later' },
  { hours: 72, label: '3 days later' },
  { hours: 168, label: '1 week later' },
  { hours: 336, label: '2 weeks later' },
  { hours: 720, label: '1 month later' },
];

function formatMoment(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function delayLabel(hours: number) {
  const known = delayChoices.find((choice) => choice.hours === hours);
  if (known) return known.label;
  if (hours < 24) return `${hours} hours later`;
  return `${Math.round(hours / 24)} days later`;
}

function blankStep(channel: DripChannel = 'WHATSAPP'): DripStepDraft {
  return { channel, delayHours: 0, messageBody: '', templateId: null, templateVariables: {} };
}

function messageTone(status: DripMessage['status']) {
  if (status === 'SENT') return { icon: Check, className: 'text-emerald-600' };
  if (status === 'FAILED') return { icon: TriangleAlert, className: 'text-destructive' };
  if (status === 'CANCELLED') return { icon: CircleSlash, className: 'text-muted-foreground' };
  return { icon: CalendarClock, className: 'text-blue-600' };
}

function StepRow({
  index,
  step,
  onChange,
  onRemove,
  removable,
  templateOptions,
}: {
  index: number;
  step: DripStepDraft;
  onChange: (patch: Partial<DripStepDraft>) => void;
  onRemove: () => void;
  removable: boolean;
  templateOptions: DripTemplateOption[];
}) {
  // A template belongs to one channel, so switching channel invalidates the
  // chosen template rather than silently sending it on the wrong one.
  const available = templateOptions.filter((option) => option.channel === step.channel);
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-blue-600 text-xs font-semibold text-white">
          {index + 1}
        </span>
        <Select
          value={step.channel}
          onValueChange={(value) => onChange({ channel: value as DripChannel, templateId: null })}
        >
          <SelectTrigger className="h-9 w-36" aria-label={`Step ${index + 1} channel`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {dripChannels.map((channel) => (
              <SelectItem key={channel} value={channel}>
                {dripChannelLabel[channel]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(step.delayHours)}
          onValueChange={(value) => onChange({ delayHours: Number(value) })}
        >
          <SelectTrigger className="h-9 w-44" aria-label={`Step ${index + 1} timing`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {delayChoices.map((choice) => (
              <SelectItem key={choice.hours} value={String(choice.hours)}>
                {index === 0 && choice.hours === 0 ? 'Immediately' : choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {removable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto size-8 text-muted-foreground"
            aria-label={`Remove step ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
      {available.length ? (
        <Select
          value={step.templateId ?? ''}
          onValueChange={(value) => onChange({ templateId: value })}
        >
          <SelectTrigger className="h-9" aria-label={`Step ${index + 1} approved template`}>
            <SelectValue placeholder="Choose an approved template" />
          </SelectTrigger>
          <SelectContent>
            {available.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          No approved {dripChannelLabel[step.channel]} template yet. A sequence step sends long
          after the conversation starts, so the provider only accepts an approved template. Ask an
          administrator to approve one under Templates.
        </p>
      )}
      <Textarea
        value={step.messageBody}
        maxLength={DRIP_MAX_BODY_LENGTH}
        rows={3}
        placeholder="Write the copy as the customer will read it."
        aria-label={`Step ${index + 1} message`}
        onChange={(event) => onChange({ messageBody: event.target.value })}
      />
      <p className="text-xs text-muted-foreground">
        Saved as the reviewed copy of this step. The provider sends the approved template.
      </p>
    </div>
  );
}

function StartDripDialog({
  open,
  onOpenChange,
  customerId,
  leadId,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  leadId: string | null;
  onStarted: () => void;
}) {
  const [sourceName, setSourceName] = useState('');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [steps, setSteps] = useState<DripStepDraft[]>(() => [blankStep()]);
  const templateOptions = useQuery({
    queryKey: customerDripTemplateOptionsKey,
    queryFn: ({ signal }) => fetchCustomerDripTemplateOptions(signal),
    staleTime: 300_000,
  });
  const options = templateOptions.data ?? [];
  const [chosen, setChosen] = useState(false);
  const requestId = useRef<string | null>(null);

  const templates = useQuery({
    queryKey: customerDripTemplatesKey,
    queryFn: ({ signal }) => fetchCustomerDripTemplates(signal),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= globalThis.crypto.randomUUID();
      return createCustomerDripEnrollment({
        customerId,
        leadId,
        sourceCampaignId: campaignId,
        sourceName: sourceName.trim(),
        steps: steps.map((step) => ({ ...step, messageBody: step.messageBody.trim() })),
        requestId: requestId.current,
      });
    },
    onSuccess: () => {
      onStarted();
      onOpenChange(false);
    },
    onError: () => {
      // A changed retry needs a fresh idempotency key, or the server correctly
      // rejects the reused one for having a different fingerprint.
      requestId.current = null;
    },
  });

  function applyTemplate(templateCampaignId: string | null) {
    requestId.current = null;
    setChosen(true);
    if (!templateCampaignId) {
      setCampaignId(null);
      setSourceName('Custom sequence');
      setSteps([blankStep()]);
      return;
    }
    const template = templates.data?.find((item) => item.campaign_id === templateCampaignId);
    if (!template) return;
    setCampaignId(template.campaign_id);
    setSourceName(template.name);
    setSteps(
      template.steps.slice(0, DRIP_MAX_STEPS).map((step) => ({
        channel: step.channel,
        delayHours: step.delay_hours,
        messageBody: step.message_body,
        templateId: step.template_id,
        templateVariables: step.template_variables,
      })),
    );
  }

  const emptyStep = steps.some((step) => !step.messageBody.trim() || !step.templateId);
  const validationMessage = !sourceName.trim()
    ? 'Name this sequence so it is recognisable on the timeline.'
    : emptyStep
      ? 'Every step needs a message.'
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setChosen(false);
          setCampaignId(null);
          setSourceName('');
          setSteps([blankStep()]);
          requestId.current = null;
          mutation.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Start a drip sequence</DialogTitle>
          <DialogDescription>
            Pick a ready-made sequence and edit it for this customer, or write one from scratch. The
            wording is saved as you leave it here — later edits to the original template do not
            change what this customer receives.
          </DialogDescription>
        </DialogHeader>

        {!chosen ? (
          <div className="mt-4 space-y-2">
            {templates.isPending ? (
              <>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </>
            ) : templates.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Sequence templates could not be loaded. You can still write one from scratch.
                </AlertDescription>
              </Alert>
            ) : (
              templates.data?.map((template) => (
                <button
                  key={template.campaign_id}
                  type="button"
                  className="flex w-full flex-col items-start gap-1 rounded-lg border p-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  onClick={() => applyTemplate(template.campaign_id)}
                >
                  <span className="text-sm font-semibold">{template.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {template.steps.length} step{template.steps.length === 1 ? '' : 's'} ·{' '}
                    {dripChannelLabel[template.default_channel]}
                    {template.description ? ` · ${template.description}` : ''}
                  </span>
                </button>
              ))
            )}
            <button
              type="button"
              className="flex w-full flex-col items-start gap-1 rounded-lg border border-dashed p-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
              onClick={() => applyTemplate(null)}
            >
              <span className="text-sm font-semibold">Start from blank</span>
              <span className="text-xs text-muted-foreground">Write every step yourself.</span>
            </button>
          </div>
        ) : (
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!validationMessage) mutation.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="drip-source-name">Sequence name</Label>
              <Input
                id="drip-source-name"
                value={sourceName}
                maxLength={180}
                onChange={(event) => {
                  requestId.current = null;
                  setSourceName(event.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              {steps.map((step, index) => (
                <StepRow
                  key={index}
                  index={index}
                  step={step}
                  removable={steps.length > 1}
                  templateOptions={options}
                  onChange={(patch) => {
                    requestId.current = null;
                    setSteps((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, ...patch } : item,
                      ),
                    );
                  }}
                  onRemove={() => {
                    requestId.current = null;
                    setSteps((current) => current.filter((_, itemIndex) => itemIndex !== index));
                  }}
                />
              ))}
            </div>

            {steps.length < DRIP_MAX_STEPS ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  requestId.current = null;
                  setSteps((current) => [
                    ...current,
                    blankStep(current.at(-1)?.channel ?? 'WHATSAPP'),
                  ]);
                }}
              >
                <Plus className="size-4" /> Add step
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                A sequence holds at most {DRIP_MAX_STEPS} steps.
              </p>
            )}

            {mutation.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{getDripErrorMessage(mutation.error)}</AlertDescription>
              </Alert>
            ) : null}
            {validationMessage ? (
              <p className="text-xs font-medium text-amber-700">{validationMessage}</p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setChosen(false)}>
                Back
              </Button>
              <Button type="submit" disabled={Boolean(validationMessage) || mutation.isPending}>
                <Send className="size-4" />
                {mutation.isPending ? 'Starting…' : 'Start sequence'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CancelDripDialog({
  enrollment,
  onOpenChange,
  onCancelled,
}: {
  enrollment: DripEnrollment | null;
  onOpenChange: (open: boolean) => void;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState('');
  const requestId = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      if (!enrollment) throw new Error('NO_ENROLLMENT');
      requestId.current ??= globalThis.crypto.randomUUID();
      return cancelCustomerDripEnrollment({
        enrollmentId: enrollment.id,
        expectedVersion: enrollment.version,
        reason: reason.trim(),
        requestId: requestId.current,
      });
    },
    onSuccess: () => {
      onCancelled();
      onOpenChange(false);
    },
    onError: () => {
      requestId.current = null;
    },
  });
  const queued = enrollment?.messages.filter((message) => message.status === 'QUEUED').length ?? 0;

  return (
    <Dialog
      open={Boolean(enrollment)}
      onOpenChange={(next) => {
        if (!next) {
          setReason('');
          requestId.current = null;
          mutation.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop this sequence</DialogTitle>
          <DialogDescription>
            {queued === 0
              ? 'Nothing is still waiting to go out, so this only closes the sequence.'
              : `${queued} message${queued === 1 ? '' : 's'} still waiting to be sent will be cancelled. Messages already sent stay on the record.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim().length >= 3) mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="drip-cancel-reason">Why is it being stopped?</Label>
            <Textarea
              id="drip-cancel-reason"
              value={reason}
              rows={3}
              maxLength={500}
              placeholder="Customer asked us to stop messaging"
              onChange={(event) => {
                requestId.current = null;
                setReason(event.target.value);
              }}
            />
          </div>
          {mutation.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{getDripErrorMessage(mutation.error)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep it running
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={reason.trim().length < 3 || mutation.isPending}
            >
              {mutation.isPending ? 'Stopping…' : 'Stop sequence'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerDripPanel({
  customerId,
  leadId,
}: {
  customerId: string;
  leadId: string | null;
}) {
  const queryClient = useQueryClient();
  const [startOpen, setStartOpen] = useState(false);
  const [cancelling, setCancelling] = useState<DripEnrollment | null>(null);

  const panel = useQuery({
    queryKey: customerDripPanelKey(customerId),
    queryFn: ({ signal }) => fetchCustomerDripPanel(customerId, signal),
    staleTime: 60_000,
  });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: customerDripPanelKey(customerId) });

  if (panel.isPending)
    return (
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );

  if (panel.isError)
    return (
      <Card className="shadow-none">
        <CardContent className="flex flex-col items-center p-8 text-center">
          <TriangleAlert className="size-8 text-destructive" />
          <p className="mt-3 text-sm font-medium">Drip sequences could not be loaded.</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => void panel.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );

  const enrollments = panel.data?.enrollments ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Drip sequences</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Scheduled messages written for this customer. Each step is queued at the time it is due.
          </p>
        </div>
        {panel.data?.can_manage ? (
          <Button size="sm" onClick={() => setStartOpen(true)}>
            <Plus className="size-4" /> Start a drip
          </Button>
        ) : null}
      </div>

      {enrollments.length === 0 ? (
        <Card className="shadow-none">
          <CardContent className="flex flex-col items-center p-10 text-center">
            <span className="grid size-11 place-items-center rounded-full bg-blue-50 text-blue-600">
              <Send className="size-5" />
            </span>
            <p className="mt-3 text-sm font-medium">No drip sequence yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Start one from a ready-made template and adjust the wording, or write every step
              yourself.
            </p>
          </CardContent>
        </Card>
      ) : (
        enrollments.map((enrollment) => (
          <Card key={enrollment.id} className="shadow-none">
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {enrollment.source_name}
                  <Badge
                    variant={enrollment.status === 'ACTIVE' ? 'default' : 'outline'}
                    className="font-normal"
                  >
                    {enrollment.status.toLowerCase()}
                  </Badge>
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Started {formatMoment(enrollment.created_at)} by {enrollment.enrolled_by_name}
                  {enrollment.cancellation_reason
                    ? ` · Stopped: ${enrollment.cancellation_reason}`
                    : ''}
                </p>
              </div>
              {panel.data?.can_manage && enrollment.status === 'ACTIVE' ? (
                <Button variant="outline" size="sm" onClick={() => setCancelling(enrollment)}>
                  <CircleSlash className="size-4" /> Stop
                </Button>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-2">
              {enrollment.messages.map((message) => {
                const Icon = channelIcon[message.channel];
                const tone = messageTone(message.status);
                const ToneIcon = tone.icon;
                return (
                  <div key={message.id} className="flex gap-3 rounded-lg border p-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          Step {message.step_order} · {dripChannelLabel[message.channel]}
                        </span>
                        <span className={`inline-flex items-center gap-1 ${tone.className}`}>
                          <ToneIcon className="size-3.5" />
                          {message.status === 'SENT' && message.sent_at
                            ? `Sent ${formatMoment(message.sent_at)}`
                            : message.status === 'QUEUED'
                              ? `Due ${formatMoment(message.scheduled_for)}`
                              : message.status.toLowerCase()}
                        </span>
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap text-sm">{message.message_body}</p>
                      {message.failure_reason ? (
                        <p className="mt-1 text-xs text-destructive">{message.failure_reason}</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))
      )}

      <StartDripDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        customerId={customerId}
        leadId={leadId}
        onStarted={refresh}
      />
      <CancelDripDialog
        enrollment={cancelling}
        onOpenChange={(open) => !open && setCancelling(null)}
        onCancelled={refresh}
      />
    </div>
  );
}

export { delayLabel };
