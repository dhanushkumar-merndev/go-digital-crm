'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import {
  CalendarCheck2,
  CalendarClock,
  CircleAlert,
  Clock3,
  PhoneCall,
  RefreshCw,
  Route,
  UserCheck,
  UsersRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { AppIcon } from '@/components/shared/icon';
import { MetricCard } from '@/components/shared/metric-card';
import { SectionCard } from '@/components/shared/section-card';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { AGGREGATE_REALTIME_MIN_INTERVAL_MS } from '@/lib/query/cache-policy';
import { TenantDashboardSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { roleHasNavigationSlug, roleNavigation } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import type { PageSpec } from '@/lib/domain';
import { cn } from '@/lib/utils';
import { ManualDashboardRefreshLimitError } from '@/lib/query/cached-dashboard-api';
import {
  useTenantRealtimeInvalidation,
  type TenantRealtimeResource,
} from '@/lib/realtime/use-realtime-invalidation';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import { toneStyles, type Tone } from './dashboard-tone';
import {
  tenantDashboardKey,
  type TenantDashboardLeadPreview,
  type TenantDashboardResult,
} from './tenant-dashboard-api';
import { useTenantDashboard } from './use-tenant-dashboard';

/** One tile per column on wide screens, whatever the role's tile count. */
const kpiColumns: Record<number, string> = {
  5: 'xl:grid-cols-5',
  6: 'xl:grid-cols-6',
  7: 'xl:grid-cols-7',
  8: 'xl:grid-cols-8',
};

/** The dashboard RPC buckets its days in this zone, so times are read back in it. */
const DASHBOARD_TIMEZONE = 'Asia/Kolkata';

type KpiCard = {
  key: string;
  label: string;
  value: number;
  caption: string;
  icon: LucideIcon;
  tone: Tone;
  href?: string;
};

function leadDestination(role: RoleKey) {
  if (role === 'telecaller' || role === 'sales-consultant') return 'my-leads';
  if (role === 'team-manager') return 'team-leads';
  if (role === 'showroom-manager') return 'showroom-leads';
  if (role === 'gm-sales') return 'sales-leads';
  return null;
}

/** The first of `slugs` this role actually has a page for, as a link. */
function firstPage(role: RoleKey, slugs: string[], query = '') {
  const slug = slugs.find((candidate) => roleHasNavigationSlug(role, candidate));
  return slug ? `/${role}/${slug}${query}` : undefined;
}

/**
 * One tile per number. Each tile opens the list that number counts, so the
 * page never has to print the same count a second time to make it actionable.
 */
function dashboardKpis(data: TenantDashboardResult, role: RoleKey): KpiCard[] {
  const { capabilities, kpis } = data;
  const leadPage = leadDestination(role);
  const leads =
    leadPage && roleHasNavigationSlug(role, leadPage) ? `/${role}/${leadPage}` : undefined;
  // Managers and their executive desks share the case list's slug.
  const caseList = firstPage(role, [
    'finance-cases',
    'insurance-cases',
    'rto-cases',
    'upcoming-deliveries',
    'exchange-requests',
    'customer-cases',
  ]);
  const cards: KpiCard[] = [];
  if (capabilities.leads)
    cards.push(
      {
        key: 'new_leads_today',
        label: 'New leads today',
        value: kpis.new_leads_today,
        caption: 'Created today',
        icon: UserCheck,
        tone: 'blue',
        href: leads ? `${leads}?status=new-today` : undefined,
      },
      {
        key: 'open_leads',
        label: 'Open leads',
        value: kpis.open_leads,
        caption: 'In your current scope',
        icon: UsersRound,
        tone: 'violet',
        href: leads,
      },
    );
  if (capabilities.calls)
    cards.push({
      key: 'calls_today',
      label: 'Calls today',
      value: kpis.calls_today,
      caption: 'Logged calls',
      icon: PhoneCall,
      tone: 'emerald',
      href: firstPage(role, ['team-calls', 'calls']),
    });
  if (capabilities.work)
    cards.push(
      {
        key: 'followups_due_today',
        label: 'Follow-ups today',
        value: kpis.followups_due_today,
        caption: 'Due today',
        icon: CalendarClock,
        tone: 'orange',
        href: firstPage(role, ['follow-ups'], '?status=today'),
      },
      {
        key: 'followups_overdue',
        label: 'Overdue follow-ups',
        value: kpis.followups_overdue,
        caption: 'Needs attention',
        icon: Clock3,
        tone: 'rose',
        href: firstPage(role, ['follow-ups'], '?status=overdue'),
      },
      {
        key: 'appointments_today',
        label: 'Appointments today',
        value: kpis.appointments_today,
        caption: 'Scheduled or confirmed',
        icon: CalendarCheck2,
        tone: 'cyan',
        href: firstPage(role, ['appointments']),
      },
    );
  if (capabilities.test_drives)
    cards.push({
      key: 'test_drives_today',
      label: 'Test drives today',
      value: kpis.test_drives_today,
      caption: 'Scheduled and active',
      icon: Route,
      tone: 'violet',
      href: firstPage(role, ['test-drives']),
    });
  if (capabilities.bookings)
    cards.push({
      key: 'bookings_month',
      label: 'Bookings this month',
      value: kpis.bookings_month,
      caption: 'Non-cancelled bookings',
      icon: CalendarCheck2,
      tone: 'amber',
      href: firstPage(role, ['bookings', 'bookings-overview', 'bookings-delivery']),
    });
  if (capabilities.inventory && !cards.length)
    cards.push({
      key: 'available_stock',
      label: 'Available stock',
      value: kpis.available_stock,
      caption: 'Authorized branches',
      icon: UsersRound,
      tone: 'blue',
      href: firstPage(role, ['vehicle-inventory', 'stock-check']),
    });
  if (capabilities.operations)
    cards.push(
      {
        key: 'open_cases',
        label: 'Open cases',
        value: kpis.open_cases,
        caption: 'Current authorized scope',
        icon: CircleAlert,
        tone: 'amber',
        href: caseList ? `${caseList}?status=OPEN` : undefined,
      },
      {
        key: 'overdue_cases',
        label: 'Overdue cases',
        value: kpis.overdue_cases,
        caption: 'Past due, not closed',
        icon: Clock3,
        tone: 'rose',
        href: caseList ? `${caseList}?status=ACTION_DUE` : undefined,
      },
      {
        key: 'cases_due_today',
        label: 'Due today',
        value: kpis.cases_due_today,
        caption: 'Open case commitments',
        icon: CalendarClock,
        tone: 'cyan',
        href: caseList ? `${caseList}?status=ACTION_DUE` : undefined,
      },
      {
        key: 'cases_completed_month',
        label: 'Completed this month',
        value: kpis.cases_completed_month,
        caption: 'Closed operational work',
        icon: CalendarCheck2,
        tone: 'emerald',
        href: caseList ? `${caseList}?status=COMPLETED` : undefined,
      },
    );
  return cards.slice(0, 8);
}

function subscriptions(data: TenantDashboardResult | undefined) {
  if (!data) return [];
  const resources: TenantRealtimeResource[] = [];
  if (data.capabilities.leads) resources.push('leads');
  if (data.capabilities.work) resources.push('work');
  if (data.capabilities.calls) resources.push('communications');
  if (data.capabilities.bookings) resources.push('sales');
  if (data.capabilities.inventory) resources.push('inventory');
  if (data.capabilities.test_drives && !resources.includes('work')) resources.push('work');
  if (data.capabilities.operations) resources.push('operations');
  return resources.map((resource) => ({
    resource,
    queryKeys: [tenantDashboardKey],
    minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  }));
}

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

function DashboardHeader({
  spec,
  role,
  generatedAt,
  heading,
  onRefresh,
  refreshing,
  manualRefreshRemaining,
  manualRefreshMessage,
}: {
  spec: PageSpec;
  role: RoleKey;
  generatedAt?: string;
  heading?: string;
  onRefresh: () => void;
  refreshing: boolean;
  manualRefreshRemaining: number;
  manualRefreshMessage?: string;
}) {
  const navigation = roleNavigation[role];
  return (
    <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
          {heading ?? `${navigation.shortLabel} Workspace`}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{spec.description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing || manualRefreshRemaining === 0}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          {generatedAt ? `Last synced ${formatTime(generatedAt)}` : 'Refresh'}
        </Button>
        <span>{manualRefreshRemaining}/3 manual refreshes left</span>
        {manualRefreshMessage && <span className="text-rose-600">{manualRefreshMessage}</span>}
      </div>
    </div>
  );
}

function LeadPreviewTable({
  records,
  leadHref,
}: {
  records: TenantDashboardLeadPreview[];
  leadHref: string | null;
}) {
  const router = useRouter();
  const openLead = (lead: TenantDashboardLeadPreview) => {
    if (!leadHref) return;
    router.push(`${leadHref}?q=${encodeURIComponent(lead.phone)}`);
  };
  return (
    <SectionCard
      title="Recently updated leads"
      description="Five most recently updated leads in your scope"
      actionHref={leadHref ?? undefined}
      actionLabel="View all leads"
      flush
      className="h-full"
    >
      {records.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead className="hidden lg:table-cell">Mobile</TableHead>
              <TableHead className="hidden xl:table-cell">Source</TableHead>
              <TableHead className="hidden xl:table-cell">Interested model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Temperature</TableHead>
              <TableHead className="hidden md:table-cell">Next follow-up</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((lead) => (
              <TableRow
                key={lead.id}
                onClick={() => openLead(lead)}
                tabIndex={leadHref ? 0 : undefined}
                role={leadHref ? 'link' : undefined}
                onKeyDown={(event) => {
                  if (leadHref && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    openLead(lead);
                  }
                }}
                className={leadHref ? 'cursor-pointer hover:bg-slate-50' : undefined}
              >
                <TableCell className="text-xs font-semibold text-blue-700">
                  {lead.customer_name}
                </TableCell>
                <TableCell className="hidden text-xs lg:table-cell">{lead.phone}</TableCell>
                <TableCell className="hidden text-xs xl:table-cell">{lead.source}</TableCell>
                <TableCell className="hidden text-xs xl:table-cell">
                  {lead.interested_model ?? '—'}
                </TableCell>
                <TableCell>
                  <Badge variant={leadStageVariant(lead.work_state ?? lead.lifecycle_status)}>
                    {lead.work_state === 'NEW_TODAY'
                      ? 'New today'
                      : lead.work_state === 'SLA_RISK'
                        ? 'SLA risk'
                        : lead.work_state === 'PENDING'
                          ? 'Pending'
                          : lead.lifecycle_status}
                  </Badge>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {lead.temperature ? (
                    <Badge variant={temperatureVariant(lead.temperature)}>{lead.temperature}</Badge>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                  {formatDateTime(lead.next_followup_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="p-8 text-center text-sm text-muted-foreground">
          No leads are currently visible in your assigned scope.
        </p>
      )}
    </SectionCard>
  );
}

/**
 * The individual follow-ups behind the overdue count: who, and how late. The
 * count itself is already a tile, so this panel lists records rather than
 * restating the number.
 */
function OverdueFollowups({ data, role }: { data: TenantDashboardResult; role: RoleKey }) {
  const href = firstPage(role, ['follow-ups'], '?status=overdue');
  const items = [...data.attention].sort(
    (left, right) =>
      new Date(left.sort_at).getTime() - new Date(right.sort_at).getTime() ||
      left.id.localeCompare(right.id),
  );
  return (
    <SectionCard
      title="Needs a follow-up now"
      actionHref={href}
      actionLabel="View follow-ups"
      className="flex h-[22rem] flex-col xl:h-full"
      contentClassName="min-h-0 flex-1 p-3"
    >
      {items.length ? (
        <ScrollArea type="always" className="h-full pr-1" aria-label="Overdue follow-ups">
          <div className="space-y-2 pr-2">
            {items.map((item) => (
              <Link
                key={item.id}
                href={href ?? '#'}
                className="flex items-start gap-2.5 rounded-lg border bg-white p-2.5 transition-colors hover:border-blue-200 hover:bg-blue-50/30"
              >
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
                      {formatTime(item.sort_at)}
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
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{item.detail}</p>
                </div>
              </Link>
            ))}
          </div>
        </ScrollArea>
      ) : (
        <p className="grid h-full place-items-center text-center text-xs text-muted-foreground">
          Nothing is overdue in your scope.
        </p>
      )}
    </SectionCard>
  );
}

/** Stage names and counts beside the funnel, with each step's conversion. */
function PipelineStages({ stages }: { stages: TenantDashboardResult['pipeline'] }) {
  const shown = stages.slice(0, 6);
  return (
    <div
      className="grid h-[260px] w-44 shrink-0 text-[10px]"
      style={{ gridTemplateRows: `25px repeat(${shown.length}, minmax(0, 1fr))` }}
    >
      <div className="flex items-center justify-between border-b font-medium text-muted-foreground">
        <span>Stage</span>
        <span>Count</span>
      </div>
      {shown.map((stage, index) => {
        const previous = shown[index - 1]?.value ?? stage.value;
        const conversion = previous > 0 ? (stage.value / previous) * 100 : 0;
        return (
          <div
            key={stage.name}
            className="flex items-center justify-between gap-2 border-b border-slate-100 last:border-0"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium text-[#263550]" title={stage.name}>
                {stage.name}
              </span>
              <span className="block text-[9px] text-emerald-600">
                {index === 0 ? 'Starting stage' : `${conversion.toFixed(1)}% conversion`}
              </span>
            </span>
            <span className="shrink-0 rounded bg-slate-50 px-1.5 py-0.5 font-semibold text-[#263550]">
              {stage.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const shortcutTones: Tone[] = ['blue', 'violet', 'emerald', 'orange', 'cyan', 'amber'];

/** Pages this role owns, so a shortcut can never lead somewhere it has no access. */
function QuickActions({ role }: { role: RoleKey }) {
  const items = roleNavigation[role].items
    .filter((item) => item.slug !== 'dashboard' && !item.optional)
    .slice(0, 6);
  if (!items.length) return null;
  return (
    <SectionCard title="Quick actions" contentClassName="p-3">
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {items.map((item, index) => (
          <Link
            key={item.slug}
            href={`/${role}/${item.slug}`}
            className="group flex min-w-0 flex-col items-center rounded-lg p-1.5 text-center hover:bg-slate-50"
          >
            <span
              className={cn(
                'grid size-8 place-items-center rounded-lg transition-transform group-hover:-translate-y-0.5',
                toneStyles[shortcutTones[index % shortcutTones.length]!].icon,
              )}
            >
              <AppIcon name={item.icon} className="size-4" />
            </span>
            <span className="mt-1.5 text-[10px] font-medium leading-3 text-[#263550]">
              {item.title}
            </span>
          </Link>
        ))}
      </div>
    </SectionCard>
  );
}

export function TenantDashboard({
  spec,
  role,
  heading,
  children,
}: {
  spec: PageSpec;
  role: RoleKey;
  heading?: string;
  /** Extra sections a host page appends below the dashboard. */
  children?: React.ReactNode;
}) {
  const session = useWorkspaceSession();
  const manualRefreshRequest = useRef(false);
  const dashboardKey = useMemo(
    () => [...tenantDashboardKey, ...workspaceQueryScope(session)] as const,
    [session],
  );
  // Browser first: memory, then the IndexedDB copy, then Redis, then PostgreSQL.
  const dashboard = useTenantDashboard(dashboardKey, manualRefreshRequest);
  const realtimeSubscriptions = useMemo(() => subscriptions(dashboard.data), [dashboard.data]);
  useTenantRealtimeInvalidation(dashboard.data?.organization_id, realtimeSubscriptions);
  const [manualRefreshRemaining, setManualRefreshRemaining] = useState(3);
  const [manualRefreshMessage, setManualRefreshMessage] = useState<string>();

  const refresh = async () => {
    setManualRefreshMessage(undefined);
    manualRefreshRequest.current = true;
    const result = await dashboard.refetch();
    manualRefreshRequest.current = false;
    if (result.error instanceof ManualDashboardRefreshLimitError) {
      setManualRefreshRemaining(0);
      setManualRefreshMessage('Refresh limit reached. Try again after the 30-minute window.');
      return;
    }
    if (!result.error) {
      const budget = result.data?.refresh_budget;
      if (budget?.enforced && budget.remaining !== null) {
        setManualRefreshRemaining(budget.remaining);
      } else {
        setManualRefreshRemaining((remaining) => Math.max(0, remaining - 1));
      }
    }
  };

  const header = (generatedAt?: string) => (
    <DashboardHeader
      spec={spec}
      role={role}
      heading={heading}
      generatedAt={generatedAt}
      onRefresh={() => void refresh()}
      refreshing={dashboard.isFetching}
      manualRefreshRemaining={manualRefreshRemaining}
      manualRefreshMessage={manualRefreshMessage}
    />
  );

  if (dashboard.isPending) return <TenantDashboardSkeleton role={role} />;
  if (dashboard.isError || !dashboard.data)
    return (
      <div className="mx-auto max-w-[1800px] space-y-4">
        {header()}
        <Card className="shadow-none">
          <CardContent className="p-8 text-center">
            <p className="font-semibold">Dashboard data is unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Your current role, data scope, or dashboard connection needs attention.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  const data = dashboard.data;
  const leadPage = leadDestination(role);
  const leadsHref =
    leadPage && roleHasNavigationSlug(role, leadPage) ? `/${role}/${leadPage}` : null;
  const kpis = dashboardKpis(data, role);
  // Roles with a sales analytics page read the funnel there, not twice.
  const ownsFunnelElsewhere = ['sales-overview', 'sales-performance'].some((slug) =>
    roleHasNavigationSlug(role, slug),
  );
  const showPipeline =
    data.capabilities.leads &&
    !ownsFunnelElsewhere &&
    data.pipeline.some((stage) => stage.value > 0);

  return (
    <div className="mx-auto max-w-[1800px] space-y-4 pb-8">
      {header(data.generated_at)}

      <div className={cn('grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4', kpiColumns[kpis.length])}>
        {kpis.map(({ key, ...metric }) => (
          <MetricCard key={key} {...metric} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <SectionCard
          title="Activity trend"
          className={showPipeline ? 'xl:col-span-7' : 'xl:col-span-12'}
          action={
            <span className="rounded-md border px-2 py-1 text-[10px] text-muted-foreground">
              Last {data.days} days
            </span>
          }
        >
          <EChart
            kind="line"
            data={data.activity}
            seriesNames={[data.activity_primary, data.activity_secondary]}
            className="h-[260px]"
          />
        </SectionCard>
        {showPipeline ? (
          <SectionCard
            title="Lead pipeline"
            className="xl:col-span-5"
            actionHref={leadsHref ?? undefined}
            actionLabel="View leads"
          >
            <div className="flex gap-3">
              <EChart
                kind="funnel"
                funnelMode="staged"
                data={data.pipeline}
                className="h-[260px] min-w-0 flex-1"
              />
              <PipelineStages stages={data.pipeline} />
            </div>
          </SectionCard>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        {data.capabilities.leads ? (
          <div className="xl:col-span-8">
            <LeadPreviewTable records={data.lead_preview} leadHref={leadsHref} />
          </div>
        ) : null}
        <div
          className={cn(
            'flex flex-col gap-4',
            data.capabilities.leads ? 'xl:col-span-4' : 'xl:col-span-12',
          )}
        >
          {data.capabilities.work ? <OverdueFollowups data={data} role={role} /> : null}
          <QuickActions role={role} />
        </div>
      </div>
      {children}
    </div>
  );
}
