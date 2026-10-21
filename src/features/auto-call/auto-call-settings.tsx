'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Bot, Copy, PhoneCall, Plus, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { AiCallScriptDialog } from './ai-call-script-dialog';
import { aiCallLanguageLabel, aiCallScriptSchema } from './ai-call-script-definition';
import {
  archiveAutoIvrFlow,
  autoCallAdminKey,
  autoCallErrorMessage,
  fetchAutoCallAdminWorkspace,
  pausedReasonLabels,
  saveAutoCallAiSettings,
  saveAutoCallSettings,
  saveAutoIvrFlowDraft,
  savePiopiyConnection,
  type AutoCallAdminWorkspace,
  type AutoCallMode,
} from './auto-call-api';
import { starterDefinition } from './auto-ivr-definition';

export const autoIvrLanguages = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'ta-IN', label: 'Tamil' },
  { value: 'te-IN', label: 'Telugu' },
  { value: 'kn-IN', label: 'Kannada' },
  { value: 'ml-IN', label: 'Malayalam' },
  { value: 'mr-IN', label: 'Marathi' },
  { value: 'bn-IN', label: 'Bengali' },
  { value: 'gu-IN', label: 'Gujarati' },
] as const;

function ConnectionDialog({
  organizationId,
  existing,
  onClose,
}: {
  organizationId: string;
  existing: AutoCallAdminWorkspace['connections'][number] | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [language, setLanguage] = useState('en-IN');
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const save = useMutation({
    meta: { toast: false },
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return savePiopiyConnection({
        organizationId,
        connectionId: existing?.id,
        displayName: String(data.get('displayName') ?? '').trim(),
        appId: String(data.get('appId') ?? '').trim(),
        token: String(data.get('token') ?? ''),
        callerId: String(data.get('callerId') ?? '').trim(),
        defaultLanguage: language,
        defaultVoiceId: String(data.get('voiceId') ?? '').trim() || 'female',
        agentId: String(data.get('agentId') ?? '').trim(),
      });
    },
    onSuccess: async (result) => {
      setWebhookUrl(result.status_webhook_url);
      await queryClient.invalidateQueries({ queryKey: autoCallAdminKey });
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {existing ? 'Replace PIOPIY connection' : 'Connect TeleCMI PIOPIY'}
          </DialogTitle>
          <DialogDescription>
            Auto calls dial through your PIOPIY number. The token is stored encrypted and never
            shown again; leave it empty to keep the saved one.
          </DialogDescription>
        </DialogHeader>
        {webhookUrl ? (
          <div className="grid gap-3">
            <Alert>
              <AlertTitle>Saved. One step left in the PIOPIY dashboard</AlertTitle>
              <AlertDescription>
                Set this as the call status (CDR) webhook for your PIOPIY app, so finished calls
                close at once and recordings arrive.
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Input readOnly value={webhookUrl} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy webhook URL"
                onClick={() => {
                  void navigator.clipboard.writeText(webhookUrl);
                  toast.add({ type: 'success', title: 'Webhook URL copied' });
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(event.currentTarget);
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="piopiy-name">Connection name</Label>
              <Input
                id="piopiy-name"
                name="displayName"
                required
                minLength={2}
                maxLength={120}
                defaultValue={existing?.display_name ?? 'TeleCMI PIOPIY'}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="piopiy-app">App ID</Label>
                <Input id="piopiy-app" name="appId" required maxLength={80} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="piopiy-caller">Caller ID (PIOPIY number)</Label>
                <Input
                  id="piopiy-caller"
                  name="callerId"
                  required
                  inputMode="tel"
                  placeholder="91XXXXXXXXXX"
                  defaultValue={existing?.caller_id_label ?? ''}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="piopiy-token">API token</Label>
              <PasswordInput
                id="piopiy-token"
                name="token"
                autoComplete="off"
                required={!existing}
                placeholder={existing ? 'Leave empty to keep the saved token' : ''}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="piopiy-agent">AI agent ID (optional)</Label>
              <Input
                id="piopiy-agent"
                name="agentId"
                maxLength={80}
                pattern="[A-Za-z0-9-]{8,80}"
                defaultValue={existing?.agent_id ?? ''}
                placeholder="Uses the platform AI agent when empty"
              />
              <p className="text-xs text-muted-foreground">
                From PIOPIY Voice AI Agents. Only needed if this dealership runs its own agent.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Keypad voice language</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {autoIvrLanguages.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="piopiy-voice">Voice ID</Label>
                <Input id="piopiy-voice" name="voiceId" maxLength={40} placeholder="female" />
              </div>
            </div>
            {save.isError ? (
              <p className="text-sm text-destructive">
                {save.error instanceof Error ? save.error.message : 'The connection was not saved.'}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save connection'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

const modeOptions: { value: AutoCallMode; label: string; description: string }[] = [
  {
    value: 'AI_AGENT',
    label: 'AI agent',
    description: 'An AI talks with the customer in their language and asks your questions.',
  },
  {
    value: 'KEYPAD_IVR',
    label: 'Keypad IVR',
    description: 'A recorded menu plays and the customer answers on the keypad.',
  },
];

function CallModeForm({
  workspace,
  onEditScript,
}: {
  workspace: AutoCallAdminWorkspace;
  onEditScript: (mode: AutoCallMode) => void;
}) {
  const queryClient = useQueryClient();
  const settings = workspace.settings;
  const [mode, setMode] = useState<AutoCallMode>(settings.mode);
  const [creditCost, setCreditCost] = useState(String(settings.ai_credit_cost));
  const script = aiCallScriptSchema.safeParse(settings.ai_script);
  const save = useMutation({
    meta: { toast: false },
    mutationFn: () =>
      saveAutoCallAiSettings({
        mode,
        script: script.success ? script.data : null,
        creditCost: Number(creditCost),
        expectedVersion: settings.version,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: autoCallAdminKey });
      toast.add({ type: 'success', title: 'Call mode saved' });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Call mode was not saved',
        description: autoCallErrorMessage(error, 'Check the values and try again.'),
      }),
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {modeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={mode === option.value}
            onClick={() => setMode(option.value)}
            className={`rounded-lg border p-3 text-left transition-colors ${
              mode === option.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
            }`}
          >
            <p className="text-sm font-medium">{option.label}</p>
            <p className="text-xs text-muted-foreground">{option.description}</p>
          </button>
        ))}
      </div>
      {mode === 'AI_AGENT' ? (
        <div className="grid gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-0.5">
              <p className="text-sm font-medium">
                {script.success
                  ? `${script.data.agent_name} · ${script.data.questions.length} questions`
                  : 'No script yet'}
              </p>
              <p className="text-xs text-muted-foreground">
                {script.success
                  ? `Speaks ${script.data.languages.map(aiCallLanguageLabel).join(', ')}; starts in ${aiCallLanguageLabel(script.data.default_language)}`
                  : 'Write the questions the AI should ask before switching Auto call on.'}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => onEditScript(mode)}>
              <SquarePen className="size-4" /> {script.success ? 'Edit script' : 'Write script'}
            </Button>
          </div>
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="ai-credit-cost">AI credits per answered call</Label>
            <Input
              id="ai-credit-cost"
              type="number"
              min={0}
              max={100}
              required
              value={creditCost}
              onChange={(event) => setCreditCost(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Charged only when the customer talks to the AI; unanswered calls are free. Balance:{' '}
            {workspace.ai_credit_balance.toLocaleString('en-IN')} credits. Auto call pauses when it
            runs out.
          </p>
        </div>
      ) : null}
      <div>
        <Button
          type="submit"
          disabled={
            save.isPending ||
            (mode === settings.mode && Number(creditCost) === settings.ai_credit_cost)
          }
        >
          {save.isPending ? 'Saving…' : 'Save call mode'}
        </Button>
      </div>
    </form>
  );
}

function SettingsForm({ workspace }: { workspace: AutoCallAdminWorkspace }) {
  const queryClient = useQueryClient();
  const settings = workspace.settings;
  const published = workspace.flows.filter((flow) => flow.status === 'PUBLISHED');
  const [enabled, setEnabled] = useState(settings.enabled);
  const [flowId, setFlowId] = useState(settings.default_flow_id ?? '');
  const save = useMutation({
    meta: { toast: false },
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return saveAutoCallSettings({
        enabled,
        defaultFlowId: flowId || null,
        windowStart: String(data.get('windowStart')),
        windowEnd: String(data.get('windowEnd')),
        maxAttempts: Number(data.get('maxAttempts')),
        retryAfterMinutes: Number(data.get('retryAfterMinutes')),
        ringTimeoutSec: Number(data.get('ringTimeoutSec')),
        maxDurationSec: Number(data.get('maxDurationSec')),
        expectedVersion: settings.version,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: autoCallAdminKey });
      toast.add({ type: 'success', title: 'Auto-call settings saved' });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Settings were not saved',
        description: autoCallErrorMessage(error, 'Check the values and try again.'),
      }),
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(event.currentTarget);
      }}
    >
      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">Allow telecallers to use Auto call</p>
          <p className="text-xs text-muted-foreground">
            Each telecaller still switches it on for their own leads.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Allow Auto call" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {settings.mode === 'KEYPAD_IVR' ? (
          <div className="grid gap-1.5 sm:col-span-2 lg:col-span-1">
            <Label>Question flow</Label>
            <Select value={flowId} onValueChange={setFlowId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a published flow" />
              </SelectTrigger>
              <SelectContent>
                {published.map((flow) => (
                  <SelectItem key={flow.id} value={flow.id}>
                    {flow.name} (v{flow.published_version_no})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="window-start">Calls from</Label>
            <Input
              id="window-start"
              name="windowStart"
              type="time"
              required
              defaultValue={settings.calling_window_start}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="window-end">Until</Label>
            <Input
              id="window-end"
              name="windowEnd"
              type="time"
              required
              defaultValue={settings.calling_window_end}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="max-attempts">Tries per lead</Label>
            <Input
              id="max-attempts"
              name="maxAttempts"
              type="number"
              min={1}
              max={5}
              required
              defaultValue={settings.max_attempts_per_lead}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="retry-after">Retry after (min)</Label>
            <Input
              id="retry-after"
              name="retryAfterMinutes"
              type="number"
              min={15}
              max={2880}
              required
              defaultValue={settings.retry_after_minutes}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ring-timeout">Ring for (s)</Label>
            <Input
              id="ring-timeout"
              name="ringTimeoutSec"
              type="number"
              min={10}
              max={60}
              required
              defaultValue={settings.ring_timeout_sec}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="max-duration">Max call (s)</Label>
            <Input
              id="max-duration"
              name="maxDurationSec"
              type="number"
              min={60}
              max={900}
              required
              defaultValue={settings.max_duration_sec}
            />
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Times are India time. Dormant leads are never called. TeleCMI bills its per-minute rate;
        {settings.mode === 'AI_AGENT'
          ? ' AI calls also use AI credits for each answered call.'
          : ' keypad calls use no AI credits.'}
      </p>
      <div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
}

export function AutoCallSettingsCard({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [connectionDialog, setConnectionDialog] = useState<
    AutoCallAdminWorkspace['connections'][number] | 'new' | null
  >(null);
  // The mode picked in the form when the script editor opened; saved with the script.
  const [scriptDialog, setScriptDialog] = useState<AutoCallMode | null>(null);
  const workspace = useQuery({
    queryKey: autoCallAdminKey,
    queryFn: ({ signal }) => fetchAutoCallAdminWorkspace(signal),
  });
  const createFlow = useMutation({
    meta: { toast: false },
    mutationFn: () =>
      saveAutoIvrFlowDraft({
        flowId: null,
        name: 'Enquiry follow-up',
        definition: starterDefinition(),
        expectedVersion: null,
      }),
    onSuccess: (flow) => router.push(`/client-admin/integrations/auto-ivr/${flow.id}`),
    onError: () => toast.add({ type: 'error', title: 'The flow could not be created' }),
  });
  const archive = useMutation({
    meta: { toast: false },
    mutationFn: (flow: { id: string; version: number }) =>
      archiveAutoIvrFlow(flow.id, flow.version),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: autoCallAdminKey }),
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'The flow was not archived',
        description: autoCallErrorMessage(error, 'Try again.'),
      }),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <PhoneCall className="size-4 text-primary" /> Auto call
          </CardTitle>
          <CardDescription>
            TeleCMI calls each telecaller&apos;s new leads one by one and asks your questions,
            through an AI agent or a keypad menu. Answers become suggestions the telecaller
            verifies.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        {workspace.isPending ? (
          <div className="grid gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : workspace.isError || !workspace.data ? (
          <Alert>
            <AlertTitle>Auto-call settings are unavailable</AlertTitle>
            <AlertDescription>
              <Button variant="outline" size="sm" onClick={() => void workspace.refetch()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <section className="grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">TeleCMI PIOPIY connection</h3>
                {workspace.data.connections.length === 0 ? (
                  <Button size="sm" onClick={() => setConnectionDialog('new')}>
                    <Plus className="size-4" /> Connect
                  </Button>
                ) : null}
              </div>
              {workspace.data.connections.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Not connected. You need a PIOPIY account, app ID, token and a PIOPIY number.
                </p>
              ) : (
                workspace.data.connections.map((connection) => (
                  <div
                    key={connection.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="grid gap-0.5">
                      <p className="text-sm font-medium">{connection.display_name}</p>
                      <p className="text-xs text-muted-foreground">
                        Caller ID {connection.caller_id_label ?? '—'}
                        {connection.agent_id ? ` · AI agent ${connection.agent_id}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={connection.status === 'CONNECTED' ? 'success' : 'warning'}>
                        {connection.status === 'CONNECTED' ? 'Connected' : connection.status}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConnectionDialog(connection)}
                      >
                        Replace credential
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </section>

            <Separator />
            <section className="grid gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Bot className="size-4 text-primary" /> Who talks to the customer
              </h3>
              <CallModeForm
                key={`mode-${workspace.data.settings.version ?? 0}`}
                workspace={workspace.data}
                onEditScript={setScriptDialog}
              />
            </section>

            <Separator />
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold">Calling rules</h3>
              <SettingsForm
                key={`${workspace.data.settings.version ?? 0}`}
                workspace={workspace.data}
              />
            </section>

            <Separator />
            <section className="grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Keypad question flows</h3>
                <Button
                  size="sm"
                  onClick={() => createFlow.mutate()}
                  disabled={createFlow.isPending}
                >
                  <Plus className="size-4" /> New flow
                </Button>
              </div>
              {workspace.data.flows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No flows yet. A new flow starts with three sample questions you can change.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Flow</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Questions</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspace.data.flows.map((flow) => (
                        <TableRow key={flow.id}>
                          <TableCell className="font-medium">
                            {flow.name}
                            {workspace.data.settings.default_flow_id === flow.id ? (
                              <Badge variant="info" className="ml-2">
                                In use
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Badge variant={flow.status === 'PUBLISHED' ? 'success' : 'secondary'}>
                              {flow.status === 'PUBLISHED'
                                ? `Published v${flow.published_version_no}`
                                : 'Draft'}
                            </Badge>
                          </TableCell>
                          <TableCell>{flow.question_count}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {new Date(flow.updated_at).toLocaleString('en-IN', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="outline" asChild>
                                <Link href={`/client-admin/integrations/auto-ivr/${flow.id}`}>
                                  <SquarePen className="size-4" /> Edit
                                </Link>
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Archive ${flow.name}`}
                                disabled={archive.isPending}
                                onClick={() => archive.mutate(flow)}
                              >
                                <Archive className="size-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>

            <Separator />
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold">Telecallers</h3>
              {workspace.data.telecallers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active telecallers.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Telecaller</TableHead>
                        <TableHead>Auto call</TableHead>
                        <TableHead className="text-right">Calls today</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspace.data.telecallers.map((telecaller) => (
                        <TableRow key={telecaller.user_id}>
                          <TableCell className="font-medium">{telecaller.full_name}</TableCell>
                          <TableCell>
                            {telecaller.paused_reason ? (
                              <Badge variant="warning">
                                Paused:{' '}
                                {pausedReasonLabels[telecaller.paused_reason] ??
                                  telecaller.paused_reason}
                              </Badge>
                            ) : telecaller.enabled ? (
                              <Badge variant="success">On</Badge>
                            ) : (
                              <Badge variant="secondary">Off</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">{telecaller.calls_today}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </>
        )}
      </CardContent>
      {scriptDialog && workspace.data ? (
        <AiCallScriptDialog
          settings={workspace.data.settings}
          mode={scriptDialog}
          onClose={() => setScriptDialog(null)}
        />
      ) : null}
      {connectionDialog ? (
        <ConnectionDialog
          organizationId={organizationId}
          existing={connectionDialog === 'new' ? null : connectionDialog}
          onClose={() => setConnectionDialog(null)}
        />
      ) : null}
    </Card>
  );
}
