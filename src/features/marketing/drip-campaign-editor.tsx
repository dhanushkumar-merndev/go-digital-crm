'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Plus, Trash2 } from 'lucide-react';
import { EmailMessageEditor } from '@/components/shared/email-message-editor';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  createMarketingDripCampaign,
  createMarketingDripTemplate,
  fetchMarketingAutomationScopeOptions,
  fetchMarketingDripBuilderOptions,
  fetchMarketingDripCampaign,
  saveMarketingDripCampaign,
  setMarketingDripStatus,
  type MarketingAutomationScopeOptions,
  type MarketingDripDetail,
  type MarketingDripChannel,
} from './marketing-automation-api';

const channelNames = ['WHATSAPP', 'SMS', 'EMAIL'] as const;
const triggerNames: Record<MarketingDripDetail['trigger_type'], string> = {
  AUDIENCE: 'Audience',
  LEAD_CREATED: 'New lead',
  BIRTHDAY: 'Birthday',
  ANNIVERSARY: 'Anniversary',
  BOOKING_CONFIRMED: 'Booking confirmed',
  VEHICLE_DELIVERED: 'Vehicle delivered',
  DELIVERY_ANNIVERSARY: 'Delivery anniversary',
  AUTOMATION: 'Started by an automation',
};
// What a new campaign can start from, in the order the builder offers them.
const triggerHelp: Record<MarketingDripDetail['trigger_type'], string> = {
  LEAD_CREATED: 'Starts when a new lead arrives; the first step leaves within about a minute.',
  BOOKING_CONFIRMED: 'Starts when a booking is created.',
  VEHICLE_DELIVERED: 'Starts when a delivery is marked delivered.',
  BIRTHDAY: "Starts on the customer's birthday. Needs the Date of birth custom field on customers.",
  ANNIVERSARY:
    "Starts on the customer's wedding anniversary. Needs the Wedding anniversary custom field on customers.",
  DELIVERY_ANNIVERSARY: 'Starts each year on the date the vehicle was delivered.',
  AUTOMATION:
    'Starts only when an automation (Campaigns → Automations) runs it, for example when a lead moves to Qualified.',
  AUDIENCE:
    'Checked every hour: enrolls each customer once when a lead matches the stage, temperature, source and age rules.',
};
const triggerOrder = Object.keys(triggerHelp) as Array<MarketingDripDetail['trigger_type']>;
function defaultConditions(trigger: MarketingDripDetail['trigger_type']): Record<string, unknown> {
  if (trigger === 'LEAD_CREATED') return { sources: [], models: [], email_presence: 'ANY' };
  if (['BIRTHDAY', 'ANNIVERSARY', 'DELIVERY_ANNIVERSARY'].includes(trigger))
    return { days_before: 0, send_hour: 10 };
  return {};
}
// A new campaign exists only in the form until it is saved, so its id and
// version are never sent.
function newCampaign(scopes: MarketingAutomationScopeOptions): MarketingDripDetail {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    name: '',
    description: null,
    branch_id: scopes.can_use_organization_scope ? null : (scopes.branches[0]?.id ?? null),
    status: 'DRAFT',
    version: 1,
    trigger_type: 'LEAD_CREATED',
    trigger_conditions: defaultConditions('LEAD_CREATED'),
    audience_filter: {},
    steps: [
      {
        step_order: 1,
        delay_hours: 0,
        channels: [{ channel: 'EMAIL', template_id: null, body: '', variable_map: {} }],
      },
    ],
  };
}
function placeholders(body: string) {
  return [
    ...new Set(
      Array.from(body.matchAll(/\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}/g), (match) => match[1]),
    ),
  ];
}
function errorMessage(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (message.includes('VERSION_CONFLICT'))
    return 'This campaign changed while you were editing. Reload it before saving again.';
  if (message.includes('TEMPLATE_NOT_APPROVED') || message.includes('HAS_NO_STEPS'))
    return 'Choose approved provider templates for every step before activating this campaign.';
  if (message.includes('CHANNEL_NOT_CONNECTED'))
    return 'Connect the selected channel for this branch in Tools before activating.';
  if (message.includes('SCOPE') || message.includes('PERMISSION'))
    return 'You do not have permission to change this campaign or its selected scope.';
  return 'Could not save the campaign. Check the fields and template variables, then try again.';
}

export function DripCampaignEditor({
  campaignId,
  creating = false,
  canManage,
  onClose,
  onComplete,
}: {
  campaignId: string | null;
  /** Open on a blank draft instead of an existing campaign. */
  creating?: boolean;
  canManage: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const scope = workspaceQueryScope(useWorkspaceSession());
  const queryClient = useQueryClient();
  const busy = useRef(false);
  const open = Boolean(campaignId) || creating;
  const detail = useQuery({
    queryKey: ['marketing-drip-detail', ...scope, campaignId],
    queryFn: ({ signal }) => fetchMarketingDripCampaign(campaignId!, signal),
    enabled: Boolean(campaignId),
  });
  const options = useQuery({
    queryKey: ['marketing-drip-builder-options', ...scope],
    queryFn: ({ signal }) => fetchMarketingDripBuilderOptions(signal),
    enabled: open,
  });
  const scopes = useQuery({
    queryKey: ['marketing-automation-scope-options', ...scope],
    queryFn: ({ signal }) => fetchMarketingAutomationScopeOptions(signal),
    enabled: open,
  });
  const draft = useMemo(() => (scopes.data ? newCampaign(scopes.data) : null), [scopes.data]);
  const initial = creating ? draft : detail.data;
  const refresh = async () => {
    await detail.refetch();
    onComplete();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy.current) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{creating ? 'Create drip campaign' : 'Drip campaign'}</DialogTitle>
          <DialogDescription>
            {creating
              ? 'Choose what starts the sequence, then write each step. It is saved as a draft.'
              : 'Review the audience, messages and timing for this campaign.'}
          </DialogDescription>
        </DialogHeader>
        {(!creating && detail.isError) || options.isError || scopes.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              Unable to load campaign details.{' '}
              <Button
                variant="link"
                onClick={() => {
                  if (!creating) void detail.refetch();
                  void options.refetch();
                  void scopes.refetch();
                }}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : initial && options.data && scopes.data ? (
          <CampaignForm
            key={creating ? 'new' : `${initial.id}:${initial.version}`}
            initial={initial}
            isNew={creating}
            options={options.data}
            scopes={scopes.data}
            canManage={canManage && options.data.can_manage}
            onRefresh={refresh}
            onComplete={() => {
              void queryClient.invalidateQueries({
                queryKey: ['marketing-drip-detail', ...scope, campaignId],
              });
              onComplete();
            }}
            onClose={onClose}
            onTemplatesChanged={() => {
              void options.refetch();
            }}
            onBusyChange={(value) => {
              busy.current = value;
            }}
          />
        ) : (
          <p className="py-8 text-sm text-muted-foreground">Loading campaign…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CampaignForm({
  initial,
  isNew,
  options,
  scopes,
  canManage,
  onRefresh,
  onComplete,
  onClose,
  onTemplatesChanged,
  onBusyChange,
}: {
  initial: MarketingDripDetail;
  isNew: boolean;
  options: Awaited<ReturnType<typeof fetchMarketingDripBuilderOptions>>;
  scopes: Awaited<ReturnType<typeof fetchMarketingAutomationScopeOptions>>;
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onComplete: () => void;
  onClose: () => void;
  onTemplatesChanged: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [form, setForm] = useState(() => structuredClone(initial));
  const requestId = useRef(crypto.randomUUID());
  // A new audience campaign is created first and then saved as an edit; if that
  // second call fails, the retry must edit the campaign that already exists.
  const createdAudience = useRef<{ id: string; version: number } | null>(null);
  const audienceEditRequestId = useRef(crypto.randomUUID());
  const draftRequests = useRef(new Map<string, { requestId: string; id?: string }>());
  const [dirty, setDirty] = useState(false);
  const editable = canManage && (initial.status === 'DRAFT' || initial.status === 'PAUSED');
  const legacy = form.trigger_type === 'AUDIENCE';
  const edit = (next: MarketingDripDetail) => {
    setForm(next);
    setDirty(true);
  };
  const editChannel = (stepIndex: number, channelIndex: number, next: MarketingDripChannel) =>
    edit({
      ...form,
      steps: form.steps.map((step, i) =>
        i === stepIndex
          ? {
              ...step,
              channels: step.channels.map((channel, j) => (j === channelIndex ? next : channel)),
            }
          : step,
      ),
    });
  const changeTrigger = (trigger_type: MarketingDripDetail['trigger_type']) =>
    edit({
      ...form,
      trigger_type,
      trigger_conditions: defaultConditions(trigger_type),
      audience_filter: {},
      // An audience step sends on one channel and takes typed values, not
      // lead fields, so a mapping made for the other kind cannot carry over.
      steps: form.steps.map((step) => ({
        ...step,
        channels: (trigger_type === 'AUDIENCE' ? step.channels.slice(0, 1) : step.channels).map(
          (channel) => ({ ...channel, variable_map: {} }),
        ),
      })),
    });
  const condition = (key: string, value: unknown) =>
    edit({ ...form, trigger_conditions: { ...form.trigger_conditions, [key]: value } });
  const selectedSources = Array.isArray(form.trigger_conditions.sources)
    ? (form.trigger_conditions.sources as string[])
    : [];
  const save = useMutation({
    meta: { toast: false },
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
    mutationFn: async () => {
      const payload = structuredClone(form);
      if (
        payload.trigger_type === 'LEAD_CREATED' &&
        Array.isArray(payload.trigger_conditions.models)
      )
        payload.trigger_conditions.models = payload.trigger_conditions.models
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
      for (const [i, step] of payload.steps.entries()) {
        step.step_order = i + 1;
        for (const channel of step.channels) {
          const template = options.templates.find((t) => t.id === channel.template_id);
          const unchangedLegacy =
            legacy &&
            !channel.template_id &&
            initial.steps.some((old) =>
              old.channels.some(
                (c) =>
                  !c.template_id &&
                  c.channel === channel.channel &&
                  c.body === channel.body &&
                  JSON.stringify(Object.entries(c.variable_map).sort()) ===
                    JSON.stringify(Object.entries(channel.variable_map).sort()),
              ),
            );
          if (unchangedLegacy) continue;
          if (!unchangedLegacy && (!template || (template.body ?? '') !== channel.body)) {
            const key = JSON.stringify([i, channel.channel, channel.body]);
            let draft = draftRequests.current.get(key);
            if (!draft) {
              draft = { requestId: crypto.randomUUID() };
              draftRequests.current.set(key, draft);
            }
            if (!draft.id)
              draft.id = (
                await createMarketingDripTemplate(
                  `${payload.name} - step ${i + 1}`,
                  channel.channel,
                  channel.body,
                  draft.requestId,
                )
              ).id;
            channel.template_id = draft.id;
          }
          const names = placeholders(channel.body);
          channel.variable_map = Object.fromEntries(
            Object.entries(channel.variable_map).filter(([name]) => names.includes(name)),
          );
        }
      }
      if (!isNew) return saveMarketingDripCampaign(payload, requestId.current);
      if (payload.trigger_type !== 'AUDIENCE')
        return saveMarketingDripCampaign(payload, requestId.current, true);
      if (!createdAudience.current) {
        const created = await createMarketingDripCampaign({
          name: payload.name.trim(),
          description: payload.description?.trim() || undefined,
          branchId: payload.branch_id ?? undefined,
          defaultChannel: payload.steps[0].channels[0].channel,
          audienceFilter: payload.audience_filter,
          steps: payload.steps.map((step) => ({
            step_order: step.step_order,
            delay_hours: step.delay_hours,
            channel: step.channels[0].channel,
            message_body: step.channels[0].body.trim(),
          })),
          requestId: requestId.current,
        });
        createdAudience.current = { id: created.id, version: created.version };
      }
      return saveMarketingDripCampaign(
        { ...payload, ...createdAudience.current },
        audienceEditRequestId.current,
      );
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: isNew ? 'Campaign saved as a draft' : 'Campaign saved',
        description: isNew
          ? 'Open it to activate once the provider has approved every template.'
          : 'Message changes use new draft templates and need provider approval before activation.',
      });
      onTemplatesChanged();
      onComplete();
      onClose();
    },
  });
  const status = useMutation({
    meta: { toast: false },
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
    mutationFn: (next: 'ACTIVE' | 'PAUSED') =>
      setMarketingDripStatus(initial.id, next, initial.version),
    onSuccess: async (_, next) => {
      toast.add({
        type: 'success',
        title: next === 'PAUSED' ? 'Campaign paused — ready to edit' : 'Campaign activated',
      });
      await onRefresh();
    },
  });
  const pending = save.isPending || status.isPending;
  const valid =
    form.name.trim().length >= 3 &&
    form.name.trim().length <= 180 &&
    (form.description?.length ?? 0) <= 2000 &&
    form.steps.length > 0 &&
    form.steps.every(
      (step) =>
        Number.isInteger(step.delay_hours) &&
        step.delay_hours >= 0 &&
        step.delay_hours <= 8760 &&
        step.channels.length > 0 &&
        step.channels.every(
          (channel) =>
            channel.body.trim().length > 0 &&
            channel.body.length <= 4000 &&
            placeholders(channel.body).every((p) => Boolean(channel.variable_map[p]?.trim())),
        ),
    );
  const failure = save.error || status.error;
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (editable && valid && !pending) save.mutate();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {isNew ? 'New campaign' : `${initial.status} · ${triggerNames[initial.trigger_type]}`}
        </p>
        {canManage && initial.status === 'ACTIVE' && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => status.mutate('PAUSED')}
          >
            <Pause className="size-4" />
            Pause to edit
          </Button>
        )}
        {canManage && !isNew && (initial.status === 'DRAFT' || initial.status === 'PAUSED') && (
          <Button
            type="button"
            variant="outline"
            disabled={pending || dirty}
            onClick={() => status.mutate('ACTIVE')}
          >
            {initial.status === 'PAUSED' ? 'Resume campaign' : 'Activate campaign'}
          </Button>
        )}
      </div>
      {initial.status === 'ACTIVE' && (
        <p className="text-sm text-muted-foreground">
          Pause this campaign before editing. Pausing cancels queued sends when the dispatcher
          checks them; messages already submitted to a provider cannot be recalled.
        </p>
      )}
      {dirty && !isNew && (
        <p className="text-sm text-muted-foreground">
          Save your changes before activating. Changed message text is saved as a new draft
          template.
        </p>
      )}
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>
            {errorMessage(failure)}{' '}
            <Button
              type="button"
              variant="link"
              disabled={pending}
              onClick={() => void onRefresh()}
            >
              Reload campaign
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <fieldset disabled={!editable || pending} className="space-y-5 disabled:opacity-75">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Campaign name
            <Input
              value={form.name}
              maxLength={180}
              onChange={(e) => edit({ ...form, name: e.target.value })}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Scope
            <Select
              disabled={!editable || pending}
              value={form.branch_id ?? 'organization'}
              onValueChange={(id) =>
                edit({ ...form, branch_id: id === 'organization' ? null : id })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopes.can_use_organization_scope && (
                  <SelectItem value="organization">Organization-wide</SelectItem>
                )}
                {scopes.branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        <label className="grid gap-1.5 text-sm font-medium">
          Description
          <Textarea
            aria-label="Description"
            value={form.description ?? ''}
            rows={2}
            maxLength={2000}
            onChange={(e) => edit({ ...form, description: e.target.value })}
          />
        </label>
        {isNew && (
          <label className="grid gap-1.5 text-sm font-medium">
            Starts when
            <Select
              disabled={pending}
              value={form.trigger_type}
              onValueChange={(value) => changeTrigger(value as MarketingDripDetail['trigger_type'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {triggerOrder.map((trigger) => (
                  <SelectItem key={trigger} value={trigger}>
                    {triggerNames[trigger]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs font-normal text-muted-foreground">
              {triggerHelp[form.trigger_type]}
            </span>
          </label>
        )}
        {legacy && (
          <div className="space-y-4 rounded-md border p-4">
            <p className="text-sm font-medium">Audience rules</p>
            <p className="text-xs text-muted-foreground">
              Leave a filter unselected to include all eligible customers. Dormant leads are always
              excluded.
            </p>
            {[
              {
                key: 'lifecycle_status',
                label: 'Lead stages',
                values: [
                  'New',
                  'Contacted',
                  'Qualified',
                  'Appointment Scheduled',
                  'Transferred to Sales',
                  'Lost',
                ],
              },
              { key: 'temperature', label: 'Lead temperatures', values: ['HOT', 'WARM', 'COLD'] },
              { key: 'source', label: 'Lead sources', values: options.sources },
            ].map(({ key, label, values }) => {
              const selected = Array.isArray(form.audience_filter[key])
                ? (form.audience_filter[key] as string[])
                : [];
              return (
                <div key={key} className="space-y-2">
                  <p className="text-sm font-medium">{label}</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {values.map((value) => (
                      <label key={value} className="flex items-center gap-2 text-sm">
                        <Input
                          type="checkbox"
                          className="size-4 shrink-0"
                          checked={selected.includes(value)}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...selected, value]
                              : selected.filter((item) => item !== value);
                            const audience_filter = { ...form.audience_filter };
                            if (next.length) audience_filter[key] = next;
                            else delete audience_filter[key];
                            edit({ ...form, audience_filter });
                          }}
                        />
                        {value}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
            <label className="grid gap-1.5 text-sm font-medium">
              Leads created within days (blank means any age)
              <Input
                type="number"
                min={1}
                max={3650}
                value={
                  typeof form.audience_filter.created_within_days === 'number'
                    ? form.audience_filter.created_within_days
                    : ''
                }
                onChange={(e) => {
                  const audience_filter = { ...form.audience_filter };
                  if (e.target.value) audience_filter.created_within_days = Number(e.target.value);
                  else delete audience_filter.created_within_days;
                  edit({ ...form, audience_filter });
                }}
              />
            </label>
          </div>
        )}
        {form.trigger_type === 'LEAD_CREATED' && (
          <div className="space-y-4 rounded-md border p-4">
            <p className="text-sm font-medium">
              Lead sources{' '}
              <span className="font-normal text-muted-foreground">(none selected means all)</span>
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {options.sources.map((source) => (
                <label className="flex items-center gap-2 text-sm" key={source}>
                  <Input
                    type="checkbox"
                    className="size-4 shrink-0"
                    disabled={!editable || pending}
                    checked={selectedSources.includes(source)}
                    onChange={(event) =>
                      condition(
                        'sources',
                        event.target.checked
                          ? [...selectedSources, source]
                          : selectedSources.filter((s) => s !== source),
                      )
                    }
                  />
                  {source}
                </label>
              ))}
            </div>
            <label className="grid gap-1.5 text-sm font-medium">
              Email availability
              <Select
                disabled={!editable || pending}
                value={String(form.trigger_conditions.email_presence ?? 'ANY')}
                onValueChange={(value) => condition('email_presence', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ANY">Any</SelectItem>
                  <SelectItem value="PRESENT">Email provided</SelectItem>
                  <SelectItem value="MISSING">No email — SMS fallback</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Interested models (one per line; blank means all)
              <Textarea
                aria-label="Interested models"
                rows={2}
                value={
                  Array.isArray(form.trigger_conditions.models)
                    ? form.trigger_conditions.models.join('\n')
                    : ''
                }
                onChange={(e) => condition('models', e.target.value.split('\n'))}
              />
            </label>
          </div>
        )}
        {['BIRTHDAY', 'ANNIVERSARY', 'DELIVERY_ANNIVERSARY'].includes(form.trigger_type) && (
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ['days_before', 'Days before', 30, 0],
              ['send_hour', 'Send hour (0–23)', 23, 10],
            ].map(([key, label, max, fallback]) => (
              <label className="grid gap-1.5 text-sm font-medium" key={key}>
                {label}
                <Input
                  type="number"
                  min={0}
                  max={Number(max)}
                  value={Number(form.trigger_conditions[String(key)] ?? fallback)}
                  onChange={(e) => condition(String(key), Number(e.target.value))}
                />
              </label>
            ))}
          </div>
        )}
        <div className="space-y-4">
          <p className="text-sm font-medium">
            Sequence steps{' '}
            <span className="font-normal text-muted-foreground">
              · delays are from the previous step
            </span>
          </p>
          {form.steps.map((step, i) => (
            <div className="space-y-4 rounded-lg border p-4" key={i}>
              <div className="flex items-end gap-3">
                <label className="grid max-w-44 gap-1.5 text-sm font-medium">
                  Step {i + 1}: delay hours
                  <Input
                    aria-label={`Step ${i + 1} delay hours`}
                    type="number"
                    min={0}
                    max={8760}
                    value={step.delay_hours}
                    onChange={(e) =>
                      edit({
                        ...form,
                        steps: form.steps.map((s, n) =>
                          n === i ? { ...s, delay_hours: Number(e.target.value) } : s,
                        ),
                      })
                    }
                  />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove step ${i + 1}`}
                  disabled={form.steps.length === 1}
                  onClick={() => edit({ ...form, steps: form.steps.filter((_, n) => n !== i) })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              {step.channels.map((channel, j) => (
                <div className="space-y-3 rounded-md bg-muted/30 p-3" key={j}>
                  <div className="grid gap-3 sm:grid-cols-[150px_1fr_auto]">
                    <label className="grid gap-1.5 text-sm font-medium">
                      Channel
                      <Select
                        disabled={!editable || pending}
                        value={channel.channel}
                        onValueChange={(value) =>
                          editChannel(i, j, {
                            channel: value as MarketingDripChannel['channel'],
                            template_id: null,
                            variable_map: {},
                            body: '',
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {channelNames
                            .filter(
                              (c) =>
                                c === channel.channel ||
                                !step.channels.some((s) => s.channel === c),
                            )
                            .map((c) => (
                              <SelectItem key={c} value={c}>
                                {c}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Template
                      <Select
                        disabled={!editable || pending}
                        value={channel.template_id ?? 'custom'}
                        onValueChange={(id) => {
                          const t = options.templates.find((t) => t.id === id);
                          editChannel(i, j, {
                            ...channel,
                            template_id: t?.id ?? null,
                            variable_map: {},
                            body: t?.body ?? channel.body,
                          });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a template" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="custom">Custom message (draft)</SelectItem>
                          {options.templates
                            .filter((t) => t.channel === channel.channel)
                            .map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.name} ({t.status.toLowerCase()})
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </label>
                    {!legacy && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${channel.channel} from step ${i + 1}`}
                        disabled={step.channels.length === 1}
                        onClick={() =>
                          edit({
                            ...form,
                            steps: form.steps.map((s, n) =>
                              n === i
                                ? { ...s, channels: s.channels.filter((_, c) => c !== j) }
                                : s,
                            ),
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  {!options.channels[channel.channel] && (
                    <p className="text-xs text-amber-700">
                      {channel.channel === 'WHATSAPP' ? 'WhatsApp' : channel.channel} is not
                      connected yet. Connect it in Tools before activating this campaign.
                    </p>
                  )}
                  {channel.channel === 'EMAIL' ? (
                    <EmailMessageEditor
                      ariaLabel={`Step ${i + 1} ${channel.channel} message`}
                      value={channel.body}
                      variableMap={channel.variable_map}
                      literalVariables={legacy}
                      disabled={!editable || pending}
                      onChange={(body) => editChannel(i, j, { ...channel, body })}
                    />
                  ) : (
                    <>
                      <label className="grid gap-1.5 text-sm font-medium">
                        Message
                        <Textarea
                          aria-label={`Step ${i + 1} ${channel.channel} message`}
                          value={channel.body}
                          rows={3}
                          maxLength={4000}
                          onChange={(e) => editChannel(i, j, { ...channel, body: e.target.value })}
                        />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Use {'{{NAME}}'} for a variable. Edited text creates a draft template and
                        needs provider approval.
                      </p>
                    </>
                  )}
                  {placeholders(channel.body).map((p) => (
                    <label className="grid gap-1.5 text-sm font-medium" key={p}>
                      {p}
                      {legacy ? (
                        <Input
                          maxLength={500}
                          value={channel.variable_map[p] ?? ''}
                          placeholder="Value for this audience message"
                          onChange={(e) =>
                            editChannel(i, j, {
                              ...channel,
                              variable_map: { ...channel.variable_map, [p]: e.target.value },
                            })
                          }
                        />
                      ) : (
                        <Select
                          disabled={!editable || pending}
                          value={channel.variable_map[p] ?? ''}
                          onValueChange={(token) =>
                            editChannel(i, j, {
                              ...channel,
                              variable_map: { ...channel.variable_map, [p]: token },
                            })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a lead or customer field" />
                          </SelectTrigger>
                          <SelectContent>
                            {options.tokens.map((token) => (
                              <SelectItem key={token} value={token}>
                                {token.replaceAll('_', ' ')}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </label>
                  ))}
                </div>
              ))}
              {!legacy && step.channels.length < 3 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const channel = channelNames.find(
                      (c) => !step.channels.some((s) => s.channel === c),
                    )!;
                    edit({
                      ...form,
                      steps: form.steps.map((s, n) =>
                        n === i
                          ? {
                              ...s,
                              channels: [
                                ...s.channels,
                                { channel, template_id: null, body: '', variable_map: {} },
                              ],
                            }
                          : s,
                      ),
                    });
                  }}
                >
                  <Plus className="size-4" />
                  Add channel
                </Button>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={form.steps.length >= 24}
            onClick={() =>
              edit({
                ...form,
                steps: [
                  ...form.steps,
                  {
                    step_order: form.steps.length + 1,
                    delay_hours: 24,
                    channels: [{ channel: 'EMAIL', template_id: null, body: '', variable_map: {} }],
                  },
                ],
              })
            }
          >
            <Plus className="size-4" />
            Add step
          </Button>
        </div>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          Close
        </Button>
        {editable && (
          <Button type="submit" disabled={!valid || pending || !dirty}>
            {save.isPending ? 'Saving…' : isNew ? 'Save draft' : 'Save changes'}
          </Button>
        )}
      </div>
    </form>
  );
}
