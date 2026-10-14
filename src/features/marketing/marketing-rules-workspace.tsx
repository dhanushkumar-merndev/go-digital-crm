'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Bell, ListRestart, Pencil, Plus, Workflow, Zap } from 'lucide-react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { MarketingAutomationSkeleton } from '@/components/skeletons';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { Switch } from '@/components/ui/switch';
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
import type { PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  fetchMarketingAutomationScopeOptions,
  fetchMarketingDripBuilderOptions,
} from './marketing-automation-api';
import {
  automationEvents,
  fetchMarketingAutomations,
  saveMarketingAutomation,
  setMarketingAutomationState,
  type AutomationAction,
  type AutomationConditions,
  type AutomationEvent,
  type MarketingAutomationRule,
  type MarketingAutomationsWorkspace,
} from './marketing-rules-api';

const workspaceKey = ['marketing-automations'] as const;

const eventNames: Record<AutomationEvent, string> = {
  LEAD_CREATED: 'A new lead arrives',
  LEAD_STAGE_CHANGED: 'A lead moves to a stage',
  LEAD_TEMPERATURE_CHANGED: "A lead's temperature changes",
  TEST_DRIVE_COMPLETED: 'A test drive is completed',
  BOOKING_CONFIRMED: 'A booking is confirmed',
  VEHICLE_DELIVERED: 'A vehicle is delivered',
};
const stages = [
  'New',
  'Contacted',
  'Qualified',
  'Appointment Scheduled',
  'Transferred to Sales',
  'Lost',
];
const temperatures = ['HOT', 'WARM', 'COLD', 'DORMANT'];

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function errorMessage(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (message.includes('VERSION_CONFLICT'))
    return 'This automation changed while you were editing. Reload the page and try again.';
  if (message.includes('AUTOMATION_DRIP_NOT_ACTIVE'))
    return 'Activate the selected drip campaign before switching this automation on.';
  if (message.includes('AUTOMATION_DRIP_SCOPE_MISMATCH'))
    return 'The selected drip campaign belongs to a different branch than this automation.';
  if (message.includes('AUTOMATION_DRIP_NOT_FOUND'))
    return 'Choose a drip campaign that starts from an automation.';
  if (message.includes('INVALID_AUTOMATION_CONDITIONS'))
    return 'Check the conditions: a stage or temperature change needs at least one value.';
  if (message.includes('SCOPE') || message.includes('PERMISSION'))
    return 'You do not have permission to change automations in this scope.';
  return 'Could not save the automation. Check the fields and try again.';
}

function toggleValue(list: string[], value: string, checked: boolean) {
  return checked ? [...new Set([...list, value])] : list.filter((item) => item !== value);
}

function CheckboxList({
  label,
  values,
  selected,
  onChange,
  hint,
}: {
  label: string;
  values: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {label} {hint ? <span className="font-normal text-muted-foreground">({hint})</span> : null}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {values.map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <Input
              type="checkbox"
              className="size-4 shrink-0"
              checked={selected.includes(value)}
              onChange={(event) => onChange(toggleValue(selected, value, event.target.checked))}
            />
            {value}
          </label>
        ))}
      </div>
    </div>
  );
}

type FormState = {
  name: string;
  description: string;
  branchId: string | null;
  eventType: AutomationEvent;
  conditions: AutomationConditions;
  startDrip: boolean;
  dripId: string;
  notify: boolean;
  notifyTitle: string;
  notifyMessage: string;
  includeTeamManager: boolean;
};

function initialForm(
  rule: MarketingAutomationRule | null,
  canUseOrganization: boolean,
  firstBranch: string | null,
): FormState {
  const drip = rule?.actions.find((action) => action.type === 'START_DRIP');
  const notify = rule?.actions.find((action) => action.type === 'NOTIFY_OWNER');
  return {
    name: rule?.name ?? '',
    description: rule?.description ?? '',
    branchId: rule ? rule.branch_id : canUseOrganization ? null : firstBranch,
    eventType: rule?.event_type ?? 'LEAD_CREATED',
    conditions: rule?.conditions ?? { sources: [], models: [], temperatures: [], stages: [] },
    startDrip: Boolean(drip),
    dripId: drip?.type === 'START_DRIP' ? drip.campaign_id : '',
    notify: Boolean(notify),
    notifyTitle: notify?.type === 'NOTIFY_OWNER' ? notify.title : '',
    notifyMessage: notify?.type === 'NOTIFY_OWNER' ? notify.message : '',
    includeTeamManager: notify?.type === 'NOTIFY_OWNER' ? notify.include_team_manager : false,
  };
}

function AutomationDialog({
  rule,
  open,
  workspace,
  onClose,
  onSaved,
}: {
  rule: MarketingAutomationRule | null;
  open: boolean;
  workspace: MarketingAutomationsWorkspace;
  onClose: () => void;
  onSaved: () => void;
}) {
  const scope = workspaceQueryScope(useWorkspaceSession());
  const scopes = useQuery({
    queryKey: ['marketing-automation-scope-options', ...scope],
    queryFn: ({ signal }) => fetchMarketingAutomationScopeOptions(signal),
    enabled: open,
  });
  const builder = useQuery({
    queryKey: ['marketing-drip-builder-options', ...scope],
    queryFn: ({ signal }) => fetchMarketingDripBuilderOptions(signal),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit automation' : 'Create automation'}</DialogTitle>
          <DialogDescription>
            When the event happens and the conditions match, the actions run once for that event.
          </DialogDescription>
        </DialogHeader>
        {scopes.isError || builder.isError ? (
          <Alert variant="destructive">
            <AlertDescription>Unable to load the options for this form.</AlertDescription>
          </Alert>
        ) : scopes.data && builder.data ? (
          <AutomationForm
            key={rule ? `${rule.id}:${rule.version}` : 'new'}
            rule={rule}
            workspace={workspace}
            scopes={scopes.data}
            sources={builder.data.sources}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : (
          <p className="py-8 text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AutomationForm({
  rule,
  workspace,
  scopes,
  sources,
  onClose,
  onSaved,
}: {
  rule: MarketingAutomationRule | null;
  workspace: MarketingAutomationsWorkspace;
  scopes: Awaited<ReturnType<typeof fetchMarketingAutomationScopeOptions>>;
  sources: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(() =>
    initialForm(rule, scopes.can_use_organization_scope, scopes.branches[0]?.id ?? null),
  );
  const requestId = useRef(crypto.randomUUID());
  const set = (next: Partial<FormState>) => setForm((current) => ({ ...current, ...next }));
  const setConditions = (next: Partial<AutomationConditions>) =>
    setForm((current) => ({ ...current, conditions: { ...current.conditions, ...next } }));
  // A drip scoped to one branch can only be started by a rule in that branch.
  const dripOptions = workspace.drip_options.filter(
    (drip) => !drip.branch_id || drip.branch_id === form.branchId,
  );
  const leadEvent = !['BOOKING_CONFIRMED', 'VEHICLE_DELIVERED', 'TEST_DRIVE_COMPLETED'].includes(
    form.eventType,
  );
  const save = useMutation({
    meta: { toast: false },
    mutationFn: () => {
      const actions: AutomationAction[] = [];
      if (form.startDrip) actions.push({ type: 'START_DRIP', campaign_id: form.dripId });
      if (form.notify)
        actions.push({
          type: 'NOTIFY_OWNER',
          title: form.notifyTitle.trim(),
          message: form.notifyMessage.trim(),
          include_team_manager: form.includeTeamManager,
        });
      return saveMarketingAutomation(
        {
          name: form.name.trim(),
          description: form.description.trim() || null,
          branchId: form.branchId,
          eventType: form.eventType,
          conditions: {
            ...form.conditions,
            stages: form.eventType === 'LEAD_STAGE_CHANGED' ? form.conditions.stages : [],
            models: form.conditions.models.map((model) => model.trim()).filter(Boolean),
          },
          actions,
        },
        rule ? { id: rule.id, version: rule.version } : null,
        requestId.current,
      );
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: rule ? 'Automation saved' : 'Automation created',
        description: rule
          ? rule.enabled
            ? 'Changes apply to events from now on.'
            : 'Switch it on from the list when you are ready.'
          : 'It starts switched off. Switch it on from the list when you are ready.',
      });
      onSaved();
      onClose();
    },
  });
  const valid =
    form.name.trim().length >= 3 &&
    form.name.trim().length <= 180 &&
    (form.startDrip || form.notify) &&
    (!form.startDrip || Boolean(form.dripId)) &&
    (!form.notify ||
      (form.notifyTitle.trim().length >= 3 &&
        form.notifyTitle.trim().length <= 120 &&
        form.notifyMessage.trim().length >= 1 &&
        form.notifyMessage.trim().length <= 500)) &&
    (form.eventType !== 'LEAD_STAGE_CHANGED' || form.conditions.stages.length > 0) &&
    (form.eventType !== 'LEAD_TEMPERATURE_CHANGED' || form.conditions.temperatures.length > 0) &&
    (form.branchId !== null || scopes.can_use_organization_scope);
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !save.isPending) save.mutate();
      }}
    >
      {save.error ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(save.error)}</AlertDescription>
        </Alert>
      ) : null}
      <fieldset disabled={save.isPending} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Automation name
            <Input
              value={form.name}
              maxLength={180}
              placeholder="Hot lead alert"
              onChange={(event) => set({ name: event.target.value })}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Scope
            <Select
              value={form.branchId ?? 'organization'}
              onValueChange={(value) =>
                set({ branchId: value === 'organization' ? null : value, dripId: '' })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopes.can_use_organization_scope && (
                  <SelectItem value="organization">Organization-wide</SelectItem>
                )}
                {scopes.branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
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
            rows={2}
            maxLength={2000}
            value={form.description}
            onChange={(event) => set({ description: event.target.value })}
          />
        </label>

        <div className="space-y-4 rounded-md border p-4">
          <label className="grid gap-1.5 text-sm font-medium">
            When
            <Select
              value={form.eventType}
              onValueChange={(value) => set({ eventType: value as AutomationEvent })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {automationEvents.map((event) => (
                  <SelectItem key={event} value={event}>
                    {eventNames[event]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {form.eventType === 'LEAD_STAGE_CHANGED' && (
            <CheckboxList
              label="Moves to"
              values={stages}
              selected={form.conditions.stages}
              onChange={(next) => setConditions({ stages: next })}
              hint="choose at least one"
            />
          )}
          <CheckboxList
            label={
              form.eventType === 'LEAD_TEMPERATURE_CHANGED'
                ? 'Becomes'
                : 'Only when the lead temperature is'
            }
            values={temperatures}
            selected={form.conditions.temperatures}
            onChange={(next) => setConditions({ temperatures: next })}
            hint={
              form.eventType === 'LEAD_TEMPERATURE_CHANGED'
                ? 'choose at least one'
                : 'none selected means any'
            }
          />
          <CheckboxList
            label="Only for lead sources"
            values={sources}
            selected={form.conditions.sources}
            onChange={(next) => setConditions({ sources: next })}
            hint="none selected means all"
          />
          <label className="grid gap-1.5 text-sm font-medium">
            Only for interested models (one per line; blank means all)
            <Textarea
              aria-label="Interested models"
              rows={2}
              value={form.conditions.models.join('\n')}
              onChange={(event) => setConditions({ models: event.target.value.split('\n') })}
            />
          </label>
          {!leadEvent && (
            <p className="text-xs text-muted-foreground">
              Source, model and temperature are read from the lead behind the booking, test drive or
              delivery. Leave them empty to include every one.
            </p>
          )}
        </div>

        <div className="space-y-4 rounded-md border p-4">
          <p className="text-sm font-medium">Then</p>
          <label className="flex items-center gap-2 text-sm">
            <Input
              type="checkbox"
              className="size-4 shrink-0"
              checked={form.startDrip}
              onChange={(event) => set({ startDrip: event.target.checked })}
            />
            Start a drip campaign
          </label>
          {form.startDrip && (
            <div className="space-y-2 pl-6">
              <Select value={form.dripId} onValueChange={(value) => set({ dripId: value })}>
                <SelectTrigger aria-label="Drip campaign">
                  <SelectValue placeholder="Choose a drip campaign" />
                </SelectTrigger>
                <SelectContent>
                  {dripOptions.map((drip) => (
                    <SelectItem key={drip.id} value={drip.id}>
                      {drip.name} ({drip.status.toLowerCase()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {dripOptions.length
                  ? 'Only drips set to “Started by an automation” are listed. The drip must be active before this automation can be switched on. Dormant leads and opted-out customers are never messaged.'
                  : 'No drip starts from an automation yet. In Drip Campaigns, create one and choose “Started by an automation”.'}
              </p>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Input
              type="checkbox"
              className="size-4 shrink-0"
              checked={form.notify}
              onChange={(event) => set({ notify: event.target.checked })}
            />
            Notify the lead owner in the CRM
          </label>
          {form.notify && (
            <div className="grid gap-3 pl-6">
              <Input
                aria-label="Notification title"
                maxLength={120}
                placeholder="Hot lead — call now"
                value={form.notifyTitle}
                onChange={(event) => set({ notifyTitle: event.target.value })}
              />
              <Textarea
                aria-label="Notification message"
                rows={2}
                maxLength={500}
                placeholder="The customer's name is added automatically."
                value={form.notifyMessage}
                onChange={(event) => set({ notifyMessage: event.target.value })}
              />
              <label className="flex items-center gap-2 text-sm">
                <Input
                  type="checkbox"
                  className="size-4 shrink-0"
                  checked={form.includeTeamManager}
                  onChange={(event) => set({ includeTeamManager: event.target.checked })}
                />
                Also notify the team manager
              </label>
            </div>
          )}
        </div>
      </fieldset>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || save.isPending}>
          {save.isPending ? 'Saving…' : rule ? 'Save changes' : 'Create automation'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function runResult(run: MarketingAutomationsWorkspace['recent_runs'][number]) {
  const parts = [];
  if (run.drip_state === 'REQUESTED') parts.push('Drip started');
  if (run.drip_state === 'CAMPAIGN_NOT_ACTIVE') parts.push('Drip not active — nothing sent');
  if (run.notified) parts.push('Owner notified');
  return parts.join(' · ') || run.status.toLowerCase();
}

export function MarketingRulesWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const scope = useMemo(() => workspaceQueryScope(session), [session]);
  const queryClient = useQueryClient();
  const queryKey = [...workspaceKey, ...scope];
  const workspace = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchMarketingAutomations(signal),
  });
  useTenantRealtimeInvalidation(workspace.data?.organization_id, [
    { resource: 'marketing', queryKeys: [queryKey] },
  ]);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey });
  const [editing, setEditing] = useState<MarketingAutomationRule | 'new' | null>(null);
  const [archiving, setArchiving] = useState<MarketingAutomationRule | null>(null);
  const state = useMutation({
    meta: { toast: false },
    mutationFn: (input: {
      rule: MarketingAutomationRule;
      state: 'ENABLED' | 'DISABLED' | 'ARCHIVED';
    }) => setMarketingAutomationState(input.rule.id, input.state, input.rule.version),
    onSuccess: (_, input) => {
      toast.add({
        type: 'success',
        title:
          input.state === 'ENABLED'
            ? 'Automation switched on'
            : input.state === 'DISABLED'
              ? 'Automation switched off'
              : 'Automation archived',
        description:
          input.state === 'ENABLED' ? 'It acts on events from now on, within a minute.' : undefined,
      });
      setArchiving(null);
      invalidate();
    },
    onError: (error) =>
      toast.add({ type: 'error', title: 'Not changed', description: errorMessage(error) }),
  });

  if (workspace.isPending) return <MarketingAutomationSkeleton />;
  if (workspace.isError || !workspace.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Alert variant="destructive">
          <AlertDescription>
            {workspace.error && 'code' in workspace.error && workspace.error.code === '42501'
              ? 'Marketing automation permission and an authorized tenant scope are required.'
              : 'Unable to load automations.'}{' '}
            <Button variant="link" onClick={() => void workspace.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  const data = workspace.data;
  const metrics = [
    {
      label: 'Automations',
      value: String(data.kpis.total),
      helper: 'In your scope',
      icon: Workflow,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Switched on',
      value: String(data.kpis.enabled),
      helper: 'Acting on new events',
      icon: Zap,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Runs today',
      value: String(data.kpis.runs_today),
      helper: 'Events acted on',
      icon: Bell,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Drips started',
      value: String(data.kpis.drips_started_7d),
      helper: 'Last 7 days',
      icon: ListRestart,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];
  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <PageHeader
        spec={{
          ...spec,
          title: spec.title || 'Automations',
          description:
            'When something happens to a lead, start a drip or alert the team — switch each rule on or off.',
          primaryAction: undefined,
        }}
      />
      {data.can_manage ? (
        <div className="flex justify-end">
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" /> Create automation
          </Button>
        </div>
      ) : null}
      <KpiGrid metrics={metrics} />
      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base">Automations</CardTitle>
          <CardDescription>
            Each event is acted on once. Switching a rule on never replays earlier events.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Automation</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Then</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Runs (30 days)</TableHead>
                  <TableHead>On</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rules.length ? (
                  data.rules.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell>
                        <p className="font-medium">{rule.name}</p>
                        {rule.description ? (
                          <p className="max-w-xs truncate text-xs text-muted-foreground">
                            {rule.description}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-64 text-sm">
                        {rule.condition_summary ?? eventNames[rule.event_type]}
                      </TableCell>
                      <TableCell className="max-w-64 text-sm">{rule.action_summary}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {rule.branch_name ?? 'Organization-wide'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {rule.runs_30d}
                        <span className="block text-xs text-muted-foreground">
                          Last: {formatDate(rule.last_run_at)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={rule.enabled}
                          disabled={!data.can_manage || state.isPending}
                          aria-label={`${rule.enabled ? 'Switch off' : 'Switch on'} ${rule.name}`}
                          onCheckedChange={(checked) =>
                            state.mutate({ rule, state: checked ? 'ENABLED' : 'DISABLED' })
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {data.can_manage ? (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${rule.name}`}
                              onClick={() => setEditing(rule)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Archive ${rule.name}`}
                              onClick={() => setArchiving(rule)}
                            >
                              <Archive className="size-4" />
                            </Button>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="h-44 text-center">
                      <p className="font-medium">No automations yet</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Create one to start a drip or alert the owner when a lead event happens.
                      </p>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base">Recent runs</CardTitle>
          <CardDescription>The last 25 events an automation acted on.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Automation</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recent_runs.length ? (
                  data.recent_runs.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDate(run.started_at)}
                      </TableCell>
                      <TableCell>{run.rule_name}</TableCell>
                      <TableCell>{run.customer_name ?? '—'}</TableCell>
                      <TableCell>
                        <Badge
                          variant={run.drip_state === 'CAMPAIGN_NOT_ACTIVE' ? 'warning' : 'success'}
                        >
                          {runResult(run)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      Nothing has run yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <AutomationDialog
        open={editing !== null}
        rule={editing === 'new' ? null : editing}
        workspace={data}
        onClose={() => setEditing(null)}
        onSaved={invalidate}
      />
      <Dialog open={archiving !== null} onOpenChange={(next) => !next && setArchiving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this automation?</DialogTitle>
            <DialogDescription>
              {archiving?.name} stops acting on events and is removed from this list. Its run
              history is kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={state.isPending}
              onClick={() => archiving && state.mutate({ rule: archiving, state: 'ARCHIVED' })}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
