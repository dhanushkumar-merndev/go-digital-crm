'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BadgeCheck,
  BellRing,
  CalendarClock,
  ChartNoAxesCombined,
  Clock3,
  PhoneCall,
  PhoneOutgoing,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  UserRoundCheck,
  UserRoundPlus,
  UsersRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { TelecallerDashboardSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { PageSpec } from '@/lib/domain';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import { leadDetailHref } from '@/lib/navigation/record-links';
import { ManualDashboardRefreshLimitError } from '@/lib/query/cached-dashboard-api';
import {
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { cn } from '@/lib/utils';
import { toneStyles, type Tone } from './dashboard-tone';
import {
  fetchTenantDashboard,
  tenantDashboardKey,
  type TenantDashboardLeadPreview,
  type TenantDashboardResult,
} from './tenant-dashboard-api';

/** Every link on this page is scoped to the telecaller workspace. */
const DASHBOARD_ROLE = 'telecaller';

/** The dashboard RPC buckets its days in this zone, so the page reads them back
 * in the same one rather than in whichever zone the browser happens to be in. */
const DASHBOARD_TIMEZONE = 'Asia/Kolkata';

/** The lifecycle stage the pipeline RPC emits that this page reads by name. */
const PIPELINE_TRANSFERRED = 'Transferred to Sales';

type MetricCardModel = {
  key: string;
  label: string;
  value: number;
  icon: LucideIcon;
  tone: Tone;
  href: string;
  /** A day-over-day move, where the activity series actually carries one. */
  change?: { percent: number; comparison: string };
  /** The caption shown when there is no comparable series behind the number. */
  caption?: string;
  /** Rendered against the value, for a card that reports a rate. */
  suffix?: string;
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: DASHBOARD_TIMEZONE,
  }).format(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return 'Not scheduled';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: DASHBOARD_TIMEZONE,
  }).format(new Date(value));
}

function temperatureVariant(temperature: TenantDashboardLeadPreview['temperature']) {
  if (temperature === 'HOT') return 'destructive' as const;
  if (temperature === 'WARM') return 'warning' as const;
  // DORMANT is do-not-disturb, not a colder COLD, so it must not share the
  // COLD styling: someone scanning the column has to see that this lead is
  // suppressed from outbound messaging. See AGENTS.md 9.7.
  if (temperature === 'DORMANT') return 'secondary' as const;
  return 'info' as const;
}

function leadStatusLabel(lead: TenantDashboardLeadPreview) {
  if (lead.work_state === 'NEW_TODAY') return 'New today';
  if (lead.work_state === 'SLA_RISK') return 'SLA risk';
  return lead.lifecycle_status;
}

function pipelineStage(data: TenantDashboardResult, name: string) {
  return data.pipeline.find((stage) => stage.name === name)?.value ?? 0;
}

/**
 * A day-over-day percentage for the two counts the activity series actually
 * tracks. The series is named by the RPC (`activity_primary` /
 * `activity_secondary`), so the reading is matched to the name rather than to
 * a position that changes with the caller's capabilities. Every other KPI on
 * this page has no historical series behind it and carries a caption instead —
 * inventing a trend for those would be worse than not showing one.
 */
function dayOverDayChange(data: TenantDashboardResult, seriesLabel: string) {
  const usesPrimary = data.activity_primary === seriesLabel;
  const usesSecondary = data.activity_secondary === seriesLabel;
  if (!usesPrimary && !usesSecondary) return undefined;
  if (data.activity.length < 2) return undefined;

  const readPoint = (point: (typeof data.activity)[number]) =>
    usesPrimary ? point.value : (point.secondary ?? 0);
  const today = readPoint(data.activity[data.activity.length - 1]!);
  const yesterday = readPoint(data.activity[data.activity.length - 2]!);
  if (yesterday === 0) return { percent: today === 0 ? 0 : 100, comparison: 'yesterday' };
  return {
    percent: Math.round(((today - yesterday) / yesterday) * 100),
    comparison: 'yesterday',
  };
}

/**
 * Share of the telecaller's non-lost queue that has reached Sales. Both terms
 * come from the same pipeline payload, so the rate cannot disagree with the
 * counts printed beside it.
 */
function handoffRate(data: TenantDashboardResult) {
  const total = data.pipeline.reduce((sum, stage) => sum + stage.value, 0);
  if (total <= 0) return 0;
  return Math.round((pipelineStage(data, PIPELINE_TRANSFERRED) / total) * 100);
}

function metricCards(data: TenantDashboardResult): MetricCardModel[] {
  const leads = `/${DASHBOARD_ROLE}/my-leads`;
  const followups = `/${DASHBOARD_ROLE}/follow-ups`;
  return [
    {
      key: 'new_leads_today',
      label: 'New leads today',
      value: data.kpis.new_leads_today,
      icon: UserRoundPlus,
      tone: 'blue',
      href: `${leads}?status=new-today`,
      change: dayOverDayChange(data, 'New leads'),
      caption: 'Fresh enquiries',
    },
    {
      key: 'open_leads',
      label: 'Leads assigned',
      value: data.kpis.open_leads,
      icon: UsersRound,
      tone: 'violet',
      href: leads,
      caption: 'Own active queue',
    },
    {
      key: 'calls_today',
      label: 'Calls logged today',
      value: data.kpis.calls_today,
      icon: PhoneCall,
      tone: 'emerald',
      href: `/${DASHBOARD_ROLE}/calls`,
      change: dayOverDayChange(data, 'Calls'),
      caption: 'Tracked calls',
    },
    {
      key: 'followups_due_today',
      label: 'Follow-ups today',
      value: data.kpis.followups_due_today,
      icon: CalendarClock,
      tone: 'orange',
      href: `${followups}?status=today`,
      caption: 'Customer commitments',
    },
    {
      key: 'followups_overdue',
      label: 'Overdue follow-ups',
      value: data.kpis.followups_overdue,
      icon: Clock3,
      tone: 'rose',
      href: `${followups}?status=overdue`,
      caption: 'Needs attention',
    },
    {
      key: 'contacted_leads',
      label: 'Contacted leads',
      value: pipelineStage(data, 'Contacted'),
      icon: PhoneOutgoing,
      tone: 'cyan',
      href: `${leads}?status=contacted`,
      caption: 'Customer reached',
    },
    {
      key: 'handoff_rate',
      label: 'Handoff rate',
      // Not a stage count. 'Qualified' used to sit here and could only ever read
      // zero: transfer_lead_to_sales sets it, then record_sales_lead_handoff
      // replaces it with 'Transferred to Sales' inside the same transaction, so
      // no lead is ever at rest in it. This reports the telecaller's actual
      // output instead -- how much of the queue reached Sales.
      value: handoffRate(data),
      suffix: '%',
      icon: BadgeCheck,
      tone: 'amber',
      href: `${leads}?status=transferred-to-sales`,
      caption: 'of assigned leads',
    },
    {
      key: 'transferred_leads',
      label: 'Transferred to sales',
      value: pipelineStage(data, PIPELINE_TRANSFERRED),
      icon: UserRoundCheck,
      tone: 'emerald',
      href: `${leads}?status=transferred-to-sales`,
      caption: 'Handed to consultants',
    },
  ];
}

function attentionTiles(data: TenantDashboardResult) {
  const leads = `/${DASHBOARD_ROLE}/my-leads`;
  const followups = `/${DASHBOARD_ROLE}/follow-ups`;
  return [
    {
      key: 'OVERDUE_FOLLOWUPS',
      label: 'Overdue follow-up',
      value: data.kpis.followups_overdue,
      action: 'View follow-ups',
      icon: Clock3,
      tone: 'rose' as Tone,
      href: `${followups}?status=overdue`,
    },
    {
      key: 'FOLLOWUPS_TODAY',
      label: 'Follow-up due today',
      value: data.kpis.followups_due_today,
      action: 'View follow-ups',
      icon: CalendarClock,
      tone: 'orange' as Tone,
      href: `${followups}?status=today`,
    },
    {
      key: 'AWAITING_FIRST_CALL',
      label: 'Lead awaiting first call',
      value: pipelineStage(data, 'New'),
      action: 'View leads',
      icon: PhoneOutgoing,
      tone: 'violet' as Tone,
      href: `${leads}?status=new`,
    },
    {
      key: 'CONTACTED_AWAITING_HANDOFF',
      label: 'Contacted, not yet handed off',
      // Replaces a 'Qualified' tile that could not be non-zero. These are the
      // leads the customer has been reached on and that still need a decision.
      value: pipelineStage(data, 'Contacted'),
      action: 'Review contacted leads',
      icon: BadgeCheck,
      tone: 'cyan' as Tone,
      href: `${leads}?status=contacted`,
    },
    {
      key: 'OPEN_QUEUE',
      label: 'Open lead in your queue',
      value: data.kpis.open_leads,
      action: 'View leads',
      icon: UsersRound,
      tone: 'blue' as Tone,
      href: leads,
    },
  ];
}

function alertRows(data: TenantDashboardResult) {
  const leads = `/${DASHBOARD_ROLE}/my-leads`;
  const followups = `/${DASHBOARD_ROLE}/follow-ups`;
  return [
    {
      key: 'FOLLOWUPS_DUE',
      label: 'Follow-ups due today',
      value: data.kpis.followups_due_today,
      icon: Clock3,
      tone: 'rose' as Tone,
      href: `${followups}?status=today`,
    },
    {
      key: 'FOLLOWUPS_OVERDUE',
      label: 'Follow-ups overdue',
      value: data.kpis.followups_overdue,
      icon: BellRing,
      tone: 'rose' as Tone,
      href: `${followups}?status=overdue`,
    },
    {
      key: 'TRANSFERRED_TO_SALES',
      label: 'Transferred to Sales',
      value: pipelineStage(data, PIPELINE_TRANSFERRED),
      icon: UserRoundCheck,
      tone: 'blue' as Tone,
      href: `${leads}?status=transferred-to-sales`,
    },
    {
      key: 'CALLS_TODAY',
      label: 'Calls logged today',
      value: data.kpis.calls_today,
      icon: PhoneCall,
      tone: 'emerald' as Tone,
      href: `/${DASHBOARD_ROLE}/calls`,
    },
    {
      key: 'NEW_LEADS_TODAY',
      label: 'New leads today',
      value: data.kpis.new_leads_today,
      icon: UserRoundPlus,
      tone: 'violet' as Tone,
      href: `${leads}?status=new-today`,
    },
    {
      key: 'AWAITING_FIRST_CALL',
      label: 'Leads awaiting first call',
      value: pipelineStage(data, 'New'),
      icon: PhoneOutgoing,
      tone: 'orange' as Tone,
      href: `${leads}?status=new`,
    },
  ];
}

function MetricCard({ metric }: { metric: MetricCardModel }) {
  const Icon = metric.icon;
  const positive = (metric.change?.percent ?? 0) >= 0;
  const TrendIcon = positive ? TrendingUp : TrendingDown;
  return (
    <Link
      href={metric.href}
      className="group min-w-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Card className="h-full min-w-0 border-slate-200/90 shadow-none transition-all group-hover:-translate-y-0.5 group-hover:border-blue-200 group-hover:shadow-sm">
        <CardContent className="p-4">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'grid size-8 shrink-0 place-items-center rounded-lg',
                toneStyles[metric.tone].icon,
              )}
            >
              <Icon className="size-4" />
            </span>
            <p className="min-w-0 text-[11px] font-semibold leading-4 text-[#263550]">
              {metric.label}
            </p>
          </div>
          <p className="mt-3 text-center text-[26px] font-bold leading-none tracking-tight text-[#12213f]">
            {metric.value}
            {metric.suffix}
          </p>
          {metric.change ? (
            <p
              className={cn(
                'mt-3 flex items-center justify-center gap-1 text-[10px] font-semibold',
                positive ? 'text-emerald-600' : 'text-rose-600',
              )}
            >
              <TrendIcon className="size-3" /> {Math.abs(metric.change.percent)}%
              <span className="font-normal text-muted-foreground">
                vs {metric.change.comparison}
              </span>
            </p>
          ) : (
            // The KPI has no historical series behind it, so the slot carries
            // what the number means instead of a trend that would be invented.
            <p className="mt-3 text-center text-[10px] font-normal text-muted-foreground">
              {metric.caption}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function OverdueQueue({ data, className }: { data: TenantDashboardResult; className?: string }) {
  const items = [...data.attention].sort((left, right) => {
    const difference = new Date(left.sort_at).getTime() - new Date(right.sort_at).getTime();
    if (difference) return difference;
    return left.id.localeCompare(right.id);
  });

  return (
    <Card className={cn('flex h-[22rem] min-h-0 flex-col overflow-hidden shadow-none', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3.5">
        <CardTitle className="text-sm">Needs a call now</CardTitle>
        <Button asChild variant="link" size="sm" className="h-auto px-0 text-[11px] text-blue-600">
          <Link href={`/${DASHBOARD_ROLE}/follow-ups?status=overdue`}>View follow-ups</Link>
        </Button>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-3">
        {items.length ? (
          <ScrollArea type="always" className="min-h-0 flex-1 pr-1" aria-label="Overdue follow-ups">
            <div className="relative space-y-2 pr-2 before:absolute before:bottom-5 before:left-[52px] before:top-5 before:w-px before:bg-slate-200">
              {items.map((item) => {
                const href = item.lead_id
                  ? leadDetailHref(DASHBOARD_ROLE, item.lead_id)
                  : `/${DASHBOARD_ROLE}/follow-ups?status=overdue`;
                return (
                  <div key={item.id} className="relative grid grid-cols-[48px_1fr] gap-3">
                    <p className="pt-3 text-[10px] font-medium text-muted-foreground">
                      {formatTime(item.sort_at)}
                    </p>
                    <span className="absolute left-[49px] top-4 z-10 size-2 rounded-full border-2 border-white bg-blue-600" />
                    <Link
                      href={href}
                      aria-label={`Open the overdue follow-up for ${item.title}`}
                      className="ml-2 rounded-lg border bg-white p-2.5 transition-colors hover:border-blue-200 hover:bg-blue-50/30"
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className={cn(
                            'grid size-7 shrink-0 place-items-center rounded-md',
                            toneStyles[item.severity === 'HIGH' ? 'rose' : 'orange'].icon,
                          )}
                        >
                          <PhoneCall className="size-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[10px] font-medium text-muted-foreground">
                              Follow-up
                            </p>
                            <Badge
                              variant={item.severity === 'HIGH' ? 'destructive' : 'warning'}
                              className="px-1.5 py-0 text-[9px] normal-case"
                            >
                              {item.severity === 'HIGH' ? 'overdue 1 day+' : 'overdue'}
                            </Badge>
                          </div>
                          <p className="mt-0.5 truncate text-xs font-semibold text-[#17233d]">
                            {item.title}
                          </p>
                          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                            {item.detail}
                          </p>
                        </div>
                      </div>
                    </Link>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <span className="grid size-10 place-items-center rounded-full bg-emerald-50 text-emerald-600">
              <BadgeCheck className="size-5" />
            </span>
            <p className="mt-3 text-sm font-semibold">Nothing is overdue</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Follow-ups appear here the moment they pass their due time.
            </p>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="mt-3 w-full max-w-[272px] border-blue-200 text-blue-700"
            >
              <Link href={`/${DASHBOARD_ROLE}/follow-ups?status=today`}>
                View today&apos;s follow-ups <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentLeads({ leads }: { leads: TenantDashboardLeadPreview[] }) {
  const router = useRouter();
  // The row and the arrow go to the same place, so the arrow stays as the
  // visible affordance for anyone who does not know the row is clickable.
  const openLead = (leadId: string) =>
    router.push(`/${DASHBOARD_ROLE}/my-leads?status=all&focus=${encodeURIComponent(leadId)}`);

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">My recent leads</CardTitle>
        <Button asChild variant="link" size="sm" className="h-auto px-0 text-[11px] text-blue-600">
          <Link href={`/${DASHBOARD_ROLE}/my-leads`}>
            View all leads <ArrowRight className="size-3" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {leads.length ? (
          <Table>
            <TableHeader className="bg-slate-50/80">
              <TableRow>
                <TableHead className="h-9 px-3 text-[9px] normal-case tracking-normal">
                  Customer
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[9px] normal-case tracking-normal lg:table-cell">
                  Mobile
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[9px] normal-case tracking-normal lg:table-cell">
                  Source
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[9px] normal-case tracking-normal lg:table-cell">
                  Interested model
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[9px] normal-case tracking-normal lg:table-cell">
                  Next follow-up
                </TableHead>
                <TableHead className="h-9 px-3 text-[9px] normal-case tracking-normal">
                  Status
                </TableHead>
                <TableHead className="h-9 px-3 text-[9px] normal-case tracking-normal">
                  Temperature
                </TableHead>
                <TableHead className="h-9 px-3 text-right text-[9px] normal-case tracking-normal">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow
                  key={lead.id}
                  role="link"
                  tabIndex={0}
                  aria-label={`Open ${lead.customer_name} in My Leads`}
                  onClick={() => openLead(lead.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openLead(lead.id);
                    }
                  }}
                  className="cursor-pointer text-[10px] hover:bg-slate-50"
                >
                  <TableCell className="whitespace-nowrap px-3 py-2 font-semibold text-blue-700">
                    {/* The name opens the lead's own record page, so it keeps
                        its own destination rather than the row's. */}
                    <Link
                      href={leadDetailHref(DASHBOARD_ROLE, lead.id)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {lead.customer_name}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden px-3 py-2 lg:table-cell">{lead.phone}</TableCell>
                  <TableCell className="hidden px-3 py-2 lg:table-cell">{lead.source}</TableCell>
                  <TableCell className="hidden max-w-36 truncate px-3 py-2 lg:table-cell">
                    {lead.interested_model ?? '—'}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap px-3 py-2 lg:table-cell">
                    {formatDateTime(lead.next_followup_at)}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      variant={leadStageVariant(lead.work_state ?? lead.lifecycle_status)}
                      className="rounded px-1.5 py-0 text-[9px]"
                    >
                      {leadStatusLabel(lead)}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      variant={temperatureVariant(lead.temperature)}
                      className="rounded px-1.5 py-0 text-[9px]"
                    >
                      {lead.temperature ?? 'COLD'}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="flex justify-end">
                      <Button asChild variant="ghost" size="icon" className="size-7 text-blue-600">
                        <Link
                          href={`/${DASHBOARD_ROLE}/my-leads?status=all&focus=${encodeURIComponent(lead.id)}`}
                          aria-label={`Open ${lead.customer_name} in My Leads`}
                          title={`Open ${lead.customer_name} in My Leads`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <ArrowRight className="size-3.5" />
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No leads are assigned to you yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function TelecallerDashboard({ spec }: { spec: PageSpec }) {
  const workspaceSession = useWorkspaceSession();
  const dashboardQueryKey = useMemo(
    () => [...tenantDashboardKey, ...workspaceQueryScope(workspaceSession)] as const,
    [workspaceSession],
  );
  const manualRefreshRequest = useRef(false);
  const dashboard = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: ({ signal }) =>
      fetchTenantDashboard(signal, { manualRefresh: manualRefreshRequest.current }),
    // Matches the consultant dashboard: an in-session revisit is served from
    // memory, a cold start reads Redis, and only Refresh rebuilds from Postgres.
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
  });
  const [refreshMessage, setRefreshMessage] = useState<string>();
  const [manualRefreshRemaining, setManualRefreshRemaining] = useState(3);
  const data = dashboard.data;

  // The server's refresh budget is mirrored into local state as a render-phase
  // adjustment rather than an effect: `refresh()` below also writes both values
  // on a rejected manual refresh, so they cannot simply be derived.
  const budget = data?.refresh_budget;
  const [syncedBudget, setSyncedBudget] = useState(budget);
  if (budget !== syncedBudget) {
    setSyncedBudget(budget);
    if (budget?.enforced && budget.remaining !== null) {
      setManualRefreshRemaining(budget.remaining);
    }
  }

  const realtimeSubscriptions = useMemo(
    () =>
      data
        ? (['leads', 'work', 'communications'] as const).map((resource) => ({
            resource,
            queryKeys: [dashboardQueryKey],
          }))
        : [],
    [dashboardQueryKey, data],
  );
  useTenantRealtimeInvalidation(data?.organization_id, realtimeSubscriptions);

  const conversionRate = useMemo(() => {
    if (!data?.pipeline.length) return 0;
    const first = data.pipeline[0]?.value ?? 0;
    const last = data.pipeline.at(-1)?.value ?? 0;
    return first > 0 ? (last / first) * 100 : 0;
  }, [data]);

  async function refresh(manual = true) {
    setRefreshMessage(undefined);
    manualRefreshRequest.current = manual;
    const result = await dashboard.refetch();
    manualRefreshRequest.current = false;
    if (manual && result.error instanceof ManualDashboardRefreshLimitError) {
      setManualRefreshRemaining(0);
      setRefreshMessage('Refresh limit reached. Try again after the 30-minute window.');
      return;
    }
    if (result.error) {
      setRefreshMessage('Could not refresh right now. Showing the last synced dashboard.');
      return;
    }
    if (manual) {
      const nextBudget = result.data?.refresh_budget;
      if (nextBudget?.enforced && nextBudget.remaining !== null)
        setManualRefreshRemaining(nextBudget.remaining);
      else setManualRefreshRemaining((remaining) => Math.max(0, remaining - 1));
    }
  }

  if (dashboard.isPending) return <TelecallerDashboardSkeleton />;
  // A rejected Refresh (such as the 3-per-30-minute quota) must not replace a
  // rendered dashboard with a blank error page. Only the initial load has no
  // previous data to keep visible.
  if (!data)
    return (
      <div className="mx-auto max-w-[1800px]">
        <Card className="border-rose-100 shadow-none">
          <CardContent className="flex min-h-56 flex-col items-center justify-center p-8 text-center">
            <span className="grid size-11 place-items-center rounded-full bg-rose-50 text-rose-600">
              <BellRing className="size-5" />
            </span>
            <h2 className="mt-4 font-semibold text-[#17233d]">
              Telecaller dashboard could not be loaded
            </h2>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">
              Your current role, data scope, or dashboard connection needs attention.
            </p>
            <Button
              className="mt-5"
              variant="outline"
              onClick={() => void refresh(false)}
              disabled={dashboard.isFetching}
            >
              <RefreshCw className={cn('size-4', dashboard.isFetching && 'animate-spin')} />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );

  const metrics = metricCards(data);
  const attention = attentionTiles(data);
  const alerts = alertRows(data);

  return (
    <div className="mx-auto max-w-[1800px] space-y-4">
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
            Telecaller Workspace
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{spec.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={dashboard.isFetching || manualRefreshRemaining === 0}
          >
            <RefreshCw className={cn('size-3.5', dashboard.isFetching && 'animate-spin')} />
            Last synced {formatTime(data.generated_at)}
          </Button>
          <span>{manualRefreshRemaining}/3 manual refreshes left</span>
          {refreshMessage && <span className="text-rose-600">{refreshMessage}</span>}
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-8">
        {metrics.map((metric) => (
          <MetricCard key={metric.key} metric={metric} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <Card className="shadow-none">
            <CardHeader className="border-b px-4 py-3.5">
              <CardTitle className="text-sm">Requires attention</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2.5 p-3 sm:grid-cols-2 lg:grid-cols-5">
              {attention.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={cn(
                      'group flex min-h-32 flex-col rounded-lg border p-3 transition-all hover:-translate-y-0.5 hover:shadow-sm',
                      toneStyles[item.tone].soft,
                      toneStyles[item.tone].border,
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          'grid size-8 place-items-center rounded-lg bg-white/90',
                          toneStyles[item.tone].icon,
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="text-xl font-bold text-[#17233d]">{item.value}</span>
                    </div>
                    <p className="mt-3 text-[11px] font-medium leading-4 text-[#263550]">
                      {item.label}
                    </p>
                    <span className="mt-auto flex items-center gap-1 pt-3 text-[10px] font-semibold text-blue-600">
                      {item.action}
                      <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                );
              })}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-12">
            <Card className="flex h-full flex-col overflow-hidden shadow-none lg:col-span-7">
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-sm">Lead pipeline funnel</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col p-3">
                <div className="flex gap-3">
                  <EChart
                    kind="funnel"
                    funnelMode="staged"
                    data={data.pipeline}
                    className="h-[235px] min-w-0 flex-1"
                  />
                  <div className="grid h-[235px] w-44 shrink-0 grid-rows-[25px_repeat(5,minmax(0,1fr))] text-[10px]">
                    <div className="flex items-center justify-between border-b font-medium text-muted-foreground">
                      <span>Stage</span>
                      <span>Count</span>
                    </div>
                    {data.pipeline.slice(0, 5).map((stage, index) => {
                      const previous = data.pipeline[index - 1]?.value ?? stage.value;
                      const conversion = previous > 0 ? (stage.value / previous) * 100 : 0;
                      return (
                        <div
                          key={stage.name}
                          className="flex items-center justify-between gap-2 border-b border-slate-100 last:border-0"
                        >
                          <span className="min-w-0">
                            <span
                              className="block truncate font-medium text-[#263550]"
                              title={stage.name}
                            >
                              {stage.name}
                            </span>
                            <span className="block text-[9px] text-emerald-600">
                              {index === 0
                                ? 'Starting stage'
                                : `${conversion.toFixed(1)}% conversion`}
                            </span>
                          </span>
                          <span className="shrink-0 rounded bg-slate-50 px-1.5 py-0.5 font-semibold text-[#263550]">
                            {stage.value}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between rounded-lg bg-slate-50 px-4 py-2.5 text-xs">
                  <span className="text-muted-foreground">Lead to handoff conversion</span>
                  <span className="font-bold text-[#17233d]">{conversionRate.toFixed(1)}%</span>
                  <span className="flex items-center gap-1 text-emerald-600">
                    <TrendingUp className="size-3.5" />
                    Live
                  </span>
                </div>
              </CardContent>
            </Card>
            <div className="space-y-4 lg:col-span-5">
              <Card className="shadow-none">
                <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
                  <CardTitle className="text-sm">Activity trend</CardTitle>
                  <span className="rounded-md border px-2 py-1 text-[10px] text-muted-foreground">
                    Last {data.days} days
                  </span>
                </CardHeader>
                <CardContent className="p-3">
                  <EChart
                    kind="line"
                    data={data.activity}
                    seriesNames={[data.activity_primary, data.activity_secondary]}
                    className="h-[168px]"
                  />
                </CardContent>
              </Card>
              <Card className="shadow-none">
                <CardHeader className="border-b px-4 py-3">
                  <CardTitle className="text-sm">Quick actions</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-5 gap-1.5 p-3">
                  {(
                    [
                      [
                        'Add lead',
                        UserRoundPlus,
                        `/${DASHBOARD_ROLE}/my-leads?action=create`,
                        'blue',
                      ],
                      [
                        'Log call',
                        PhoneOutgoing,
                        `/${DASHBOARD_ROLE}/calls?action=create`,
                        'emerald',
                      ],
                      [
                        'Qualified leads',
                        BadgeCheck,
                        `/${DASHBOARD_ROLE}/my-leads?status=qualified`,
                        'cyan',
                      ],
                      [
                        'Follow-ups',
                        CalendarClock,
                        `/${DASHBOARD_ROLE}/follow-ups?status=today`,
                        'orange',
                      ],
                      [
                        'Performance',
                        ChartNoAxesCombined,
                        `/${DASHBOARD_ROLE}/performance`,
                        'violet',
                      ],
                    ] as const
                  ).map(([label, Icon, href, tone]) => (
                    <Link
                      key={label}
                      href={href}
                      className="group flex min-w-0 flex-col items-center rounded-lg p-1.5 text-center hover:bg-slate-50"
                    >
                      <span
                        className={cn(
                          'grid size-8 place-items-center rounded-lg transition-transform group-hover:-translate-y-0.5',
                          toneStyles[tone].icon,
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="mt-1.5 text-[9px] font-medium leading-3 text-[#263550]">
                        {label}
                      </span>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
          <RecentLeads leads={data.lead_preview} />
        </div>
        <div className="space-y-4 xl:col-span-4">
          <OverdueQueue data={data} className="xl:h-[690px]" />
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
              <CardTitle className="text-sm">Tasks &amp; alerts</CardTitle>
              <Button
                asChild
                variant="link"
                size="sm"
                className="h-auto px-0 text-[11px] text-blue-600"
              >
                <Link href={`/${DASHBOARD_ROLE}/tasks`}>
                  View all <ArrowRight className="size-3" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="divide-y p-0">
              {alerts.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    <span
                      className={cn(
                        'grid size-7 place-items-center rounded-md',
                        toneStyles[item.tone].icon,
                      )}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[#263550]">
                      {item.label}
                    </span>
                    <span className="text-xs font-bold text-[#17233d]">{item.value}</span>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
