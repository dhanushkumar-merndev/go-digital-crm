'use client';

import { PageHeader } from '@/components/shared/page-header';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
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
import { kpiGridColumns } from '@/components/shared/kpi-grid';
import { AiDashboardSummary } from './ai-dashboard-summary';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { TelecallerDashboardSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
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
import { retryRpcRead } from '@/lib/supabase/read-rpc';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import {
  fetchLeadWorkspaceMeta,
  leadsQualifiedOrLater,
  toLeadMetaQuery,
  type LeadWorkspaceResult,
} from '@/features/leads/lead-workspace-api';
import { defaultLeadQuery } from '@/features/leads/lead-workspace-query';
import { fetchWorkWorkspace } from '@/features/work/workspace-api';
import { defaultWorkQuery } from '@/features/work/workspace-query';
import { focusRowHref } from '@/lib/navigation/focus-row';
import { leadDetailHref, myLeadsFocusHref } from '@/lib/navigation/record-links';
import { ManualDashboardRefreshLimitError } from '@/lib/query/cached-dashboard-api';
import {
  AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { countRecordSchema, usePersistedQuery } from '@/lib/query/persisted-query';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { cn } from '@/lib/utils';
import { toneStyles, type Tone } from './dashboard-tone';
import {
  overdueText,
  tenantDashboardKey,
  type TenantDashboardLeadPreview,
  type TenantDashboardResult,
} from './tenant-dashboard-api';
import { useTenantDashboard } from './use-tenant-dashboard';
import { leadTemperatureVariant } from '@/features/leads/lead-temperature-variant';

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
  /** `undefined` while the query that owns the number is still loading. */
  value: number | undefined;
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

type FollowupDashboardKpis = { today: number; overdue: number };

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

function leadStatusLabel(lead: TenantDashboardLeadPreview) {
  // “New” is the Telecaller's uncontacted queue for today. The day boundary is
  // a system rule; repeating it in every badge made the workflow unclear.
  if (lead.work_state === 'NEW_TODAY') return 'New';
  if (lead.work_state === 'SLA_RISK') return 'SLA risk';
  return lead.lifecycle_status;
}

function pipelineStage(data: TenantDashboardResult, name: string) {
  return data.pipeline.find((stage) => stage.name === name)?.value ?? 0;
}

/**
 * The pipeline RPC reports where each lead is now, not how many passed through a
 * stage, so stage-over-stage "conversion" read 233% when more leads sat in
 * Contacted than in New. Each stage's share of the queue is what these numbers
 * can honestly show.
 */
/** The free text shown until the telecaller asks for an AI summary. */
function telecallerSummaryText(
  data: TenantDashboardResult,
  followups: FollowupDashboardKpis | undefined,
) {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const overdue = followups?.overdue ?? data.kpis.followups_overdue;
  const dueToday = followups?.today ?? data.kpis.followups_due_today;
  return `${plural(data.kpis.new_leads_today, 'new lead')} today and ${plural(dueToday, 'follow-up')} due. ${
    overdue
      ? `Clear ${plural(overdue, 'overdue follow-up')} first, then call the new leads.`
      : 'No follow-ups are overdue, so start with the new leads.'
  }`;
}

type FunnelStage = { name: string; value: number; color: string };

/**
 * The telecaller's leads counted at every stage they have passed, so each stage
 * holds no more than the one before it. The summary's pipeline only lists open
 * leads by their current stage, which left the 373 already handed to Sales out
 * of the funnel and drew Contacted wider than New. Lost leads drop out after
 * contact, so they count as contacted and are reported beside the funnel.
 * Colours follow AGENTS.md 9.8.
 */
function pipelineFunnel(kpis: LeadWorkspaceResult['kpis']): FunnelStage[] {
  const qualified = leadsQualifiedOrLater(kpis);
  return [
    { name: 'Assigned', value: kpis.total, color: '#2563eb' },
    {
      name: 'Contacted',
      value: Math.max(kpis.total - kpis.new_count, qualified),
      color: '#0891b2',
    },
    { name: 'Qualified', value: qualified, color: '#0d9488' },
    { name: 'Transferred to sales', value: kpis.transferred_to_sales_count, color: '#059669' },
  ];
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
function handoffRate(data: TenantDashboardResult, leadKpis?: LeadWorkspaceResult['kpis']) {
  if (leadKpis) {
    if (leadKpis.total <= 0) return 0;
    return Math.round((leadKpis.transferred_to_sales_count / leadKpis.total) * 100);
  }
  const total = data.pipeline.reduce((sum, stage) => sum + stage.value, 0);
  if (total <= 0) return 0;
  return Math.round((pipelineStage(data, PIPELINE_TRANSFERRED) / total) * 100);
}

function metricCards(
  data: TenantDashboardResult,
  leadKpis: LeadWorkspaceResult['kpis'] | undefined,
  followupKpis: FollowupDashboardKpis | undefined,
  pending: { leads: boolean; followups: boolean },
): MetricCardModel[] {
  const leads = `/${DASHBOARD_ROLE}/my-leads`;
  const followups = `/${DASHBOARD_ROLE}/follow-ups`;
  // A tile owned by the lead or follow-up workspace waits for that query rather
  // than showing the summary's number first and then jumping to a different one.
  const fromLeads = (value: number) => (pending.leads ? undefined : value);
  const fromFollowups = (value: number) => (pending.followups ? undefined : value);
  return [
    {
      key: 'new_leads_today',
      label: 'New leads',
      // My Leads calls this same derived queue “New”. Keeping both surfaces on
      // NEW_TODAY means a click always lands on the tab showing this count.
      value: fromLeads(leadKpis?.new_today ?? data.kpis.new_leads_today),
      icon: UserRoundPlus,
      tone: 'blue',
      href: `${leads}?status=new-today`,
      change: dayOverDayChange(data, 'New leads'),
      caption: 'Fresh enquiries',
    },
    {
      key: 'open_leads',
      label: 'Total my leads',
      // “Assigned” was previously the active-only dashboard number while its
      // destination was My Leads > All. Use the exact All-tab total instead.
      value: fromLeads(leadKpis?.total ?? data.kpis.open_leads),
      icon: UsersRound,
      tone: 'violet',
      href: leads,
      caption: 'All assigned leads',
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
      value: fromFollowups(followupKpis?.today ?? data.kpis.followups_due_today),
      icon: CalendarClock,
      tone: 'orange',
      href: `${followups}?status=today`,
      caption: 'Customer commitments',
    },
    {
      key: 'followups_overdue',
      label: 'Overdue follow-ups',
      value: fromFollowups(followupKpis?.overdue ?? data.kpis.followups_overdue),
      icon: Clock3,
      tone: 'rose',
      href: `${followups}?status=overdue`,
      caption: 'Needs attention',
    },
    {
      key: 'contacted_leads',
      label: 'Contacted leads',
      value: fromLeads(leadKpis?.contacted_count ?? pipelineStage(data, 'Contacted')),
      icon: PhoneOutgoing,
      tone: 'cyan',
      href: `${leads}?status=contacted`,
      caption: 'Reached, not yet qualified',
    },
    {
      key: 'handoff_rate',
      label: 'Handoff rate',
      // Not a stage count. 'Qualified' used to sit here and could only ever read
      // zero: transfer_lead_to_sales sets it, then record_sales_lead_handoff
      // replaces it with 'Transferred to Sales' inside the same transaction, so
      // no lead is ever at rest in it. This reports the telecaller's actual
      // output instead -- how much of the queue reached Sales.
      value: fromLeads(handoffRate(data, leadKpis)),
      suffix: '%',
      icon: BadgeCheck,
      tone: 'amber',
      href: `${leads}?status=transferred-to-sales`,
      caption: 'of assigned leads',
    },
    {
      key: 'transferred_leads',
      label: 'Transferred to sales',
      value: fromLeads(
        leadKpis?.transferred_to_sales_count ?? pipelineStage(data, PIPELINE_TRANSFERRED),
      ),
      icon: UserRoundCheck,
      tone: 'emerald',
      href: `${leads}?status=transferred-to-sales`,
      caption: 'Handed to consultants',
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
      <Card
        data-kpi
        className="h-full min-w-0 border-slate-200/90 shadow-none transition-all group-hover:-translate-y-0.5 group-hover:border-blue-200 group-hover:shadow-sm"
      >
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
            <p className="min-w-0 text-[11px] font-semibold leading-4 text-heading-soft">
              {metric.label}
            </p>
          </div>
          <div className="mt-3 text-center text-[26px] font-bold leading-none tracking-tight text-heading">
            {metric.value === undefined ? (
              <Skeleton className="mx-auto h-[26px] w-14" />
            ) : (
              <>
                {metric.value}
                {metric.suffix}
              </>
            )}
          </div>
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
    <Card
      className={cn(
        'flex h-[22rem] min-h-0 flex-col overflow-hidden shadow-none xl:h-full',
        className,
      )}
    >
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
                // The card is a follow-up, so it opens the follow-up list with
                // that lead's row marked. Jumping to the lead record instead
                // dropped the caller out of the queue they were working.
                const href = item.lead_id
                  ? focusRowHref(`/${DASHBOARD_ROLE}/follow-ups`, item.lead_id, {
                      status: 'overdue',
                    })
                  : `/${DASHBOARD_ROLE}/follow-ups?status=overdue`;
                return (
                  <div key={item.id} className="relative grid grid-cols-[48px_1fr] gap-3">
                    <p className="pt-3 text-[10px] font-medium text-muted-foreground">
                      {formatTime(item.sort_at)}
                    </p>
                    <span className="absolute left-[49px] top-4 z-10 size-2 rounded-full border-2 border-white bg-blue-600" />
                    <Link
                      href={href}
                      aria-label={`Show the overdue follow-up for ${item.title} in the follow-up list`}
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
                              className="px-1.5 py-0 text-[10px] normal-case"
                            >
                              {overdueText(item.sort_at, data.generated_at)}
                            </Badge>
                          </div>
                          <p className="mt-0.5 truncate text-xs font-semibold text-heading">
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

function RecentLeads({
  leads,
  syncedAt,
  className,
}: {
  leads: TenantDashboardLeadPreview[];
  /** When the rows were read; a follow-up due before it is overdue. */
  syncedAt: string;
  className?: string;
}) {
  const syncedTime = new Date(syncedAt).getTime();
  const router = useRouter();
  // The row and the arrow go to the same place, so the arrow stays as the
  // visible affordance for anyone who does not know the row is clickable.
  const openLead = (lead: { id: string; phone: string | null }) =>
    router.push(myLeadsFocusHref(DASHBOARD_ROLE, lead));

  return (
    <Card className={cn('flex flex-col overflow-hidden shadow-none', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">My recent leads</CardTitle>
        <Button asChild variant="link" size="sm" className="h-auto px-0 text-[11px] text-blue-600">
          <Link href={`/${DASHBOARD_ROLE}/my-leads`}>
            View all leads <ArrowRight className="size-3" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="flex-1 p-0">
        {leads.length ? (
          <Table>
            <TableHeader className="bg-slate-50/80">
              <TableRow>
                <TableHead className="h-9 px-3 text-[10px] normal-case tracking-normal">
                  Customer
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[10px] normal-case tracking-normal lg:table-cell">
                  Mobile
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[10px] normal-case tracking-normal lg:table-cell">
                  Source
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[10px] normal-case tracking-normal lg:table-cell">
                  Interested model
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[10px] normal-case tracking-normal lg:table-cell">
                  Next follow-up
                </TableHead>
                <TableHead className="h-9 px-3 text-[10px] normal-case tracking-normal">
                  Status
                </TableHead>
                <TableHead className="h-9 px-3 text-[10px] normal-case tracking-normal">
                  Temperature
                </TableHead>
                <TableHead className="h-9 px-3 text-right text-[10px] normal-case tracking-normal">
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
                  onClick={() => openLead(lead)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openLead(lead);
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
                  <TableCell
                    className={cn(
                      'hidden whitespace-nowrap px-3 py-2 lg:table-cell',
                      lead.next_followup_at &&
                        new Date(lead.next_followup_at).getTime() < syncedTime &&
                        'font-semibold text-rose-600',
                    )}
                  >
                    {formatDateTime(lead.next_followup_at)}
                    {lead.next_followup_at && new Date(lead.next_followup_at).getTime() < syncedTime
                      ? ' · overdue'
                      : null}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      variant={leadStageVariant(lead.work_state ?? lead.lifecycle_status)}
                      className="rounded px-1.5 py-0 text-[10px]"
                    >
                      {leadStatusLabel(lead)}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      variant={leadTemperatureVariant(lead.temperature)}
                      className="rounded px-1.5 py-0 text-[10px]"
                    >
                      {lead.temperature ?? 'COLD'}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="flex justify-end">
                      <Button asChild variant="ghost" size="icon" className="size-7 text-blue-600">
                        <Link
                          href={myLeadsFocusHref(DASHBOARD_ROLE, lead)}
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
  const leadMetricsQueryKey = useMemo(
    () => ['lead-workspace-meta', ...workspaceQueryScope(workspaceSession), 'dashboard'] as const,
    [workspaceSession],
  );
  const followupMetricsQueryKey = useMemo(
    () =>
      [
        'work-workspace',
        ...workspaceQueryScope(workspaceSession),
        'followups',
        'dashboard',
      ] as const,
    [workspaceSession],
  );
  const manualRefreshRequest = useRef(false);
  // Browser first: memory, then the IndexedDB copy (a reload inside 30 minutes
  // makes no request for these counts), then PostgreSQL. The telecaller's
  // summary is their own records, so the Redis hop is skipped.
  const dashboard = useTenantDashboard(dashboardQueryKey, manualRefreshRequest, { direct: true });
  // The shared workspace RPC owns the Telecaller tab definitions (including
  // “Contacted” excluding leads already in Follow-up). Reusing it here keeps
  // dashboard cards and their destinations mathematically identical. Only the
  // counts are kept, so the persisted copy holds no filter lists or rows.
  const leadMetrics = usePersistedQuery({
    queryKey: leadMetricsQueryKey,
    retry: retryRpcRead,
    queryFn: async ({ signal }) =>
      (await fetchLeadWorkspaceMeta(toLeadMetaQuery(defaultLeadQuery), signal)).kpis,
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: countRecordSchema<LeadWorkspaceResult['kpis']>() },
  });
  // The Follow-ups workspace owns its overdue definition. Its KPI is used in
  // preference to the cached cross-module aggregate, avoiding a card/tab drift.
  const followupMetrics = usePersistedQuery({
    queryKey: followupMetricsQueryKey,
    queryFn: async ({ signal }) => {
      const result = await fetchWorkWorkspace(
        'followups',
        { ...defaultWorkQuery, status: 'all' },
        DASHBOARD_TIMEZONE,
        signal,
      );
      if (!('overdue' in result.kpis)) throw new Error('FOLLOWUP_KPI_UNAVAILABLE');
      return result.kpis;
    },
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: countRecordSchema<FollowupDashboardKpis>() },
  });
  const [refreshMessage, setRefreshMessage] = useState<string>();
  const [manualRefreshRemaining, setManualRefreshRemaining] = useState(3);
  const data = dashboard.data;
  const refreshing = dashboard.isFetching || leadMetrics.isFetching || followupMetrics.isFetching;

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
            queryKeys:
              resource === 'leads'
                ? [dashboardQueryKey, leadMetricsQueryKey]
                : resource === 'work'
                  ? [dashboardQueryKey, followupMetricsQueryKey]
                  : [dashboardQueryKey],
            minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
          }))
        : [],
    [dashboardQueryKey, data, followupMetricsQueryKey, leadMetricsQueryKey],
  );
  useTenantRealtimeInvalidation(data?.organization_id, realtimeSubscriptions);

  async function refresh(manual = true) {
    setRefreshMessage(undefined);
    manualRefreshRequest.current = manual;
    // Refresh means every number on the page: the lead and follow-up counts are
    // separate queries persisted in IndexedDB, and refetching only the summary
    // left them showing their old copy for up to 30 minutes. Both read the
    // database directly; the summary skips Redis on a manual refresh.
    const [result] = await Promise.all([
      dashboard.refetch(),
      leadMetrics.refetch(),
      followupMetrics.refetch(),
    ]);
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

  // Only the summary holds the page back; the tiles owned by the lead and
  // follow-up queries show their own placeholder until those land.
  if (dashboard.isPending) return <TelecallerDashboardSkeleton />;
  // A rejected Refresh (such as the 3-per-30-minute quota) must not replace a
  // rendered dashboard with a blank error page. Only the initial load has no
  // previous data to keep visible.
  if (!data)
    return (
      <div className="mx-auto w-full">
        <Card className="border-rose-100 shadow-none">
          <CardContent className="flex min-h-56 flex-col items-center justify-center p-8 text-center">
            <span className="grid size-11 place-items-center rounded-full bg-rose-50 text-rose-600">
              <BellRing className="size-5" />
            </span>
            <h2 className="mt-4 font-semibold text-heading">
              Telecaller dashboard could not be loaded
            </h2>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">
              Your current role, data scope, or dashboard connection needs attention.
            </p>
            <Button
              className="mt-5"
              variant="outline"
              onClick={() => void refresh(false)}
              disabled={refreshing}
            >
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );

  const metrics = metricCards(data, leadMetrics.data, followupMetrics.data, {
    leads: leadMetrics.isPending,
    followups: followupMetrics.isPending,
  });
  const funnel = leadMetrics.data ? pipelineFunnel(leadMetrics.data) : undefined;

  return (
    <div className="mx-auto w-full space-y-5 pb-8">
      <PageHeader
        spec={spec}
        title="Telecaller Workspace"
        description={spec.description}
        actions={
          <>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refresh()}
                disabled={refreshing || manualRefreshRemaining === 0}
              >
                <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
                Last synced {formatTime(data.generated_at)}
              </Button>
              <span>{manualRefreshRemaining}/3 manual refreshes left</span>
              {data.cache?.status === 'STALE' && <span>Updating&hellip;</span>}
              {refreshMessage && <span className="text-rose-600">{refreshMessage}</span>}
            </div>
          </>
        }
      />

      <div className={cn('grid gap-2.5', kpiGridColumns(metrics.length))}>
        {metrics.map((metric) => (
          <MetricCard key={metric.key} metric={metric} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <div className="grid gap-4 lg:grid-cols-12">
            <Card className="flex h-full flex-col overflow-hidden shadow-none lg:col-span-7">
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-sm">Lead pipeline</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col p-3">
                {/* The same card as the Sales Consultant dashboard: the funnel
                    with each stage's count beside it, then the AI summary.
                    Every stage is a share of the leads assigned. */}
                {funnel ? (
                  <div className="flex gap-3">
                    <EChart
                      kind="funnel"
                      funnelMode="staged"
                      funnelStages={funnel.length}
                      data={funnel}
                      colors={funnel.map((stage) => stage.color)}
                      className="h-[235px] min-w-0 flex-1"
                    />
                    <div className="flex w-52 shrink-0 flex-col justify-center text-[11px]">
                      <div className="flex items-center justify-between border-b pb-1.5 text-[10px] font-medium text-muted-foreground">
                        <span>Stage</span>
                        <span>Leads · of assigned</span>
                      </div>
                      {funnel.map((stage) => (
                        <div
                          key={stage.name}
                          className="flex items-center justify-between gap-2 border-b border-slate-100 py-2 last:border-0"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: stage.color }}
                            />
                            <span
                              className="truncate font-medium text-heading-soft"
                              title={stage.name}
                            >
                              {stage.name}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="font-semibold text-heading">{stage.value}</span>
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {funnel[0]!.value
                                ? Math.round((stage.value / funnel[0]!.value) * 100)
                                : 0}
                              %
                            </span>
                          </span>
                        </div>
                      ))}
                      <p className="pt-2 text-[10px] text-muted-foreground">
                        {leadMetrics.data?.lost_count ?? 0} lost after contact
                      </p>
                    </div>
                  </div>
                ) : (
                  <Skeleton className="h-[235px] w-full" />
                )}
                <AiDashboardSummary
                  title="AI calling summary"
                  defaultSummary={telecallerSummaryText(data, followupMetrics.data)}
                  timezone={DASHBOARD_TIMEZONE}
                />
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
                      <span className="mt-1.5 text-[10px] font-medium leading-3 text-heading-soft">
                        {label}
                      </span>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
        <div className="flex flex-col xl:col-span-4 xl-fill-row">
          <OverdueQueue data={data} className="flex-1 min-h-0" />
        </div>
        <div className="flex flex-col xl:col-span-12">
          <RecentLeads
            leads={data.lead_preview}
            syncedAt={data.generated_at}
            className="h-full flex-1"
          />
        </div>
      </div>
    </div>
  );
}
