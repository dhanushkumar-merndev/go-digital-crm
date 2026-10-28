'use client';

import { PageHeader } from '@/components/shared/page-header';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BellRing,
  CalendarClock,
  CalendarDays,
  CarFront,
  ClipboardList,
  Clock3,
  FileText,
  Flame,
  Gauge,
  PackageSearch,
  Phone,
  PhoneCall,
  Plus,
  RefreshCw,
  Target,
  TrendingDown,
  TrendingUp,
  UserRoundPlus,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { fallbackVehicleImage } from '@/lib/vehicle-image';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { SalesConsultantDashboardSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
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
import { ManualDashboardRefreshLimitError } from '@/lib/query/cached-dashboard-api';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { kpiGridColumns } from '@/components/shared/kpi-grid';
import { AiDashboardSummary } from './ai-dashboard-summary';
import { cn } from '@/lib/utils';
import {
  fetchSalesConsultantDashboard,
  fetchSalesConsultantDashboardDirect,
  fetchSalesConsultantModelImages,
  salesConsultantDashboardKey,
  type SalesConsultantDashboardResult,
} from './sales-consultant-dashboard-api';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import {
  fetchLeadWorkspaceMeta,
  toLeadMetaQuery,
  type LeadWorkspaceResult,
} from '@/features/leads/lead-workspace-api';
import { defaultLeadQuery } from '@/features/leads/lead-workspace-query';
import { retryRpcRead } from '@/lib/supabase/read-rpc';
import { countRecordSchema, usePersistedQuery } from '@/lib/query/persisted-query';
import { Skeleton } from '@/components/ui/skeleton';
import { leadDetailHref, myLeadsFocusHref } from '@/lib/navigation/record-links';
import { toneStyles, type Tone } from './dashboard-tone';

type DashboardMetric =
  SalesConsultantDashboardResult['metrics'][keyof SalesConsultantDashboardResult['metrics']];

const metricDefinitions: Array<{
  key: keyof SalesConsultantDashboardResult['metrics'];
  label: string;
  icon: LucideIcon;
  tone: Tone;
  href: string;
  suffix?: string;
}> = [
  {
    key: 'leads_assigned_today',
    label: 'Leads assigned today',
    icon: UserRoundPlus,
    tone: 'blue',
    href: '/sales-consultant/my-leads?status=new-today',
  },
  {
    key: 'hot_leads',
    label: 'Hot leads',
    icon: Flame,
    tone: 'rose',
    // `temperature` is the dropdown filter; there is no Hot status tab for this
    // role. `status=all` is required as well -- without a status param the
    // My Leads default-status pass runs on first load and replaces the query.
    href: '/sales-consultant/my-leads?status=all&temperature=HOT',
  },
  {
    key: 'followups_today',
    label: 'Follow-ups today',
    icon: CalendarClock,
    tone: 'orange',
    href: '/sales-consultant/follow-ups?status=today',
  },
  {
    key: 'calls_pending',
    label: 'Calls pending',
    icon: PhoneCall,
    tone: 'emerald',
    href: '/sales-consultant/follow-ups?status=today',
  },
  {
    key: 'test_drives_today',
    label: 'Test drives today',
    icon: Gauge,
    tone: 'cyan',
    href: '/sales-consultant/test-drives?view=today',
  },
  {
    key: 'quotations_pending',
    label: 'Quotations pending',
    icon: FileText,
    tone: 'violet',
    href: '/sales-consultant/quotations?status=sent',
  },
  {
    key: 'bookings_month',
    label: 'Bookings this month',
    icon: CarFront,
    tone: 'emerald',
    href: '/sales-consultant/bookings',
  },
  {
    key: 'target_achievement',
    label: 'Target achievement',
    icon: Target,
    tone: 'rose',
    href: '/sales-consultant/performance',
    suffix: '%',
  },
];

const attentionDefinitions: Record<
  SalesConsultantDashboardResult['attention'][number]['key'],
  { label: string; action: string; icon: LucideIcon; tone: Tone; href: string }
> = {
  HOT_NOT_CALLED: {
    label: 'Hot lead not called',
    action: 'View leads',
    icon: PhoneCall,
    tone: 'rose',
    // "Never contacted" has no filter of its own, so this lands on the hot
    // leads that contain them rather than on an unfiltered list. Deliberately a
    // superset: a narrower tab (Pending) would hide the ones handed off today.
    href: '/sales-consultant/my-leads?status=all&temperature=HOT',
  },
  OVERDUE_FOLLOWUPS: {
    label: 'Overdue follow-up',
    action: 'View follow-ups',
    icon: Clock3,
    tone: 'orange',
    href: '/sales-consultant/follow-ups?status=overdue',
  },
  TEST_DRIVE_QUOTATION: {
    label: 'Test drive completed, quotation pending',
    action: 'View leads',
    icon: CarFront,
    tone: 'violet',
    href: '/sales-consultant/test-drives?view=completed',
  },
  QUOTATION_NO_BOOKING: {
    label: 'Quotation sent, no booking',
    action: 'View quotations',
    icon: FileText,
    tone: 'blue',
    href: '/sales-consultant/quotations?status=sent',
  },
  WAITING_FOR_STOCK: {
    label: 'Customer waiting for stock',
    action: 'Check stock',
    icon: PackageSearch,
    tone: 'cyan',
    href: '/sales-consultant/stock-check',
  },
};

const alertDefinitions: Record<
  SalesConsultantDashboardResult['alerts'][number]['key'],
  { label: string; icon: LucideIcon; tone: Tone; href: string }
> = {
  TASKS_DUE: {
    label: 'Tasks due today',
    icon: ClipboardList,
    tone: 'rose',
    href: '/sales-consultant/tasks?status=today',
  },
  FOLLOWUPS_DUE: {
    label: 'Follow-ups due today',
    icon: Clock3,
    tone: 'rose',
    href: '/sales-consultant/follow-ups?status=today',
  },
  TEST_DRIVES_SCHEDULED: {
    label: 'Test drives scheduled',
    icon: CarFront,
    tone: 'blue',
    href: '/sales-consultant/test-drives?view=today',
  },
  QUOTATIONS_AWAITING: {
    label: 'Quotations awaiting response',
    icon: FileText,
    tone: 'violet',
    href: '/sales-consultant/quotations?status=sent',
  },
  INSURANCE_DOCUMENTS: {
    label: 'Insurance documents pending',
    icon: ClipboardList,
    tone: 'orange',
    href: '/sales-consultant/bookings',
  },
  RTO_PENDING: {
    label: 'RC transfer pending',
    icon: BellRing,
    tone: 'rose',
    href: '/sales-consultant/bookings',
  },
};

// Follow-ups today and test drives today are KPI tiles, and quotations awaiting
// a response is a Requires attention card with a different definition; listing
// them again here showed two different numbers for the same question.
const followThroughAlertKeys = new Set<SalesConsultantDashboardResult['alerts'][number]['key']>([
  'TASKS_DUE',
  'INSURANCE_DOCUMENTS',
  'RTO_PENDING',
]);

const scheduleDefinitions: Record<
  SalesConsultantDashboardResult['schedule'][number]['kind'],
  { label: string; icon: LucideIcon; tone: Tone; href: string }
> = {
  FOLLOW_UP: {
    label: 'Follow-up',
    icon: PhoneCall,
    tone: 'emerald',
    href: '/sales-consultant/follow-ups?status=today',
  },
  SHOWROOM_VISIT: {
    label: 'Showroom visit',
    icon: CalendarDays,
    tone: 'orange',
    href: '/sales-consultant/appointments?status=today&type=Showroom%20Visit',
  },
  APPOINTMENT_VIDEO_CALL: {
    label: 'Video call',
    icon: Video,
    tone: 'blue',
    href: '/sales-consultant/appointments?status=today&type=Video%20Call',
  },
  // Only legacy rows carry this type; it can no longer be booked, and the
  // Appointments filter no longer accepts it as a value.
  APPOINTMENT_TEST_DRIVE: {
    label: 'Test drive',
    icon: CarFront,
    tone: 'blue',
    href: '/sales-consultant/appointments?status=today',
  },
  APPOINTMENT_CONSULTANT_CALL: {
    label: 'Consultant call',
    icon: Phone,
    tone: 'emerald',
    href: '/sales-consultant/appointments?status=today&type=Consultant%20Call',
  },
  TEST_DRIVE: {
    label: 'Test drive',
    icon: CarFront,
    tone: 'blue',
    href: '/sales-consultant/test-drives?view=today',
  },
  DELIVERY: {
    label: 'Delivery',
    icon: CarFront,
    tone: 'orange',
    href: '/sales-consultant/bookings',
  },
};

function formatTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  }).format(new Date(value));
}

function formatDate(value: string, timezone: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(`${value}T12:00:00Z`));
}

/**
 * Schedule rows only -- appointments, test drives, follow-ups, deliveries.
 * Lead stages used to be mixed in here, which is how this page ended up calling
 * `Transferred to Sales` blue while every other surface called it green. Lead
 * stages go through `leadStageVariant`; see AGENTS.md 9.8.
 */
function scheduleStatusVariant(status: string) {
  if (['COMPLETED', 'DELIVERED'].includes(status)) return 'success' as const;
  if (['OVERDUE', 'CANCELLED'].includes(status)) return 'destructive' as const;
  if (['ACTIVE', 'CONFIRMED', 'SENT'].includes(status)) return 'warning' as const;
  return 'info' as const;
}

/** Every link on this page is scoped to the consultant workspace. */
const DASHBOARD_ROLE = 'sales-consultant';

function followupStatusForSchedule(status: string) {
  if (status === 'OVERDUE') return 'overdue';
  if (status === 'COMPLETED') return 'completed';
  if (status === 'CANCELLED') return 'cancelled';
  return 'today';
}

function testDriveViewForSchedule(status: string) {
  if (status === 'ACTIVE') return 'active';
  if (status === 'COMPLETED') return 'completed';
  if (status === 'CANCELLED') return 'cancelled';
  return 'today';
}

function scheduleItemHref(item: SalesConsultantDashboardResult['schedule'][number]) {
  if (item.kind === 'SHOWROOM_VISIT' || item.kind.startsWith('APPOINTMENT_')) {
    return `/sales-consultant/appointments?appointment=${encodeURIComponent(item.id)}`;
  }

  if (item.kind === 'FOLLOW_UP') {
    return `/sales-consultant/follow-ups?status=${followupStatusForSchedule(item.status)}&q=${encodeURIComponent(item.id)}`;
  }

  if (item.kind === 'TEST_DRIVE') {
    return `/sales-consultant/test-drives?view=${testDriveViewForSchedule(item.status)}&q=${encodeURIComponent(item.id)}`;
  }

  return scheduleDefinitions[item.kind].href;
}

function scheduleItemAriaLabel(
  item: SalesConsultantDashboardResult['schedule'][number],
  definition: (typeof scheduleDefinitions)[SalesConsultantDashboardResult['schedule'][number]['kind']],
) {
  if (item.kind === 'SHOWROOM_VISIT' || item.kind.startsWith('APPOINTMENT_'))
    return `Open ${definition.label} for ${item.customer_name} in Appointments`;
  if (item.kind === 'FOLLOW_UP') return `Open ${item.customer_name}'s follow-up`;
  if (item.kind === 'TEST_DRIVE') return `Open ${item.customer_name}'s test drive`;
  return `Open ${definition.label} for ${item.customer_name}`;
}

function MetricCard({
  definition,
  metric,
  unsetCaption,
}: {
  definition: (typeof metricDefinitions)[number];
  metric: DashboardMetric;
  /** Set when the number has nothing behind it, e.g. no target for the month. */
  unsetCaption?: string;
}) {
  const Icon = definition.icon;
  const positive = metric.change >= 0;
  const TrendIcon = positive ? TrendingUp : TrendingDown;
  return (
    <Link
      href={definition.href}
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
                toneStyles[definition.tone].icon,
              )}
            >
              <Icon className="size-4" />
            </span>
            <p className="min-w-0 text-[11px] font-semibold leading-4 text-heading-soft">
              {definition.label}
            </p>
          </div>
          <p className="mt-3 text-center text-[26px] font-bold leading-none tracking-tight text-heading">
            {unsetCaption ? '—' : metric.value}
            {unsetCaption ? null : definition.suffix}
          </p>
          {unsetCaption ? (
            <p className="mt-3 text-center text-[10px] text-muted-foreground">{unsetCaption}</p>
          ) : (
            <p
              className={cn(
                'mt-3 flex items-center justify-center gap-1 text-[10px] font-semibold',
                positive ? 'text-emerald-600' : 'text-rose-600',
              )}
            >
              <TrendIcon className="size-3" /> {Math.abs(metric.change)}%
              <span className="font-normal text-muted-foreground">
                vs {metric.comparison === 'YESTERDAY' ? 'yesterday' : 'last month'}
              </span>
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function TodaySchedule({
  data,
  className,
}: {
  data: SalesConsultantDashboardResult;
  className?: string;
}) {
  const scheduleItems = [...data.schedule].sort((left, right) => {
    const timeDifference =
      new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime();
    if (timeDifference) return timeDifference;
    return left.id.localeCompare(right.id);
  });

  return (
    <Card className={cn('flex h-[22rem] min-h-0 flex-col overflow-hidden shadow-none', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3.5">
        <CardTitle className="text-sm">Today&apos;s schedule</CardTitle>
        <Button asChild variant="link" size="sm" className="h-auto px-0 text-[11px] text-blue-600">
          <Link href="/sales-consultant/appointments?status=today">View calendar</Link>
        </Button>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-3">
        {data.schedule.length ? (
          <ScrollArea type="always" className="min-h-0 flex-1 pr-1" aria-label="Today’s schedule">
            <div className="relative space-y-2 pr-2 before:absolute before:bottom-5 before:left-[52px] before:top-5 before:w-px before:bg-slate-200">
              {scheduleItems.map((item) => {
                const definition = scheduleDefinitions[item.kind];
                const Icon = definition.icon;
                const href = scheduleItemHref(item);
                return (
                  <div
                    key={`${item.kind}:${item.id}`}
                    className="relative grid grid-cols-[48px_1fr] gap-3"
                  >
                    <p className="pt-3 text-[10px] font-medium text-muted-foreground">
                      {formatTime(item.scheduled_at, data.timezone)}
                    </p>
                    <span className="absolute left-[49px] top-4 z-10 size-2 rounded-full border-2 border-white bg-blue-600" />
                    <Link
                      href={href}
                      aria-label={scheduleItemAriaLabel(item, definition)}
                      className="ml-2 rounded-lg border bg-white p-2.5 transition-colors hover:border-blue-200 hover:bg-blue-50/30"
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className={cn(
                            'grid size-7 shrink-0 place-items-center rounded-md',
                            toneStyles[definition.tone].icon,
                          )}
                        >
                          <Icon className="size-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[10px] font-medium text-muted-foreground">
                              {definition.label}
                            </p>
                            <Badge
                              variant={scheduleStatusVariant(item.status)}
                              className="px-1.5 py-0 text-[10px] normal-case"
                            >
                              {item.status.replaceAll('_', ' ').toLocaleLowerCase()}
                            </Badge>
                          </div>
                          <p className="mt-0.5 truncate text-xs font-semibold text-heading">
                            {item.customer_name}
                          </p>
                          {item.detail && (
                            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                              {item.detail}
                            </p>
                          )}
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
            <span className="grid size-10 place-items-center rounded-full bg-blue-50 text-blue-600">
              <CalendarDays className="size-5" />
            </span>
            <p className="mt-3 text-sm font-semibold">No events scheduled today</p>
            <p className="mt-1 text-xs text-muted-foreground">
              New appointments will appear here automatically.
            </p>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="mt-3 w-full max-w-[272px] border-blue-200 text-blue-700"
            >
              <Link href="/sales-consultant/appointments?status=today">
                View full schedule <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TopModels({
  models,
  images,
  imagesPending,
}: {
  models: SalesConsultantDashboardResult['top_models'];
  images: Record<string, string> | undefined;
  imagesPending: boolean;
}) {
  // A stock photo still being signed shows an empty tile, not the stand-in
  // artwork, so the thumbnail does not swap from one picture to another.
  const imageFor = (model: SalesConsultantDashboardResult['top_models'][number]) => {
    const signed = model.image_url ?? (model.model_id ? images?.[model.model_id] : undefined);
    if (signed) return signed;
    return model.image_object_file_id && imagesPending ? null : fallbackVehicleImage(model.name);
  };
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">Top performing models</CardTitle>
        <span className="rounded-md border px-2 py-1 text-[10px] text-muted-foreground">
          This month
        </span>
      </CardHeader>
      <CardContent className="space-y-1 p-3">
        {models.length ? (
          models.slice(0, 5).map((model) => (
            <Link
              key={`${model.model_id}:${model.name}`}
              href={`/sales-consultant/stock-check?q=${encodeURIComponent(model.name)}`}
              className="grid grid-cols-[52px_1fr_auto_auto] items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-slate-50"
            >
              <span
                role="img"
                aria-label={`${model.name} inventory vehicle`}
                className="h-8 w-12 rounded-md bg-slate-100 bg-contain bg-center bg-no-repeat"
                style={(() => {
                  const image = imageFor(model);
                  return image
                    ? { backgroundImage: `url(${JSON.stringify(image).slice(1, -1)})` }
                    : undefined;
                })()}
              />
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-heading-soft">
                  {model.name}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  {model.available_stock} in stock
                </span>
              </span>
              <span className="text-xs font-semibold">{model.bookings}</span>
              <span
                className={cn(
                  'flex min-w-10 items-center justify-end gap-0.5 text-[10px] font-semibold',
                  model.change >= 0 ? 'text-emerald-600' : 'text-rose-600',
                )}
              >
                {model.change >= 0 ? (
                  <TrendingUp className="size-3" />
                ) : (
                  <TrendingDown className="size-3" />
                )}
                {Math.abs(model.change)}%
              </span>
            </Link>
          ))
        ) : (
          <p className="py-9 text-center text-xs text-muted-foreground">
            Model performance will appear after the first booking.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RecentLeads({
  leads,
  timezone,
}: {
  leads: SalesConsultantDashboardResult['recent_leads'];
  timezone: string;
}) {
  const router = useRouter();
  // The row and the arrow go to the same place, so the arrow stays as the
  // visible affordance for anyone who does not know the row is clickable.
  const openLead = (lead: { id: string; phone: string | null }) =>
    router.push(myLeadsFocusHref(DASHBOARD_ROLE, lead));

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">My recent leads</CardTitle>
        <Button asChild variant="link" size="sm" className="h-auto px-0 text-[11px] text-blue-600">
          <Link href="/sales-consultant/my-leads">
            View all leads <ArrowRight className="size-3" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {leads.length ? (
          <Table>
            <TableHeader className="bg-slate-50/80">
              <TableRow>
                <TableHead className="h-9 px-3 text-[10px] normal-case tracking-normal">
                  Lead ID
                </TableHead>
                <TableHead className="h-9 px-3 text-[10px] normal-case tracking-normal">
                  Customer
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[10px] normal-case tracking-normal lg:table-cell">
                  Mobile
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[10px] normal-case tracking-normal lg:table-cell">
                  Interested model
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[10px] normal-case tracking-normal lg:table-cell">
                  Next follow-up
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[10px] normal-case tracking-normal lg:table-cell">
                  Lead source
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
                  <TableCell className="px-3 py-2 font-semibold text-blue-700">
                    {/* The reference opens the lead's own record page, so it keeps
                        its own destination rather than the row's. */}
                    <Link
                      href={leadDetailHref(DASHBOARD_ROLE, lead.id)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {lead.reference}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 font-medium">
                    {lead.customer_name}
                  </TableCell>
                  <TableCell className="hidden px-3 py-2 lg:table-cell">{lead.phone}</TableCell>
                  <TableCell className="hidden max-w-36 truncate px-3 py-2 lg:table-cell">
                    {lead.interested_model ?? '—'}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap px-3 py-2 lg:table-cell">
                    {lead.next_followup_at
                      ? `${formatDate(lead.next_followup_at.slice(0, 10), timezone)} · ${formatTime(lead.next_followup_at, timezone)}`
                      : 'Not scheduled'}
                  </TableCell>
                  <TableCell className="hidden px-3 py-2 lg:table-cell">{lead.source}</TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      variant={leadStageVariant(lead.lifecycle_status)}
                      className="rounded px-1.5 py-0 text-[10px]"
                    >
                      {lead.lifecycle_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      variant={
                        lead.temperature === 'HOT'
                          ? 'destructive'
                          : lead.temperature === 'WARM'
                            ? 'warning'
                            : lead.temperature === 'DORMANT'
                              ? 'secondary'
                              : 'info'
                      }
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

type FunnelStage = { name: string; value: number; color: string };

/**
 * The consultant's leads counted at every sales stage they have reached, so a
 * stage never holds more than the one before it. The dashboard's own pipeline
 * counts records created this month (a lead can carry several quotations), which
 * drew 81 quotations under 53 test drives. Colours follow AGENTS.md 9.8.
 */
function salesFunnel(kpis: LeadWorkspaceResult['kpis']): FunnelStage[] {
  const quotationOrLater = kpis.quotation + kpis.booking;
  const testDriveOrLater = kpis.test_drive + quotationOrLater;
  return [
    { name: 'Assigned', value: kpis.total, color: '#2563eb' },
    { name: 'Followed up', value: kpis.follow_up + testDriveOrLater, color: '#d97706' },
    { name: 'Test drive', value: testDriveOrLater, color: '#7c3aed' },
    { name: 'Quotation', value: quotationOrLater, color: '#ea580c' },
    { name: 'Booked', value: kpis.booking, color: '#059669' },
  ];
}

function salesSummaryText(data: SalesConsultantDashboardResult, conversionRate: number) {
  const hotLeads = data.metrics.hot_leads.value;
  const followupsToday = data.metrics.followups_today.value;
  const overdueFollowups =
    data.attention.find((item) => item.key === 'OVERDUE_FOLLOWUPS')?.value ?? 0;
  const assigned = data.pipeline[0]?.value ?? 0;
  const booked = data.pipeline.at(-1)?.value ?? 0;
  return `Prioritize ${hotLeads} hot lead${hotLeads === 1 ? '' : 's'} and ${followupsToday} follow-up${followupsToday === 1 ? '' : 's'} today. This month: ${assigned} lead${assigned === 1 ? '' : 's'} assigned and ${booked} booking${booked === 1 ? '' : 's'} (${conversionRate.toFixed(1)}% per lead assigned). ${overdueFollowups ? `Clear ${overdueFollowups} overdue follow-up${overdueFollowups === 1 ? '' : 's'} first.` : 'No overdue follow-ups are waiting.'}`;
}

export function SalesConsultantDashboard({ spec }: { spec: PageSpec }) {
  const workspaceSession = useWorkspaceSession();
  const dashboardQueryKey = useMemo(
    () => [...salesConsultantDashboardKey, ...workspaceQueryScope(workspaceSession)] as const,
    [workspaceSession],
  );
  const manualRefreshRequest = useRef(false);
  const dashboard = useQuery({
    queryKey: dashboardQueryKey,
    // An ordinary read goes straight to PostgreSQL (~250 ms); Refresh goes
    // through Edge, where its quota is enforced. Kept in memory for 30 minutes,
    // never in IndexedDB: this payload carries customer rows.
    queryFn: ({ signal }) =>
      manualRefreshRequest.current
        ? fetchSalesConsultantDashboard(signal, { manualRefresh: true })
        : fetchSalesConsultantDashboardDirect(signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    // Another request is rebuilding the entry; check back once it has.
    refetchInterval: (query) =>
      query.state.data?.cache.status === 'STALE' ? AGGREGATE_REALTIME_MIN_INTERVAL_MS : false,
  });
  // The stock thumbnails are private Tigris files only the Edge function can
  // sign. They load alongside the counts and fill in when ready; the 5-minute
  // links are kept for 4 so a cached dashboard never shows an expired one.
  const modelImages = useQuery({
    queryKey: ['sales-consultant-model-images', ...workspaceQueryScope(workspaceSession)],
    queryFn: ({ signal }) => fetchSalesConsultantModelImages(signal),
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
  });
  const leadMetricsQueryKey = useMemo(
    () => ['lead-workspace-meta', ...workspaceQueryScope(workspaceSession), 'dashboard'] as const,
    [workspaceSession],
  );
  // The funnel reads My Leads' own stage counts, so a click on a stage lands on
  // a tab showing the same number. Only the counts are persisted.
  const leadMetrics = usePersistedQuery({
    queryKey: leadMetricsQueryKey,
    retry: retryRpcRead,
    queryFn: async ({ signal }) =>
      (await fetchLeadWorkspaceMeta(toLeadMetaQuery(defaultLeadQuery), signal)).kpis,
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: countRecordSchema<LeadWorkspaceResult['kpis']>() },
  });
  const funnel = leadMetrics.data ? salesFunnel(leadMetrics.data) : undefined;
  const [refreshMessage, setRefreshMessage] = useState<string>();
  const [manualRefreshRemaining, setManualRefreshRemaining] = useState(3);
  const data = dashboard.data;

  // The server's refresh budget is mirrored into local state as a render-phase
  // adjustment rather than an effect: `refresh()` below also writes both values
  // on a rejected manual refresh, so they cannot simply be derived, and an
  // effect made every dashboard payload cost an extra render pass.
  const budget = data?.refresh_budget;
  const [syncedBudget, setSyncedBudget] = useState(budget);
  if (budget !== syncedBudget) {
    setSyncedBudget(budget);
    if (budget?.enforced && budget.remaining !== null) {
      setManualRefreshRemaining(budget.remaining);
      setRefreshMessage(
        budget.remaining === 0 && budget.retry_at
          ? `Refresh limit reached. Available again at ${formatTime(
              budget.retry_at,
              data?.timezone ?? 'Asia/Kolkata',
            )}.`
          : undefined,
      );
    }
  }
  const realtimeSubscriptions = useMemo(
    () =>
      data
        ? (['leads', 'work', 'communications', 'sales', 'inventory'] as const).map((resource) => ({
            resource,
            queryKeys:
              resource === 'leads' || resource === 'sales'
                ? [dashboardQueryKey, leadMetricsQueryKey]
                : [dashboardQueryKey],
            minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
          }))
        : [],
    [dashboardQueryKey, data, leadMetricsQueryKey],
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
    const [result] = await Promise.all([dashboard.refetch(), leadMetrics.refetch()]);
    manualRefreshRequest.current = false;
    if (manual && result.error instanceof ManualDashboardRefreshLimitError) {
      setManualRefreshRemaining(0);
      const refreshAt = result.error.retryAfterMs
        ? formatTime(
            new Date(Date.now() + result.error.retryAfterMs).toISOString(),
            data?.timezone ?? 'Asia/Kolkata',
          )
        : null;
      setRefreshMessage(
        refreshAt
          ? `Refresh limit reached. Available again at ${refreshAt}.`
          : 'Refresh limit reached. Try again after the 30-minute window.',
      );
      return;
    }
    if (result.error) {
      setRefreshMessage('Could not refresh right now. Showing the last synced dashboard.');
      return;
    }
    if (manual) {
      const budget = result.data?.refresh_budget;
      if (budget?.enforced && budget.remaining !== null)
        setManualRefreshRemaining(budget.remaining);
      else setManualRefreshRemaining((remaining) => Math.max(0, remaining - 1));
    }
  }

  if (dashboard.isPending) return <SalesConsultantDashboardSkeleton />;
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
            <h2 className="mt-4 font-semibold text-heading">Sales dashboard could not be loaded</h2>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">
              The live dashboard requires the Sales Consultant dashboard migration and an active
              scoped role assignment.
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

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={spec}
        title="Sales Consultant Workspace"
        description={spec.description}
        actions={
          <>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refresh()}
                disabled={dashboard.isFetching || manualRefreshRemaining === 0}
              >
                <RefreshCw className={cn('size-3.5', dashboard.isFetching && 'animate-spin')} />
                Last synced {formatTime(data.cache.synced_at ?? data.generated_at, data.timezone)}
              </Button>
              <span>{manualRefreshRemaining}/3 manual refreshes left</span>
              {data.cache.status === 'STALE' && (
                <span className="text-muted-foreground">Updating&hellip;</span>
              )}
              {refreshMessage && <span className="text-rose-600">{refreshMessage}</span>}
            </div>
          </>
        }
      />

      <div className={cn('grid gap-2.5', kpiGridColumns(metricDefinitions.length))}>
        {metricDefinitions.map((definition) => (
          <MetricCard
            key={definition.key}
            definition={definition}
            metric={data.metrics[definition.key]}
            // Achievement is bookings over the month's booking target, so
            // bookings with 0% can only mean no target is set.
            unsetCaption={
              definition.key === 'target_achievement' &&
              data.metrics.target_achievement.value === 0 &&
              data.metrics.bookings_month.value > 0
                ? 'No booking target set'
                : undefined
            }
          />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <Card className="shadow-none">
            <CardHeader className="border-b px-4 py-3.5">
              <CardTitle className="text-sm">Requires attention</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2.5 p-3 sm:grid-cols-2 lg:grid-cols-5">
              {data.attention.map((item) => {
                const definition = attentionDefinitions[item.key];
                const Icon = definition.icon;
                return (
                  <Link
                    key={item.key}
                    href={definition.href}
                    className={cn(
                      'group flex min-h-32 flex-col rounded-lg border p-3 transition-all hover:-translate-y-0.5 hover:shadow-sm',
                      toneStyles[definition.tone].soft,
                      toneStyles[definition.tone].border,
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          'grid size-8 place-items-center rounded-lg bg-white/90',
                          toneStyles[definition.tone].icon,
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="text-xl font-bold text-heading">{item.value}</span>
                    </div>
                    <p className="mt-3 text-[11px] font-medium leading-4 text-heading-soft">
                      {definition.label}
                    </p>
                    <span className="mt-auto flex items-center gap-1 pt-3 text-[10px] font-semibold text-blue-600">
                      {definition.action}
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
                <CardTitle className="text-sm">Sales pipeline funnel</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col p-3">
                {/* Every stage is a share of the consultant's assigned leads. */}
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
                            <span className="truncate font-medium text-heading-soft">
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
                        {leadMetrics.data?.lost_count ?? 0} lost along the way
                      </p>
                    </div>
                  </div>
                ) : (
                  <Skeleton className="h-[235px] w-full" />
                )}
                <AiDashboardSummary
                  title="AI sales summary"
                  defaultSummary={salesSummaryText(data, conversionRate)}
                  timezone={data.timezone}
                />
              </CardContent>
            </Card>
            <div className="space-y-4 lg:col-span-5">
              <TopModels
                models={data.top_models}
                images={modelImages.data}
                imagesPending={modelImages.isPending}
              />
              <Card className="shadow-none">
                <CardHeader className="border-b px-4 py-3">
                  <CardTitle className="text-sm">Quick actions</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-5 gap-1.5 p-3">
                  {[
                    ['Add lead', UserRoundPlus, '/sales-consultant/my-leads?action=create', 'blue'],
                    [
                      'Book test drive',
                      CarFront,
                      '/sales-consultant/test-drives?action=create',
                      'blue',
                    ],
                    [
                      'Create quotation',
                      FileText,
                      '/sales-consultant/quotations?action=create',
                      'violet',
                    ],
                    ['Check stock', PackageSearch, '/sales-consultant/stock-check', 'emerald'],
                    ['New booking', Plus, '/sales-consultant/bookings?action=create', 'orange'],
                  ].map(([label, Icon, href, tone]) => (
                    <Link
                      key={label as string}
                      href={href as string}
                      className="group flex min-w-0 flex-col items-center rounded-lg p-1.5 text-center hover:bg-slate-50"
                    >
                      <span
                        className={cn(
                          'grid size-8 place-items-center rounded-lg transition-transform group-hover:-translate-y-0.5',
                          toneStyles[tone as Tone].icon,
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="mt-1.5 text-[10px] font-medium leading-3 text-heading-soft">
                        {label as string}
                      </span>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
          <RecentLeads leads={data.recent_leads} timezone={data.timezone} />
        </div>
        <div className="flex flex-col gap-4 xl:col-span-4">
          {/* The schedule takes whatever height the left column sets and
              scrolls inside it; positioned absolutely so a long day cannot
              stretch the row past the cards beside it. */}
          <div className="relative xl:min-h-[22rem] xl:flex-1">
            <TodaySchedule data={data} className="xl:absolute xl:inset-0 xl:h-auto" />
          </div>
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
              <CardTitle className="text-sm">Tasks & alerts</CardTitle>
              <Button
                asChild
                variant="link"
                size="sm"
                className="h-auto px-0 text-[11px] text-blue-600"
              >
                <Link href="/sales-consultant/tasks">
                  View all <ArrowRight className="size-3" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="divide-y p-0">
              {data.alerts
                .filter((item) => followThroughAlertKeys.has(item.key))
                .map((item) => {
                  const definition = alertDefinitions[item.key];
                  const Icon = definition.icon;
                  return (
                    <Link
                      key={item.key}
                      href={definition.href}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"
                    >
                      <span
                        className={cn(
                          'grid size-7 place-items-center rounded-md',
                          toneStyles[definition.tone].icon,
                        )}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-heading-soft">
                        {definition.label}
                      </span>
                      <span className="text-xs font-bold text-heading">{item.value}</span>
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
