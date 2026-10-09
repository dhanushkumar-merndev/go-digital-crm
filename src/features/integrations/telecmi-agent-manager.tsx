'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatNationalPhone, toDialableDigits } from '@/lib/phone';
import {
  removeTelecmiAgent,
  telecmiPlanQueryKeyRoot,
  type ManagedTelecmiAgent,
} from './telecmi-agents-api';
import type { IntegrationScopeMode } from './integration-workspace-api';
import type { TelecmiAgentRow } from './telecmi-agent-editor';

export function TelecmiAgentManager({
  agents,
  rows,
  defaultUserId,
  context,
  busy,
  onAssign,
  onRemoved,
}: {
  agents: ManagedTelecmiAgent[];
  rows: TelecmiAgentRow[];
  defaultUserId: string;
  busy: boolean;
  context: {
    organizationId: string;
    connectionId?: string;
    scopeMode: IntegrationScopeMode;
    branchIds: string[];
    appId: number;
    appSecret?: string;
  };
  onAssign: (agent: ManagedTelecmiAgent) => void;
  onRemoved: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<ManagedTelecmiAgent | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selected = (agent: ManagedTelecmiAgent) =>
    rows.some(
      (row) =>
        row.user_id === agent.agent_id ||
        Boolean(agent.phone && toDialableDigits(row.phone) === agent.phone),
    );
  const remove = useMutation({
    mutationFn: (agentId: string) =>
      removeTelecmiAgent({ ...context, agentId, requestId: crypto.randomUUID() }),
    meta: { toast: false },
    onSuccess: async () => {
      setTarget(null);
      setMessage('Agent removed from TeleCMI.');
      await Promise.all([
        onRemoved(),
        queryClient.invalidateQueries({
          queryKey: [...telecmiPlanQueryKeyRoot, context.organizationId],
        }),
      ]);
    },
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">All agents in TeleCMI</h4>
        <Badge variant="secondary">{agents.length} agents</Badge>
      </div>
      {message ? (
        <p role="status" className="text-xs text-emerald-700">
          {message}
        </p>
      ) : null}
      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents found in this TeleCMI app.</p>
      ) : (
        <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
          {agents.map((agent) => {
            const locallySelected = selected(agent);
            const unavailable = agent.in_use || locallySelected;
            const accountDefault = agent.agent_id === defaultUserId.trim();
            return (
              <li
                key={agent.agent_id}
                className="flex flex-wrap items-center justify-between gap-2 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{agent.name ?? agent.agent_id}</p>
                  <p className="text-xs text-muted-foreground">
                    {agent.agent_id} ·{' '}
                    {agent.phone ? formatNationalPhone(agent.phone) : 'No registered mobile'}
                  </p>
                  <Badge
                    className="mt-1"
                    variant={unavailable || accountDefault ? 'secondary' : 'success'}
                  >
                    {locallySelected
                      ? 'Selected here'
                      : accountDefault
                        ? 'Account default'
                        : agent.in_use
                          ? 'In use in CRM'
                          : 'Available'}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || remove.isPending || unavailable || !agent.assignable}
                    onClick={() => onAssign(agent)}
                  >
                    Assign
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    disabled={busy || remove.isPending || unavailable || accountDefault}
                    onClick={() => {
                      remove.reset();
                      setTarget(agent);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Assign adds the agent’s registered mobile to this connection. Save the connection to apply
        it. To remove a mapped agent, remove its mapping and save first. If it is the account
        default, select another account user ID before removing it.
      </p>
      <Dialog
        open={Boolean(target)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setTarget(null);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (remove.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (remove.isPending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove agent from TeleCMI?</DialogTitle>
            <DialogDescription>
              Permanently remove {target?.name ?? 'this agent'} ({target?.agent_id}) from TeleCMI to
              free its seat. This agent’s TeleCMI login will stop working. CRM call history is
              retained.
            </DialogDescription>
          </DialogHeader>
          {remove.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {remove.error instanceof Error
                  ? remove.error.message
                  : 'The agent could not be removed.'}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                busy ||
                remove.isPending ||
                !target ||
                Boolean(
                  target &&
                  (selected(target) || target.in_use || target.agent_id === defaultUserId.trim()),
                )
              }
              onClick={() => {
                if (target) remove.mutate(target.agent_id);
              }}
            >
              {remove.isPending ? 'Removing…' : 'Remove from TeleCMI'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
