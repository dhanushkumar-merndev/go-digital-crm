'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ZodError } from 'zod';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  Building2,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  ClockAlert,
  List,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Search,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import { useCallback, useMemo, useState } from 'react';
import { useSalesConsultantCache } from '@/features/sales-consultant/sales-consultant-cache';
import {
  FollowupsSkeleton,
  AppointmentsSkeleton,
} from '@/components/skeletons/sales-consultant-skeletons';
import { SummaryToggle } from '@/components/domain/summary-toggle';
import { StatusBadge } from '@/components/shared/status-badge';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { cn } from '@/lib/utils';
import type { PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import { FollowupCalendar } from './followup-calendar';
import { AppointmentWorkspaceView } from './appointment-workspace-view';
import {
  fetchWorkWorkspace,
  fetchWorkWorkspacePermissions,
  type AppointmentRecord,
  type AppointmentWorkspaceResult,
  type FollowupRecord,
  type FollowupWorkspaceResult,
  type WorkRecord,
  type WorkWorkspacePermissions,
  type WorkWorkspaceResult,
} from './workspace-api';
import {
  FollowupCompleteDialog,
  WorkActionDialog,
  WorkCreateDialog,
  WorkEditDialog,
} from './workspace-dialogs';
import {
  appointmentFilters,
  followupFilters,
  parseWorkQuery,
  toWorkQueryString,
  type WorkKind,
  type WorkQuery,
  type WorkStatusFilter,
} from './workspace-query';
import { recordDetailHref } from '@/lib/navigation/record-links';
import {
  focusRowElementId,
  focusedRowClassName,
  readFocusParam,
  useFocusedRows,
} from '@/lib/navigation/focus-row';

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase();
}

function statusLabel(value: string) {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function percentOf(part: number, whole: number) {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * The follow-up KPIs, in the card language the Sales Consultant dashboard
 * already uses: tinted icon chip and label on one line, the count centred
 * beneath it, and a rate underneath.
 *
 * The rate is a share of the consultant's own workload, not a
 * period-over-period trend — there is no yesterday figure in this response and
 * inventing one would put a number on screen that nobody can check. Each card
 * says out loud what its denominator is for the same reason.
 *
 * `neutral` exists because not every share is an achievement: "0% — nothing was
 * due today" is not a failure, and colouring it red the way a missed target is
 * coloured would be lying with a stylesheet.
 */
function followupMetricCards(
  kpis: { today: number; overdue: number; upcoming: number; completed_today: number },
  statusCounts: FollowupWorkspaceResult['status_counts'],
) {
  const open = kpis.today + kpis.overdue + kpis.upcoming;
  const dueTodayTotal = kpis.completed_today + kpis.today;
  const clearedRate = percentOf(kpis.completed_today, dueTodayTotal);
  const overdueRate = percentOf(kpis.overdue, open);
  // The total card mirrors the All tab, so its open share is taken from
  // status_counts as well. `kpis` ignores the search box while status_counts
  // honours it; mixing the two here would let the share exceed 100% the moment
  // someone typed in the search field.
  const openInView = statusCounts.today + statusCounts.overdue + statusCounts.upcoming;
  return [
    {
      status: 'all' as const,
      label: 'Total follow-ups',
      value: statusCounts.all,
      icon: CalendarClock,
      chip: 'bg-violet-50 text-violet-600',
      rate: percentOf(openInView, statusCounts.all),
      helper: 'still open',
      rising: true,
      good: true,
      neutral: true,
      footnote: `${statusCounts.completed.toLocaleString()} completed · ${statusCounts.cancelled.toLocaleString()} cancelled`,
    },
    {
      status: 'today' as const,
      label: 'Due today',
      value: kpis.today,
      icon: CalendarCheck2,
      chip: 'bg-blue-50 text-blue-600',
      rate: percentOf(kpis.today, open),
      helper: 'of open follow-ups',
      rising: true,
      good: true,
    },
    {
      status: 'overdue' as const,
      label: 'Overdue',
      value: kpis.overdue,
      icon: ClockAlert,
      chip: 'bg-rose-50 text-rose-600',
      rate: overdueRate,
      helper: 'missed against open workload',
      rising: kpis.overdue > 0,
      good: kpis.overdue === 0,
    },
    {
      status: 'completed' as const,
      label: 'Completed today',
      value: kpis.completed_today,
      icon: CircleCheckBig,
      chip: 'bg-emerald-50 text-emerald-600',
      rate: clearedRate,
      helper: dueTodayTotal ? 'of today’s commitments cleared' : 'nothing was due today',
      rising: clearedRate >= 50,
      good: clearedRate >= 50,
      neutral: dueTodayTotal === 0,
      // The tab lists every completed follow-up ever; the card counts only
      // today's. Naming the tab total keeps that difference from reading as a
      // second contradiction between the KPIs and the tabs.
      footnote: `${statusCounts.completed.toLocaleString()} completed all time`,
    },
    {
      status: 'upcoming' as const,
      label: 'Upcoming',
      value: kpis.upcoming,
      icon: CalendarDays,
      chip: 'bg-orange-50 text-orange-600',
      rate: percentOf(kpis.upcoming, open),
      helper: 'of open follow-ups',
      rising: true,
      good: true,
    },
  ];
}

function FollowupMetricCard({
  card,
  active,
  onSelect,
}: {
  card: ReturnType<typeof followupMetricCards>[number];
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = card.icon;
  const TrendIcon = card.rising ? TrendingUp : TrendingDown;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className="group min-w-0 rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Card
        className={cn(
          'h-full min-w-0 shadow-none transition-all group-hover:-translate-y-0.5 group-hover:border-blue-200 group-hover:shadow-sm',
          active ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200/90',
        )}
      >
        <CardContent className="p-4">
          <div className="flex items-center gap-2.5">
            <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', card.chip)}>
              <Icon className="size-4" />
            </span>
            <p className="min-w-0 text-[11px] font-semibold leading-4 text-[#263550]">
              {card.label}
            </p>
          </div>
          <p className="mt-3 text-center text-[26px] font-bold leading-none tracking-tight text-[#12213f]">
            {card.value.toLocaleString()}
          </p>
          <p
            className={cn(
              'mt-3 flex flex-wrap items-center justify-center gap-1 text-[10px] font-semibold',
              card.neutral
                ? 'text-muted-foreground'
                : card.good
                  ? 'text-emerald-600'
                  : 'text-rose-600',
            )}
          >
            <TrendIcon className="size-3" /> {card.rate}%
            <span className="font-normal text-muted-foreground">{card.helper}</span>
          </p>
          {card.footnote && (
            <p className="mt-1 text-center text-[10px] text-muted-foreground">{card.footnote}</p>
          )}
        </CardContent>
      </Card>
    </button>
  );
}

/**
 * Same tab strip as the Leads workspace, counts included. Without the counts a
 * consultant had no way to tell from this page whether a short list meant
 * "nothing is overdue" or "the query is hiding work", which is exactly how the
 * 18-versus-11 mismatch went unnoticed.
 */
function FollowupStatusTabs({
  statusCounts,
  status,
  onStatusChange,
  summaryOpen,
  onSummaryToggle,
}: {
  statusCounts: FollowupWorkspaceResult['status_counts'];
  status: WorkStatusFilter;
  onStatusChange: (status: WorkStatusFilter) => void;
  summaryOpen: boolean;
  onSummaryToggle: () => void;
}) {
  const tabs: Array<{ label: string; value: WorkStatusFilter; count: number }> = [
    { label: 'All', value: 'all', count: statusCounts.all },
    { label: 'Today', value: 'today', count: statusCounts.today },
    { label: 'Upcoming', value: 'upcoming', count: statusCounts.upcoming },
    { label: 'Overdue', value: 'overdue', count: statusCounts.overdue },
    { label: 'Completed', value: 'completed', count: statusCounts.completed },
    { label: 'Cancelled', value: 'cancelled', count: statusCounts.cancelled },
  ];
  return (
    <div className="flex h-10 border-b">
      <div
        role="tablist"
        aria-label="Follow-up quick views"
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = status === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onStatusChange(tab.value)}
              style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
              className={`relative flex h-full shrink-0 items-center gap-1.5 px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset ${
                active ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700'
              }`}
            >
              <span>{tab.label}</span>
              <span
                className={`grid min-w-5 place-items-center rounded px-1 py-0.5 text-[10px] leading-none ${
                  active ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {tab.count.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
      <SummaryToggle
        open={summaryOpen}
        onToggle={onSummaryToggle}
        controls="followup-summary-kpis"
        label="follow-up summary"
      />
    </div>
  );
}

function isTerminal(kind: WorkKind, record: WorkRecord) {
  if (kind === 'followups' && 'due_at' in record) return record.status !== 'OPEN';
  const status = (record as AppointmentRecord).status;
  return status === 'COMPLETED' || status === 'CANCELLED' || status === 'NO_SHOW';
}

function WorkTable({
  kind,
  role,
  result,
  query,
  calendarQuery,
  onQueryChange,
  permissions,
  isFetching,
  onEdit,
  onAction,
  view,
  onViewChange,
  timezone,
  organizationId,
  scopeKey,
  focusedRowIds,
}: {
  kind: WorkKind;
  role: string;
  result: WorkWorkspaceResult;
  query: WorkQuery;
  calendarQuery: WorkQuery;
  onQueryChange: (next: Partial<WorkQuery>) => void;
  permissions: WorkWorkspacePermissions;
  isFetching: boolean;
  onEdit: (record: WorkRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: WorkRecord) => void;
  view: 'table' | 'calendar';
  onViewChange: (view: 'table' | 'calendar') => void;
  timezone: string;
  organizationId: string;
  scopeKey: string;
  focusedRowIds: ReadonlySet<string>;
}) {
  const managerial = role === 'team-manager' || role === 'showroom-manager';
  const columns = useMemo<ColumnDef<WorkRecord>[]>(() => {
    if (kind === 'followups') {
      return [
        {
          id: 'due',
          header: 'Time',
          cell: ({ row }) => {
            const followup = row.original as FollowupRecord;
            return (
              <div className={followup.display_status === 'OVERDUE' ? 'text-rose-700' : ''}>
                <p className="whitespace-nowrap font-medium">
                  {new Intl.DateTimeFormat('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(new Date(followup.due_at))}
                </p>
                <p className="mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
                  {new Intl.DateTimeFormat('en-IN', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  }).format(new Date(followup.due_at))}
                </p>
              </div>
            );
          },
        },
        {
          id: 'customer',
          header: 'Customer',
          cell: ({ row }) => {
            const followup = row.original as FollowupRecord;
            // Gated on customer_id alone before, so a follow-up that knew its
            // lead but had no linked customer rendered as dead text — pressing
            // the row did nothing. recordDetailHref already prefers the lead,
            // which is the page that can actually show the follow-up; ask it
            // for a destination and link whenever it has one.
            const href = recordDetailHref(role, followup);
            return href ? (
              <Link
                href={href}
                title={followup.customer_name}
                className="block max-w-[190px] truncate font-semibold text-foreground hover:text-primary hover:underline"
              >
                {followup.customer_name}
              </Link>
            ) : (
              <span
                title={followup.customer_name}
                className="block max-w-[190px] truncate font-semibold text-foreground"
              >
                {followup.customer_name}
              </span>
            );
          },
        },
        {
          id: 'phone',
          header: 'Mobile',
          cell: ({ row }) => (
            <span className="font-medium">{(row.original as FollowupRecord).phone ?? '—'}</span>
          ),
        },
        {
          id: 'model',
          header: 'Model',
          cell: ({ row }) => (row.original as FollowupRecord).interested_model ?? '—',
        },
        {
          id: 'reason',
          header: 'Follow-up type / note',
          cell: ({ row }) => (
            <p className="max-w-64 whitespace-normal leading-5">
              {(row.original as FollowupRecord).reason}
            </p>
          ),
        },
        {
          id: 'priority',
          header: 'Priority',
          cell: ({ row }) => {
            const priority = (row.original as FollowupRecord).priority;
            return (
              <Badge
                variant={
                  priority === 'URGENT' || priority === 'HIGH'
                    ? 'destructive'
                    : priority === 'NORMAL'
                      ? 'warning'
                      : 'success'
                }
                className="px-2.5 py-0.5 text-[11px] font-medium"
              >
                {priority.charAt(0) + priority.slice(1).toLowerCase()}
              </Badge>
            );
          },
        },
        {
          id: 'owner',
          header: 'Assigned user',
          cell: ({ row }) => (row.original as FollowupRecord).assigned_user_name,
        },
        ...(managerial
          ? [
              {
                id: 'branch',
                header: 'Branch / team',
                cell: ({ row }: { row: { original: WorkRecord } }) => {
                  const followup = row.original as FollowupRecord;
                  return (
                    <div>
                      <p>{followup.branch_name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {followup.team_name ?? 'No team'}
                      </p>
                    </div>
                  );
                },
              } as ColumnDef<WorkRecord>,
            ]
          : []),
        {
          id: 'status',
          header: 'Status',
          cell: ({ row }) => {
            const status = (row.original as FollowupRecord).display_status;
            const variant =
              status === 'OVERDUE'
                ? 'destructive'
                : status === 'COMPLETED'
                  ? 'success'
                  : status === 'OPEN'
                    ? 'secondary'
                    : 'outline';
            return (
              <Badge variant={variant} className="px-2.5 py-0.5 text-[11px] font-medium">
                {status.charAt(0) + status.slice(1).toLowerCase().replaceAll('_', ' ')}
              </Badge>
            );
          },
        },
        {
          id: 'actions',
          header: 'Actions',
          cell: ({ row }) => {
            const followup = row.original as FollowupRecord;
            const closed = followup.status === 'COMPLETED' || followup.status === 'CANCELLED';
            if (closed) {
              const completed = followup.status === 'COMPLETED';
              return (
                <Badge
                  variant={completed ? 'success' : 'destructive'}
                  className="pointer-events-none w-full select-none justify-center gap-1 rounded-md px-2 py-1 text-[11px]"
                >
                  {completed ? (
                    <CheckCircle2 className="size-3.5" />
                  ) : (
                    <XCircle className="size-3.5" />
                  )}
                  {completed ? 'Completed' : 'Cancelled'}
                </Badge>
              );
            }
            // The page now also lists follow-ups that sit on this user's lead
            // but belong to someone else — a telecaller's call that came with
            // the handover. The write RPCs authorise against the follow-up's
            // own assignee, so on OWN_RECORDS scope those rows would answer
            // every action button with PERMISSION_DENIED. Show the phone and
            // WhatsApp shortcuts (which need no permission) and drop the rest;
            // wider scopes are unaffected because the server does allow them.
            const ownScopeOnly = permissions.dataScope === 'OWN_RECORDS';
            const writable =
              !ownScopeOnly ||
              followup.assigned_user_id === permissions.userId ||
              permissions.canOverrideComplete;
            const canComplete =
              permissions.canComplete &&
              (followup.assigned_user_id === permissions.userId || permissions.canOverrideComplete);
            return (
              <div className="flex items-center justify-end gap-0.5">
                {followup.phone && (
                  <Button variant="ghost" size="icon" className="size-7 text-emerald-600" asChild>
                    <a href={`tel:${followup.phone}`} aria-label={`Call ${followup.customer_name}`}>
                      <Phone className="size-3.5" />
                    </a>
                  </Button>
                )}
                {followup.phone && (
                  <Button variant="ghost" size="icon" className="size-7 text-emerald-600" asChild>
                    <a
                      href={toWhatsAppClickToChatUrl(followup.phone)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`WhatsApp ${followup.customer_name}`}
                    >
                      <WhatsAppIcon className="size-4" />
                    </a>
                  </Button>
                )}
                {permissions.canUpdate && writable && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-violet-600"
                    onClick={() => onEdit(followup)}
                    aria-label="Reschedule follow-up"
                  >
                    <CalendarDays className="size-3.5" />
                  </Button>
                )}
                {canComplete && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 whitespace-nowrap border-emerald-200 px-2 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50"
                    onClick={() => onAction('complete', followup)}
                  >
                    <CheckCircle2 className="size-3.5" />
                    Complete
                  </Button>
                )}
                {permissions.canCancel && writable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 whitespace-nowrap border-destructive/30 px-2 text-[11px] font-semibold text-destructive hover:bg-destructive/10"
                    onClick={() => onAction('cancel', followup)}
                  >
                    <XCircle className="size-3.5" />
                    Cancel
                  </Button>
                )}
              </div>
            );
          },
        },
      ];
    }
    const definitions: ColumnDef<WorkRecord>[] = [
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-44">
            {row.original.customer_id ? (
              <Link
                href={recordDetailHref(role, row.original) ?? '#'}
                className="font-semibold hover:text-primary hover:underline"
              >
                {row.original.customer_name}
              </Link>
            ) : (
              <span className="font-semibold">{row.original.customer_name}</span>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.lead_id ? `Lead ${shortId(row.original.lead_id)}` : 'Customer work'}
            </p>
          </div>
        ),
      },
      {
        id: 'phone',
        header: 'Phone',
        cell: ({ row }) =>
          row.original.phone ? (
            <a
              className="font-medium text-blue-700 hover:underline"
              href={`tel:${row.original.phone}`}
            >
              {row.original.phone}
            </a>
          ) : (
            '—'
          ),
      },
      {
        id: 'work',
        header: 'Type / model',
        cell: ({ row }) => {
          const appointment = row.original as AppointmentRecord;
          return (
            <div className="min-w-36">
              <p className="font-medium">{appointment.appointment_type}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {appointment.interested_model ?? 'Model not recorded'}
              </p>
            </div>
          );
        },
      },
      {
        id: 'scheduled',
        header: 'Scheduled',
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-medium">
            {formatDateTime((row.original as AppointmentRecord).scheduled_at)}
          </span>
        ),
      },
      {
        id: 'branch',
        header: 'Branch',
        cell: ({ row }) => (
          <div className="min-w-32">
            <p>{row.original.branch_name}</p>
            {managerial && row.original.team_name && (
              <p className="mt-0.5 text-xs text-muted-foreground">{row.original.team_name}</p>
            )}
          </div>
        ),
      },
      {
        id: 'owner',
        header: 'Responsible user',
        cell: ({ row }) => row.original.assigned_user_name,
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <div className="flex min-w-28 flex-col items-start gap-1">
            <StatusBadge value={(row.original as AppointmentRecord).status} />
            <span className="text-[11px] text-muted-foreground">
              {(row.original as AppointmentRecord).attendance_status.replaceAll('_', ' ')}
            </span>
          </div>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const record = row.original;
          const terminal = isTerminal(kind, record);
          const canComplete = permissions.canComplete;
          if (terminal || (!permissions.canUpdate && !canComplete && !permissions.canCancel))
            return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label="Work actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {permissions.canUpdate && (
                  <DropdownMenuItem onSelect={() => onEdit(record)}>
                    <Pencil className="size-4" />
                    Update appointment
                  </DropdownMenuItem>
                )}
                {canComplete && (
                  <DropdownMenuItem onSelect={() => onAction('complete', record)}>
                    Mark complete
                  </DropdownMenuItem>
                )}
                {permissions.canCancel && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => onAction('cancel', record)}
                    >
                      Cancel work item
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ];
    return definitions;
  }, [kind, managerial, onAction, onEdit, permissions, role]);

  // TanStack Table intentionally returns an imperative model; React Compiler skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: result.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: result.total,
  });
  const pages = Math.max(1, Math.ceil(result.total / query.pageSize));
  const pageNumbers = Array.from({ length: Math.min(5, pages) }, (_, index) =>
    Math.min(Math.max(query.page - 2, 1) + index, pages),
  ).filter((value, index, values) => index === 0 || value > values[index - 1]!);
  const statuses = kind === 'followups' ? followupFilters : appointmentFilters;
  const selectedBranchTeams = result.filters.teams.filter(
    (team) => query.branchId === 'all' || team.branch_id === query.branchId,
  );
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [draftFollowupFrom, setDraftFollowupFrom] = useState(query.followupFrom);
  const [draftFollowupTo, setDraftFollowupTo] = useState(query.followupTo);
  const followupDateLabel =
    query.followupFrom && query.followupTo
      ? `${query.followupFrom} – ${query.followupTo}`
      : query.followupFrom
        ? `From ${query.followupFrom}`
        : query.followupTo
          ? `Until ${query.followupTo}`
          : 'Select Date Range';

  return (
    <Card className="sales-consultant-list-card overflow-hidden border-slate-200 shadow-none">
      <CardHeader className="space-y-0 p-0">
        <div className="overflow-x-auto bg-white px-3 py-3 sm:px-4">
          <div
            className={cn(
              'grid items-end gap-2.5',
              kind === 'followups'
                ? managerial
                  ? 'min-w-[1800px] grid-cols-[1.45fr_.85fr_.85fr_.9fr_1.2fr_.85fr_.9fr_.85fr_.9fr_1.2fr_108px_auto]'
                  : 'min-w-[1400px] grid-cols-[1.45fr_.85fr_.85fr_.9fr_1.2fr_.85fr_1.2fr_108px_auto]'
                : managerial
                  ? 'min-w-[1320px] grid-cols-[1.45fr_.85fr_.9fr_.85fr_.85fr_.9fr_1.2fr_108px]'
                  : 'min-w-[920px] grid-cols-[1.45fr_.9fr_.9fr_1.2fr_108px]',
            )}
          >
            <div className="relative min-w-0">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query.search}
                onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
                className="h-8 bg-white pl-9 text-[10px]"
                maxLength={160}
                placeholder="Search customer, phone, lead or work ID…"
              />
            </div>
            {kind !== 'followups' && (
              <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                Status
                <Select
                  value={query.status}
                  onValueChange={(status) =>
                    onQueryChange({ status: status as WorkStatusFilter, page: 1 })
                  }
                >
                  <SelectTrigger className="h-8 bg-white text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status === 'all' ? 'All statuses' : statusLabel(status)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            {kind === 'followups' ? (
              <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                Priority
                <Select
                  value={query.priority}
                  onValueChange={(priority) =>
                    onQueryChange({ priority: priority as WorkQuery['priority'], page: 1 })
                  }
                >
                  <SelectTrigger className="h-8 bg-white text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All priorities</SelectItem>
                    <SelectItem value="LOW">Low priority</SelectItem>
                    <SelectItem value="NORMAL">Normal priority</SelectItem>
                    <SelectItem value="HIGH">High priority</SelectItem>
                    <SelectItem value="URGENT">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : (
              <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                Type
                <Select
                  value={query.appointmentType}
                  onValueChange={(appointmentType) =>
                    onQueryChange({
                      appointmentType: appointmentType as WorkQuery['appointmentType'],
                      page: 1,
                    })
                  }
                >
                  <SelectTrigger className="h-8 bg-white text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All appointment types</SelectItem>
                    <SelectItem value="Showroom Visit">Showroom visits</SelectItem>
                    <SelectItem value="Video Call">Video calls</SelectItem>
                    <SelectItem value="Consultant Call">Consultant calls</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            )}
            {kind === 'followups' && (
              <>
                <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                  Model
                  <Select
                    value={query.model || 'all'}
                    onValueChange={(model) =>
                      onQueryChange({ model: model === 'all' ? '' : model, page: 1 })
                    }
                  >
                    <SelectTrigger className="h-8 bg-white text-[10px]">
                      <SelectValue placeholder="All models" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All models</SelectItem>
                      {result.filters.models.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                  Source
                  <Select
                    value={query.source || 'all'}
                    onValueChange={(source) =>
                      onQueryChange({ source: source === 'all' ? '' : source, page: 1 })
                    }
                  >
                    <SelectTrigger className="h-8 bg-white text-[10px]">
                      <SelectValue placeholder="All sources" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All sources</SelectItem>
                      {result.filters.sources.map((source) => (
                        <SelectItem key={source} value={source}>
                          {source}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                  Temperature
                  <Select
                    value={query.temperature}
                    onValueChange={(temperature) =>
                      onQueryChange({
                        temperature: temperature as WorkQuery['temperature'],
                        page: 1,
                      })
                    }
                  >
                    <SelectTrigger className="h-8 bg-white text-[10px]">
                      <SelectValue placeholder="All temperatures" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All temperatures</SelectItem>
                      <SelectItem value="HOT">Hot</SelectItem>
                      <SelectItem value="WARM">Warm</SelectItem>
                      <SelectItem value="COLD">Cold</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <div className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                  Follow-up date
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 justify-start px-2 text-[10px] font-normal text-muted-foreground"
                    onClick={() => {
                      setDraftFollowupFrom(query.followupFrom);
                      setDraftFollowupTo(query.followupTo);
                      setDateRangeOpen(true);
                    }}
                  >
                    <CalendarDays className="size-3.5 shrink-0 text-blue-600" />
                    <span className="truncate">{followupDateLabel}</span>
                  </Button>
                </div>
              </>
            )}
            {managerial ? (
              <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                Branch
                <Select
                  value={query.branchId}
                  onValueChange={(branchId) => onQueryChange({ branchId, teamId: 'all', page: 1 })}
                >
                  <SelectTrigger className="h-8 bg-white text-[10px]">
                    <SelectValue placeholder="Branch" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All assigned branches</SelectItem>
                    {result.filters.branches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : kind !== 'followups' ? (
              <div
                className="flex h-10 min-w-0 items-center gap-2 rounded-md border bg-slate-50 px-3 text-xs text-[#263550] xl:min-w-[170px] xl:flex-1"
                title={result.filters.branches[0]?.name ?? 'Assigned dealership'}
              >
                <Building2 className="size-4 shrink-0 text-blue-600" />
                <span className="truncate font-medium">
                  {result.filters.branches[0]?.name ?? 'Assigned dealership'}
                </span>
              </div>
            ) : null}
            {managerial && (
              <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                Team
                <Select
                  value={query.teamId}
                  onValueChange={(teamId) => onQueryChange({ teamId, page: 1 })}
                >
                  <SelectTrigger className="h-8 bg-white text-[10px]">
                    <SelectValue placeholder="Team" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All teams</SelectItem>
                    {selectedBranchTeams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            {managerial && (
              <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                Assigned user
                <Select
                  value={query.ownerId}
                  onValueChange={(ownerId) => onQueryChange({ ownerId, page: 1 })}
                >
                  <SelectTrigger className="h-8 bg-white text-[10px]">
                    <SelectValue placeholder="Responsible user" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All users</SelectItem>
                    {result.filters.owners.map((owner) => (
                      <SelectItem key={owner.id} value={owner.id}>
                        {owner.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
              Sort by
              <Select
                value={query.sort}
                onValueChange={(sort) =>
                  onQueryChange({ sort: sort as WorkQuery['sort'], page: 1 })
                }
              >
                <SelectTrigger className="h-8 bg-white text-[10px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="scheduled:asc">Soonest first</SelectItem>
                  <SelectItem value="scheduled:desc">Latest first</SelectItem>
                  <SelectItem value="updated:desc">Recently updated</SelectItem>
                  <SelectItem value="customer:asc">Customer A–Z</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
              Rows
              <Select
                value={String(query.pageSize)}
                onValueChange={(value) =>
                  onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
                }
              >
                <SelectTrigger className="h-8 w-full bg-white text-[10px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="25">25 rows</SelectItem>
                  <SelectItem value="50">50 rows</SelectItem>
                  <SelectItem value="100">100 rows</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {kind === 'followups' && (
              <div className="flex h-10 self-end shrink-0 items-center rounded-md border bg-slate-50 p-1">
                <button
                  type="button"
                  className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium ${
                    view === 'table'
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => onViewChange('table')}
                >
                  <List className="size-3.5" /> Table
                </button>
                <button
                  type="button"
                  className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium ${
                    view === 'calendar'
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => onViewChange('calendar')}
                >
                  <CalendarDays className="size-3.5" /> Calendar
                </button>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {view === 'calendar' && kind === 'followups' ? (
          <FollowupCalendar
            role={role}
            query={calendarQuery}
            timezone={timezone}
            organizationId={organizationId}
            scopeKey={scopeKey}
            permissions={permissions}
            isActive
            onEdit={onEdit}
            onAction={onAction}
          />
        ) : (
          <>
            <div
              className={
                isFetching
                  ? 'overflow-x-auto opacity-65 transition-opacity'
                  : 'overflow-x-auto transition-opacity'
              }
            >
              <Table className="min-w-[1180px]">
                <TableHeader>
                  {table.getHeaderGroups().map((group) => (
                    <TableRow key={group.id} className="hover:bg-transparent">
                      {group.headers.map((header) => (
                        <TableHead
                          key={header.id}
                          className="h-11 whitespace-nowrap bg-slate-50 px-4 text-[10px] font-semibold uppercase tracking-wide text-[#263550]"
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.length ? (
                    table.getRowModel().rows.map((row) => {
                      const focused = focusedRowIds.has(row.original.id);
                      return (
                        <TableRow
                          key={row.id}
                          id={focusRowElementId(kind, row.original.id)}
                          className={focused ? focusedRowClassName : 'hover:bg-slate-50/70'}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell
                              key={cell.id}
                              className={cn(
                                'whitespace-nowrap px-4 py-4 align-middle text-xs text-[#263550]',
                                cell.column.id === 'actions' && 'w-px',
                                cell.column.id === 'customer' && 'max-w-[190px]',
                              )}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="h-44 text-center">
                        <p className="font-medium">No matching work items</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {kind === 'followups'
                            ? 'Clear the page-local filters or select another status tab.'
                            : 'Clear the page-local filters or schedule a new appointment if permitted.'}
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm lg:flex-row lg:items-center lg:justify-between">
              <p className="text-xs text-[#526079]">
                Showing {result.total ? (query.page - 1) * query.pageSize + 1 : 0} to{' '}
                {Math.min(query.page * query.pageSize, result.total)} of {result.total}{' '}
                {kind === 'followups' ? 'follow-ups' : 'appointments'}
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={query.page <= 1}
                  onClick={() => onQueryChange({ page: query.page - 1 })}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {pageNumbers.map((page) => (
                  <Button
                    key={page}
                    variant={page === query.page ? 'default' : 'outline'}
                    size="icon"
                    className="size-8"
                    onClick={() => onQueryChange({ page })}
                  >
                    {page}
                  </Button>
                ))}
                {pages > pageNumbers[pageNumbers.length - 1]! && (
                  <span className="px-1 text-muted-foreground">…</span>
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={query.page >= pages}
                  onClick={() => onQueryChange({ page: query.page + 1 })}
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </Button>
                <Select
                  value={String(query.pageSize)}
                  onValueChange={(value) =>
                    onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
                  }
                >
                  <SelectTrigger className="ml-3 h-8 w-[112px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="25">25 / page</SelectItem>
                    <SelectItem value="50">50 / page</SelectItem>
                    <SelectItem value="100">100 / page</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </>
        )}
      </CardContent>
      {kind === 'followups' && (
        <Dialog open={dateRangeOpen} onOpenChange={setDateRangeOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Follow-up date range</DialogTitle>
              <DialogDescription>Show follow-ups due in this period.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                From
                <Input
                  type="date"
                  value={draftFollowupFrom}
                  onChange={(event) => setDraftFollowupFrom(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                To
                <Input
                  type="date"
                  min={draftFollowupFrom || undefined}
                  value={draftFollowupTo}
                  onChange={(event) => setDraftFollowupTo(event.target.value)}
                />
              </label>
            </div>
            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraftFollowupFrom('');
                  setDraftFollowupTo('');
                }}
              >
                Clear dates
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setDateRangeOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    onQueryChange({
                      followupFrom: draftFollowupFrom,
                      followupTo: draftFollowupTo,
                      page: 1,
                    });
                    setDateRangeOpen(false);
                  }}
                >
                  Apply range
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

/**
 * Why the work workspace could not render, in a form that can be read off the
 * screen and acted on.
 *
 * Supabase surfaces PostgREST failures as `{ code, message, details }` and Zod
 * surfaces contract drift as an issue list; neither reaches the user unless it
 * is printed. `!permissions` is its own case because nothing threw -- the
 * session simply carries no access context.
 */
function workspaceFailureDetail({
  permissions,
  workspaceError,
  permissionsError,
  hasData,
}: {
  permissions: WorkWorkspacePermissions | undefined;
  workspaceError: unknown;
  permissionsError: unknown;
  hasData: boolean;
}) {
  const describe = (error: unknown): string | null => {
    if (!error) return null;
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return `Response did not match the expected shape at "${issue?.path.join('.') || '(root)'}": ${issue?.message ?? 'unknown'}`;
    }
    if (typeof error === 'object') {
      const { code, message, details, hint } = error as Record<string, string | undefined>;
      return [code && `[${code}]`, message, details, hint].filter(Boolean).join(' ');
    }
    return String(error);
  };
  return (
    describe(permissionsError) ??
    describe(workspaceError) ??
    (!permissions
      ? 'No access context for this session. Sign out and back in, or ask an administrator to check your role assignment.'
      : !hasData
        ? 'The request finished without returning any data.'
        : 'Unknown failure.')
  );
}

export function WorkWorkspace({
  kind,
  role,
  spec,
}: {
  kind: WorkKind;
  role: string;
  spec: PageSpec;
}) {
  const workspaceSession = useWorkspaceSession();
  const useWorkspaceBootstrap = Boolean(workspaceSession?.organizationId);
  const queryScope = useMemo(
    () =>
      useWorkspaceBootstrap ? workspaceQueryScope(workspaceSession) : (['legacy', role] as const),
    [role, useWorkspaceBootstrap, workspaceSession],
  );
  const resource = kind === 'followups' ? 'followup' : 'appointment';
  const bootstrapPermissions: WorkWorkspacePermissions | undefined = useWorkspaceBootstrap
    ? {
        organizationId: workspaceSession!.organizationId as string,
        userId: workspaceSession!.userId,
        scopeKey: workspaceSession!.scopeKey,
        dataScope: workspaceSession!.dataScope,
        canCreate:
          kind === 'appointments' && hasWorkspacePermission(workspaceSession, `${resource}.create`),
        canUpdate: hasWorkspacePermission(workspaceSession, `${resource}.update`),
        canComplete: hasWorkspacePermission(workspaceSession, `${resource}.complete`),
        canCancel: hasWorkspacePermission(workspaceSession, `${resource}.cancel`),
        canAssign: hasWorkspacePermission(workspaceSession, `${resource}.assign`),
        canOverrideComplete:
          kind === 'followups'
            ? hasWorkspacePermission(workspaceSession, 'followup.override_complete')
            : hasWorkspacePermission(workspaceSession, 'appointment.complete'),
      }
    : undefined;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState<WorkQuery>(() => parseWorkQuery(searchParams, kind));
  const [view, setView] = useState<'table' | 'calendar'>('table');
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [createOpen, setCreateOpen] = useState(
    () => kind === 'appointments' && searchParams.get('action') === 'create',
  );
  const [editingRecord, setEditingRecord] = useState<WorkRecord | null>(null);
  const [actionState, setActionState] = useState<{
    action: 'complete' | 'cancel';
    record: WorkRecord;
  } | null>(null);
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
    [],
  );
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const salesConsultantCache = useSalesConsultantCache();
  const legacyPermissions = useQuery({
    queryKey: ['work-workspace-permissions', ...queryScope, kind, role],
    queryFn: () => fetchWorkWorkspacePermissions(kind),
    enabled: !useWorkspaceBootstrap,
    staleTime: 60_000,
  });
  const permissions = bootstrapPermissions ?? legacyPermissions.data;
  useTenantRealtimeInvalidation(permissions?.organizationId, [
    {
      resource: 'work',
      queryKeys: [['work-workspace', ...queryScope, kind]],
    },
  ]);
  const workspace = useQuery({
    queryKey: ['work-workspace', ...queryScope, kind, timezone, requestQuery],
    queryFn: ({ signal }) => fetchWorkWorkspace(kind, requestQuery, timezone, signal),
    enabled: Boolean(permissions),
    placeholderData: keepPreviousData,
  });
  // Arrived from a lead's stage badge: mark whichever rows on this page belong
  // to that lead. The badge only knows the lead, so more than one follow-up or
  // appointment can match and all of them are marked.
  const focusId = readFocusParam(searchParams);
  const focusMatchedIds = useMemo(
    () =>
      focusId
        ? (workspace.data?.records ?? [])
            .filter((record) => record.lead_id === focusId || record.id === focusId)
            .map((record) => record.id)
        : [],
    [focusId, workspace.data],
  );
  const focusedRowIds = useFocusedRows({
    focusId,
    matchedIds: focusMatchedIds,
    scope: kind,
    pathname,
    searchParams,
  });

  const onQueryChange = (next: Partial<WorkQuery>) => {
    const changesFilter = [
      'search',
      'status',
      'priority',
      'appointmentType',
      'branchId',
      'teamId',
      'ownerId',
      'model',
      'source',
      'temperature',
      'followupFrom',
      'followupTo',
    ].some((key) => key in next);
    const updated = { ...query, ...next, appointmentId: changesFilter ? '' : query.appointmentId };
    setQuery(updated);
    replaceQueryString(pathname, toWorkQueryString(updated, kind));
  };
  const invalidate = useCallback(() => {
    salesConsultantCache.invalidate(
      kind === 'appointments' ? 'appointment.changed' : 'followup.changed',
    );
  }, [kind, salesConsultantCache]);

  if (
    (!useWorkspaceBootstrap && legacyPermissions.isPending) ||
    (workspace.isPending && permissions)
  )
    return kind === 'appointments' ? <AppointmentsSkeleton /> : <FollowupsSkeleton />;
  if (
    (!useWorkspaceBootstrap && legacyPermissions.isError) ||
    workspace.isError ||
    !permissions ||
    !workspace.data
  )
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Work items are not available yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your access scope or the work workspace migration needs attention. Reference:
            GDM-WORK-QUERY.
          </p>
          {/*
            The card used to stop at the reference code, which hid every actual
            cause behind one sentence and made the page undiagnosable without a
            devtools session. The underlying reason is shown here instead: a
            PostgREST code and message for a failed call, a Zod path for a
            response that did not match the contract, or the missing-permission
            case that produces no error object at all.
          */}
          <p className="mt-3 max-w-lg break-words rounded-md bg-slate-50 px-3 py-2 text-left font-mono text-[11px] leading-5 text-[#263550]">
            {workspaceFailureDetail({
              permissions,
              workspaceError: workspace.error,
              permissionsError: useWorkspaceBootstrap ? null : legacyPermissions.error,
              hasData: Boolean(workspace.data),
            })}
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              if (!useWorkspaceBootstrap) void legacyPermissions.refetch();
              void workspace.refetch();
            }}
          >
            <RotateCcw className="size-4" />
            Try again
          </Button>
        </CardContent>
      </Card>
    );

  // `kind` selects which RPC ran, so the response shape is already decided by
  // the time we get here; the union just cannot express that to TypeScript.
  const followupData = workspace.data as FollowupWorkspaceResult;

  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        {kind === 'followups' ? (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Link href={`/${role}/dashboard`} className="text-blue-600 hover:underline">
                Dashboard
              </Link>
              <ChevronRight className="size-3" />
              <span>{role === 'team-manager' ? 'Team Follow-ups' : 'Follow-ups'}</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
              {role === 'team-manager' ? 'Team Follow-up Monitor' : 'Follow-up Management'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {role === 'team-manager'
                ? 'Monitor your team’s customer follow-ups and ensure no opportunity is missed.'
                : 'Manage and track customer follow-ups to keep every commitment on time.'}
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Link href={`/${role}/dashboard`} className="text-blue-600 hover:underline">
                Dashboard
              </Link>
              <ChevronRight className="size-3" />
              <span>Appointments</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
              Appointments
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Schedule, manage and track all customer appointments in one place.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {kind === 'appointments' && permissions.canCreate && !spec.readOnly && (
            <Button className="shrink-0" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              New appointment
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-6">
        {kind === 'followups' ? (
          <>
            <div
              id="followup-summary-kpis"
              hidden={!summaryOpen}
              className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
            >
              {followupMetricCards(followupData.kpis, followupData.status_counts).map((card) => (
                <FollowupMetricCard
                  key={card.status}
                  card={card}
                  active={query.status === card.status}
                  onSelect={() =>
                    onQueryChange({
                      status: query.status === card.status ? 'all' : card.status,
                      page: 1,
                    })
                  }
                />
              ))}
            </div>
            <FollowupStatusTabs
              statusCounts={followupData.status_counts}
              status={query.status}
              onStatusChange={(status) => onQueryChange({ status, page: 1 })}
              summaryOpen={summaryOpen}
              onSummaryToggle={() => setSummaryOpen((open) => !open)}
            />
            <WorkTable
              kind={kind}
              role={role}
              result={workspace.data}
              query={query}
              calendarQuery={requestQuery}
              onQueryChange={onQueryChange}
              permissions={permissions}
              isFetching={workspace.isFetching}
              onEdit={setEditingRecord}
              onAction={(action, record) => setActionState({ action, record })}
              view={view}
              onViewChange={setView}
              timezone={timezone}
              organizationId={permissions.organizationId}
              scopeKey={permissions.scopeKey}
              focusedRowIds={focusedRowIds}
            />
          </>
        ) : (
          <AppointmentWorkspaceView
            role={role}
            result={workspace.data as AppointmentWorkspaceResult}
            query={query}
            requestQuery={requestQuery}
            onQueryChange={onQueryChange}
            permissions={permissions}
            isFetching={workspace.isFetching}
            onEdit={setEditingRecord}
            onAction={(action, record) => setActionState({ action, record })}
            timezone={timezone}
            organizationId={permissions.organizationId}
            scopeKey={permissions.scopeKey}
            focusedRowIds={focusedRowIds}
          />
        )}
      </div>
      {kind === 'appointments' && permissions.canCreate && createOpen && (
        <WorkCreateDialog
          kind="appointments"
          open
          onOpenChange={setCreateOpen}
          onCreated={invalidate}
        />
      )}
      {editingRecord && (
        <WorkEditDialog
          key={`${editingRecord.id}:${editingRecord.version}`}
          kind={kind}
          record={editingRecord}
          open
          onOpenChange={(open) => !open && setEditingRecord(null)}
          onUpdated={() => {
            setEditingRecord(null);
            invalidate();
          }}
        />
      )}
      {actionState && kind === 'followups' && actionState.action === 'complete' && (
        <FollowupCompleteDialog
          key={`complete:${actionState.record.id}:${actionState.record.version}`}
          record={actionState.record as FollowupRecord}
          open
          onOpenChange={(open) => !open && setActionState(null)}
          onCompleted={() => {
            setActionState(null);
            invalidate();
          }}
        />
      )}
      {actionState && !(kind === 'followups' && actionState.action === 'complete') && (
        <WorkActionDialog
          key={`${actionState.action}:${actionState.record.id}:${actionState.record.version}`}
          kind={kind}
          action={actionState.action}
          record={actionState.record}
          open
          onOpenChange={(open) => !open && setActionState(null)}
          onCompleted={() => {
            setActionState(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}
