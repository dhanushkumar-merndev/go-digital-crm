'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  CalendarDays,
  CircleAlert,
  Clock3,
  Flame,
  History,
  Mail,
  MessageCircle,
  Phone,
  RotateCcw,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import { WorkCreateDialog } from '@/features/work/workspace-dialogs';
import { updateLead } from './lead-workspace-api';
import { fetchLeadDetail, type LeadDetail } from './lead-detail-api';

function formatDate(value: string | null | undefined, includeTime = true) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(
    'en-IN',
    includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
  ).format(new Date(value));
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return '—';
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
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

function Calls({ calls }: { calls: LeadDetail['calls'] }) {
  if (!calls.length)
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No calls recorded for this lead.
      </p>
    );
  return (
    <div className="divide-y">
      {calls.map((call) => (
        <div key={call.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div>
            <p className="text-sm font-semibold">
              {call.direction === 'OUTBOUND' ? 'Outbound call' : 'Inbound call'}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDate(call.started_at)} · {formatDuration(call.duration_seconds)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {call.outcome && <Badge variant="secondary">{call.outcome}</Badge>}
            <StatusBadge value={call.status} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Followups({ followups }: { followups: LeadDetail['followups'] }) {
  if (!followups.length)
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No follow-ups scheduled for this lead.
      </p>
    );
  return (
    <div className="divide-y">
      {followups.map((followup) => (
        <div
          key={followup.id}
          className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
        >
          <div>
            <p className="text-sm font-semibold">{followup.reason}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Due {formatDate(followup.due_at)} · {followup.assigned_user_name ?? 'Unassigned'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{followup.priority}</Badge>
            <StatusBadge value={followup.status} />
          </div>
        </div>
      ))}
    </div>
  );
}

function LeadDetailSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-32 w-full" />
      ))}
    </div>
  );
}

export function LeadDetailWorkspace({ role, leadId }: { role: string; leadId: string }) {
  const queryClient = useQueryClient();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const detail = useQuery({
    queryKey: ['lead-detail', leadId],
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
      await queryClient.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      await queryClient.invalidateQueries({ queryKey: ['lead-workspace'] });
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
    <div className="mx-auto max-w-[1600px] space-y-4">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href={`/${role}/my-leads`}>
          <ArrowLeft className="size-4" /> Back to leads
        </Link>
      </Button>
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-5">
          <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-center">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5 xl:gap-8">
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold">{lead.customer_name}</h1>
                  <StatusBadge value={lead.lifecycle_status} />
                </div>
                <a
                  href={`tel:${lead.phone}`}
                  className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700 hover:text-blue-700"
                >
                  <Phone className="size-4" /> {lead.phone}
                </a>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Interested model</p>
                <p className="mt-1 font-semibold">{lead.interested_model ?? 'Not captured'}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Lead source</p>
                <p className="mt-1 font-semibold">{lead.source}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Temperature</p>
                <p className="mt-1 font-semibold">{temperatureLabel(lead.temperature)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Assigned to</p>
                <p className="mt-1 font-semibold">{lead.assigned_user_name ?? 'Unassigned'}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:justify-end">
              <Button asChild variant="outline" size="sm">
                <a href={`tel:${lead.phone}`}>
                  <Phone className="size-4 text-emerald-600" /> Call
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={toWhatsAppClickToChatUrl(lead.phone)} target="_blank" rel="noreferrer">
                  <WhatsAppIcon className="size-4 text-emerald-600" /> WhatsApp
                </a>
              </Button>
              {lead.email && (
                <Button asChild variant="outline" size="sm">
                  <a href={`mailto:${lead.email}`}>
                    <Mail className="size-4 text-blue-600" /> Email
                  </a>
                </Button>
              )}
              {data.access.can_followups && (
                <Button size="sm" onClick={() => setScheduleOpen(true)}>
                  <CalendarClock className="size-4" /> Schedule follow-up
                </Button>
              )}
              {data.access.can_update && lead.lifecycle_status !== 'Lost' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setLostOpen(true)}
                >
                  <CircleAlert className="size-4" /> Mark lost
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      <Tabs defaultValue="overview">
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-none border-b bg-transparent p-0">
          <TabsTrigger
            value="overview"
            className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="timeline"
            className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
          >
            Timeline
          </TabsTrigger>
          {data.access.can_calls && (
            <TabsTrigger
              value="calls"
              className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
            >
              Calls{' '}
              <Badge variant="secondary" className="ml-1.5">
                {data.counts.calls}
              </Badge>
            </TabsTrigger>
          )}
          {data.access.can_messages && (
            <TabsTrigger
              value="messages"
              className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
            >
              Messages{' '}
              <Badge variant="secondary" className="ml-1.5">
                {data.counts.messages}
              </Badge>
            </TabsTrigger>
          )}
          {data.access.can_followups && (
            <TabsTrigger
              value="followups"
              className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
            >
              Follow-ups{' '}
              <Badge variant="secondary" className="ml-1.5">
                {data.counts.followups}
              </Badge>
            </TabsTrigger>
          )}
          {data.access.can_appointments && (
            <TabsTrigger
              value="appointments"
              className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
            >
              Appointments{' '}
              <Badge variant="secondary" className="ml-1.5">
                {data.counts.appointments}
              </Badge>
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <LeadOverview data={data} role={role} />
        </TabsContent>
        <TabsContent value="timeline" className="mt-4">
          <Card className="shadow-none">
            <Timeline items={data.timeline} />
          </Card>
        </TabsContent>
        {data.access.can_calls && (
          <TabsContent value="calls" className="mt-4">
            <Card className="shadow-none">
              <Calls calls={data.calls} />
            </Card>
          </TabsContent>
        )}
        {data.access.can_messages && (
          <TabsContent value="messages" className="mt-4">
            <Card className="shadow-none">
              <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                <MessageCircle className="size-6 text-blue-600" />
                <p className="font-semibold">
                  {data.counts.messages
                    ? `${data.counts.messages} linked conversations`
                    : 'No linked conversations'}
                </p>
                <p className="text-sm text-muted-foreground">
                  Conversation messages are shown in the shared inbox once the approved provider
                  channel is connected.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        )}
        {data.access.can_followups && (
          <TabsContent value="followups" className="mt-4">
            <Card className="shadow-none">
              <Followups followups={data.followups} />
            </Card>
          </TabsContent>
        )}
        {data.access.can_appointments && (
          <TabsContent value="appointments" className="mt-4">
            <Card className="shadow-none">
              <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                <Clock3 className="size-6 text-blue-600" />
                <p className="font-semibold">
                  {data.counts.appointments
                    ? `${data.counts.appointments} linked appointments`
                    : 'No linked appointments'}
                </p>
                <Button asChild variant="outline">
                  <Link href={`/${role}/appointments`}>Open appointments</Link>
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
      <WorkCreateDialog
        kind="followups"
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        initialEntity={{
          leadId: lead.id,
          customerId: lead.customer_id,
          branchId: lead.branch_id,
          assignedUserId: lead.assigned_user_id,
        }}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['lead-detail', leadId] });
          queryClient.invalidateQueries({ queryKey: ['lead-workspace'] });
        }}
      />
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
