'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Pencil, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchAiVoiceAgentSettings,
  saveAiVoiceAgent,
  type AiVoiceAgent,
  type AiVoiceAgentSettings,
} from './ai-voice-agent-settings-api';

function AgentDialog({
  settings,
  agent,
  onClose,
}: {
  settings: AiVoiceAgentSettings;
  agent: AiVoiceAgent | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [branchId, setBranchId] = useState(agent?.branch_id ?? settings.branches[0]?.id ?? '');
  const teams = useMemo(
    () => settings.teams.filter((team) => team.branch_id === branchId),
    [branchId, settings.teams],
  );
  const [teamId, setTeamId] = useState(agent?.team_id ?? '');
  const resolvedTeamId = teams.some((team) => team.id === teamId) ? teamId : (teams[0]?.id ?? '');
  const telecallers = useMemo(
    () => settings.telecallers.filter((user) => user.team_id === resolvedTeamId),
    [settings.telecallers, resolvedTeamId],
  );
  const [assignedUserId, setAssignedUserId] = useState(agent?.assigned_user_id ?? '');
  const resolvedAssignedUserId = telecallers.some((user) => user.id === assignedUserId)
    ? assignedUserId
    : (telecallers[0]?.id ?? '');
  const [enabled, setEnabled] = useState(agent?.auto_call_enabled ?? true);
  const save = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return saveAiVoiceAgent({
        id: agent?.id,
        branchId,
        teamId: resolvedTeamId,
        assignedUserId: resolvedAssignedUserId,
        name: String(data.get('name') ?? '').trim(),
        externalAgentId: String(data.get('externalAgentId') ?? '').trim(),
        language: String(data.get('language') ?? '').trim(),
        promptInstructions: String(data.get('promptInstructions') ?? '').trim(),
        autoCallEnabled: enabled,
        creditCost: Number(data.get('creditCost')),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai-voice-agent-settings'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{agent ? 'Edit AI voice agent' : 'Configure AI voice agent'}</DialogTitle>
          <DialogDescription>
            This agent may call only when its telecaller has not attempted a fresh round-robin lead
            within five minutes. Every accepted dispatch consumes the configured AI credits.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(event.currentTarget);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Branch</Label>
              <Select
                value={branchId}
                onValueChange={(value) => {
                  setBranchId(value);
                  setTeamId('');
                  setAssignedUserId('');
                }}
                disabled={Boolean(agent)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {settings.branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Team</Label>
              <Select
                value={resolvedTeamId}
                onValueChange={(value) => {
                  setTeamId(value);
                  setAssignedUserId('');
                }}
                disabled={Boolean(agent)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select team" />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Telecaller</Label>
              <Select
                value={resolvedAssignedUserId}
                onValueChange={setAssignedUserId}
                disabled={Boolean(agent)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select telecaller" />
                </SelectTrigger>
                <SelectContent>
                  {telecallers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="grid gap-1.5 text-sm font-medium">
              Display name
              <Input
                name="name"
                required
                minLength={2}
                maxLength={120}
                defaultValue={agent?.name ?? ''}
                placeholder="Sales enquiry assistant"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Gateway agent ID
              <Input
                name="externalAgentId"
                required
                minLength={2}
                maxLength={255}
                defaultValue={agent?.external_agent_id ?? ''}
                autoComplete="off"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Language / locale
              <Input
                name="language"
                required
                maxLength={35}
                defaultValue={agent?.language ?? 'en-IN'}
                placeholder="en-IN"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Credits per AI call
              <Input
                name="creditCost"
                type="number"
                required
                min={1}
                max={10000}
                defaultValue={agent?.credit_cost ?? 1}
              />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Branch-specific agent instructions
            <Textarea
              name="promptInstructions"
              maxLength={12000}
              rows={5}
              defaultValue={agent?.prompt_instructions ?? ''}
              placeholder="Greeting, dealership policies, supported languages, and escalation rules. Inventory is supplied live."
            />
          </label>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Automatic five-minute fallback</p>
              <p className="text-xs text-muted-foreground">
                DORMANT leads and leads with any human call attempt are always suppressed.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable automatic AI voice calls"
            />
          </div>
          {save.isError ? (
            <Alert>
              <AlertTitle>Agent was not saved</AlertTitle>
              <AlertDescription>
                Check your integration permission, team membership, and values.
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={save.isPending || !branchId || !resolvedTeamId || !resolvedAssignedUserId}
            >
              {save.isPending ? 'Saving…' : 'Save AI agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AiVoiceAgentSettingsCard({ organizationId }: { organizationId: string }) {
  const [editing, setEditing] = useState<AiVoiceAgent | null | undefined>();
  const settings = useQuery({
    queryKey: ['ai-voice-agent-settings', organizationId],
    queryFn: ({ signal }) => fetchAiVoiceAgentSettings(signal),
    staleTime: 60_000,
  });
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-5 text-violet-600" /> AI voice fallback agents
          </CardTitle>
          <CardDescription className="mt-1">
            Per-telecaller agents for unanswered fresh round-robin assignments. The delay is fixed
            at five minutes.
          </CardDescription>
        </div>
        <Button
          size="sm"
          onClick={() => setEditing(null)}
          disabled={!settings.data?.telecallers.length}
        >
          <Plus /> Configure agent
        </Button>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <p className="text-sm text-muted-foreground">Loading AI voice settings…</p>
        ) : null}
        {settings.isError ? (
          <Alert>
            <AlertTitle>AI voice settings unavailable</AlertTitle>
            <AlertDescription>
              Confirm integration management access and the latest migration.
            </AlertDescription>
          </Alert>
        ) : null}
        {settings.data && !settings.data.agents.length ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No telecaller has an AI voice fallback agent yet.
          </p>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {settings.data?.agents.map((agent) => {
            const branch = settings.data.branches.find((item) => item.id === agent.branch_id)?.name;
            const team = settings.data.teams.find((item) => item.id === agent.team_id)?.name;
            const user = settings.data.telecallers.find(
              (item) => item.id === agent.assigned_user_id,
            )?.full_name;
            return (
              <div
                key={agent.id}
                className="flex items-start justify-between gap-3 rounded-lg border p-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{agent.name}</p>
                    <Badge variant={agent.auto_call_enabled ? 'success' : 'secondary'}>
                      {agent.auto_call_enabled ? 'Enabled' : 'Paused'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {user ?? 'Telecaller'} · {team ?? 'Team'} · {branch ?? 'Branch'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    5 min · {agent.credit_cost} AI credit{agent.credit_cost === 1 ? '' : 's'} per
                    accepted call · {agent.language}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${agent.name}`}
                  onClick={() => setEditing(agent)}
                >
                  <Pencil className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
      {editing !== undefined && settings.data ? (
        <AgentDialog
          settings={settings.data}
          agent={editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </Card>
  );
}
