'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
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
import { EChart } from '@/components/charts/e-chart';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { roleNavigation } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import type { PageSpec } from '@/lib/domain';
import { ManualDashboardRefreshLimitError } from '@/lib/query/cached-dashboard-api';
import {
  useTenantRealtimeInvalidation,
  type TenantRealtimeResource,
} from '@/lib/realtime/use-realtime-invalidation';
import {
  fetchTenantDashboard,
  tenantDashboardKey,
  type TenantDashboardLeadPreview,
  type TenantDashboardResult,
} from './tenant-dashboard-api';

type KpiCard = {
  label: string;
  value: number;
  helper: string;
  icon: typeof UsersRound;
  tone: string;
};

function leadDestination(role: RoleKey) {
  if (role === 'telecaller' || role === 'sales-consultant') return 'my-leads';
  if (role === 'team-manager') return 'team-leads';
  if (role === 'showroom-manager') return 'showroom-leads';
  if (role === 'gm-sales') return 'sales-leads';
  return null;
}

function dashboardKpis(data: TenantDashboardResult): KpiCard[] {
  const { capabilities, kpis } = data;
  const cards: KpiCard[] = [];
  if (capabilities.leads) {
    cards.push(
      {
        label: 'New leads today',
        value: kpis.new_leads_today,
        helper: 'Created today',
        icon: UserCheck,
        tone: 'bg-blue-50 text-blue-600',
      },
      {
        label: 'Open leads',
        value: kpis.open_leads,
        helper: 'In your current scope',
        icon: UsersRound,
        tone: 'bg-indigo-50 text-indigo-600',
      },
    );
  }
  if (capabilities.calls)
    cards.push({
      label: 'Calls today',
      value: kpis.calls_today,
      helper: 'Logged calls',
      icon: PhoneCall,
      tone: 'bg-emerald-50 text-emerald-600',
    });
  if (capabilities.work) {
    cards.push(
      {
        label: 'Follow-ups today',
        value: kpis.followups_due_today,
        helper: 'Due today',
        icon: CalendarClock,
        tone: 'bg-amber-50 text-amber-600',
      },
      {
        label: 'Overdue follow-ups',
        value: kpis.followups_overdue,
        helper: 'Needs attention',
        icon: CircleAlert,
        tone: 'bg-rose-50 text-rose-600',
      },
      {
        label: 'Appointments today',
        value: kpis.appointments_today,
        helper: 'Scheduled or confirmed',
        icon: CalendarCheck2,
        tone: 'bg-cyan-50 text-cyan-600',
      },
    );
  }
  if (capabilities.test_drives)
    cards.push({
      label: 'Test drives today',
      value: kpis.test_drives_today,
      helper: 'Scheduled and active',
      icon: Route,
      tone: 'bg-violet-50 text-violet-600',
    });
  if (capabilities.bookings)
    cards.push({
      label: 'Bookings this month',
      value: kpis.bookings_month,
      helper: 'Non-cancelled bookings',
      icon: CalendarCheck2,
      tone: 'bg-orange-50 text-orange-600',
    });
  if (capabilities.inventory && !cards.length)
    cards.push({
      label: 'Available stock',
      value: kpis.available_stock,
      helper: 'Authorized branches',
      icon: UsersRound,
      tone: 'bg-blue-50 text-blue-600',
    });
  if (capabilities.operations && !cards.length)
    cards.push({
      label: 'Open cases',
      value: kpis.open_cases,
      helper: 'Current authorized scope',
      icon: CircleAlert,
      tone: 'bg-amber-50 text-amber-600',
    });
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
  }));
}

function formatDateTime(value: string | null) {
  if (!value) return 'Not scheduled';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusVariant(status: string): 'info' | 'success' | 'warning' | 'destructive' | 'outline' {
  if (status === 'Lost' || status === 'SLA_RISK') return 'destructive';
  if (status === 'Qualified' || status === 'Transferred to Sales') return 'success';
  if (status === 'Contacted' || status === 'PENDING') return 'warning';
  return 'info';
}

function temperatureVariant(temperature: TenantDashboardLeadPreview['temperature']) {
  if (temperature === 'HOT') return 'destructive' as const;
  if (temperature === 'WARM') return 'warning' as const;
  return 'info' as const;
}

function DashboardHeader({
  spec,
  role,
  generatedAt,
  onRefresh,
  refreshing,
  manualRefreshRemaining,
  manualRefreshMessage,
}: {
  spec: PageSpec;
  role: RoleKey;
  generatedAt?: string;
  onRefresh: () => void;
  refreshing: boolean;
  manualRefreshRemaining: number;
  manualRefreshMessage?: string;
}) {
  const navigation = roleNavigation[role];
  return (
    <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
      <div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>Workspace</span>
          <span>›</span>
          <span>Dashboard</span>
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-[#17233d] md:text-[28px]">
          {navigation.shortLabel} Dashboard
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{spec.description}</p>
        <p className="mt-2 text-xs font-medium text-blue-500">
          {navigation.label} · {navigation.scope}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {generatedAt && <span>Last updated: {formatDateTime(generatedAt)}</span>}
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          Refresh
        </Button>
        <span>{manualRefreshMessage ?? `${manualRefreshRemaining}/3 manual refreshes left`}</span>
      </div>
    </div>
  );
}

function PriorityCard({
  label,
  value,
  description,
  icon: Icon,
  tone,
  href,
}: {
  label: string;
  value: number;
  description: string;
  icon: typeof UsersRound;
  tone: string;
  href?: string;
}) {
  const content = (
    <div className="flex h-full flex-col items-center p-5 text-center">
      <span className={`grid size-10 place-items-center rounded-xl ${tone}`}>
        <Icon className="size-5" />
      </span>
      <p className="mt-3 text-sm font-semibold text-[#17233d]">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <p className="mt-3 text-2xl font-bold tracking-tight text-[#17233d]">{value}</p>
      {href && (
        <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-blue-600">
          View list <ArrowRight className="size-3.5" />
        </span>
      )}
    </div>
  );
  return href ? (
    <Link
      href={href}
      className="block h-full rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {content}
    </Link>
  ) : (
    content
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
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-5 py-4">
        <div>
          <CardTitle className="text-base">Leads at a glance</CardTitle>
          <CardDescription className="mt-1">
            Five most recently updated leads in your scope
          </CardDescription>
        </div>
        {leadHref && (
          <Button asChild variant="link" size="sm" className="h-auto px-0 text-blue-600">
            <Link href={leadHref}>
              View all leads <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {records.length ? (
          <Table>
            <TableHeader className="bg-slate-50/80">
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
                  <TableCell className="font-medium text-[#17233d]">{lead.customer_name}</TableCell>
                  <TableCell className="hidden lg:table-cell">{lead.phone}</TableCell>
                  <TableCell className="hidden xl:table-cell">{lead.source}</TableCell>
                  <TableCell className="hidden xl:table-cell">
                    {lead.interested_model ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(lead.work_state ?? lead.lifecycle_status)}>
                      {lead.work_state === 'NEW_TODAY'
                        ? 'New today'
                        : lead.work_state === 'SLA_RISK'
                          ? 'SLA risk'
                          : lead.lifecycle_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {lead.temperature ? (
                      <Badge variant={temperatureVariant(lead.temperature)}>
                        {lead.temperature}
                      </Badge>
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
          <div className="p-8 text-center text-sm text-muted-foreground">
            No leads are currently visible in your assigned scope.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TenantDashboard({ spec, role }: { spec: PageSpec; role: RoleKey }) {
  const manualRefreshRequest = useRef(false);
  const dashboard = useQuery({
    queryKey: tenantDashboardKey,
    queryFn: ({ signal }) =>
      fetchTenantDashboard(signal, { manualRefresh: manualRefreshRequest.current }),
  });
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
      setManualRefreshMessage(
        'Refresh limit reached. Try again after the current ten-minute window.',
      );
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

  if (dashboard.isPending) return <PageSkeleton />;
  if (dashboard.isError || !dashboard.data)
    return (
      <div className="mx-auto max-w-[1600px] space-y-6">
        <DashboardHeader
          spec={spec}
          role={role}
          onRefresh={refresh}
          refreshing={dashboard.isFetching}
          manualRefreshRemaining={manualRefreshRemaining}
          manualRefreshMessage={manualRefreshMessage}
        />
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
  const navigation = roleNavigation[role];
  const leadPage = leadDestination(role);
  const leadsHref = leadPage ? `/${role}/${leadPage}` : null;
  const priorityCards = [
    data.capabilities.leads
      ? {
          label: 'New leads',
          value: data.kpis.new_leads_today,
          description: 'Created today',
          icon: UserCheck,
          tone: 'bg-blue-50 text-blue-600',
          href: leadsHref ? `${leadsHref}?status=new-today` : undefined,
        }
      : null,
    data.capabilities.leads
      ? {
          label: 'Open lead queue',
          value: data.kpis.open_leads,
          description: 'Awaiting progress',
          icon: UsersRound,
          tone: 'bg-indigo-50 text-indigo-600',
          href: leadsHref ?? undefined,
        }
      : null,
    data.capabilities.work
      ? {
          label: 'Follow-ups today',
          value: data.kpis.followups_due_today,
          description: 'Customer commitments',
          icon: CalendarClock,
          tone: 'bg-amber-50 text-amber-600',
          href: `/${role}/follow-ups`,
        }
      : null,
    data.capabilities.work
      ? {
          label: 'Overdue follow-ups',
          value: data.kpis.followups_overdue,
          description: 'Needs attention',
          icon: CircleAlert,
          tone: 'bg-rose-50 text-rose-600',
          href: `/${role}/follow-ups?status=overdue`,
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const workload = dashboardKpis(data).slice(0, 6);
  const workloadMaximum = Math.max(...workload.map((item) => item.value), 1);

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <DashboardHeader
        spec={spec}
        role={role}
        generatedAt={data.generated_at}
        onRefresh={refresh}
        refreshing={dashboard.isFetching}
        manualRefreshRemaining={manualRefreshRemaining}
        manualRefreshMessage={manualRefreshMessage}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
        {dashboardKpis(data).map((metric) => {
          const Icon = metric.icon;
          return (
            <Card
              key={metric.label}
              className="min-w-0 overflow-hidden shadow-none transition-shadow hover:shadow-md"
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {metric.label}
                  </p>
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-full ${metric.tone}`}
                  >
                    <Icon className="size-4" />
                  </span>
                </div>
                <p className="mt-2 text-[28px] font-bold leading-none tracking-tight text-[#17233d]">
                  {metric.value}
                </p>
                <p className="mt-2.5 inline-flex max-w-full items-center truncate rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {metric.helper}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-5 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Today&apos;s priority</CardTitle>
            <CardDescription>Start with the work that needs attention now.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-2">
            {priorityCards.length ? (
              priorityCards.map((item) => (
                <div
                  key={item.label}
                  className="rounded-lg border bg-white transition-shadow hover:shadow-sm"
                >
                  <PriorityCard {...item} />
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground sm:col-span-2">
                There are no priority queues available for this role yet.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none xl:col-span-7">
          <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-base">Activity trend</CardTitle>
              <CardDescription>Authorized activity over the last {data.days} days</CardDescription>
            </div>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="size-3.5" /> Last {data.days} days
            </span>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={data.activity}
              seriesNames={[data.activity_primary, data.activity_secondary]}
              className="h-[275px]"
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-12">
        <div className="xl:col-span-8">
          <LeadPreviewTable records={data.lead_preview} leadHref={leadsHref} />
        </div>
        <Card className="shadow-none xl:col-span-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Today&apos;s workload</CardTitle>
            <CardDescription>Live volume in your authorized scope</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {workload.map((metric) => {
              const Icon = metric.icon;
              const relativeVolume = (metric.value / workloadMaximum) * 100;
              return (
                <div key={metric.label}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                      <span
                        className={`grid size-7 shrink-0 place-items-center rounded-md ${metric.tone}`}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <span className="truncate">{metric.label}</span>
                    </span>
                    <span className="font-semibold text-[#17233d]">{metric.value}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-[width]"
                      style={{ width: `${relativeVolume}%` }}
                    />
                  </div>
                </div>
              );
            })}
            <p className="border-t pt-4 text-xs text-muted-foreground">
              Bars show relative live queue volume, not a performance target.
            </p>
            {navigation.items.some((item) => item.slug === 'performance') && (
              <Button asChild variant="outline" className="w-full">
                <Link href={`/${role}/performance`}>
                  View detailed performance <ArrowRight className="size-4" />
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
