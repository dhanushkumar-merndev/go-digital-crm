'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { formatNationalPhone, toDialableDigits } from '@/lib/phone';
import { fetchAvailableTelecmiAgents } from './telecmi-agents-api';
import { TelecmiAgentManager } from './telecmi-agent-manager';
import { provisionTelecmiAgent, type IntegrationScopeMode } from './integration-workspace-api';

export type TelecmiAgentRow = { key: string; user_id: string; phone: string };

export function newTelecmiAgentRow(row?: { user_id: string; phone: string }): TelecmiAgentRow {
  return { key: crypto.randomUUID(), user_id: row?.user_id ?? '', phone: row?.phone ?? '' };
}

/**
 * Editor for the TeleCMI user_id/phone mappings a website call needs.
 *
 * A row is selected from available agents in the TeleCMI
 * dashboard, or created here: provisioning calls TeleCMI's user API and fills
 * the returned `extension_appid` in, which is the field admins most often
 * mistype. The App Secret is only ever forwarded to the Edge Function.
 */
export function TelecmiAgentEditor({
  organizationId,
  connectionId,
  scopeMode,
  branchIds,
  appId,
  appSecret,
  rows,
  defaultUserId,
  onChange,
}: {
  organizationId: string;
  connectionId?: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  appId: string;
  appSecret: string;
  rows: TelecmiAgentRow[];
  defaultUserId: string;
  onChange: (rows: TelecmiAgentRow[]) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [choosingExisting, setChoosingExisting] = useState(false);
  const [draft, setDraft] = useState({ name: '', extension: '', phone: '', password: '' });
  // Query keys must never contain the plaintext secret. Rotate an opaque key
  // when it changes so agents loaded for old credentials cannot be selected.
  const credentialKey = useMemo(() => (appSecret ? crypto.randomUUID() : 'stored'), [appSecret]);
  const canList =
    Number(appId) > 0 &&
    (appSecret.trim().length >= 8 || (Boolean(connectionId) && appSecret.trim() === '')) &&
    (scopeMode === 'ALL_BRANCHES' ? branchIds.length === 0 : branchIds.length > 0);
  const existingAgents = useQuery({
    queryKey: [
      'telecmi-available-agents',
      organizationId,
      connectionId,
      appId,
      scopeMode,
      branchIds,
      credentialKey,
    ],
    queryFn: () =>
      fetchAvailableTelecmiAgents({
        organizationId,
        connectionId,
        scopeMode,
        branchIds,
        appId: Number(appId),
        appSecret: appSecret.trim() || undefined,
      }),
    enabled: false,
    gcTime: 0,
    staleTime: 0,
  });
  const selectableAgents = (existingAgents.data?.agents ?? []).filter(
    (agent) =>
      !rows.some(
        (row) => row.user_id === agent.agent_id || toDialableDigits(row.phone) === agent.phone,
      ),
  );
  const canProvision =
    Number(appId) > 0 &&
    appSecret.trim().length >= 8 &&
    draft.name.trim().length >= 2 &&
    /^[1-9]\d{2}$/.test(draft.extension.trim()) &&
    draft.phone.trim().length >= 8 &&
    draft.password.length >= 8;

  const provision = useMutation({
    mutationFn: () =>
      provisionTelecmiAgent({
        organizationId,
        scopeMode,
        branchIds,
        appId: Number(appId),
        appSecret: appSecret.trim(),
        extension: draft.extension.trim(),
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        password: draft.password,
      }),
    onSuccess: (created) => {
      onChange([
        ...rows,
        newTelecmiAgentRow({ user_id: created.user_id, phone: String(created.phone) }),
      ]);
      setDraft({ name: '', extension: '', phone: '', password: '' });
      setCreating(false);
      void existingAgents.refetch();
    },
  });

  return (
    <div className="grid gap-3 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Employee mobile mappings</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canList || existingAgents.isFetching}
            onClick={() => {
              setCreating(false);
              setChoosingExisting(true);
              void existingAgents.refetch();
            }}
          >
            <Plus className="size-4" />
            Existing agents
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setChoosingExisting(false);
              setCreating((open) => !open);
            }}
          >
            <UserPlus className="size-4" />
            Create in TeleCMI
          </Button>
        </div>
      </div>

      {!canList ? (
        <p className="text-xs text-muted-foreground">
          Enter the App ID, App Secret and connection scope above to load existing agents.
        </p>
      ) : null}

      {choosingExisting ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">
            Assign an available agent or remove an unused agent from TeleCMI. Agents already mapped
            in the CRM or selected here are hidden from the assignment dropdown.
          </p>
          {existingAgents.isFetching ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading TeleCMI agents…
            </p>
          ) : existingAgents.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Agents could not be loaded</AlertTitle>
              <AlertDescription>
                {existingAgents.error instanceof Error
                  ? existingAgents.error.message
                  : 'Try again.'}
              </AlertDescription>
            </Alert>
          ) : existingAgents.data && selectableAgents.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              No available agents with a registered mobile. Already mapped or selected agents are
              hidden. You can create an agent if your TeleCMI plan has a free seat.
            </p>
          ) : existingAgents.data ? (
            <Select
              value=""
              onValueChange={(agentId) => {
                const agent = selectableAgents.find((candidate) => candidate.agent_id === agentId);
                if (!agent || existingAgents.isFetching) return;
                onChange([
                  ...rows,
                  newTelecmiAgentRow({ user_id: agent.agent_id, phone: agent.phone }),
                ]);
              }}
            >
              <SelectTrigger aria-label="Select existing TeleCMI agent">
                <SelectValue placeholder="Select an available agent" />
              </SelectTrigger>
              <SelectContent>
                {selectableAgents.map((agent) => (
                  <SelectItem key={agent.agent_id} value={agent.agent_id}>
                    {agent.name ?? 'Agent'} · {agent.agent_id} · {formatNationalPhone(agent.phone)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {existingAgents.data && !existingAgents.isFetching && !existingAgents.isError ? (
            <TelecmiAgentManager
              agents={existingAgents.data.all_agents}
              rows={rows}
              defaultUserId={defaultUserId}
              busy={!canList}
              context={{
                organizationId,
                connectionId,
                scopeMode,
                branchIds,
                appId: Number(appId),
                appSecret: appSecret.trim() || undefined,
              }}
              onAssign={(agent) => {
                if (
                  !agent.phone ||
                  rows.some(
                    (row) =>
                      row.user_id === agent.agent_id || toDialableDigits(row.phone) === agent.phone,
                  )
                )
                  return;
                onChange([
                  ...rows,
                  newTelecmiAgentRow({ user_id: agent.agent_id, phone: agent.phone }),
                ]);
              }}
              onRemoved={() => existingAgents.refetch()}
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canList || existingAgents.isFetching}
              onClick={() => void existingAgents.refetch()}
            >
              Refresh agents
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setChoosingExisting(false)}
            >
              Close
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Add at least one mapping. A website call rings the signed-in employee’s exact mapped
          mobile; there is no shared-agent fallback.
        </p>
      ) : null}

      {rows.map((row, index) => (
        <div key={row.key} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <label className="grid gap-1 text-xs font-normal text-muted-foreground">
            {index === 0 ? 'TeleCMI user ID' : null}
            <Input
              value={row.user_id}
              readOnly
              placeholder="101_2223012"
              pattern="\d{1,12}_\d{1,12}"
              required
              autoComplete="off"
              aria-label={`TeleCMI user ID ${index + 1}`}
            />
          </label>
          <label className="grid gap-1 text-xs font-normal text-muted-foreground">
            {index === 0 ? 'Employee mobile' : null}
            <Input
              value={row.phone}
              readOnly
              placeholder="919876543210"
              required
              autoComplete="off"
              aria-label={`Employee mobile ${index + 1}`}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={index === 0 ? 'self-end' : undefined}
            onClick={() => onChange(rows.filter((entry) => entry.key !== row.key))}
            aria-label={`Remove mapping ${index + 1}`}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      {creating ? (
        <div className="grid gap-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-2">
          <p className="text-xs text-muted-foreground sm:col-span-2">
            This creates the user in your TeleCMI account and adds the returned mapping below. Give
            the softphone password to the employee yourself — the CRM never stores it.
          </p>
          <label className="grid gap-1.5 text-sm font-medium">
            Agent name
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Extension
            <Input
              value={draft.extension}
              onChange={(event) => setDraft({ ...draft, extension: event.target.value })}
              placeholder="101"
              inputMode="numeric"
              maxLength={3}
              autoComplete="off"
            />
            <span className="text-xs font-normal text-muted-foreground">
              100–999. TeleCMI builds the user ID as extension_appid.
            </span>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Employee mobile
            <Input
              value={draft.phone}
              onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
              placeholder="919876543210"
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Softphone password
            <PasswordInput
              value={draft.password}
              onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              minLength={8}
              maxLength={64}
              autoComplete="new-password"
            />
          </label>
          {provision.isError ? (
            <Alert className="sm:col-span-2">
              <AlertTitle>Agent was not created</AlertTitle>
              <AlertDescription>
                {provision.error instanceof Error
                  ? provision.error.message
                  : 'TeleCMI rejected the request.'}
              </AlertDescription>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={!canList || existingAgents.isFetching}
                onClick={() => {
                  setCreating(false);
                  setChoosingExisting(true);
                  void existingAgents.refetch();
                }}
              >
                View existing agents
              </Button>
            </Alert>
          ) : null}
          <div className="flex items-center justify-end gap-2 sm:col-span-2">
            {appSecret.trim().length < 8 ? (
              // The App Secret is optional when re-saving a connection, but
              // provisioning calls TeleCMI directly and cannot reuse the stored
              // one, so say why the button is dead rather than leaving it grey.
              <span className="mr-auto text-xs text-muted-foreground">
                Enter the App Secret above to create an agent in TeleCMI.
              </span>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canProvision || provision.isPending}
              onClick={() => provision.mutate()}
            >
              {provision.isPending ? 'Creating…' : 'Create agent'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
