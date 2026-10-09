'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import {
  callLeadOptionsKey,
  fetchCallLeadOptions,
  setCallLeads,
  type CallLeadOptions,
} from './call-workspace-api';

const createdFormatter = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' });

export function useCallLeadOptions(leadId: string | null, callId: string | null, enabled = true) {
  const session = useWorkspaceSession();
  return useQuery({
    queryKey: [...callLeadOptionsKey, ...workspaceQueryScope(session), leadId, callId],
    queryFn: ({ signal }) => fetchCallLeadOptions(leadId as string, callId, signal),
    enabled: enabled && Boolean(leadId),
    staleTime: 60_000,
  });
}

/**
 * One call often covers several of a customer's enquiries -- the Elevate at
 * Test Drive and the City that came in yesterday. The call's own lead is
 * always on it; the caller ticks which of their other leads on this mobile the
 * call also covered, so it shows on each of those leads' history too.
 */
export function CallLeadsChecklist({
  options,
  selected,
  onChange,
  disabled = false,
}: {
  options: CallLeadOptions;
  /** Extra lead ids, never the call's own lead. */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      {options.leads.map((lead) => {
        const checked = lead.is_primary || selected.includes(lead.lead_id);
        return (
          <label
            key={lead.lead_id}
            className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm has-[:checked]:border-blue-200 has-[:checked]:bg-blue-50/50"
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={lead.is_primary || disabled}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, lead.lead_id]
                    : selected.filter((id) => id !== lead.lead_id),
                )
              }
            />
            <span className="font-medium">L-{lead.lead_id.slice(0, 8).toUpperCase()}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {lead.interested_model ?? 'Model not recorded'} · {lead.source} ·{' '}
              {createdFormatter.format(new Date(lead.created_at))}
            </span>
            <Badge
              variant={leadStageVariant(lead.lifecycle_status)}
              className="rounded px-2 py-0 text-[10px]"
            >
              {lead.lifecycle_status}
            </Badge>
            {lead.is_primary ? (
              <span className="text-[10px] text-muted-foreground">This call</span>
            ) : null}
          </label>
        );
      })}
    </fieldset>
  );
}

/** Call detail: which leads this call covered, editable by the caller. */
export function CallLeadsCard({ leadId, callId }: { leadId: string; callId: string }) {
  const queryClient = useQueryClient();
  const options = useCallLeadOptions(leadId, callId);
  const [draft, setDraft] = useState<string[] | null>(null);
  const linked =
    options.data?.leads
      .filter((lead) => lead.linked && !lead.is_primary)
      .map((lead) => lead.lead_id) ?? [];
  const selected = draft ?? linked;
  const save = useMutation({
    meta: { toast: false },
    mutationFn: setCallLeads,
    onSuccess: async () => {
      setDraft(null);
      toast.add({ type: 'success', title: 'Leads on this call updated' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: callLeadOptionsKey }),
        queryClient.invalidateQueries({ queryKey: ['lead-activity'] }),
      ]);
    },
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Leads were not updated',
        description: 'Only your own leads on this customer can be added. Refresh and try again.',
      }),
  });

  // A customer with a single enquiry has nothing to choose between.
  if (!options.data || options.data.leads.length < 2) return null;
  const dirty =
    draft !== null && (draft.length !== linked.length || draft.some((id) => !linked.includes(id)));
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm">Leads on this call</CardTitle>
        <CardDescription>
          This customer has more than one enquiry. Tick each lead this call covered so it shows on
          that lead&rsquo;s history too.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <CallLeadsChecklist
          options={options.data}
          selected={selected}
          onChange={setDraft}
          disabled={!options.data.can_edit || save.isPending}
        />
        {options.data.can_edit ? (
          <div className="flex justify-end gap-2">
            {dirty ? (
              <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
                Reset
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate({ callId, leadIds: selected })}
            >
              {save.isPending ? 'Saving…' : 'Save leads'}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Only the person who made the call can change its leads.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
