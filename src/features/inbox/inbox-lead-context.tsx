'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { SearchSelect } from '@/components/ui/search-select';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { WorkCreateDialog } from '@/features/work/workspace-dialogs';
import { CustomerTelecmiCallDialog } from '@/features/customers/customer-360-actions';
import { fetchInboxLeadOptions, setInboxWorkingLead, type InboxConversation } from './inbox-api';

export function InboxLeadContext({
  conversation,
  leadId,
  disabled,
}: {
  conversation: InboxConversation;
  leadId?: string;
  disabled: boolean;
}) {
  const session = useWorkspaceSession();
  const scope = workspaceQueryScope(session);
  const cache = useQueryClient();
  const [search, setSearch] = useState('');
  const [work, setWork] = useState<'followups' | 'appointments' | null>(null);
  const [callOpen, setCallOpen] = useState(false);
  const term = useDebouncedValue(search, 300);
  const options = useQuery({
    queryKey: ['inbox-lead-options', ...scope, conversation.id, conversation.lead_id, term],
    queryFn: ({ signal }) => fetchInboxLeadOptions(conversation.id, term, signal),
  });
  const selected = options.data?.find((lead) => lead.id === conversation.lead_id);
  const change = useMutation({
    mutationFn: (id: string) =>
      setInboxWorkingLead({
        conversationId: conversation.id,
        leadId: id,
        expectedLeadId: conversation.lead_id,
      }),
    onSuccess: async () => {
      await Promise.all(
        [
          'shared-inbox',
          'shared-inbox-messages',
          'inbox-lead-options',
          'lead-detail',
          'customer-360',
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
      toast.add({
        type: 'success',
        title: 'Working lead updated',
        description: 'New messages will use this lead. Earlier messages keep their original lead.',
      });
    },
    onError: () => {
      void cache.invalidateQueries({ queryKey: ['shared-inbox', ...scope] });
      toast.add({
        type: 'error',
        title: 'Lead was not changed',
        description:
          'The context or your access may have changed. Check the current lead and try again.',
      });
    },
  });
  const canChange = !disabled && hasWorkspacePermission(session, 'message.send');
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs font-medium">Working lead · new messages and activities</p>
      <SearchSelect
        aria-label="Working lead"
        value={conversation.lead_id ?? ''}
        options={options.data?.map((lead) => ({
          value: lead.id,
          label: `${lead.interested_model ?? 'Enquiry'} · ${lead.id.slice(0, 8)}`,
          description: `${lead.lifecycle_status} · ${new Date(lead.created_at).toLocaleDateString('en-IN')}`,
        }))}
        search={search}
        onSearchChange={setSearch}
        onValueChange={(value) => change.mutate(value)}
        disabled={!canChange || change.isPending}
        isPending={options.isPending}
        isFetching={options.isFetching}
        isError={options.isError}
        placeholder={
          conversation.lead_id ? `Lead ${conversation.lead_id.slice(0, 8)}` : 'Select a linked lead'
        }
        searchPlaceholder="Search this customer’s leads"
        emptyMessage="No eligible leads. Link the enquiry to this customer from Leads first."
      />
      <p className="text-[11px] text-muted-foreground">
        Only this customer’s accessible leads are available. Earlier messages stay with their
        original lead.
      </p>
      {leadId && leadId !== conversation.lead_id && (
        <Button
          size="sm"
          variant="outline"
          disabled={!canChange || change.isPending}
          onClick={() => change.mutate(leadId)}
        >
          Work on this lead
        </Button>
      )}
      {selected && (!leadId || leadId === selected.id) && (
        <div className="flex flex-wrap gap-2">
          {hasWorkspacePermission(session, 'call.create') && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || change.isPending}
              onClick={() => setCallOpen(true)}
            >
              Call through CRM
            </Button>
          )}
          {hasWorkspacePermission(session, 'followup.create') && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || change.isPending}
              onClick={() => setWork('followups')}
            >
              Follow-up
            </Button>
          )}
          {hasWorkspacePermission(session, 'appointment.create') && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || change.isPending}
              onClick={() => setWork('appointments')}
            >
              Appointment
            </Button>
          )}
        </div>
      )}
      {selected && session?.organizationId && (
        <CustomerTelecmiCallDialog
          key={selected.id}
          open={callOpen}
          onOpenChange={setCallOpen}
          customerId={selected.customer_id ?? ''}
          leadId={selected.id}
          organizationId={session.organizationId}
          customerName={selected.customer_name}
          customerPhone={selected.phone}
          onStarted={() => {
            void cache.invalidateQueries({ queryKey: ['lead-activity'] });
          }}
        />
      )}
      {selected && work && (
        <WorkCreateDialog
          key={`${selected.id}:${work}`}
          kind={work}
          open
          onOpenChange={(open) => {
            if (!open) setWork(null);
          }}
          lockInitialEntity
          initialEntity={{
            leadId: selected.id,
            customerId: selected.customer_id,
            branchId: selected.branch_id,
            teamId: selected.team_id,
            assignedUserId: selected.assigned_user_id,
            customerName: selected.customer_name,
            phone: selected.phone,
            interestedModel: selected.interested_model,
          }}
          onCreated={() => {
            void cache.invalidateQueries({ queryKey: ['lead-activity'] });
            void cache.invalidateQueries({ queryKey: ['lead-detail'] });
          }}
        />
      )}
    </div>
  );
}
