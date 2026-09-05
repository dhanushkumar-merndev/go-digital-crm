'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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
  Sparkles,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { cn } from '@/lib/utils';
import {
  fetchSalesConsultantDashboard,
  generateSalesConsultantAiSummary,
  salesConsultantDashboardKey,
  type SalesConsultantDashboardResult,
} from './sales-consultant-dashboard-api';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import { leadDetailHref } from '@/lib/navigation/record-links';
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
    href: '/sales-consultant/my-leads',
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
    href: '/sales-consultant/my-leads',
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
}: {
  definition: (typeof metricDefinitions)[number];
  metric: DashboardMetric;
}) {
  const Icon = definition.icon;
  const positive = metric.change >= 0;
  const TrendIcon = positive ? TrendingUp : TrendingDown;
  return (
    <Link
      href={definition.href}
      className="group min-w-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Card className="h-full min-w-0 border-slate-200/90 shadow-none transition-all group-hover:-translate-y-0.5 group-hover:border-blue-200 group-hover:shadow-sm">
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
            <p className="min-w-0 text-[11px] font-semibold leading-4 text-[#263550]">
              {definition.label}
            </p>
          </div>
          <p className="mt-3 text-center text-[26px] font-bold leading-none tracking-tight text-[#12213f]">
            {metric.value}
            {definition.suffix}
          </p>
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
                              className="px-1.5 py-0 text-[9px] normal-case"
                            >
                              {item.status.replaceAll('_', ' ').toLocaleLowerCase()}
                            </Badge>
                          </div>
                          <p className="mt-0.5 truncate text-xs font-semibold text-[#17233d]">
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

function TopModels({ models }: { models: SalesConsultantDashboardResult['top_models'] }) {
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
                style={{
                  backgroundImage: `url(${JSON.stringify(
                    model.image_url ?? fallbackVehicleImage(model.name),
                  ).slice(1, -1)})`,
                }}
              />
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-[#263550]">
                  {model.name}
                </span>
                <span className="block text-[9px] text-muted-foreground">
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
  const openLead = (leadId: string) =>
    router.push(`/${DASHBOARD_ROLE}/my-leads?status=all&focus=${encodeURIComponent(leadId)}`);

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
                <TableHead className="h-9 px-3 text-[9px] normal-case tracking-normal">
                  Lead ID
                </TableHead>
                <TableHead className="h-9 px-3 text-[9px] normal-case tracking-normal">
                  Customer
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[9px] normal-case tracking-normal lg:table-cell">
                  Mobile
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[9px] normal-case tracking-normal lg:table-cell">
                  Interested model
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[9px] normal-case tracking-normal lg:table-cell">
                  Next follow-up
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-[9px] normal-case tracking-normal lg:table-cell">
                  Lead source
                </TableHead>
                <TableHead className="h-9 px-3 text-[9px] normal-case tracking-normal">
                  Status
                </TableHead>
                <TableHead className="h-9 px-3 text-[9px] normal-case tracking-normal">
                  Priority
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
                      className="rounded px-1.5 py-0 text-[9px]"
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

function AiPipelineSummary({
  data,
  conversionRate,
}: {
  data: SalesConsultantDashboardResult;
  conversionRate: number;
}) {
  const [open, setOpen] = useState(false);
  const hotLeads = data.metrics.hot_leads.value;
  const followupsToday = data.metrics.followups_today.value;
  const overdueFollowups =
    data.attention.find((item) => item.key === 'OVERDUE_FOLLOWUPS')?.value ?? 0;
  const nextStage = data.pipeline[1]?.name ?? 'qualified opportunities';
  const firstStage = data.pipeline[0]?.value ?? 0;
  const nextStageValue = data.pipeline[1]?.value ?? 0;
  const nextStageRate = firstStage > 0 ? (nextStageValue / firstStage) * 100 : 0;
  const defaultSummary = `Prioritize ${hotLeads} hot lead${hotLeads === 1 ? '' : 's'} and ${followupsToday} follow-up${followupsToday === 1 ? '' : 's'} today. ${nextStageRate.toFixed(1)}% of starting leads have reached ${nextStage}; overall conversion is ${conversionRate.toFixed(1)}%. ${overdueFollowups ? `Clear ${overdueFollowups} overdue follow-up${overdueFollowups === 1 ? '' : 's'} first.` : 'No overdue follow-ups are waiting.'}`;
  const summary = useMutation({
    mutationFn: (forceRefresh: boolean) => generateSalesConsultantAiSummary(forceRefresh),
  });
  const summaryText = summary.data?.summary ?? defaultSummary;

  return (
    <div className="mt-auto border-t border-dashed pt-3">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-violet-100 bg-violet-50/50 p-3 text-left transition-colors hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        aria-label="Open AI sales summary"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-violet-100 text-violet-700">
              <Sparkles className="size-3.5" />
            </span>
            <div>
              <p className="text-xs font-semibold text-[#263550]">AI sales summary</p>
              <p className="text-[10px] text-muted-foreground">Open for the full summary</p>
            </div>
          </div>
          <Badge variant="info" className="text-[9px]">
            {summary.data
              ? summary.data.provider === 'AI'
                ? 'AI cached'
                : 'Signal cached'
              : 'AI ready'}
          </Badge>
        </div>
        <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-[#334155]">{summaryText}</p>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>AI sales summary</DialogTitle>
            <DialogDescription>
              Generated from your current dashboard signals. It remains cached until you regenerate
              it.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-lg bg-slate-50 p-3 text-sm leading-6 text-[#263550]">
            {summaryText}
          </p>
          {summary.isError && (
            <p className="text-sm text-rose-600">The summary could not be generated. Try again.</p>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {summary.data
                ? `Generated ${formatTime(summary.data.generated_at, data.timezone)}`
                : 'No generated summary yet'}
            </span>
            <Button
              type="button"
              onClick={() => summary.mutate(Boolean(summary.data))}
              disabled={summary.isPending}
            >
              <Sparkles className="size-4" />
              {summary.isPending
                ? 'Generating…'
                : summary.data
                  ? 'Regenerate summary'
                  : 'Generate summary'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
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
    queryFn: ({ signal }) =>
      fetchSalesConsultantDashboard(signal, { manualRefresh: manualRefreshRequest.current }),
    // Keep the dashboard in memory while navigating. The Refresh control below
    // explicitly replaces its Redis entry with a fresh database bundle.
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
  });
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
      <div className="mx-auto max-w-[1800px]">
        <Card className="border-rose-100 shadow-none">
          <CardContent className="flex min-h-56 flex-col items-center justify-center p-8 text-center">
            <span className="grid size-11 place-items-center rounded-full bg-rose-50 text-rose-600">
              <BellRing className="size-5" />
            </span>
            <h2 className="mt-4 font-semibold text-[#17233d]">
              Sales dashboard could not be loaded
            </h2>
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
    <div className="mx-auto max-w-[1800px] space-y-4">
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
            Sales Consultant Workspace
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
            Last synced {formatTime(data.cache.synced_at ?? data.generated_at, data.timezone)}
          </Button>
          <span>{manualRefreshRemaining}/3 manual refreshes left</span>
          {data.cache.status === 'HIT' && (
            <span className="text-muted-foreground">Cached &middot; refresh for the latest</span>
          )}
          {refreshMessage && <span className="text-rose-600">{refreshMessage}</span>}
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-8">
        {metricDefinitions.map((definition) => (
          <MetricCard
            key={definition.key}
            definition={definition}
            metric={data.metrics[definition.key]}
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
                      <span className="text-xl font-bold text-[#17233d]">{item.value}</span>
                    </div>
                    <p className="mt-3 text-[11px] font-medium leading-4 text-[#263550]">
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
                <div className="mt-1 flex items-center justify-between rounded-lg bg-slate-50 px-4 py-2.5 text-xs">
                  <span className="text-muted-foreground">Overall conversion rate</span>
                  <span className="font-bold text-[#17233d]">{conversionRate.toFixed(1)}%</span>
                  <span className="flex items-center gap-1 text-emerald-600">
                    <TrendingUp className="size-3.5" />
                    Live
                  </span>
                </div>
                <AiPipelineSummary data={data} conversionRate={conversionRate} />
              </CardContent>
            </Card>
            <div className="space-y-4 lg:col-span-5">
              <TopModels models={data.top_models} />
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
                      <span className="mt-1.5 text-[9px] font-medium leading-3 text-[#263550]">
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
        <div className="space-y-4 xl:col-span-4">
          <TodaySchedule data={data} className="xl:h-[690px]" />
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
              {data.alerts.map((item) => {
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
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[#263550]">
                      {definition.label}
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
