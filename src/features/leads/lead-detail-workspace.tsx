'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  CalendarDays,
  CircleAlert,
  Flame,
  History,
  Mail,
  Phone,
  RotateCcw,
  UserRound,
  UserRoundPlus,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
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
import { LeadDetailSkeleton } from '@/components/skeletons';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { roleHasNavigationSlug, roleLeadListHref } from '@/config/navigation';
import { useReturnToList } from '@/lib/navigation/use-return-to-list';
import { InboxWorkspace } from '@/features/inbox/inbox-workspace';
import { LeadActivityPanel } from './lead-activity-panel';
import { CustomerTelecmiCallDialog } from '@/features/customers/customer-360-actions';
import { WorkCreateDialog } from '@/features/work/workspace-dialogs';
import { useSalesConsultantCache } from '@/features/sales-consultant/sales-consultant-cache';
import {
  CustomerMatchDialog,
  type MatchableLead,
} from '@/features/customers/customer-match-dialog';
import { updateLead } from './lead-workspace-api';
import { fetchLeadDetail, type LeadDetail } from './lead-detail-api';

function formatDate(value: string | null | undefined, includeTime = true) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(
    'en-IN',
    includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
  ).format(new Date(value));
}

function temperatureLabel(value: LeadDetail['lead']['temperature']) {
  if (!value) return 'Not set';
  return value[0] + value.slice(1).toLowerCase();
}

function DetailGrid({ values }: { values: Array<[string, React.ReactNode]> }) {
  return (
    <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
      {values.map(([label, value]) => (
        <div key={label}>
          <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
          <div className="mt-1 text-sm font-semibold">{value || '—'}</div>
        </div>
      ))}
    </div>
  );
}

function LeadHeaderValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1.5 min-h-5 text-sm font-semibold">{children}</div>
    </div>
  );
}

function LeadOverview({ data, role }: { data: LeadDetail; role: string }) {
  const lead = data.lead;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,.8fr)]">
      <div className="space-y-4">
        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <CardTitle className="flex items-center gap-2 text-sm">
              <UserRound className="size-4 text-blue-600" /> Customer information
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5">
            <DetailGrid
              values={[
                ['Name', lead.customer_name],
                [
                  'Mobile',
                  <a
                    key="mobile"
                    className="hover:text-blue-700 hover:underline"
                    href={`tel:${lead.phone}`}
                  >
                    {lead.phone}
                  </a>,
                ],
                [
                  'Email',
                  lead.email ? (
                    <a
                      key="email"
                      className="hover:text-blue-700 hover:underline"
                      href={`mailto:${lead.email}`}
                    >
                      {lead.email}
                    </a>
                  ) : (
                    '—'
                  ),
                ],
                ['Preferred branch', lead.branch_name],
                ['Team', lead.team_name ?? '—'],
                ['Assigned consultant', lead.assigned_user_name ?? 'Unassigned'],
              ]}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarDays className="size-4 text-blue-600" /> Lead information
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5">
            <DetailGrid
              values={[
                ['Interested model', lead.interested_model ?? 'Not captured'],
                ['Lead source', lead.source],
                ['Source detail', lead.source_detail ?? '—'],
                ['Campaign', lead.campaign ?? '—'],
                ['Created', formatDate(lead.created_at)],
                ['First contacted', formatDate(lead.first_contacted_at)],
              ]}
            />
          </CardContent>
        </Card>
      </div>
      <div className="space-y-4">
        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <CardTitle className="text-sm">Lead summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-slate-50 p-3">
                <p className="text-[11px] text-muted-foreground">Lead temperature</p>
                <p className="mt-1 flex items-center gap-1.5 font-semibold">
                  <Flame className="size-4 text-orange-500" /> {temperatureLabel(lead.temperature)}
                </p>
              </div>
              <div className="rounded-lg border bg-slate-50 p-3">
                <p className="text-[11px] text-muted-foreground">Work state</p>
                <p className="mt-1 font-semibold">
                  {lead.work_state?.replaceAll('_', ' ') ?? 'On track'}
                </p>
              </div>
            </div>
            <div className="border-t pt-3">
              <p className="text-[11px] text-muted-foreground">Lifecycle</p>
              <div className="mt-1">
                <StatusBadge value={lead.lifecycle_status} />
              </div>
            </div>
            <div className="border-t pt-3">
              <p className="text-[11px] text-muted-foreground">Next follow-up</p>
              <p className="mt-1 text-sm font-semibold">{formatDate(lead.next_followup_at)}</p>
            </div>
            {lead.customer_id && (
              <Button asChild variant="outline" className="w-full">
                <Link href={`/${role}/customers/${lead.customer_id}`}>Open customer 360</Link>
              </Button>
            )}
          </CardContent>
        </Card>
        {data.latest_ai_summary && (
          <Card className="border-violet-200 bg-violet-50/40 shadow-none">
            <CardHeader className="px-5 py-4">
              <CardTitle className="text-sm">Latest call AI summary</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5 text-sm leading-6 text-slate-700">
              {data.latest_ai_summary}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Timeline({ items }: { items: LeadDetail['timeline'] }) {
  if (!items.length) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No recorded lead activity yet.
      </p>
    );
  }
  return (
    <div className="space-y-0 p-5">
      {items.map((item, index) => (
        <div key={item.id} className="relative flex gap-3 pb-5 last:pb-0">
          {index < items.length - 1 && (
            <span className="absolute left-4 top-8 h-[calc(100%-20px)] w-px bg-border" />
          )}
          <span className="z-10 grid size-8 shrink-0 place-items-center rounded-full border bg-white text-blue-600">
            <History className="size-4" />
          </span>
          <div className="min-w-0 pt-0.5">
            <p className="text-sm font-semibold">{item.title}</p>
            {item.detail && <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>}
            <p className="mt-1 text-[11px] text-muted-foreground">{formatDate(item.occurred_at)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LeadDetailWorkspace({ role, leadId }: { role: string; leadId: string }) {
  const router = useRouter();
  const returnToLeads = useReturnToList(roleLeadListHref(role));
  const queryClient = useQueryClient();
  const workspaceSession = useWorkspaceSession();
  const salesConsultantCache = useSalesConsultantCache();
  const canOpenAppointments = roleHasNavigationSlug(role, 'appointments');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [appointmentOpen, setAppointmentOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [tab, setTab] = useState('overview');
  const [lostOpen, setLostOpen] = useState(false);
  const [customerMatchOpen, setCustomerMatchOpen] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const detail = useQuery({
    queryKey: ['lead-detail', leadId, ...workspaceQueryScope(workspaceSession)],
    queryFn: ({ signal }) => fetchLeadDetail(leadId, signal),
    staleTime: 60_000,
  });
  const markLost = useMutation({
    mutationFn: () => {
      if (!detail.data) throw new Error('LEAD_NOT_READY');
      return updateLead({
        leadId,
        expectedUpdatedAt: detail.data.lead.updated_at,
        patch: { lifecycle_status: 'Lost', lost_reason: lostReason.trim() },
        reason: lostReason.trim(),
      });
    },
    onSuccess: async () => {
      setLostOpen(false);
      setLostReason('');
      await salesConsultantCache.settle('lead.updated', { leadId });
      toast.add({
        type: 'success',
        title: 'Lead marked as lost',
        description: 'The lifecycle history has been updated.',
      });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Could not update lead',
        description: 'Refresh the lead and try again.',
      }),
  });

  if (detail.isPending) return <LeadDetailSkeleton />;
  if (detail.isError || !detail.data) {
    return (
      <Card className="shadow-none">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <CircleAlert className="size-6 text-destructive" />
          <p className="font-semibold">Lead details are unavailable</p>
          <p className="text-sm text-muted-foreground">
            The lead may be outside your current access scope.
          </p>
          <Button variant="outline" onClick={() => detail.refetch()}>
            <RotateCcw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );
  }
  const data = detail.data;
  const lead = data.lead;
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={returnToLeads} className="-ml-3 mb-3">
          <ArrowLeft className="size-4" /> Back to leads
        </Button>
        <Card className="overflow-hidden shadow-none">
          <CardContent className="p-0">
            <div className="grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-[1.45fr_repeat(4,minmax(0,1fr))]">
              <div className="min-w-0 xl:border-r xl:pr-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-2xl font-bold tracking-tight">
                    {lead.customer_name}
                  </h1>
                  {lead.work_state && <StatusBadge value={lead.work_state} />}
                  {data.access.read_only && <Badge variant="secondary">Read only</Badge>}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <a
                    href={`tel:${lead.phone}`}
                    className="inline-flex items-center gap-1.5 font-medium text-foreground hover:text-primary"
                  >
                    <Phone className="size-4 text-emerald-600" /> {lead.phone}
                  </a>
                  {lead.email && <span>{lead.email}</span>}
                </div>
              </div>
              <LeadHeaderValue label="Interested model">
                {lead.interested_model ?? 'Not recorded'}
              </LeadHeaderValue>
              <LeadHeaderValue label="Lead stage">
                <StatusBadge value={lead.lifecycle_status} />
              </LeadHeaderValue>
              <LeadHeaderValue label="Temperature">
                {lead.temperature ? <StatusBadge value={lead.temperature} /> : 'Not recorded'}
              </LeadHeaderValue>
              <LeadHeaderValue label="Sales owner">
                {lead.assigned_user_name ?? 'Unassigned'}
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {lead.branch_name}
                </span>
              </LeadHeaderValue>
            </div>
            <div className="flex flex-wrap gap-2 border-t p-3">
              {!data.access.read_only && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!hasWorkspacePermission(workspaceSession, 'call.create')}
                    onClick={() => setCallOpen(true)}
                  >
                    <Phone className="size-3.5 text-emerald-600" /> Call through CRM
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setTab('messages')}
                    disabled={!data.access.can_messages}
                  >
                    <WhatsAppIcon className="size-3.5 text-emerald-600" /> Conversations
                  </Button>
                  {lead.email && (
                    <Button asChild size="sm" variant="outline">
                      <a href={`mailto:${lead.email}`}>
                        <Mail className="size-3.5 text-blue-600" /> Email
                      </a>
                    </Button>
                  )}
                </>
              )}
              {!lead.customer_id &&
                !data.access.read_only &&
                hasWorkspacePermission(workspaceSession, 'customer.link') && (
                  <Button size="sm" variant="outline" onClick={() => setCustomerMatchOpen(true)}>
                    <UserRoundPlus className="size-3.5 text-blue-600" /> Review possible customer
                    match
                  </Button>
                )}
              {lead.customer_id && (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/${role}/customers/${lead.customer_id}`}>Open customer 360</Link>
                </Button>
              )}
              {data.access.can_followups &&
                !data.access.read_only &&
                hasWorkspacePermission(workspaceSession, 'followup.create') && (
                  <Button size="sm" className="sm:ml-auto" onClick={() => setScheduleOpen(true)}>
                    <CalendarClock className="size-3.5" /> Schedule follow-up
                  </Button>
                )}
              {data.access.can_update && lead.lifecycle_status !== 'Lost' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setLostOpen(true)}
                >
                  <CircleAlert className="size-3.5" /> Mark lost
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-auto min-w-max justify-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            {data.access.can_calls && (
              <TabsTrigger value="calls">
                Calls{' '}
                <Badge variant="secondary" className="ml-1.5">
                  {data.counts.calls}
                </Badge>
              </TabsTrigger>
            )}
            {data.access.can_messages && <TabsTrigger value="messages">Conversations</TabsTrigger>}
            {data.access.can_followups && (
              <TabsTrigger value="followups">
                Follow-ups{' '}
                <Badge variant="secondary" className="ml-1.5">
                  {data.counts.followups}
                </Badge>
              </TabsTrigger>
            )}
            {data.access.can_appointments && (
              <TabsTrigger value="appointments">
                Appointments{' '}
                <Badge variant="secondary" className="ml-1.5">
                  {data.counts.appointments}
                </Badge>
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        <TabsContent value="overview">
          <LeadOverview data={data} role={role} />
        </TabsContent>
        <TabsContent value="timeline">
          <Card className="shadow-none">
            <Timeline items={data.timeline} />
          </Card>
        </TabsContent>
        {data.access.can_calls && (
          <TabsContent value="calls">
            <LeadActivityPanel key={leadId} leadId={leadId} kind="calls" />
          </TabsContent>
        )}
        {data.access.can_messages && (
          <TabsContent value="messages">
            <InboxWorkspace role={role} leadId={leadId} embedded readOnly={data.access.read_only} />
          </TabsContent>
        )}
        {data.access.can_followups && (
          <TabsContent value="followups">
            <LeadActivityPanel key={leadId} leadId={leadId} kind="followups" />
          </TabsContent>
        )}
        {data.access.can_appointments && (
          <TabsContent value="appointments" className="space-y-3">
            {canOpenAppointments &&
              !data.access.read_only &&
              hasWorkspacePermission(workspaceSession, 'appointment.create') && (
                <Button size="sm" onClick={() => setAppointmentOpen(true)}>
                  <CalendarDays className="size-4" /> New appointment for this lead
                </Button>
              )}
            <LeadActivityPanel key={leadId} leadId={leadId} kind="appointments" />
          </TabsContent>
        )}
      </Tabs>
      <CustomerMatchDialog
        lead={(customerMatchOpen ? lead : null) as MatchableLead | null}
        open={customerMatchOpen}
        canCreate={hasWorkspacePermission(workspaceSession, 'customer.create')}
        onOpenChange={setCustomerMatchOpen}
        onResolved={(customerId) => {
          void queryClient.invalidateQueries({ queryKey: ['lead-detail', leadId] });
          router.push(`/${role}/customers/${customerId}`);
        }}
      />
      <WorkCreateDialog
        kind="followups"
        lockInitialEntity
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        initialEntity={{
          leadId: lead.id,
          customerId: lead.customer_id,
          branchId: lead.branch_id,
          teamId: lead.team_id,
          customerName: lead.customer_name,
          phone: lead.phone,
          interestedModel: lead.interested_model,
          assignedUserId: lead.assigned_user_id,
        }}
        onCreated={() => {
          salesConsultantCache.invalidate('lead.updated', { leadId });
          void queryClient.invalidateQueries({ queryKey: ['lead-activity'] });
        }}
      />
      <WorkCreateDialog
        kind="appointments"
        open={appointmentOpen}
        onOpenChange={setAppointmentOpen}
        lockInitialEntity
        initialEntity={{
          leadId: lead.id,
          customerId: lead.customer_id,
          branchId: lead.branch_id,
          teamId: lead.team_id,
          assignedUserId: lead.assigned_user_id,
          customerName: lead.customer_name,
          phone: lead.phone,
          interestedModel: lead.interested_model,
        }}
        onCreated={() => {
          salesConsultantCache.invalidate('lead.updated', { leadId });
          void queryClient.invalidateQueries({ queryKey: ['lead-activity'] });
        }}
      />
      {workspaceSession?.organizationId && (
        <CustomerTelecmiCallDialog
          key={lead.id}
          open={callOpen}
          onOpenChange={setCallOpen}
          organizationId={workspaceSession.organizationId}
          customerId={lead.customer_id ?? ''}
          leadId={lead.id}
          customerName={lead.customer_name}
          customerPhone={lead.phone}
          onStarted={() => {
            void queryClient.invalidateQueries({ queryKey: ['lead-activity'] });
          }}
        />
      )}
      <Dialog open={lostOpen} onOpenChange={setLostOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark lead as lost</DialogTitle>
            <DialogDescription>
              This changes the lead lifecycle and writes an audit history entry.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={lostReason}
            onChange={(event) => setLostReason(event.target.value)}
            placeholder="Reason for loss"
            maxLength={500}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setLostOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!lostReason.trim() || markLost.isPending}
              onClick={() => markLost.mutate()}
            >
              {markLost.isPending ? 'Saving…' : 'Mark lost'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
