'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ArrowRightLeft,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClockAlert,
  Eye,
  FileUp,
  Flame,
  MoreVertical,
  ListTodo,
  Pin,
  Phone,
  PhoneCall,
  Smartphone,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Undo2,
  UserRoundCheck,
  UserRoundPlus,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import { focusRowHref, focusedRowClassName } from '@/lib/navigation/focus-row';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SummaryToggle } from '@/components/domain/summary-toggle';
import { LeadWorkspaceSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import { useSalesConsultantCache } from '@/features/sales-consultant/sales-consultant-cache';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { DayPicker } from '@/components/ui/day-picker';
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/search-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { roleHasNavigationSlug } from '@/config/navigation';
import type { PageSpec } from '@/lib/domain';
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { CustomerTelecmiCallDialog } from '@/features/customers/customer-360-actions';
import {
  CustomerMatchDialog,
  type MatchableLead,
} from '@/features/customers/customer-match-dialog';
import {
  FollowupCompleteDialog,
  WorkActionDialog,
  WorkCreateDialog,
  appointmentTypes,
  followupReasons,
  type AppointmentType,
  type FollowupReason,
} from '@/features/work/workspace-dialogs';
import { fetchWorkWorkspace, type FollowupRecord } from '@/features/work/workspace-api';
import { defaultWorkQuery } from '@/features/work/workspace-query';
import {
  assignLead,
  createLead,
  fetchAssignableUsers,
  fetchInterestedModelOptions,
  fetchLeadCreateOptions,
  fetchLeadPhone,
  fetchLeadPhoneHistory,
  fetchLeadWorkspaceMeta,
  fetchLeadWorkspaceRecords,
  toLeadMetaQuery,
  fetchLeadWorkspacePermissions,
  fetchPersonalLeadFlags,
  recordSalesLeadContact,
  recordTelecallerLeadContact,
  cancelSalesHandoff,
  fetchSalesHandoffCandidates,
  transferLeadToSales,
  setPersonalLeadPreference,
  updateLead,
  type SalesHandoffCandidate,
  type PersonalLeadFlag,
  type PersonalLeadFlags,
  type LeadRecord,
  type LeadWorkspaceResult,
  type LeadWorkspacePermissions,
} from './lead-workspace-api';
import {
  getDefaultLeadStatus,
  getSalesMyLeadsDefaultStatus,
  isUuid,
  isLeadVersionConflict,
  parseLeadQuery,
  toLeadQueryString,
  type LeadQuery,
  type LeadStageFilter,
  type LeadStatusFilter,
  type LeadTemperatureFilter,
} from './lead-workspace-query';
import { leadStageVariant } from './lead-stage-variant';
import { customerDetailHref, leadDetailHref } from '@/lib/navigation/record-links';
import {
  emptySavedLeadFilterValues,
  loadSavedLeadFilters,
  MAX_SAVED_LEAD_FILTERS,
  saveSavedLeadFilters,
  type SavedLeadFilter,
  type SavedLeadFilterValues,
  savedLeadFilterValues,
} from './saved-lead-filters';
import { requestDuplicateLeadDeletion } from './duplicate-lead-deletion-api';
import { LeadBulkImportDialog } from './lead-bulk-import-dialog';

const leadSources = [
  'Facebook',
  'Instagram',
  'Google Ads',
  'Website',
  'WhatsApp Business',
  'CarWale',
  'CarDekho',
  'Justdial',
  'IndiaMART',
  'Manual',
  'Other',
] as const;

const lifecycleOptions = [
  'New',
  'Contacted',
  'Qualified',
  'Appointment Scheduled',
  'Transferred to Sales',
  'Lost',
] as const;

// DORMANT is a suppression rather than a rung on the intent ladder, but it is
// set from the same menu because it is the same decision: how much contact
// this lead should get. See AGENTS.md 9.7.
const temperatureOptions = ['COLD', 'WARM', 'HOT', 'DORMANT'] as const;

function lifecycleOptionsForRole(role: string, currentStatus: string) {
  const allowed =
    role === 'sales-consultant'
      ? ['Appointment Scheduled', 'Lost']
      : role === 'telecaller'
        ? ['New', 'Contacted', 'Qualified', 'Lost']
        : [...lifecycleOptions];

  // A consultant can see the automatic handoff state as the current value,
  // but cannot select it. It is written only by the qualified-lead handoff.
  return Array.from(new Set([currentStatus, ...allowed]));
}

type PersonalLeadToggle = 'pinned' | 'starred';

type PersonalLeadView = 'all' | 'starred';

type LeadEditPreset = {
  lifecycleStatus?: string;
  temperature?: 'COLD' | 'WARM' | 'HOT' | 'DORMANT';
};

type LeadEditRequest = {
  lead: LeadRecord;
  preset?: LeadEditPreset;
};

type FollowupShortcut = {
  lead: LeadRecord;
  reason: FollowupReason;
};

type AppointmentShortcut = {
  lead: LeadRecord;
  type: AppointmentType;
};

/**
 * An action the ladder holds back until the lead's open follow-up is resolved.
 * `resume` is the work that was pressed, replayed once the follow-up is closed.
 */
type PendingFollowupRequest = {
  lead: LeadRecord;
  actionLabel: string;
  resume: () => void;
};

// Shared frozen fallback: a fresh `{}` per render would re-run every memo keyed
// on the personal flag map.
const emptyPersonalLeadFlags: PersonalLeadFlags = Object.freeze({});

function parsePersonalLeadView(params: URLSearchParams): PersonalLeadView {
  const view = params.get('personal');
  return view === 'starred' ? view : 'all';
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase();
}

function formatCompactDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatLeadAge(createdAt: string) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 3_600_000));
  const days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : `${hours}h`;
}

const preFollowupStages = new Set([
  'New',
  'Contacted',
  'Sales Contacted',
  'Qualified',
  'Transferred to Sales',
]);

function leadStageLabel(value: string, hasFollowup = false) {
  return hasFollowup && preFollowupStages.has(value) ? 'Follow-up' : value;
}

/**
 * Where each lead stage opens, and the tab that guarantees the row is in the
 * list when it gets there.
 */
const stageFocusDestinations: Record<
  string,
  { slug: string; actionLabel: string; params?: Record<string, string> }
> = {
  'Follow-up': {
    slug: 'follow-ups',
    actionLabel: 'Open follow-ups',
    params: { status: 'all' },
  },
  'Appointment Scheduled': {
    slug: 'appointments',
    actionLabel: 'Open appointments',
    params: { status: 'all' },
  },
  'Test Drive': { slug: 'test-drives', actionLabel: 'Open test drives' },
  Quotation: { slug: 'quotations', actionLabel: 'Open quotations' },
  Booking: { slug: 'bookings', actionLabel: 'Open bookings' },
};

function StageBadge({
  value,
  href,
  actionLabel,
  customerName,
  isMuted = false,
}: {
  value: string;
  href: string;
  actionLabel: string;
  customerName: string;
  isMuted?: boolean;
}) {
  const variant = leadStageVariant(value);
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        isMuted && 'opacity-60 grayscale-[30%]',
      )}
      aria-label={`${actionLabel} for ${customerName}`}
      title={`${actionLabel} for ${customerName}`}
    >
      <Badge
        variant={variant}
        className="cursor-pointer rounded px-2 py-0 text-[10px] hover:opacity-80"
      >
        {value}
      </Badge>
    </Link>
  );
}

/**
 * The connector down the left of an expanded phone group.
 *
 * Drawn per row, because each row is its own table cell and there is no single
 * element spanning the group to hang one line off. Two things make the separate
 * pieces read as one line: the trunk overhangs its row by a pixel at each end so
 * neighbouring rows overlap instead of leaving hairline seams at the joins, and
 * it sits above the row border rather than under it.
 *
 * Every child gets the same quarter-circle where the branch leaves the trunk.
 * Only the last one used to curve; the rest were flat stubs, which read as
 * detached dashes beside the line rather than as branches off it. On the last
 * child the trunk stops at the curve, so nothing overshoots past the final row.
 */
function PhoneGroupBranch({ isLast }: { isLast: boolean }) {
  if (isLast) {
    return (
      <>
        <div className="pointer-events-none absolute left-[11px] -top-6 z-[1] h-[calc(50%+19px)] w-[2px] bg-blue-500" />
        <svg
          className="pointer-events-none absolute left-[11px] top-[calc(50%-6px)] z-[1] h-[8px] w-[14px] overflow-visible text-blue-500"
          viewBox="0 0 14 8"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M 1 0 V 1 A 5 5 0 0 0 6 6 H 14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </>
    );
  }

  return (
    <>
      <div className="pointer-events-none absolute -bottom-6 left-[11px] -top-6 z-[1] w-[2px] bg-blue-500" />
      <div className="pointer-events-none absolute left-[11px] top-1/2 -translate-y-1/2 z-[1] h-[2px] w-[14px] bg-blue-500" />
    </>
  );
}

function TemperatureBadge({ value }: { value: LeadRecord['temperature'] }) {
  // DORMANT is do-not-disturb, not a colder COLD, so it gets its own styling
  // rather than reading as an ordinary cold lead. See AGENTS.md 9.7.
  const variant =
    value === 'HOT'
      ? 'destructive'
      : value === 'WARM'
        ? 'warning'
        : value === 'DORMANT'
          ? 'secondary'
          : 'info';
  return (
    <Badge variant={variant} className="rounded px-2 py-0 text-[10px]">
      {value ?? 'COLD'}
    </Badge>
  );
}

function leadShare(part: number, whole: number) {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

type SalesLeadMetricCard = {
  status: LeadStatusFilter;
  label: string;
  value: number;
  icon: LucideIcon;
  chip: string;
  rate: number;
  helper: string;
  good: boolean;
  neutral?: boolean;
  footnote: string;
};

/**
 * The same five-card summary the Sales Consultant and Follow-ups pages carry,
 * told as the Telecaller's own funnel: everything assigned, what arrived, what
 * has not been called yet, what has, and what reached Sales. Every card maps to
 * a tab that exists for this role, so pressing one filters rather than landing
 * the user somewhere the tab strip cannot represent.
 */
function telecallerLeadMetricCards(kpis: LeadWorkspaceResult['kpis']): SalesLeadMetricCard[] {
  const active = Math.max(0, kpis.total - kpis.lost_count);
  return [
    {
      status: 'all',
      label: 'Total my leads',
      value: kpis.total,
      icon: Users,
      chip: 'bg-violet-50 text-violet-600',
      rate: leadShare(active, kpis.total),
      helper: 'still active',
      good: true,
      neutral: kpis.total === 0,
      footnote: `${kpis.transferred_to_sales_count.toLocaleString()} transferred · ${kpis.lost_count.toLocaleString()} lost`,
    },
    {
      status: 'new-today',
      label: 'New',
      value: kpis.new_today,
      icon: UserRoundPlus,
      chip: 'bg-blue-50 text-blue-600',
      rate: leadShare(kpis.new_today, kpis.total),
      helper: 'of all my leads',
      good: true,
      footnote: 'Enquiries that came in today',
    },
    {
      status: 'pending',
      label: 'Pending',
      value: kpis.pending,
      icon: ClockAlert,
      chip: 'bg-rose-50 text-rose-600',
      rate: leadShare(kpis.pending, kpis.total),
      helper: 'need attention',
      // Zero pending is the good state here, unlike the other cards where a
      // higher number is the thing to celebrate.
      good: kpis.pending === 0,
      neutral: kpis.total === 0,
      footnote: 'No call logged against the lead yet',
    },
    {
      status: 'contacted',
      label: 'Contacted',
      value: kpis.contacted_count,
      icon: Phone,
      chip: 'bg-emerald-50 text-emerald-600',
      rate: leadShare(kpis.contacted_count, kpis.total),
      helper: 'of all my leads',
      good: true,
      footnote: 'Call already recorded',
    },
    {
      status: 'transferred-to-sales',
      label: 'Transferred to Sales',
      value: kpis.transferred_to_sales_count,
      icon: UserRoundCheck,
      chip: 'bg-orange-50 text-orange-600',
      rate: leadShare(kpis.transferred_to_sales_count, kpis.total),
      helper: 'handed to a consultant',
      good: true,
      footnote: 'Qualified and passed on',
    },
  ];
}

function salesLeadMetricCards(kpis: LeadWorkspaceResult['kpis']): SalesLeadMetricCard[] {
  const active = Math.max(0, kpis.total - kpis.lost_count);
  return [
    {
      status: 'all',
      label: 'Total my leads',
      value: kpis.total,
      icon: Users,
      chip: 'bg-violet-50 text-violet-600',
      rate: leadShare(active, kpis.total),
      helper: 'still active',
      good: true,
      neutral: kpis.total === 0,
      footnote: `${kpis.booking.toLocaleString()} booked · ${kpis.lost_count.toLocaleString()} lost`,
    },
    {
      status: 'sales-new',
      label: 'New today',
      value: kpis.sales_new_today,
      icon: UserRoundPlus,
      chip: 'bg-blue-50 text-blue-600',
      rate: leadShare(kpis.sales_new_today, kpis.total),
      helper: 'of all my leads',
      good: true,
      footnote: 'Fresh leads awaiting sales progress',
    },
    {
      status: 'sales-pending',
      label: 'Pending action',
      value: kpis.sales_pending,
      icon: ClockAlert,
      chip: 'bg-rose-50 text-rose-600',
      rate: leadShare(kpis.sales_pending, kpis.total),
      helper: 'need attention',
      good: kpis.sales_pending === 0,
      neutral: kpis.total === 0,
      footnote: 'Lead has no completed sales action',
    },
    {
      status: 'sales-contacted',
      label: 'Contacted',
      value: kpis.sales_contacted,
      icon: Phone,
      chip: 'bg-emerald-50 text-emerald-600',
      rate: leadShare(kpis.sales_contacted, kpis.total),
      helper: 'of all my leads',
      good: true,
      footnote: 'Sales contact already recorded',
    },
    {
      status: 'hot',
      label: 'Hot leads',
      value: kpis.hot,
      icon: Flame,
      chip: 'bg-orange-50 text-orange-600',
      rate: leadShare(kpis.hot, kpis.total),
      helper: 'high priority',
      good: true,
      footnote: 'Customer ready to buy',
    },
  ];
}

function SalesLeadMetricCard({
  card,
  active,
  onSelect,
}: {
  card: SalesLeadMetricCard;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = card.icon;
  const TrendIcon = card.good ? TrendingUp : TrendingDown;
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
          <p className="mt-1 text-center text-[10px] text-muted-foreground">{card.footnote}</p>
        </CardContent>
      </Card>
    </button>
  );
}

function managerLeadMetricCards(kpis: LeadWorkspaceResult['kpis']): SalesLeadMetricCard[] {
  const active = Math.max(0, kpis.total - kpis.lost_count);
  return [
    {
      status: 'all',
      label: 'Total leads',
      value: kpis.total,
      icon: Users,
      chip: 'bg-violet-50 text-violet-600',
      rate: leadShare(active, kpis.total),
      helper: 'still active',
      good: true,
      neutral: kpis.total === 0,
      footnote: `${kpis.booking.toLocaleString()} booked · ${kpis.lost_count.toLocaleString()} lost`,
    },
    {
      status: 'new',
      label: 'New today',
      value: kpis.new_count,
      icon: UserRoundPlus,
      chip: 'bg-blue-50 text-blue-600',
      rate: leadShare(kpis.new_count, kpis.total),
      helper: 'of all leads',
      good: true,
      footnote: 'Fresh leads awaiting progress',
    },
    {
      status: 'pending',
      label: 'Pending action',
      value: kpis.pending,
      icon: ClockAlert,
      chip: 'bg-rose-50 text-rose-600',
      rate: leadShare(kpis.pending, kpis.total),
      helper: 'need attention',
      good: kpis.pending === 0,
      neutral: kpis.total === 0,
      footnote: 'Lead has no completed action',
    },
    {
      status: 'contacted',
      label: 'Contacted',
      value: kpis.contacted_count,
      icon: Phone,
      chip: 'bg-emerald-50 text-emerald-600',
      rate: leadShare(kpis.contacted_count, kpis.total),
      helper: 'of all leads',
      good: true,
      footnote: 'Contact already recorded',
    },
    {
      status: 'hot',
      label: 'Hot leads',
      value: kpis.hot,
      icon: Flame,
      chip: 'bg-orange-50 text-orange-600',
      rate: leadShare(kpis.hot, kpis.total),
      helper: 'high priority',
      good: true,
      footnote: 'Customer ready to buy',
    },
  ];
}

function LeadStatusTabs({
  data,
  query,
  role,
  personalView,
  onStatusChange,
  onPersonalViewChange,
  summaryOpen,
  onSummaryToggle,
}: {
  data: LeadWorkspaceResult;
  query: LeadQuery;
  role: string;
  personalView: PersonalLeadView;
  onStatusChange: (status: LeadStatusFilter) => void;
  onPersonalViewChange: (view: PersonalLeadView) => void;
  summaryOpen?: boolean;
  onSummaryToggle?: () => void;
}) {
  const generalTabs: Array<{ label: string; value: LeadStatusFilter; count: number }> = [
    { label: 'All', value: 'all', count: data.kpis.total },
    { label: 'New', value: 'new', count: data.kpis.new_count },
    { label: 'Pending', value: 'pending', count: data.kpis.pending },
    { label: 'Contacted', value: 'contacted', count: data.kpis.contacted_count },
    { label: 'Follow-up', value: 'follow-up', count: data.kpis.follow_up },
    {
      label: 'Appointments',
      value: 'appointment-scheduled',
      count: data.kpis.appointment_scheduled_count,
    },
    { label: 'Test Drive', value: 'test-drive', count: data.kpis.test_drive },
    { label: 'Quotation', value: 'quotation', count: data.kpis.quotation },
    { label: 'Booking', value: 'booking', count: data.kpis.booking },
    { label: 'Lost', value: 'lost', count: data.kpis.lost_count },
  ];
  const salesConsultantTabs: Array<{ label: string; value: LeadStatusFilter; count: number }> = [
    { label: 'All', value: 'all', count: data.kpis.total },
    { label: 'New', value: 'sales-new', count: data.kpis.sales_new_today },
    { label: 'Pending', value: 'sales-pending', count: data.kpis.sales_pending },
    { label: 'Contacted', value: 'sales-contacted', count: data.kpis.sales_contacted },
    { label: 'Follow-up', value: 'follow-up', count: data.kpis.follow_up },
    {
      label: 'Appointments',
      value: 'appointment-scheduled',
      count: data.kpis.appointment_scheduled_count,
    },
    { label: 'Test Drive', value: 'test-drive', count: data.kpis.test_drive },
    { label: 'Quotation', value: 'quotation', count: data.kpis.quotation },
    { label: 'Booking', value: 'booking', count: data.kpis.booking },
    { label: 'Lost', value: 'lost', count: data.kpis.lost_count },
  ];
  // Intake and sales use different working queues. A Telecaller owns a lead
  // from New through qualification; it becomes a Sales lead only after the
  // qualified handoff. Pending remains a derived work-state, never a lifecycle
  // update, so a freshly added lead stays in New for the rest of the day.
  const telecallerTabs: Array<{ label: string; value: LeadStatusFilter; count: number }> = [
    { label: 'All', value: 'all', count: data.kpis.total },
    // New is today's intake queue, on the Asia/Kolkata calendar day the lead was
    // created. Uncontacted enquiries from any earlier day are the separate
    // Pending queue, not hidden behind a lifecycle-only New tab.
    { label: 'New', value: 'new-today', count: data.kpis.new_today },
    { label: 'Pending', value: 'pending', count: data.kpis.pending },
    { label: 'Contacted', value: 'contacted', count: data.kpis.contacted_count },
    { label: 'Follow-up', value: 'follow-up', count: data.kpis.follow_up },
    {
      label: 'Transferred to Sales',
      value: 'transferred-to-sales',
      count: data.kpis.transferred_to_sales_count,
    },
    { label: 'Lost', value: 'lost', count: data.kpis.lost_count },
  ];
  const tabs =
    role === 'sales-consultant'
      ? salesConsultantTabs
      : role === 'telecaller'
        ? telecallerTabs
        : generalTabs;
  const starredCount = data.kpis.starred_count;

  return (
    <div className="flex h-10 border-b">
      <div
        role="tablist"
        aria-label="Lead quick views"
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = personalView === 'all' && query.status === tab.value;
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
                {tab.count}
              </span>
            </button>
          );
        })}
        {(
          [
            { label: 'Starred', value: 'starred' as const, count: starredCount, icon: Star },
          ] as const
        ).map((tab) => {
          const active = personalView === tab.value;
          const Icon = tab.icon;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onPersonalViewChange(tab.value)}
              style={active ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
              className={`relative flex h-full shrink-0 items-center gap-1.5 px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset ${
                active ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700'
              }`}
            >
              <Icon className={`size-3.5 ${active ? 'fill-current' : ''}`} />
              <span>{tab.label}</span>
              <span
                className={`grid min-w-5 place-items-center rounded px-1 py-0.5 text-[10px] leading-none ${
                  active ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>
      {typeof summaryOpen === 'boolean' && onSummaryToggle ? (
        <SummaryToggle
          open={summaryOpen}
          onToggle={onSummaryToggle}
          controls="my-leads-summary-kpis"
          label="lead summary"
        />
      ) : null}
    </div>
  );
}

/**
 * The generic "check the permitted branch and required fields" text hid every
 * real reason, including ones the user cannot act on by editing the form. The
 * server's own codes are mapped where they mean something specific, and the
 * fallback keeps the original wording for anything unrecognised.
 */
function leadCreateMessage(error: unknown) {
  const code =
    typeof error === 'object' && error !== null
      ? ((error as { message?: string }).message ?? '')
      : '';
  const known: Record<string, string> = {
    SALES_CONSULTANT_TEAM_REQUIRED:
      'You are not a member of a team in this branch, and a lead assigned to you must belong to one. Ask your manager to add you to a sales team, then try again.',
    ASSIGNED_LEAD_REQUIRES_TEAM:
      'A lead assigned to you must belong to a team. Ask your manager to add you to a sales team, then try again.',
    LEAD_ASSIGNEE_NOT_IN_TEAM: 'You are not an active member of the selected team.',
    LEAD_TEAM_NOT_IN_BRANCH: 'That team does not belong to the selected branch.',
    NO_ELIGIBLE_FRESH_ASSIGNEE: 'No one on that team can currently receive a new lead.',
    PERMISSION_DENIED: 'You are not allowed to create leads in this branch.',
    SCOPE_DENIED:
      'Your team sits in a branch you do not have access to. Ask your manager to check your branch access.',
    SALES_CONSULTANT_CANNOT_ASSIGN_LEADS:
      'A sales consultant cannot assign leads. Reload the page and try again; if it keeps happening, report it — the lead you create is meant to be assigned to you automatically.',
    FRESH_ASSIGNMENT_REQUIRES_TELECALLER:
      'A new lead can only be queued to a Telecaller. Ask your manager to check who is eligible on that team.',
    SALES_HANDOFF_REQUIRES_QUALIFIED_LEAD:
      'A lead reaches a sales consultant only after it is qualified and handed over.',
    LEAD_BRANCH_NOT_IN_ORGANIZATION: 'That branch is no longer active.',
    LEAD_FIELD_TOO_LONG:
      'Source detail and campaign are limited to 200 characters, and interested model to 160.',
    INVALID_PHONE: 'Enter a valid phone number of 7 to 15 digits.',
    INVALID_EMAIL: 'Enter a valid email address, or leave it blank.',
    INVALID_CUSTOMER_NAME: 'Customer name must be between 2 and 160 characters.',
    INVALID_LEAD_SOURCE: 'Choose a valid source.',
  };
  return (
    known[code] ??
    'The lead could not be created. Check the permitted branch and required fields, then try again.'
  );
}

/**
 * Marks a field the form will not submit without. Optional fields already say
 * so in words, so the asterisk is the only marker that has to carry meaning on
 * its own -- `aria-hidden` on the glyph plus the label text keeps it from being
 * read out as punctuation, and the title gives sighted users the same wording.
 */
function RequiredMark() {
  return (
    <span className="text-destructive" title="Required">
      <span aria-hidden="true">*</span>
      <span className="sr-only">(required)</span>
    </span>
  );
}

function LeadCreateDialog({
  organizationId,
  open,
  onOpenChange,
  onCreated,
}: {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const options = useQuery({
    queryKey: ['lead-create-options', ...queryScope, organizationId],
    queryFn: ({ signal }) => fetchLeadCreateOptions(signal),
    enabled: open,
  });
  const [branchId, setBranchId] = useState('');
  const [teamId, setTeamId] = useState('none');
  const [source, setSource] = useState<(typeof leadSources)[number]>('Manual');
  const [interestedModel, setInterestedModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const debouncedModelSearch = useDebouncedValue(modelSearch, 250);

  useEffect(() => {
    if (!open) {
      setInterestedModel('');
      setModelSearch('');
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: createLead,
    onSuccess: () => {
      setInterestedModel('');
      setModelSearch('');
      onOpenChange(false);
      onCreated();
    },
  });
  const selectedBranchId = branchId || options.data?.branches[0]?.id || '';
  const teams = options.data?.teams.filter((team) => team.branch_id === selectedBranchId) ?? [];
  const showBranchPicker = (options.data?.branches.length ?? 0) > 1;

  const modelOptionsQuery = useQuery({
    queryKey: ['lead-interested-models', organizationId, selectedBranchId, debouncedModelSearch],
    queryFn: ({ signal }) =>
      fetchInterestedModelOptions(
        {
          branchId: selectedBranchId || undefined,
          search: debouncedModelSearch,
          limit: 5,
        },
        signal,
      ),
    enabled: open,
  });

  const modelSelectOptions = useMemo<SearchSelectOption[]>(() => {
    const list: SearchSelectOption[] = [];
    const serverItems = modelOptionsQuery.data ?? [];

    for (const item of serverItems) {
      let desc = '';
      if (item.in_stock) {
        desc = `In stock (${item.stock_count} unit${item.stock_count === 1 ? '' : 's'} at branch)`;
      } else if (item.brand_name) {
        desc = `${item.brand_name} · Catalog`;
      } else {
        desc = 'Known model';
      }
      list.push({
        value: item.model_name,
        label: item.model_name,
        description: desc,
      });
    }

    const trimmedSearch = modelSearch.trim();
    if (trimmedSearch) {
      const hasExact = list.some((opt) => opt.value.toLowerCase() === trimmedSearch.toLowerCase());
      if (!hasExact) {
        list.push({
          value: trimmedSearch,
          label: `Use "${trimmedSearch}"`,
          description: 'Custom model entry',
        });
      }
    }

    if (interestedModel) {
      const alreadyIn = list.some(
        (opt) => opt.value.toLowerCase() === interestedModel.toLowerCase(),
      );
      if (!alreadyIn) {
        list.unshift({
          value: interestedModel,
          label: interestedModel,
          description: 'Selected model',
        });
      }
      list.push({
        value: '__CLEAR__',
        label: 'Clear selection',
        description: 'Leave model unselected',
      });
    }

    return list;
  }, [modelOptionsQuery.data, modelSearch, interestedModel]);

  // A consultant does not choose a team: they belong to exactly one active
  // sales team, and `create_lead` now resolves it from that membership. The
  // picker offered a choice that was never theirs and defaulted to "No team
  // yet", which quietly created teamless leads. OWN_RECORDS is the same
  // condition the server uses to decide the creator owns what they created.
  const derivesOwnTeam = workspaceSession?.dataScope === 'OWN_RECORDS';
  const showTeamPicker = teams.length > 0 && !derivesOwnTeam;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add lead</DialogTitle>
          <DialogDescription>
            A lead is a single enquiry. Existing customers are never automatically merged from a
            phone or email match.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            mutation.mutate({
              organizationId,
              branchId: selectedBranchId,
              teamId: derivesOwnTeam || teamId === 'none' ? null : teamId,
              source,
              customerName: String(form.get('customerName') ?? ''),
              phone: String(form.get('phone') ?? ''),
              email: String(form.get('email') ?? ''),
              sourceDetail: String(form.get('sourceDetail') ?? ''),
              campaign: String(form.get('campaign') ?? ''),
              interestedModel: interestedModel.trim(),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            <span>
              Customer name <RequiredMark />
            </span>
            <Input name="customerName" required minLength={2} maxLength={160} autoComplete="name" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            <span>
              Phone <RequiredMark />
            </span>
            <Input
              name="phone"
              required
              inputMode="tel"
              minLength={7}
              maxLength={24}
              autoComplete="tel"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            <span>
              Email <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <Input name="email" type="email" maxLength={320} autoComplete="email" />
          </label>
          <div className="grid gap-1.5 text-sm font-medium">
            <span>
              Source <RequiredMark />
            </span>
            <Select
              value={source}
              onValueChange={(value) => setSource(value as (typeof leadSources)[number])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {leadSources.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {showBranchPicker ? (
            <div className="grid gap-1.5 text-sm font-medium">
              <span>
                Branch <RequiredMark />
              </span>
              <Select
                value={selectedBranchId}
                onValueChange={(value) => {
                  setBranchId(value);
                  setTeamId('none');
                }}
                disabled={options.isPending || !options.data?.branches.length}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={options.isPending ? 'Loading branches…' : 'Select branch'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {options.data?.branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {showTeamPicker ? (
            <div className="grid gap-1.5 text-sm font-medium">
              <span>
                Team <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <Select value={teamId} onValueChange={setTeamId} disabled={!selectedBranchId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No team yet</SelectItem>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5 text-sm font-medium">
            <span>
              Interested model <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <SearchSelect
              value={interestedModel}
              search={modelSearch}
              onSearchChange={setModelSearch}
              onValueChange={(val) => {
                if (val === '__CLEAR__') {
                  setInterestedModel('');
                  setModelSearch('');
                } else {
                  setInterestedModel(val);
                  setModelSearch('');
                }
              }}
              options={modelSelectOptions}
              isPending={modelOptionsQuery.isPending}
              isFetching={modelOptionsQuery.isFetching}
              isError={modelOptionsQuery.isError}
              placeholder="Select or search model"
              searchPlaceholder="Type model name (top 5)…"
              emptyMessage="No matching models. Type any name to enter a custom model."
              aria-label="Interested model"
            />
            <input type="hidden" name="interestedModel" value={interestedModel} />
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            <span>
              Source detail <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <Input name="sourceDetail" maxLength={200} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            <span>
              Campaign <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <Input name="campaign" maxLength={200} />
          </label>
          {options.isError && (
            <p className="text-sm text-destructive">
              Branch options could not be loaded for your current scope.
            </p>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">{leadCreateMessage(mutation.error)}</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!selectedBranchId || mutation.isPending}>
              {mutation.isPending ? 'Creating…' : 'Create lead'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LeadAssignmentDialog({
  lead,
  open,
  onOpenChange,
  onAssigned,
}: {
  lead: LeadRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssigned: () => void;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const [userSearch, setUserSearch] = useState('');
  const debouncedUserSearch = useDebouncedValue(userSearch, 300);
  const users = useQuery({
    queryKey: ['lead-assignment-candidates', ...queryScope, lead?.id, debouncedUserSearch],
    queryFn: ({ signal }) => fetchAssignableUsers(lead?.id ?? '', debouncedUserSearch, signal),
    enabled: open && Boolean(lead),
    placeholderData: keepPreviousData,
  });
  const [userId, setUserId] = useState(() => lead?.assigned_user_id ?? '');
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: assignLead,
    onSuccess: () => {
      onOpenChange(false);
      onAssigned();
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {lead?.lifecycle_status === 'Qualified'
              ? 'Hand over to Sales Consultant'
              : 'Assign lead to Telecaller'}
          </DialogTitle>
          <DialogDescription>
            {lead
              ? lead.lifecycle_status === 'Qualified'
                ? `${lead.customer_name} · Qualified leads are transferred automatically when handed to Sales.`
                : `${lead.customer_name} · New intake is assigned to a Telecaller.`
              : 'Choose an eligible team member.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!lead) return;
            mutation.mutate({
              leadId: lead.id,
              userId,
              assignmentKind: lead.lifecycle_status === 'Qualified' ? 'QUALIFIED' : 'FRESH',
              reason,
            });
          }}
        >
          <div className="grid gap-1.5 text-sm font-medium">
            {lead?.lifecycle_status === 'Qualified' ? 'Sales Consultant' : 'Telecaller'}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={userSearch}
                onChange={(event) => setUserSearch(event.target.value)}
                className="pl-9"
                placeholder={
                  lead?.lifecycle_status === 'Qualified'
                    ? 'Search Sales Consultant'
                    : 'Search Telecaller'
                }
                maxLength={160}
              />
            </div>
            <Select value={userId} onValueChange={setUserId} disabled={users.isPending}>
              <SelectTrigger>
                <SelectValue
                  placeholder={users.isPending ? 'Loading users…' : 'Select team member'}
                />
              </SelectTrigger>
              <SelectContent>
                {users.data?.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Reason{' '}
            {lead?.assigned_user_id && (
              <span className="font-normal text-muted-foreground">(required for reassignment)</span>
            )}
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              required={Boolean(lead?.assigned_user_id)}
            />
          </label>
          {users.isError && (
            <p className="text-sm text-destructive">
              Eligible users could not be loaded for your current scope.
            </p>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              This lead could not be assigned. The selected user must be active, eligible for this
              team, and match the required handoff role.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!userId || mutation.isPending}>
              {mutation.isPending
                ? 'Saving…'
                : lead?.lifecycle_status === 'Qualified'
                  ? 'Hand over to Sales'
                  : 'Assign to Telecaller'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Auto-assign is the sentinel that tells the database to balance the book. */
const AUTO_SALES_HANDOFF = 'auto';

/**
 * The lead row knows a follow-up is due (`next_followup_at`) but not which row
 * it is, and completing or cancelling one needs its id and version for the
 * optimistic-concurrency token. Fetch it by lead id -- the same search the
 * "Open follow-ups" link uses -- and keep OPEN/OVERDUE, the two states that
 * still block the ladder.
 */
function PendingFollowupDialog({
  request,
  onOpenChange,
  onResolved,
}: {
  request: PendingFollowupRequest | null;
  onOpenChange: (open: boolean) => void;
  onResolved: (resume: () => void) => void;
}) {
  const [action, setAction] = useState<'complete' | 'cancel' | null>(null);
  const lead = request?.lead ?? null;
  const followup = useQuery({
    queryKey: ['lead-open-followup', lead?.id],
    enabled: Boolean(lead?.id),
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const page = await fetchWorkWorkspace(
        'followups',
        { ...defaultWorkQuery, search: lead!.id, sort: 'scheduled:asc' },
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        signal,
      );
      return (
        (page.records as FollowupRecord[]).find(
          (record) =>
            record.lead_id === lead!.id &&
            (record.status === 'OPEN' || record.status === 'OVERDUE'),
        ) ?? null
      );
    },
  });
  const record = followup.data ?? null;
  // The resume runs only after the follow-up is actually resolved, so a lead
  // that still owes one never slips past the ladder into Sales.
  const resume = request?.resume;
  return (
    <>
      <Dialog open={Boolean(request) && !action} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Follow-up still pending</DialogTitle>
            <DialogDescription>
              {lead?.customer_name} has a scheduled follow-up. Complete or cancel it to continue
              with {request?.actionLabel}.
            </DialogDescription>
          </DialogHeader>
          {followup.isPending ? (
            <p className="text-sm text-muted-foreground">Loading the scheduled follow-up…</p>
          ) : record ? (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{record.reason}</p>
              <p className="text-muted-foreground">
                Due {formatCompactDate(record.due_at)} · {record.assigned_user_name}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {followup.isError
                ? 'The scheduled follow-up could not be loaded. Open Follow-ups to resolve it.'
                : 'No open follow-up is visible in your scope. Ask its owner to complete or cancel it.'}
            </p>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!record}
                onClick={() => setAction('cancel')}
              >
                Cancel follow-up
              </Button>
              <Button type="button" disabled={!record} onClick={() => setAction('complete')}>
                Complete follow-up
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {record && action === 'complete' && (
        <FollowupCompleteDialog
          key={`lead-followup-complete-${record.id}-${record.version}`}
          record={record}
          open
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
          onCompleted={() => {
            setAction(null);
            onResolved(() => resume?.());
          }}
        />
      )}
      {record && action === 'cancel' && (
        <WorkActionDialog
          key={`lead-followup-cancel-${record.id}-${record.version}`}
          kind="followups"
          action="cancel"
          record={record}
          open
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
          onCompleted={() => {
            setAction(null);
            onResolved(() => resume?.());
          }}
        />
      )}
    </>
  );
}

/** A lost lead is closed, and a transferred one already belongs to Sales. */
function canHandOffToSales(lead: LeadRecord) {
  return lead.lifecycle_status !== 'Lost' && lead.lifecycle_status !== 'Transferred to Sales';
}

function salesHandoffErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('TRANSFER_REASON_REQUIRED'))
    return 'Enter why this lead is ready for Sales before transferring it.';
  if (message.includes('NO_ELIGIBLE_SALES_CONSULTANT'))
    return 'This team has no Sales Consultant marked eligible for qualified leads. Ask your Team Manager to enable one, then try again.';
  if (message.includes('SALES_CONSULTANT_NOT_ELIGIBLE'))
    return 'That Sales Consultant is no longer eligible for this team. Refresh the list and choose another.';
  if (message.includes('LEAD_ALREADY_WITH_SALES'))
    return 'This lead has already been transferred to Sales.';
  if (message.includes('LOST_LEAD_CANNOT_TRANSFER'))
    return 'A lost lead cannot be transferred. Reopen it first.';
  if (message.includes('LEAD_TEAM_REQUIRED'))
    return 'This lead is not in a team yet, so there is nobody to hand it to. Ask your manager to place it in a team.';
  if (message.includes('PERMISSION_DENIED') || message.includes('SCOPE_DENIED'))
    return 'You can only transfer leads you own. Refresh the list and try again.';
  if (message.includes('ASSIGNMENT_RPC_REQUIRED'))
    return 'The database blocked the Sales Consultant assignment. Refresh and try again; if it continues, contact your administrator.';
  if (message.includes('TELECALLER_LIFECYCLE_FORBIDDEN'))
    return 'The database blocked the automatic sales-handoff stage. Refresh and try again; if it continues, contact your administrator.';
  return 'This lead was not transferred. Nothing was changed. Refresh and try again.';
}

/**
 * Where an interested intake lead leaves the Telecaller and enters Sales.
 * Qualification and assignment happen together, so the lead is never left
 * qualified with nobody working it.
 */
function SalesHandoffDialog({
  lead,
  open,
  onOpenChange,
  onTransferred,
}: {
  lead: LeadRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTransferred: () => void;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<string>(AUTO_SALES_HANDOFF);
  const [reason, setReason] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const candidates = useQuery({
    queryKey: ['sales-handoff-candidates', ...queryScope, lead?.id, debouncedSearch],
    queryFn: ({ signal }) => fetchSalesHandoffCandidates(lead?.id ?? '', debouncedSearch, signal),
    enabled: open && Boolean(lead),
    placeholderData: keepPreviousData,
  });
  const consultants: SalesHandoffCandidate[] = candidates.data ?? [];
  const recommended = consultants.find((consultant) => consultant.recommended) ?? null;
  const mutation = useMutation({
    mutationFn: transferLeadToSales,
    onSuccess: (result) => {
      const owner = consultants.find(
        (consultant) => consultant.user_id === result.assigned_user_id,
      );
      onOpenChange(false);
      toast.add({
        type: 'success',
        title: 'Lead transferred to Sales',
        description: owner
          ? `${owner.full_name} now owns this lead${result.method === 'ROUND_ROBIN' ? ' (fewest open leads).' : '.'}`
          : 'The lead is now with Sales.',
      });
      onTransferred();
    },
    onError: (error) => {
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Lead was not transferred',
        description: salesHandoffErrorMessage(error),
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer to Sales</DialogTitle>
          <DialogDescription>
            {lead
              ? `${lead.customer_name} is qualified and handed to a Sales Consultant in the same team.`
              : 'Choose the Sales Consultant who takes this lead.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!lead) return;
            mutation.mutate({
              leadId: lead.id,
              userId: selection === AUTO_SALES_HANDOFF ? null : selection,
              reason,
            });
          }}
        >
          <div className="grid gap-1.5 text-sm font-medium">
            Sales Consultant
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Search Sales Consultant"
                maxLength={160}
              />
            </div>
            <Select value={selection} onValueChange={setSelection}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_SALES_HANDOFF}>
                  Auto-assign · fewest open leads
                  {recommended ? ` (${recommended.full_name})` : ''}
                </SelectItem>
                {consultants.map((consultant) => (
                  <SelectItem key={consultant.user_id} value={consultant.user_id}>
                    {consultant.full_name} · {consultant.open_leads} open
                    {consultant.hot_leads ? ` · ${consultant.hot_leads} hot` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs font-normal text-muted-foreground">
              {candidates.isPending
                ? 'Loading the team’s Sales Consultants…'
                : consultants.length
                  ? 'Auto-assign picks the consultant carrying the fewest open leads in this team.'
                  : 'No eligible Sales Consultant is available in this team.'}
            </p>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            <span>
              Reason <RequiredMark />
            </span>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={1}
              maxLength={500}
              placeholder="Why this lead is ready for Sales"
            />
          </label>
          {candidates.isError && (
            <p className="text-sm text-destructive">
              The Sales Consultant list could not be loaded for this lead.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                !reason.trim() ||
                (selection === AUTO_SALES_HANDOFF && !candidates.isPending && !consultants.length)
              }
            >
              {mutation.isPending ? 'Transferring…' : 'Transfer to Sales'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function salesHandoffCancellationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('HANDOFF_CANCELLATION_REASON_REQUIRED'))
    return 'Enter why this lead should return to the Telecaller queue.';
  if (message.includes('HANDOFF_NOT_CANCELLABLE'))
    return 'Only a lead that is currently transferred to Sales can be returned.';
  if (message.includes('HANDOFF_ORIGINAL_TELECALLER_REQUIRED'))
    return 'Only the Telecaller who transferred this lead can return it.';
  if (message.includes('PERMISSION_DENIED') || message.includes('SCOPE_DENIED'))
    return 'You do not have access to return this lead. Refresh and try again.';
  return 'The transfer could not be cancelled. Nothing was changed. Refresh and try again.';
}

/** A transfer reversal is a new auditable handoff event, never a history edit. */
function SalesHandoffCancellationDialog({
  lead,
  open,
  onOpenChange,
  onCancelled,
}: {
  lead: LeadRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: cancelSalesHandoff,
    onSuccess: () => {
      onOpenChange(false);
      toast.add({
        type: 'success',
        title: 'Transfer cancelled',
        description: 'The lead is back with you as Contacted and is no longer in the Sales queue.',
      });
      onCancelled();
    },
    onError: (error) => {
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Transfer was not cancelled',
        description: salesHandoffCancellationErrorMessage(error),
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel transfer to Sales?</DialogTitle>
          <DialogDescription>
            {lead
              ? `${lead.customer_name} will return to your Contacted queue and be removed from the Sales Consultant’s active leads.`
              : 'Return this lead to the Telecaller queue.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!lead) return;
            mutation.mutate({ leadId: lead.id, reason });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            <span>
              Reason <RequiredMark />
            </span>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={1}
              maxLength={500}
              placeholder="Why should this lead return to the Telecaller queue?"
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep transfer
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={mutation.isPending || !reason.trim()}
            >
              {mutation.isPending ? 'Cancelling…' : 'Cancel transfer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LeadEditDialog({
  lead,
  role,
  preset,
  open,
  onOpenChange,
  onUpdated,
}: {
  lead: LeadRecord | null;
  role: string;
  preset?: LeadEditPreset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  const [lifecycleStatus, setLifecycleStatus] = useState(
    () => preset?.lifecycleStatus ?? lead?.lifecycle_status ?? 'New',
  );
  const [temperature, setTemperature] = useState(
    () => preset?.temperature ?? lead?.temperature ?? 'none',
  );
  const [lostReason, setLostReason] = useState(() => lead?.lost_reason ?? '');
  const [reason, setReason] = useState('');
  const [versionConflict, setVersionConflict] = useState(false);
  const mutation = useMutation({
    mutationFn: updateLead,
    onSuccess: () => {
      onOpenChange(false);
      onUpdated();
    },
    onError: async (error) => {
      // A version conflict must reload this scoped workspace before the user retries.
      if (isLeadVersionConflict(error)) setVersionConflict(true);
      await onUpdated();
    },
  });
  if (!lead) return null;
  const availableLifecycleOptions = lifecycleOptionsForRole(role, lead.lifecycle_status);
  const lifecycleShortcut = preset?.lifecycleStatus;
  const temperatureShortcut = preset?.temperature;
  const lifecycleChanged = lifecycleStatus !== lead.lifecycle_status;
  const temperatureChanged = temperature !== (lead.temperature ?? 'none');
  const hasChanges = lifecycleChanged || temperatureChanged;
  const isLost = lifecycleStatus === 'Lost';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {lifecycleShortcut
              ? `Mark lead as ${lifecycleShortcut}`
              : temperatureShortcut
                ? `Set lead temperature to ${temperatureShortcut}`
                : 'Update lead'}
          </DialogTitle>
          <DialogDescription>
            {lead.customer_name} · {shortId(lead.id)}. This change is recorded in lead history.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!hasChanges || !reason.trim()) return;
            const patch: Parameters<typeof updateLead>[0]['patch'] = {};
            if (lifecycleChanged) patch.lifecycle_status = lifecycleStatus;
            if (temperatureChanged && temperature !== 'none')
              patch.temperature = temperature as 'COLD' | 'WARM' | 'HOT';
            if (isLost && (lifecycleChanged || lostReason !== (lead.lost_reason ?? '')))
              patch.lost_reason = lostReason;
            mutation.mutate({
              leadId: lead.id,
              expectedUpdatedAt: lead.updated_at,
              patch,
              reason,
            });
          }}
        >
          {!temperatureShortcut && (
            <div className="grid gap-1.5 text-sm font-medium">
              Lifecycle
              {lifecycleShortcut ? (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm font-normal">
                  {lifecycleStatus}
                </div>
              ) : (
                <Select value={lifecycleStatus} onValueChange={setLifecycleStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableLifecycleOptions.map((option) => (
                      <SelectItem
                        key={option}
                        value={option}
                        disabled={role === 'sales-consultant' && option === 'Transferred to Sales'}
                      >
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          {!lifecycleShortcut && (
            <div className="grid gap-1.5 text-sm font-medium">
              Temperature
              {temperatureShortcut ? (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm font-normal">
                  {temperature}
                </div>
              ) : (
                <Select value={temperature} onValueChange={setTemperature}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {lead.temperature === null && <SelectItem value="none">Not set</SelectItem>}
                    {temperatureOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          {isLost && (
            <label className="grid gap-1.5 text-sm font-medium">
              Lost reason
              <Input
                value={lostReason}
                onChange={(event) => setLostReason(event.target.value)}
                required
                maxLength={500}
              />
            </label>
          )}
          <label className="grid gap-1.5 text-sm font-medium">
            Change reason <span className="text-destructive">(required)</span>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              maxLength={500}
            />
          </label>
          {(mutation.isError || versionConflict) && (
            <p className="text-sm text-destructive">
              {versionConflict || isLeadVersionConflict(mutation.error)
                ? 'This lead changed elsewhere. The list has been refreshed; close this dialog, reopen the latest lead, then submit again.'
                : 'The lead could not be updated. Check the change reason and permitted lifecycle transition, then try again.'}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                versionConflict ||
                !hasChanges ||
                !reason.trim() ||
                (isLost && !lostReason.trim()) ||
                mutation.isPending
              }
            >
              {mutation.isPending
                ? 'Saving…'
                : lifecycleShortcut
                  ? `Mark as ${lifecycleShortcut}`
                  : temperatureShortcut
                    ? `Set ${temperatureShortcut}`
                    : 'Save changes'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateLeadDeletionRequestDialog({
  lead,
  open,
  onOpenChange,
}: {
  lead: LeadRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState('Duplicate lead received for an existing mobile number');
  const mutation = useMutation({
    mutationFn: () => {
      if (!lead) throw new Error('LEAD_NOT_READY');
      return requestDuplicateLeadDeletion({ leadId: lead.id, reason: reason.trim() });
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Sent to Team Manager',
        description:
          'The lead remains active until your Team Manager approves the duplicate removal.',
      });
      onOpenChange(false);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : '';
      const alreadyPending = message.includes('DUPLICATE_DELETION_ALREADY_PENDING');
      const notEligible = message.includes('LEAD_NOT_ELIGIBLE_FOR_DUPLICATE_DELETION');
      toast.add({
        type: 'error',
        title: alreadyPending
          ? 'Approval is already pending'
          : notEligible
            ? 'This lead cannot be removed as a duplicate'
            : 'Request was not sent',
        description: alreadyPending
          ? 'Your Team Manager can review the existing request in Duplicate Approvals.'
          : notEligible
            ? 'Only a newer same-mobile lead with no contact, follow-up, stage change or other work is eligible.'
            : 'Refresh the lead list and try again.',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request duplicate lead removal</DialogTitle>
          <DialogDescription>
            {lead
              ? `${lead.customer_name} · ${lead.phone} will stay active until a Team Manager approves. The earlier lead for this mobile number will be retained.`
              : 'Submit this untouched duplicate for Team Manager approval.'}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <p className="font-medium">Allowed only before any work starts</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Contact, follow-up, Lost, transfer to sales, appointment, call, task, quotation or
            booking will block deletion.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="duplicate-lead-reason">Reason</Label>
          <Textarea
            id="duplicate-lead-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={4}
          />
          <p className="text-right text-xs text-muted-foreground">{reason.length}/500</p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending || reason.trim().length < 5}
            onClick={() => mutation.mutate()}
          >
            <Trash2 className="size-4" />
            {mutation.isPending ? 'Sending…' : 'Send for approval'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeadTable({
  role,
  data,
  query,
  personalFlags,
  personalView,
  personalFlagsPending,
  savedFilters,
  savedFiltersLoading,
  savedFiltersAvailable,
  onQueryChange,
  onPersonalFlagChange,
  onSaveSavedFilter,
  onRemoveSavedFilter,
  canAssign,
  canUpdate,
  canScheduleFollowups,
  canCreateTasks,
  canScheduleAppointments,
  canScheduleTestDrives,
  canLinkCustomer,
  canTransferToSales,
  canCancelSalesHandoff,
  canRequestDuplicateDeletion,
  focusLeadId,
  onFocusConsumed,
  isFetching,
  onAssign,
  onEdit,
  onScheduleFollowup,
  onScheduleAppointment,
  onMatchCustomer,
  onSalesContact,
  onIntakeContact,
  canProviderCall,
  onProviderCall,
  onTransferToSales,
  onCancelSalesHandoff,
  onRequestDuplicateDeletion,
  onPendingFollowup,
}: {
  role: string;
  data: LeadWorkspaceResult;
  query: LeadQuery;
  personalFlags: PersonalLeadFlags;
  personalView: PersonalLeadView;
  personalFlagsPending: boolean;
  savedFilters: SavedLeadFilter[];
  savedFiltersLoading: boolean;
  savedFiltersAvailable: boolean;
  onQueryChange: (next: Partial<LeadQuery>) => void;
  onPersonalFlagChange: (leadId: string, flag: PersonalLeadToggle, active: boolean) => void;
  onSaveSavedFilter: (name: string, filters: SavedLeadFilterValues) => Promise<void>;
  onRemoveSavedFilter: (id: string) => Promise<void>;
  canAssign: boolean;
  canUpdate: boolean;
  canScheduleFollowups: boolean;
  canCreateTasks: boolean;
  canScheduleAppointments: boolean;
  canScheduleTestDrives: boolean;
  canLinkCustomer: boolean;
  canTransferToSales: boolean;
  canCancelSalesHandoff: boolean;
  canRequestDuplicateDeletion: boolean;
  focusLeadId: string | null;
  onFocusConsumed: () => void;
  isFetching: boolean;
  onAssign: (lead: LeadRecord) => void;
  onEdit: (lead: LeadRecord, preset?: LeadEditPreset) => void;
  onScheduleFollowup: (lead: LeadRecord, reason: FollowupReason) => void;
  onScheduleAppointment: (lead: LeadRecord, type: AppointmentType) => void;
  onMatchCustomer: (lead: LeadRecord) => void;
  onSalesContact: (lead: LeadRecord, channel: 'CALL' | 'WHATSAPP') => void;
  onIntakeContact: (lead: LeadRecord, channel: 'CALL' | 'WHATSAPP') => void;
  canProviderCall: boolean;
  onProviderCall: (lead: LeadRecord) => void;
  onTransferToSales: (lead: LeadRecord) => void;
  onCancelSalesHandoff: (lead: LeadRecord) => void;
  onRequestDuplicateDeletion: (lead: LeadRecord) => void;
  onPendingFollowup: (request: PendingFollowupRequest) => void;
}) {
  const isManagerView = [
    'team-manager',
    'showroom-manager',
    'gm-sales',
    'client-admin',
    'system-administrator',
    'business-owner',
  ].includes(role);
  const showLeadStageFilter = role !== 'sales-consultant';
  const leadStageOptions =
    role === 'telecaller'
      ? ['all', 'New', 'Contacted', 'Transferred to Sales', 'Lost']
      : role === 'sales-consultant'
        ? [
            'all',
            'Transferred to Sales',
            'Appointment Scheduled',
            'Test Drive',
            'Quotation',
            'Booking',
            'Lost',
          ]
        : ['all', ...lifecycleOptions, 'Test Drive', 'Quotation', 'Booking'];
  // Canonical sources stay available even before this Telecaller's scope has a
  // lead from each one. Keep scoped values too so a newly supported source is
  // visible immediately instead of waiting for a frontend release.
  const sourceOptions = useMemo(
    () => Array.from(new Set([...leadSources, ...data.filters.sources])),
    [data.filters.sources],
  );
  const canOpenFollowups = roleHasNavigationSlug(role, 'follow-ups');
  const canOpenTasks = roleHasNavigationSlug(role, 'tasks');
  const tableRouter = useRouter();
  const [highlightedLeadId, setHighlightedLeadId] = useState<string | null>(null);
  // The ladder still holds, but a blocked action now offers the way through it
  // instead of a dead-end toast: resolve the follow-up here, and the work that
  // was pressed runs straight after.
  const blockedByOpenFollowup = useCallback(
    (lead: LeadRecord, label: string, resume: () => void) => {
      if (!lead.next_followup_at) return false;
      onPendingFollowup({ lead, actionLabel: label, resume });
      return true;
    },
    [onPendingFollowup],
  );
  const advanceLead = useCallback(
    (lead: LeadRecord, destination: string, label: string) => {
      const go = () => tableRouter.push(destination);
      if (blockedByOpenFollowup(lead, label, go)) return;
      go();
    },
    [blockedByOpenFollowup, tableRouter],
  );
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [draftFollowupFrom, setDraftFollowupFrom] = useState('');
  const [draftFollowupTo, setDraftFollowupTo] = useState('');
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [savedFilterName, setSavedFilterName] = useState('');
  const [savedFilterError, setSavedFilterError] = useState<string>();
  const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null);
  const visibleRecords = useMemo(() => {
    const matchingRecords = data.records;

    // An unpinned row has no flag entry at all, so compare pin rank explicitly:
    // Number(undefined) is NaN, and a NaN comparator result is read as 0, which
    // would leave every pinned row exactly where it started.
    const pinRank = (leadId: string) => {
      const flag = personalFlags[leadId];
      return flag?.pinned ? (flag.pinnedAt ?? '') : null;
    };

    return [...matchingRecords].sort((left, right) => {
      const leftPin = pinRank(left.id);
      const rightPin = pinRank(right.id);
      if (leftPin === null && rightPin === null) return 0;
      if (leftPin === null) return 1;
      if (rightPin === null) return -1;
      // Newest pin wins, so the lead pinned last sits above earlier pins.
      return rightPin.localeCompare(leftPin);
    });
  }, [data.records, personalFlags]);
  const expandedLead = useMemo(
    () => visibleRecords.find((lead) => lead.id === expandedLeadId) ?? null,
    [expandedLeadId, visibleRecords],
  );
  const phoneHistory = useQuery({
    queryKey: ['lead-phone-history', expandedLead?.organization_id, role, expandedLead?.id],
    queryFn: ({ signal }) => fetchLeadPhoneHistory(expandedLead!.id, signal),
    enabled: Boolean(expandedLead),
    staleTime: 60_000,
  });
  const historyRecords = useMemo(
    () => phoneHistory.data?.records.filter((lead) => lead.id !== expandedLead?.id) ?? [],
    [expandedLead?.id, phoneHistory.data?.records],
  );
  const historyLeadIds = useMemo(
    () => new Set(historyRecords.map((lead) => lead.id)),
    [historyRecords],
  );
  const lastHistoryLeadId = useMemo(
    () => (historyRecords.length ? historyRecords[historyRecords.length - 1]?.id : null),
    [historyRecords],
  );
  const togglePhoneHistory = useCallback((lead: LeadRecord) => {
    if (lead.phone_lead_count <= 1) return;
    setExpandedLeadId((current) => (current === lead.id ? null : lead.id));
  }, []);
  useEffect(() => {
    if (expandedLeadId && !visibleRecords.some((lead) => lead.id === expandedLeadId)) {
      setExpandedLeadId(null);
    }
  }, [expandedLeadId, visibleRecords]);
  const focusLeadLookup = useQuery({
    queryKey: ['focus-lead-lookup', focusLeadId],
    queryFn: ({ signal }) => (focusLeadId ? fetchLeadPhone(focusLeadId, signal) : null),
    enabled: Boolean(focusLeadId) && !visibleRecords.some((lead) => lead.id === focusLeadId),
    staleTime: 60_000,
  });

  // If focusLeadId belongs to one of the phone groups on the page, expand that group.
  useEffect(() => {
    if (!focusLeadId) return;
    if (visibleRecords.some((lead) => lead.id === focusLeadId)) return;

    if (focusLeadLookup.data?.phone) {
      const parentGroup = visibleRecords.find((lead) => lead.phone === focusLeadLookup.data?.phone);
      if (parentGroup && expandedLeadId !== parentGroup.id) {
        setExpandedLeadId(parentGroup.id);
      }
    }
  }, [expandedLeadId, focusLeadId, focusLeadLookup.data?.phone, visibleRecords]);

  // Focus & highlight effect when target lead is visible (either top-level or in history)
  useEffect(() => {
    if (!focusLeadId) return;
    const isVisibleDirect = visibleRecords.some((lead) => lead.id === focusLeadId);
    const isVisibleInHistory = historyRecords.some((lead) => lead.id === focusLeadId);

    if (!isVisibleDirect && !isVisibleInHistory) return;

    setHighlightedLeadId(focusLeadId);
    const row = document.getElementById(`lead-row-${focusLeadId}`);
    globalThis.requestAnimationFrame(() => {
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const timeout = globalThis.setTimeout(() => {
      setHighlightedLeadId(null);
      onFocusConsumed();
    }, 3_000);
    return () => globalThis.clearTimeout(timeout);
  }, [focusLeadId, historyRecords, onFocusConsumed, visibleRecords]);

  const followupDateLabel =
    query.followupFrom && query.followupTo
      ? `${new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(`${query.followupFrom}T00:00:00`))} – ${new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(`${query.followupTo}T00:00:00`))}`
      : query.followupFrom
        ? `From ${new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(`${query.followupFrom}T00:00:00`))}`
        : query.followupTo
          ? `Until ${new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(`${query.followupTo}T00:00:00`))}`
          : 'Select Date Range';
  const columns = useMemo<ColumnDef<LeadRecord>[]>(
    () => [
      {
        id: 'lead_id',
        header: () => (
          <div className="flex items-center gap-1.5">
            <span className="size-6 shrink-0" aria-hidden="true" />
            <span>Lead ID</span>
          </div>
        ),
        cell: ({ row }) => {
          const lead = row.original;
          const isHistoryLead = historyLeadIds.has(lead.id);
          const isLastHistoryLead = lastHistoryLeadId === lead.id;
          const isHighlighted = highlightedLeadId === lead.id;
          return (
            <div className="flex items-center gap-1.5">
              {isHistoryLead ? (
                <div className="relative size-6 shrink-0" aria-hidden="true">
                  <PhoneGroupBranch isLast={isLastHistoryLead} />
                </div>
              ) : lead.phone_lead_count > 1 ? (
                <div className="relative grid size-6 shrink-0 place-items-center">
                  {expandedLeadId === lead.id ? (
                    <div className="pointer-events-none absolute left-[11px] top-1/2 -bottom-6 z-0 w-[2px] bg-blue-500" />
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="relative z-10 size-6 shrink-0 text-blue-700 hover:bg-blue-50"
                    aria-expanded={expandedLeadId === lead.id}
                    aria-label={`${expandedLeadId === lead.id ? 'Collapse' : 'Show'} ${lead.phone_lead_count} leads for ${lead.phone}`}
                    title={`${lead.phone_lead_count} leads use this mobile number`}
                    onClick={() => togglePhoneHistory(lead)}
                  >
                    {expandedLeadId === lead.id ? (
                      <ChevronUp className="size-3.5" />
                    ) : (
                      <ChevronDown className="size-3.5" />
                    )}
                  </Button>
                </div>
              ) : (
                <span className="size-6 shrink-0" aria-hidden="true" />
              )}
              <Link
                href={leadDetailHref(role, row.original.id)}
                className={cn(
                  'font-medium transition-colors hover:text-primary hover:underline',
                  isHighlighted
                    ? 'font-semibold text-blue-700'
                    : isHistoryLead
                      ? 'text-slate-500'
                      : 'text-muted-foreground',
                )}
              >
                L-{shortId(lead.id)}
              </Link>
              {!isHistoryLead && lead.phone_lead_count > 1 ? (
                <Badge
                  variant="outline"
                  className="border-blue-200 bg-blue-50 px-1.5 text-[9px] font-semibold text-blue-700"
                >
                  {lead.phone_lead_count} leads
                </Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'customer_name',
        header: 'Customer',
        cell: ({ row }) => {
          const { customer_id: customerId, customer_name: customerName, id } = row.original;
          const isHistoryLead = historyLeadIds.has(id);
          // `title` keeps the full name reachable once it ellipsizes.
          if (isHistoryLead) {
            return (
              <span className="block truncate font-normal text-slate-500" title={customerName}>
                {customerName}
              </span>
            );
          }
          if (!customerId)
            return (
              <span className="block truncate font-semibold text-foreground" title={customerName}>
                {customerName}
              </span>
            );
          return (
            <Link
              href={customerDetailHref(role, customerId)}
              title={customerName}
              className="block truncate font-semibold text-foreground hover:text-primary hover:underline"
            >
              {customerName}
            </Link>
          );
        },
      },
      ...(isManagerView
        ? [
            {
              id: 'assigned_consultant',
              header: 'Consultant',
              cell: ({ row }: { row: { original: LeadRecord } }) => {
                const isHistoryLead = historyLeadIds.has(row.original.id);
                return (
                  <span
                    className={cn(
                      'whitespace-nowrap font-medium',
                      isHistoryLead ? 'font-normal text-slate-500' : undefined,
                    )}
                  >
                    {row.original.assigned_user_name ?? 'Unassigned'}
                  </span>
                );
              },
            } satisfies ColumnDef<LeadRecord>,
          ]
        : []),
      {
        accessorKey: 'phone',
        header: 'Mobile',
        cell: ({ getValue, row }) => {
          const isHistoryLead = historyLeadIds.has(row.original.id);
          return (
            <span
              className={
                isHistoryLead ? 'font-normal text-slate-500' : 'font-medium text-[#263550]'
              }
            >
              {String(getValue())}
            </span>
          );
        },
      },
      {
        accessorKey: 'interested_model',
        header: 'Model',
        cell: ({ getValue, row }) => {
          const isHistoryLead = historyLeadIds.has(row.original.id);
          return (
            <span className={isHistoryLead ? 'text-slate-500' : undefined}>
              {String(getValue() ?? '—')}
            </span>
          );
        },
      },
      {
        accessorKey: 'source',
        header: 'Source',
        cell: ({ getValue, row }) => {
          const isHistoryLead = historyLeadIds.has(row.original.id);
          return (
            <span className={isHistoryLead ? 'text-slate-500' : undefined}>
              {String(getValue() ?? '—')}
            </span>
          );
        },
      },
      {
        accessorKey: 'lead_stage',
        header: 'Lead stage',
        cell: ({ row }) => {
          const lead = row.original;
          const isHistoryLead = historyLeadIds.has(lead.id);
          const stage = leadStageLabel(lead.lead_stage, Boolean(lead.next_followup_at));
          const stageDestination = stageFocusDestinations[stage];
          const destination =
            stageDestination && roleHasNavigationSlug(role, stageDestination.slug)
              ? {
                  href: focusRowHref(
                    `/${role}/${stageDestination.slug}`,
                    lead.id,
                    stageDestination.params,
                  ),
                  actionLabel: stageDestination.actionLabel,
                }
              : {
                  href: leadDetailHref(role, lead.id),
                  actionLabel: 'Open lead details',
                };
          return (
            <StageBadge
              value={stage}
              href={destination.href}
              actionLabel={destination.actionLabel}
              customerName={lead.customer_name}
              isMuted={isHistoryLead}
            />
          );
        },
      },
      {
        accessorKey: 'temperature',
        header: 'Temperature',
        cell: ({ row }) => {
          const isHistoryLead = historyLeadIds.has(row.original.id);
          if (canUpdate && !row.original.read_only && !isHistoryLead) {
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-6 w-full justify-between px-0 hover:bg-transparent"
                    aria-label={`Change temperature for ${row.original.customer_name}`}
                  >
                    <TemperatureBadge value={row.original.temperature} />
                    <ChevronDown
                      aria-hidden="true"
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-36">
                  <DropdownMenuLabel className="text-xs">Set temperature</DropdownMenuLabel>
                  {temperatureOptions.map((temperature) => (
                    <DropdownMenuItem
                      key={temperature}
                      disabled={temperature === row.original.temperature}
                      onSelect={() => onEdit(row.original, { temperature })}
                    >
                      <TemperatureBadge value={temperature} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          }
          return (
            <span className={isHistoryLead ? 'opacity-60 grayscale-[30%]' : undefined}>
              <TemperatureBadge value={row.original.temperature} />
            </span>
          );
        },
      },
      {
        accessorKey: 'updated_at',
        header: 'Last activity',
        cell: ({ getValue, row }) => {
          const isHistoryLead = historyLeadIds.has(row.original.id);
          return (
            <span className={isHistoryLead ? 'text-slate-400' : undefined}>
              {formatCompactDate(String(getValue()))}
            </span>
          );
        },
      },
      {
        accessorKey: 'next_followup_at',
        header: 'Next follow-up',
        cell: ({ row }) => {
          const isHistoryLead = historyLeadIds.has(row.original.id);
          return (
            <span className={isHistoryLead ? 'text-slate-400' : undefined}>
              {formatCompactDate(row.original.next_followup_at)}
            </span>
          );
        },
      },
      {
        accessorKey: 'created_at',
        header: 'Created',
        cell: ({ getValue, row }) => {
          const createdAt = String(getValue());
          const isHistoryLead = historyLeadIds.has(row.original.id);
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className={cn(
                    'cursor-help whitespace-nowrap underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isHistoryLead && 'text-slate-400',
                  )}
                  aria-label={`${formatCompactDate(createdAt)}. Lead age ${formatLeadAge(createdAt)}`}
                >
                  {formatCompactDate(createdAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">Lead age: {formatLeadAge(createdAt)}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => {
          if (row.original.read_only) {
            return (
              <div className="flex justify-end gap-1">
                <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
                  <Link
                    href={leadDetailHref(role, row.original.id)}
                    title="Read only — transferred to Sales"
                    aria-label={`View ${row.original.customer_name} (read only)`}
                  >
                    <Eye className="size-3.5" />
                    View
                  </Link>
                </Button>
                {canCancelSalesHandoff &&
                row.original.lifecycle_status === 'Transferred to Sales' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-rose-600 hover:text-rose-700"
                    title={`Cancel transfer for ${row.original.customer_name}`}
                    aria-label={`Cancel transfer for ${row.original.customer_name}`}
                    onClick={() => onCancelSalesHandoff(row.original)}
                  >
                    <Undo2 className="size-3.5" />
                    Cancel transfer
                  </Button>
                ) : null}
              </div>
            );
          }
          if (historyLeadIds.has(row.original.id)) return null;

          return (
            <div className="flex items-center justify-end gap-0.5">
              {!row.original.customer_id && canLinkCustomer ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-blue-600"
                  aria-label={`Review possible customer match for ${row.original.customer_name}`}
                  title="Review possible customer match"
                  onClick={() => onMatchCustomer(row.original)}
                >
                  <UserRoundPlus className="size-3.5" />
                </Button>
              ) : null}
              {canProviderCall ? (
                // Dealership calling goes through TeleCMI so the customer sees the
                // dealership line; the handset dialer stays available beside it.
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-emerald-600"
                      aria-label={`Call ${row.original.customer_name}`}
                      title={`Call ${row.original.customer_name}`}
                    >
                      <Phone className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52">
                    <DropdownMenuLabel className="text-xs">
                      Call {row.original.customer_name}
                    </DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => onProviderCall(row.original)}>
                      <PhoneCall className="size-3.5" />
                      Call through CRM
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <a
                        href={`tel:${row.original.phone}`}
                        onClick={() => {
                          if (role === 'telecaller') {
                            onIntakeContact(row.original, 'CALL');
                          } else {
                            onSalesContact(row.original, 'CALL');
                          }
                        }}
                      >
                        <Smartphone className="size-3.5" />
                        Call from my phone
                      </a>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button asChild variant="ghost" size="icon" className="size-7 text-emerald-600">
                  <a
                    href={`tel:${row.original.phone}`}
                    aria-label={`Call ${row.original.customer_name}`}
                    onClick={() => {
                      if (role === 'telecaller') {
                        onIntakeContact(row.original, 'CALL');
                      } else {
                        onSalesContact(row.original, 'CALL');
                      }
                    }}
                  >
                    <Phone className="size-3.5" />
                  </a>
                </Button>
              )}
              <Button asChild variant="ghost" size="icon" className="size-7 text-emerald-600">
                <a
                  href={toWhatsAppClickToChatUrl(row.original.phone)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`WhatsApp ${row.original.customer_name}`}
                  title={`WhatsApp ${row.original.customer_name}`}
                  onClick={() => {
                    if (role === 'telecaller') {
                      onIntakeContact(row.original, 'WHATSAPP');
                    } else {
                      onSalesContact(row.original, 'WHATSAPP');
                    }
                  }}
                >
                  <WhatsAppIcon className="size-4" />
                </a>
              </Button>
              {canScheduleFollowups ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-blue-600"
                      aria-label={`Schedule a follow-up for ${row.original.customer_name}`}
                      title={`Schedule a follow-up for ${row.original.customer_name}`}
                    >
                      <CalendarDays className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-60">
                    <DropdownMenuLabel className="text-xs">Schedule follow-up</DropdownMenuLabel>
                    {followupReasons.map((reason) => (
                      <DropdownMenuItem
                        key={reason}
                        onSelect={(event) => {
                          const schedule = () => onScheduleFollowup(row.original, reason);
                          if (
                            blockedByOpenFollowup(
                              row.original,
                              'scheduling another follow-up',
                              schedule,
                            )
                          ) {
                            event.preventDefault();
                            return;
                          }
                          schedule();
                        }}
                      >
                        <CalendarDays className="size-4" /> {reason}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : canOpenFollowups ? (
                <Button asChild variant="ghost" size="icon" className="size-7 text-blue-600">
                  <Link
                    href={`/${role}/follow-ups?q=${encodeURIComponent(row.original.id)}`}
                    aria-label={`Open follow-ups for ${row.original.customer_name}`}
                    title={`Open follow-ups for ${row.original.customer_name}`}
                  >
                    <CalendarDays className="size-3.5" />
                  </Link>
                </Button>
              ) : null}
              {canTransferToSales && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-violet-600 disabled:text-muted-foreground"
                  disabled={!canHandOffToSales(row.original)}
                  aria-label={`Transfer ${row.original.customer_name} to Sales`}
                  title={
                    canHandOffToSales(row.original)
                      ? `Transfer ${row.original.customer_name} to Sales`
                      : row.original.lifecycle_status === 'Lost'
                        ? 'A lost lead cannot be transferred'
                        : 'Already transferred to Sales'
                  }
                  onClick={() => {
                    const transfer = () => onTransferToSales(row.original);
                    if (blockedByOpenFollowup(row.original, 'the transfer to Sales', transfer))
                      return;
                    transfer();
                  }}
                >
                  <ArrowRightLeft className="size-3.5" />
                </Button>
              )}
              {canCreateTasks && canOpenTasks && (
                <Button asChild variant="ghost" size="icon" className="size-7 text-blue-600">
                  <Link
                    href={`/${role}/tasks?action=create&lead=${encodeURIComponent(row.original.id)}&customer=${encodeURIComponent(row.original.customer_name)}&phone=${encodeURIComponent(row.original.phone)}&model=${encodeURIComponent(row.original.interested_model ?? '')}`}
                    aria-label={`Create task for ${row.original.customer_name}`}
                    title={`Create task for ${row.original.customer_name}`}
                  >
                    <ListTodo className="size-3.5" />
                  </Link>
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`size-7 ${
                  personalFlags[row.original.id]?.pinned
                    ? 'text-blue-700 hover:text-blue-800'
                    : 'text-muted-foreground hover:text-blue-700'
                }`}
                aria-label={`${personalFlags[row.original.id]?.pinned ? 'Unpin' : 'Pin'} ${row.original.customer_name}`}
                title={`${personalFlags[row.original.id]?.pinned ? 'Unpin' : 'Pin'} to the top for me`}
                disabled={personalFlagsPending}
                onClick={() =>
                  onPersonalFlagChange(
                    row.original.id,
                    'pinned',
                    !personalFlags[row.original.id]?.pinned,
                  )
                }
              >
                <Pin
                  className={`size-3.5 ${personalFlags[row.original.id]?.pinned ? 'fill-current' : ''}`}
                />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`size-7 ${
                  personalFlags[row.original.id]?.starred
                    ? 'text-amber-500 hover:text-amber-600'
                    : 'text-muted-foreground hover:text-amber-500'
                }`}
                aria-label={`${personalFlags[row.original.id]?.starred ? 'Remove star from' : 'Star'} ${row.original.customer_name}`}
                title={`${personalFlags[row.original.id]?.starred ? 'Remove star' : 'Star'} for me`}
                disabled={personalFlagsPending}
                onClick={() =>
                  onPersonalFlagChange(
                    row.original.id,
                    'starred',
                    !personalFlags[row.original.id]?.starred,
                  )
                }
              >
                <Star
                  className={`size-3.5 ${personalFlags[row.original.id]?.starred ? 'fill-current' : ''}`}
                />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="More lead actions"
                  >
                    <MoreVertical className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-60">
                  {canAssign && (
                    <DropdownMenuItem onSelect={() => onAssign(row.original)}>
                      <UserRoundPlus className="size-4" /> Assign / reassign
                    </DropdownMenuItem>
                  )}
                  {canUpdate && (
                    <>
                      <DropdownMenuItem
                        disabled={row.original.lifecycle_status === 'Lost'}
                        onSelect={() => onEdit(row.original, { lifecycleStatus: 'Lost' })}
                      >
                        Mark as lost
                      </DropdownMenuItem>
                    </>
                  )}
                  {row.original.customer_id && canScheduleAppointments && (
                    <>
                      {canUpdate && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                        Schedule appointment
                      </DropdownMenuLabel>
                      {appointmentTypes.map((type) => (
                        <DropdownMenuItem
                          key={type}
                          onSelect={(event) => {
                            const book = () => onScheduleAppointment(row.original, type);
                            if (
                              blockedByOpenFollowup(row.original, 'booking an appointment', book)
                            ) {
                              event.preventDefault();
                              return;
                            }
                            book();
                          }}
                        >
                          <CalendarDays className="size-4" /> {type}
                        </DropdownMenuItem>
                      ))}
                    </>
                  )}
                  {row.original.customer_id && canScheduleTestDrives && (
                    <>
                      {(canUpdate || canScheduleAppointments) && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          advanceLead(
                            row.original,
                            `/${role}/test-drives?action=create&lead=${encodeURIComponent(row.original.id)}&q=${encodeURIComponent(row.original.phone)}`,
                            'a test drive',
                          );
                        }}
                      >
                        <CalendarDays className="size-4" /> Schedule test drive
                      </DropdownMenuItem>
                    </>
                  )}
                  {roleHasNavigationSlug(role, 'quotations') && (
                    <>
                      {(canUpdate ||
                        (row.original.customer_id && canScheduleAppointments) ||
                        (row.original.customer_id && canScheduleTestDrives)) && (
                        <DropdownMenuSeparator />
                      )}
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          advanceLead(
                            row.original,
                            `/${role}/quotations?action=create&lead=${encodeURIComponent(row.original.id)}`,
                            'a quotation',
                          );
                        }}
                      >
                        Create quotation
                      </DropdownMenuItem>
                    </>
                  )}
                  {roleHasNavigationSlug(role, 'bookings') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          advanceLead(
                            row.original,
                            `/${role}/bookings?action=create&lead=${encodeURIComponent(row.original.id)}`,
                            'a booking',
                          );
                        }}
                      >
                        Create booking
                      </DropdownMenuItem>
                    </>
                  )}
                  {canRequestDuplicateDeletion &&
                    !historyLeadIds.has(row.original.id) &&
                    row.original.phone_lead_count > 1 &&
                    row.original.lifecycle_status === 'New' &&
                    !row.original.first_contacted_at &&
                    !row.original.next_followup_at && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => onRequestDuplicateDeletion(row.original)}
                        >
                          <Trash2 className="size-4" /> Request duplicate removal
                        </DropdownMenuItem>
                      </>
                    )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [
      canAssign,
      canOpenFollowups,
      canOpenTasks,
      canCreateTasks,
      canScheduleFollowups,
      canScheduleAppointments,
      canScheduleTestDrives,
      canTransferToSales,
      canCancelSalesHandoff,
      canLinkCustomer,
      canRequestDuplicateDeletion,
      canUpdate,
      advanceLead,
      blockedByOpenFollowup,
      isManagerView,
      onAssign,
      onEdit,
      onScheduleFollowup,
      onScheduleAppointment,
      onSalesContact,
      onIntakeContact,
      canProviderCall,
      onProviderCall,
      onMatchCustomer,
      onTransferToSales,
      onCancelSalesHandoff,
      onRequestDuplicateDeletion,
      onPersonalFlagChange,
      personalFlagsPending,
      role,
      personalFlags,
      expandedLeadId,
      historyLeadIds,
      lastHistoryLeadId,
      highlightedLeadId,
      togglePhoneHistory,
    ],
  );
  // TanStack Table returns an imperative model; React Compiler intentionally skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: visibleRecords,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: data.total,
  });
  // The expanded rows reuse the exact role preset and actions from the parent
  // table; they are merely a second TanStack row model loaded on demand.
  const historyTable = useReactTable({
    data: historyRecords,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  const pages = Math.max(1, Math.ceil(data.total / query.pageSize));
  const pageNumbers = Array.from({ length: Math.min(5, pages) }, (_, index) =>
    Math.min(Math.max(query.page - 2, 1) + index, pages),
  ).filter((value, index, values) => index === 0 || value > values[index - 1]!);
  const hasFilters = Boolean(
    query.search ||
    query.model ||
    query.source ||
    query.stage !== 'all' ||
    query.temperature !== 'all' ||
    query.followupFrom ||
    query.followupTo,
  );
  const savedFilterLimitReached = savedFilters.length >= MAX_SAVED_LEAD_FILTERS;
  const openSaveFilter = () => {
    setSavedFilterName('');
    setSavedFilterError(undefined);
    setSaveFilterOpen(true);
  };
  const saveCurrentFilter = async () => {
    const name = savedFilterName.trim();
    if (!name) {
      setSavedFilterError('Enter a name for this filter.');
      return;
    }
    try {
      await onSaveSavedFilter(name, savedLeadFilterValues(query));
      setSaveFilterOpen(false);
      toast.add({
        type: 'success',
        title: 'Filter saved',
        description: `“${name}” is ready to use.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setSavedFilterError(
        message === 'SAVED_LEAD_FILTER_LIMIT_REACHED'
          ? 'You can save up to 5 filters. Remove one to save another.'
          : 'This filter could not be saved. Please try again.',
      );
    }
  };

  return (
    <Card className="overflow-hidden border-slate-200 shadow-none">
      <CardHeader className="space-y-0 p-0">
        <div className="overflow-x-auto bg-white px-3 pb-5 pt-3 sm:px-5">
          <div
            className={cn(
              'grid items-end gap-2.5',
              showLeadStageFilter
                ? 'min-w-[1100px] grid-cols-[1.45fr_.85fr_.8fr_.95fr_.9fr_1.25fr_108px]'
                : 'min-w-[980px] grid-cols-[1.45fr_.9fr_.85fr_.95fr_1.25fr_108px]',
            )}
          >
            <div className="relative min-w-0">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query.search}
                onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
                className="h-8 bg-white pl-9 text-[10px]"
                placeholder="Search by name or mobile…"
              />
            </div>
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
                  {data.filters.models.map((model) => (
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
                  {sourceOptions.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {showLeadStageFilter && (
              <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
                Lead stage
                <Select
                  value={query.stage}
                  onValueChange={(stage) =>
                    onQueryChange({ stage: stage as LeadStageFilter, page: 1 })
                  }
                >
                  <SelectTrigger className="h-8 bg-white text-[10px]">
                    <SelectValue placeholder="All lead stages" />
                  </SelectTrigger>
                  <SelectContent>
                    {leadStageOptions.map((stage) => (
                      <SelectItem key={stage} value={stage}>
                        {stage === 'all' ? 'All lead stages' : stage}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            <label className="grid min-w-0 gap-1 text-[10px] font-medium text-[#526079]">
              Temperature
              <Select
                value={query.temperature}
                onValueChange={(temperature) =>
                  onQueryChange({ temperature: temperature as LeadTemperatureFilter, page: 1 })
                }
              >
                <SelectTrigger className="h-8 bg-white text-[10px]">
                  <SelectValue placeholder="All temperatures" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All temperatures</SelectItem>
                  {temperatureOptions.map((temperature) => (
                    <SelectItem key={temperature} value={temperature}>
                      {temperature[0] + temperature.slice(1).toLowerCase()}
                    </SelectItem>
                  ))}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-8 w-full whitespace-nowrap px-2 text-[10px]">
                  <SlidersHorizontal className="size-3.5" /> Saved Filters
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Saved filters ({savedFilters.length}/5)</DropdownMenuLabel>
                {!savedFiltersAvailable ? (
                  <DropdownMenuItem disabled>
                    Saved filters need an active CRM session.
                  </DropdownMenuItem>
                ) : savedFiltersLoading ? (
                  <DropdownMenuItem disabled>Loading saved filters…</DropdownMenuItem>
                ) : savedFilters.length ? (
                  savedFilters.flatMap((savedFilter) => [
                    <DropdownMenuItem
                      key={`apply-${savedFilter.id}`}
                      onSelect={() => onQueryChange({ ...savedFilter.filters, page: 1 })}
                    >
                      <SlidersHorizontal className="size-3.5 text-blue-600" />
                      <span className="truncate">{savedFilter.name}</span>
                    </DropdownMenuItem>,
                    <DropdownMenuItem
                      key={`remove-${savedFilter.id}`}
                      className="pl-9 text-destructive focus:text-destructive"
                      onSelect={() => {
                        void onRemoveSavedFilter(savedFilter.id).catch(() =>
                          toast.add({
                            type: 'error',
                            title: 'Filter could not be removed',
                            description: 'Please try again.',
                          }),
                        );
                      }}
                    >
                      <X className="size-3.5" /> Remove “{savedFilter.name}”
                    </DropdownMenuItem>,
                  ])
                ) : (
                  <DropdownMenuItem disabled>No saved filters yet</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={
                    !hasFilters ||
                    !savedFiltersAvailable ||
                    savedFiltersLoading ||
                    savedFilterLimitReached
                  }
                  onSelect={openSaveFilter}
                >
                  Save current filters
                </DropdownMenuItem>
                {savedFilterLimitReached ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    Maximum of 5 saved filters. Remove one to save another.
                  </p>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!hasFilters}
                  onSelect={() =>
                    onQueryChange({
                      ...emptySavedLeadFilterValues(),
                      page: 1,
                    })
                  }
                >
                  Clear current filters
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div
          className={
            isFetching
              ? '[&>div]:overflow-y-hidden opacity-65 transition-opacity'
              : '[&>div]:overflow-y-hidden transition-opacity'
          }
        >
          <Table className="min-w-[1220px]">
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={cn(
                        'h-11 whitespace-nowrap bg-slate-50 px-3 text-[10px] font-semibold uppercase tracking-wide text-[#263550]',
                        // Actions sits last, so without this it inherits the
                        // table's leftover width and opens a gap between the
                        // icons and the right edge. w-px collapses the column to
                        // its content and hands the slack back to the text
                        // columns, which are the ones that benefit from it.
                        header.column.id === 'actions' && 'w-px !pr-0',
                      )}
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
                table.getRowModel().rows.map((row) => (
                  <Fragment key={row.id}>
                    <TableRow
                      id={`lead-row-${row.original.id}`}
                      tabIndex={row.original.read_only ? 0 : undefined}
                      aria-label={
                        row.original.read_only
                          ? `Open read-only lead L-${shortId(row.original.id)} for ${row.original.customer_name}`
                          : undefined
                      }
                      title={row.original.read_only ? 'Open read-only lead details' : undefined}
                      className={
                        highlightedLeadId === row.original.id
                          ? focusedRowClassName
                          : expandedLeadId === row.original.id
                            ? 'bg-blue-50/40 hover:bg-blue-50/60 transition-colors duration-500'
                            : 'hover:bg-slate-50/70 transition-colors duration-500'
                      }
                      onClick={(event) => {
                        if (!row.original.read_only) return;
                        if (
                          (event.target as HTMLElement).closest(
                            'a, button, input, select, textarea, [role="button"], [role="menuitem"]',
                          )
                        )
                          return;
                        tableRouter.push(leadDetailHref(role, row.original.id));
                      }}
                      onKeyDown={(event) => {
                        if (!row.original.read_only) return;
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        if (event.target !== event.currentTarget) return;
                        event.preventDefault();
                        tableRouter.push(leadDetailHref(role, row.original.id));
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            'whitespace-nowrap px-3 py-2.5 text-xs text-[#263550]',
                            cell.column.id === 'lead_id' && 'relative',
                            cell.column.id === 'customer_name' && 'max-w-[190px]',
                            cell.column.id === 'actions' && 'w-px !pr-0',
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {expandedLeadId === row.original.id && phoneHistory.isPending ? (
                      <TableRow className="bg-blue-50/20 hover:bg-blue-50/30">
                        <TableCell
                          colSpan={columns.length}
                          className="px-8 py-2.5 text-xs text-blue-700/80"
                        >
                          Loading all leads for {row.original.phone}…
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {expandedLeadId === row.original.id && phoneHistory.isError ? (
                      <TableRow className="bg-red-50/50 hover:bg-red-50/50">
                        <TableCell
                          colSpan={columns.length}
                          className="px-8 py-2.5 text-xs text-destructive"
                        >
                          The lead history could not be loaded. Collapse this row and try again.
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {expandedLeadId === row.original.id
                      ? historyTable.getRowModel().rows.map((historyRow) => (
                          <TableRow
                            key={`history-${historyRow.original.id}`}
                            id={`lead-row-${historyRow.original.id}`}
                            tabIndex={0}
                            aria-label={`Open historical lead L-${shortId(historyRow.original.id)} for ${historyRow.original.customer_name}`}
                            title={`Open lead L-${shortId(historyRow.original.id)}`}
                            className={
                              highlightedLeadId === historyRow.original.id
                                ? focusedRowClassName
                                : 'cursor-pointer bg-slate-50/40 text-slate-500 transition-colors hover:bg-slate-100/70 border-b border-b-slate-100/80 focus-visible:bg-slate-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
                            }
                            onClick={(event) => {
                              if (
                                (event.target as HTMLElement).closest(
                                  'a, button, input, select, textarea, [role="button"], [role="menuitem"]',
                                )
                              )
                                return;
                              tableRouter.push(leadDetailHref(role, historyRow.original.id));
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return;
                              if (event.target !== event.currentTarget) return;
                              event.preventDefault();
                              tableRouter.push(leadDetailHref(role, historyRow.original.id));
                            }}
                          >
                            {historyRow.getVisibleCells().map((cell) => (
                              <TableCell
                                key={`history-${cell.id}`}
                                className={cn(
                                  'whitespace-nowrap px-3 py-2.5 text-xs text-slate-500',
                                  cell.column.id === 'lead_id' && 'relative',
                                  cell.column.id === 'customer_name' && 'max-w-[190px]',
                                  cell.column.id === 'actions' && 'w-px !pr-0',
                                )}
                              >
                                {/* A row in the expanded group is a read-only
                                    record of an earlier enquiry on the same
                                    mobile. Its actions repeated the parent's on
                                    a lead you are only looking back at, so the
                                    cell is left empty and the row itself is the
                                    single affordance: pressing it opens the lead. */}
                                {cell.column.id === 'actions'
                                  ? null
                                  : flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))
                      : null}
                  </Fragment>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <p className="font-medium">No leads match this view</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Try a different status or page-local search.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t px-5 py-3 text-sm lg:flex-row lg:items-center lg:justify-between">
          <p className="text-xs text-[#526079]">
            <>
              Showing {data.total ? (query.page - 1) * query.pageSize + 1 : 0} to{' '}
              {Math.min(query.page * query.pageSize, data.total)} of {data.total}{' '}
              {personalView === 'starred' ? 'starred ' : ''}mobile groups ({data.lead_total}{' '}
              {data.lead_total === 1 ? 'lead' : 'leads'})
            </>
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
                onQueryChange({ pageSize: Number(value) as LeadQuery['pageSize'], page: 1 })
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
      </CardContent>
      <Dialog open={dateRangeOpen} onOpenChange={setDateRangeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Follow-up date range</DialogTitle>
            <DialogDescription>
              Show leads with a follow-up scheduled in this period.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              From
              <DayPicker value={draftFollowupFrom} onChange={setDraftFollowupFrom} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              To
              <DayPicker value={draftFollowupTo} onChange={setDraftFollowupTo} />
            </label>
          </div>
          <div className="flex justify-between gap-2">
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
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={saveFilterOpen}
        onOpenChange={(open) => {
          setSaveFilterOpen(open);
          if (!open) setSavedFilterError(undefined);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save current filters</DialogTitle>
            <DialogDescription>
              Save this filter combination for your account on this device. You can keep up to 5.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCurrentFilter();
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium">
              Filter name
              <Input
                value={savedFilterName}
                maxLength={40}
                autoFocus
                placeholder="For example, Hot website leads"
                onChange={(event) => {
                  setSavedFilterName(event.target.value);
                  setSavedFilterError(undefined);
                }}
              />
            </label>
            {savedFilterError ? (
              <p className="text-sm text-destructive">{savedFilterError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaveFilterOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save filter</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function LeadWorkspace({
  spec,
  slug,
  role,
}: {
  spec: PageSpec;
  slug: string;
  role: string;
}) {
  const workspaceSession = useWorkspaceSession();
  const useWorkspaceBootstrap = Boolean(workspaceSession?.organizationId);
  const queryScope = useMemo(
    () =>
      useWorkspaceBootstrap ? workspaceQueryScope(workspaceSession) : (['legacy', role] as const),
    [role, useWorkspaceBootstrap, workspaceSession],
  );
  const bootstrapPermissions: LeadWorkspacePermissions | undefined = useWorkspaceBootstrap
    ? {
        organizationId: workspaceSession!.organizationId as string,
        canCreate: hasWorkspacePermission(workspaceSession, 'lead.create'),
        canAssign: hasWorkspacePermission(workspaceSession, 'lead.assign'),
        canUpdate: hasWorkspacePermission(workspaceSession, 'lead.update'),
        canCreateFollowup: hasWorkspacePermission(workspaceSession, 'followup.create'),
        canCreateTask: hasWorkspacePermission(workspaceSession, 'task.create'),
        canCreateAppointment: hasWorkspacePermission(workspaceSession, 'appointment.create'),
        canManageTestDrive: hasWorkspacePermission(workspaceSession, 'test_drive.manage'),
        canCreateCustomer: hasWorkspacePermission(workspaceSession, 'customer.create'),
        canLinkCustomer: hasWorkspacePermission(workspaceSession, 'customer.link'),
      }
    : undefined;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const focusLeadId = isUuid(searchParams.get('focus') ?? '') ? searchParams.get('focus') : null;
  const fallbackStatus = getDefaultLeadStatus(slug);
  const workspaceLabel =
    role === 'team-manager'
      ? 'Team Leads'
      : role === 'showroom-manager'
        ? 'Showroom Leads'
        : role === 'gm-sales'
          ? 'Sales Leads'
          : 'My Leads';
  const [query, setQuery] = useState<LeadQuery>(() => parseLeadQuery(searchParams, fallbackStatus));
  const salesMyLeadsDefaultApplied = useRef(false);
  const [personalView, setPersonalView] = useState<PersonalLeadView>(() =>
    parsePersonalLeadView(searchParams),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [salesLeadMetricsOpen, setSalesLeadMetricsOpen] = useState(true);
  // Sales Consultant and Telecaller both work My Leads as a personal queue.
  // Both role === 'sales-consultant' && slug === 'my-leads' and
  // (role === 'sales-consultant' || role === 'telecaller') && slug === 'my-leads'
  // are satisfied, while also enabling the summary strip across team/showroom/sales/admin lead workspaces.
  const showMyLeadsSummary =
    ((role === 'sales-consultant' || role === 'telecaller') && slug === 'my-leads') ||
    (role === 'sales-consultant' && slug === 'my-leads') ||
    Boolean(
      slug &&
      (slug === 'team-leads' ||
        slug === 'showroom-leads' ||
        slug === 'sales-leads' ||
        slug === 'leads'),
    );
  // Quick add navigates to `?action=create` on a route this workspace may already
  // be mounted on. A lazy useState initialiser only runs at mount, so the param
  // changed and nothing opened until a reload remounted the component. Deriving
  // the open state from the URL instead keeps it correct on client navigation
  // without synchronising state inside an effect.
  const createRequested = searchParams.get('action') === 'create';
  const createDialogOpen = createOpen || createRequested;
  const closeCreateDialog = () => {
    setCreateOpen(false);
    if (!createRequested) return;
    // The param has to go, or reopening would be a navigation to an unchanged
    // URL and Quick add would silently do nothing the second time.
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('action');
    const nextQueryString = nextParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, {
      scroll: false,
    });
  };
  const [assignmentLead, setAssignmentLead] = useState<LeadRecord | null>(null);
  const [handoffLead, setHandoffLead] = useState<LeadRecord | null>(null);
  const [providerCallLead, setProviderCallLead] = useState<LeadRecord | null>(null);
  const [handoffCancellationLead, setHandoffCancellationLead] = useState<LeadRecord | null>(null);
  const [editingLead, setEditingLead] = useState<LeadEditRequest | null>(null);
  const [followupShortcut, setFollowupShortcut] = useState<FollowupShortcut | null>(null);
  const [appointmentShortcut, setAppointmentShortcut] = useState<AppointmentShortcut | null>(null);
  const [matchingLead, setMatchingLead] = useState<LeadRecord | null>(null);
  const [duplicateDeletionLead, setDuplicateDeletionLead] = useState<LeadRecord | null>(null);
  const [pendingFollowup, setPendingFollowup] = useState<PendingFollowupRequest | null>(null);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const queryClient = useQueryClient();
  const salesConsultantCache = useSalesConsultantCache();
  const personalPreferenceKey = [
    'personal-lead-preferences',
    workspaceSession?.organizationId,
    workspaceSession?.userId,
  ] as const;
  const savedFilterStorageKey =
    workspaceSession?.organizationId && workspaceSession.userId
      ? `${workspaceSession.organizationId}:${workspaceSession.userId}:${role}`
      : null;
  const [savedFilters, setSavedFilters] = useState<SavedLeadFilter[]>([]);
  const [savedFiltersLoadedKey, setSavedFiltersLoadedKey] = useState<string | null>(null);
  const savedFiltersLoading = Boolean(
    savedFilterStorageKey && savedFiltersLoadedKey !== savedFilterStorageKey,
  );
  const personalLeadPreferences = useQuery({
    queryKey: personalPreferenceKey,
    queryFn: ({ signal }) => fetchPersonalLeadFlags(signal),
    enabled: Boolean(workspaceSession?.organizationId && workspaceSession.userId),
    staleTime: 60_000,
  });
  const personalFlags = personalLeadPreferences.data ?? emptyPersonalLeadFlags;
  useEffect(() => {
    let cancelled = false;
    if (!savedFilterStorageKey) return;
    void loadSavedLeadFilters(savedFilterStorageKey)
      .then((filters) => {
        if (!cancelled) {
          setSavedFilters(filters);
          setSavedFiltersLoadedKey(savedFilterStorageKey);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSavedFilters([]);
          setSavedFiltersLoadedKey(savedFilterStorageKey);
          toast.add({
            type: 'error',
            title: 'Saved filters unavailable',
            description: 'Your saved filters could not be loaded. Please refresh and try again.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [savedFilterStorageKey]);
  const applyPersonalFlag = (
    current: PersonalLeadFlags,
    leadId: string,
    next: PersonalLeadFlag,
  ): PersonalLeadFlags => {
    if (!next.pinned && !next.starred) {
      const remaining = { ...current };
      delete remaining[leadId];
      return remaining;
    }
    return { ...current, [leadId]: next };
  };

  const personalLeadFlagMutation = useMutation({
    mutationFn: ({
      leadId,
      flag,
      active,
    }: {
      leadId: string;
      flag: PersonalLeadToggle;
      active: boolean;
    }) => {
      const current = personalFlags[leadId] ?? { pinned: false, starred: false, pinnedAt: null };
      return setPersonalLeadPreference({
        leadId,
        pinned: flag === 'pinned' ? active : current.pinned,
        starred: flag === 'starred' ? active : current.starred,
      });
    },
    // Reorder on click rather than after the round trip; the server reply below
    // replaces this with the authoritative pinned_at.
    onMutate: async ({ leadId, flag, active }) => {
      await queryClient.cancelQueries({ queryKey: personalPreferenceKey });
      const snapshot = queryClient.getQueryData<PersonalLeadFlags>(personalPreferenceKey);
      const current = snapshot?.[leadId] ?? { pinned: false, starred: false, pinnedAt: null };
      const pinned = flag === 'pinned' ? active : current.pinned;
      queryClient.setQueryData<PersonalLeadFlags>(personalPreferenceKey, (existing = {}) =>
        applyPersonalFlag(existing, leadId, {
          pinned,
          starred: flag === 'starred' ? active : current.starred,
          pinnedAt: pinned
            ? flag === 'pinned' && active
              ? new Date().toISOString()
              : current.pinnedAt
            : null,
        }),
      );
      return { snapshot };
    },
    onError: (error, _variables, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData<PersonalLeadFlags>(personalPreferenceKey, context.snapshot);
      }
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : '';
      const limitReached = message.includes('LEAD_PIN_LIMIT_REACHED')
        ? {
            title: 'Pin limit reached',
            description: 'You can pin up to 5 leads. Unpin one to pin another.',
          }
        : message.includes('LEAD_STAR_LIMIT_REACHED')
          ? {
              title: 'Star limit reached',
              description: 'You can star up to 10 leads. Unstar one to star another.',
            }
          : { title: 'That lead could not be updated', description: 'Please try again.' };
      toast.add({ ...limitReached, type: 'error', priority: 'high' });
    },
    onSuccess: (nextFlags) => {
      queryClient.setQueryData<PersonalLeadFlags>(personalPreferenceKey, (current = {}) =>
        applyPersonalFlag(current, nextFlags.leadId, {
          pinned: nextFlags.pinned,
          starred: nextFlags.starred,
          pinnedAt: nextFlags.pinnedAt,
        }),
      );
      // Pins float to the top of the whole result set server-side, so the page
      // that is currently rendered has to be refetched to pull them forward.
      salesConsultantCache.invalidate('lead.preference.changed');
      // Starring is now counted server-side, so the badge is a cached value that
      // goes stale the moment a star is toggled unless the counters refetch too.
      void queryClient.invalidateQueries({ queryKey: ['lead-workspace', ...queryScope] });
      void queryClient.invalidateQueries({ queryKey: ['lead-workspace-meta', ...queryScope] });
    },
  });
  const metaQuery = useMemo(() => toLeadMetaQuery(requestQuery), [requestQuery]);
  const records = useQuery({
    queryKey: ['lead-workspace', ...queryScope, requestQuery],
    queryFn: ({ signal }) => fetchLeadWorkspaceRecords(requestQuery, signal),
    placeholderData: keepPreviousData,
  });
  // Keyed without page, pageSize or sort, so paging reuses this entry outright.
  const meta = useQuery({
    queryKey: ['lead-workspace-meta', ...queryScope, metaQuery],
    queryFn: ({ signal }) => fetchLeadWorkspaceMeta(metaQuery, signal),
    placeholderData: keepPreviousData,
  });
  const workspace = {
    data: records.data && meta.data ? { ...records.data, ...meta.data } : undefined,
    isPending: records.isPending || meta.isPending,
    isError: records.isError || meta.isError,
    isFetching: records.isFetching || meta.isFetching,
    refetch: () => Promise.all([records.refetch(), meta.refetch()]),
  };
  const legacyPermissions = useQuery({
    queryKey: ['lead-workspace-permissions', ...queryScope, role],
    queryFn: fetchLeadWorkspacePermissions,
    enabled: !useWorkspaceBootstrap,
    staleTime: 60_000,
  });
  const permissions = bootstrapPermissions ?? legacyPermissions.data;

  const replaceLeadWorkspaceUrl = (nextQuery: LeadQuery, nextPersonalView = personalView) => {
    const params = new URLSearchParams(toLeadQueryString(nextQuery));
    if (nextPersonalView !== 'all') params.set('personal', nextPersonalView);
    replaceQueryString(pathname, params.toString());
  };
  const clearFocusedLead = useCallback(() => {
    if (!focusLeadId) return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('focus');
    const nextQueryString = nextParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, {
      scroll: false,
    });
  }, [focusLeadId, pathname, router, searchParams]);
  useEffect(() => {
    const isSalesMyLeads = role === 'sales-consultant' && slug === 'my-leads';
    if (
      !isSalesMyLeads ||
      searchParams.has('status') ||
      personalView !== 'all' ||
      salesMyLeadsDefaultApplied.current ||
      !workspace.data
    )
      return;

    salesMyLeadsDefaultApplied.current = true;
    const updated = {
      ...query,
      status: getSalesMyLeadsDefaultStatus(
        workspace.data.kpis.sales_new_today,
        workspace.data.kpis.sales_pending,
      ),
      page: 1,
    };
    setQuery(updated);
    const params = new URLSearchParams(toLeadQueryString(updated));
    // Quick add reaches this page with `action=create`. The Sales Consultant
    // default-filter pass runs as soon as the first workspace query resolves;
    // dropping that unrelated param here closes the controlled dialog again.
    if (createRequested) params.set('action', 'create');
    replaceQueryString(pathname, params.toString());
  }, [createRequested, pathname, personalView, query, role, searchParams, slug, workspace.data]);
  const onQueryChange = (next: Partial<LeadQuery>) => {
    const updated = { ...query, ...next };
    setQuery(updated);
    replaceLeadWorkspaceUrl(updated);
  };
  const saveCurrentLeadFilter = useCallback(
    async (name: string, filters: SavedLeadFilterValues) => {
      if (!savedFilterStorageKey) throw new Error('SAVED_LEAD_FILTERS_UNAVAILABLE');
      if (savedFilters.length >= MAX_SAVED_LEAD_FILTERS)
        throw new Error('SAVED_LEAD_FILTER_LIMIT_REACHED');
      const next: SavedLeadFilter[] = [
        ...savedFilters,
        {
          id: globalThis.crypto.randomUUID(),
          name: name.trim().slice(0, 40),
          filters,
          createdAt: new Date().toISOString(),
        },
      ];
      setSavedFilters(next);
      try {
        await saveSavedLeadFilters(savedFilterStorageKey, next);
      } catch (error) {
        setSavedFilters(savedFilters);
        throw error;
      }
    },
    [savedFilterStorageKey, savedFilters],
  );
  const removeSavedLeadFilter = useCallback(
    async (id: string) => {
      if (!savedFilterStorageKey) throw new Error('SAVED_LEAD_FILTERS_UNAVAILABLE');
      const next = savedFilters.filter((filter) => filter.id !== id);
      setSavedFilters(next);
      try {
        await saveSavedLeadFilters(savedFilterStorageKey, next);
      } catch (error) {
        setSavedFilters(savedFilters);
        throw error;
      }
    },
    [savedFilterStorageKey, savedFilters],
  );
  const onStatusChange = (status: LeadStatusFilter) => {
    const updated = { ...query, status, page: 1 };
    setQuery(updated);
    setPersonalView('all');
    replaceLeadWorkspaceUrl(updated, 'all');
  };
  const onPersonalViewChange = (view: PersonalLeadView) => {
    const updated: LeadQuery = {
      ...query,
      status: view === 'starred' ? 'starred' : 'all',
      page: 1,
    };
    setQuery(updated);
    setPersonalView(view);
    replaceLeadWorkspaceUrl(updated, view);
  };
  const onPersonalFlagChange = (leadId: string, flag: PersonalLeadToggle, active: boolean) => {
    if (!workspaceSession?.organizationId || !workspaceSession.userId) return;
    personalLeadFlagMutation.mutate({ leadId, flag, active });
  };
  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['lead-workspace', ...queryScope] }),
      queryClient.invalidateQueries({ queryKey: ['lead-workspace-meta', ...queryScope] }),
      queryClient.invalidateQueries({
        queryKey: ['lead-phone-history', workspaceSession?.organizationId],
      }),
    ]);
  }, [queryClient, queryScope, workspaceSession?.organizationId]);
  const personalPreferencesFailed = personalLeadPreferences.isError;
  useEffect(() => {
    if (!personalPreferencesFailed) return;
    toast.add({
      type: 'error',
      priority: 'high',
      title: 'Pins and stars unavailable',
      description:
        'Your personal pin and star list could not be loaded. No lead data was changed. Refresh and try again.',
    });
  }, [personalPreferencesFailed]);

  const salesContactMutation = useMutation({
    mutationFn: recordSalesLeadContact,
    onSuccess: async (_result, input) => {
      salesConsultantCache.invalidate('lead.updated', { leadId: input.leadId });
      // Recording contact moves the lead from Pending to Contacted, so both the
      // rows and the counters are stale the moment this returns. Refreshing the
      // sales-consultant cache alone left the tab showing the previous answer.
      await invalidate();
    },
  });

  // Pressing Call or WhatsApp is the Telecaller's first contact: it moves the
  // lead out of the New/Pending queue into Contacted, so the tabs and the row
  // both have to be refetched.
  const intakeContactMutation = useMutation({
    mutationFn: recordTelecallerLeadContact,
    onSuccess: invalidate,
    onError: () => {
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Contact was not recorded',
        description:
          'The call or message still went out, but this lead was not marked as contacted. Refresh and mark it from the lead row.',
      });
    },
  });

  if (workspace.isPending) return <LeadWorkspaceSkeleton />;
  if (workspace.isError || (!useWorkspaceBootstrap && legacyPermissions.isError))
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Leads are not available yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your session, database access, or the required lead workspace migration needs attention.
            Reference: GDM-LEADS-QUERY.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              void workspace.refetch();
              if (!useWorkspaceBootstrap) void legacyPermissions.refetch();
            }}
          >
            <RotateCcw className="size-4" />
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  if (!workspace.data) return null;

  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Link href={`/${role}/dashboard`} className="text-blue-600 hover:underline">
              Dashboard
            </Link>
            <ChevronRight className="size-3" />
            <span>{workspaceLabel}</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
            {workspaceLabel}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {role === 'team-manager'
              ? 'View and manage leads assigned to your team, including ownership and follow-up progress.'
              : 'View and manage your leads, track progress and take timely actions.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {permissions?.canCreate ? (
            <>
              <Button variant="outline" onClick={() => setBulkImportOpen(true)}>
                <FileUp className="size-4" /> Import CSV
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <UserRoundPlus className="size-4" /> Add lead
              </Button>
            </>
          ) : null}
          <Button
            variant="outline"
            onClick={() => void workspace.refetch()}
            disabled={workspace.isFetching}
          >
            <RefreshCw className={`size-4 ${workspace.isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>
      {showMyLeadsSummary ? (
        <section aria-label="My Leads summary">
          <div
            id="my-leads-summary-kpis"
            hidden={!salesLeadMetricsOpen}
            className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
          >
            {(role === 'telecaller'
              ? telecallerLeadMetricCards(workspace.data.kpis)
              : role === 'sales-consultant'
                ? salesLeadMetricCards(workspace.data.kpis)
                : managerLeadMetricCards(workspace.data.kpis)
            ).map((card) => (
              <SalesLeadMetricCard
                key={card.status}
                card={card}
                active={personalView === 'all' && query.status === card.status}
                onSelect={() => onStatusChange(card.status)}
              />
            ))}
          </div>
        </section>
      ) : null}
      <LeadStatusTabs
        data={workspace.data}
        query={query}
        role={role}
        personalView={personalView}
        onStatusChange={onStatusChange}
        onPersonalViewChange={onPersonalViewChange}
        summaryOpen={showMyLeadsSummary ? salesLeadMetricsOpen : undefined}
        onSummaryToggle={
          showMyLeadsSummary ? () => setSalesLeadMetricsOpen((open) => !open) : undefined
        }
      />
      <LeadTable
        role={role}
        data={workspace.data}
        query={query}
        personalFlags={personalFlags}
        personalView={personalView}
        personalFlagsPending={personalLeadFlagMutation.isPending}
        savedFilters={savedFilters}
        savedFiltersLoading={savedFiltersLoading}
        savedFiltersAvailable={Boolean(savedFilterStorageKey)}
        onQueryChange={onQueryChange}
        onPersonalFlagChange={onPersonalFlagChange}
        onSaveSavedFilter={saveCurrentLeadFilter}
        onRemoveSavedFilter={removeSavedLeadFilter}
        canAssign={!spec.readOnly && role === 'team-manager' && Boolean(permissions?.canAssign)}
        canUpdate={!spec.readOnly && Boolean(permissions?.canUpdate)}
        canScheduleFollowups={!spec.readOnly && Boolean(permissions?.canCreateFollowup)}
        canCreateTasks={
          !spec.readOnly &&
          Boolean(permissions?.canCreateTask) &&
          roleHasNavigationSlug(role, 'tasks')
        }
        canScheduleAppointments={
          role !== 'telecaller' && !spec.readOnly && Boolean(permissions?.canCreateAppointment)
        }
        canScheduleTestDrives={
          !spec.readOnly &&
          Boolean(permissions?.canManageTestDrive) &&
          roleHasNavigationSlug(role, 'test-drives')
        }
        canLinkCustomer={!spec.readOnly && Boolean(permissions?.canLinkCustomer)}
        canTransferToSales={
          !spec.readOnly && role === 'telecaller' && Boolean(permissions?.canUpdate)
        }
        canCancelSalesHandoff={
          !spec.readOnly && role === 'telecaller' && Boolean(permissions?.canUpdate)
        }
        canRequestDuplicateDeletion={
          !spec.readOnly &&
          (role === 'telecaller' || role === 'sales-consultant') &&
          Boolean(permissions?.canUpdate)
        }
        focusLeadId={focusLeadId}
        onFocusConsumed={clearFocusedLead}
        isFetching={workspace.isFetching}
        onAssign={setAssignmentLead}
        onEdit={(lead, preset) => setEditingLead({ lead, preset })}
        onScheduleFollowup={(lead, reason) => setFollowupShortcut({ lead, reason })}
        onScheduleAppointment={(lead, type) => setAppointmentShortcut({ lead, type })}
        onMatchCustomer={setMatchingLead}
        onSalesContact={(lead, channel) =>
          salesContactMutation.mutate({ leadId: lead.id, channel })
        }
        onIntakeContact={(lead, channel) => {
          if (lead.lifecycle_status === 'Lost' || lead.lifecycle_status === 'Transferred to Sales')
            return;
          intakeContactMutation.mutate({ leadId: lead.id, channel });
        }}
        canProviderCall={
          !spec.readOnly &&
          Boolean(workspaceSession?.organizationId) &&
          hasWorkspacePermission(workspaceSession, 'call.create')
        }
        onProviderCall={setProviderCallLead}
        onTransferToSales={setHandoffLead}
        onCancelSalesHandoff={setHandoffCancellationLead}
        onRequestDuplicateDeletion={setDuplicateDeletionLead}
        onPendingFollowup={setPendingFollowup}
      />
      {workspaceSession?.organizationId && providerCallLead ? (
        <CustomerTelecmiCallDialog
          key={providerCallLead.id}
          open
          onOpenChange={(open) => !open && setProviderCallLead(null)}
          organizationId={workspaceSession.organizationId}
          customerId={providerCallLead.customer_id ?? ''}
          leadId={providerCallLead.id}
          customerName={providerCallLead.customer_name}
          customerPhone={providerCallLead.phone}
          onStarted={() => {
            // A dealership call is a contact attempt exactly like the handset
            // dialer, so it advances the lead through the same workflow.
            const lead = providerCallLead;
            if (role === 'telecaller') {
              if (
                lead.lifecycle_status !== 'Lost' &&
                lead.lifecycle_status !== 'Transferred to Sales'
              )
                intakeContactMutation.mutate({ leadId: lead.id, channel: 'CALL' });
            } else {
              salesContactMutation.mutate({ leadId: lead.id, channel: 'CALL' });
            }
            void queryClient.invalidateQueries({ queryKey: ['lead-activity'] });
          }}
        />
      ) : null}
      <PendingFollowupDialog
        request={pendingFollowup}
        onOpenChange={(open) => !open && setPendingFollowup(null)}
        onResolved={(resume) => {
          setPendingFollowup(null);
          void invalidate();
          resume();
        }}
      />
      {permissions?.canCreate && (
        <>
          <LeadCreateDialog
            organizationId={permissions.organizationId}
            open={createDialogOpen}
            onOpenChange={(open) => (open ? setCreateOpen(true) : closeCreateDialog())}
            onCreated={invalidate}
          />
          {role === 'telecaller' ? (
            <LeadBulkImportDialog
              organizationId={permissions.organizationId}
              open={bulkImportOpen}
              onOpenChange={setBulkImportOpen}
              onImported={invalidate}
            />
          ) : (
            <LeadBulkImportDialog
              organizationId={permissions.organizationId}
              open={bulkImportOpen}
              onOpenChange={setBulkImportOpen}
              onImported={invalidate}
            />
          )}
        </>
      )}
      <SalesHandoffDialog
        key={`handoff-${handoffLead?.id ?? 'none'}`}
        lead={handoffLead}
        open={Boolean(handoffLead)}
        onOpenChange={(open) => !open && setHandoffLead(null)}
        onTransferred={() => {
          setHandoffLead(null);
          void invalidate();
        }}
      />
      <SalesHandoffCancellationDialog
        key={`handoff-cancellation-${handoffCancellationLead?.id ?? 'none'}`}
        lead={handoffCancellationLead}
        open={Boolean(handoffCancellationLead)}
        onOpenChange={(open) => !open && setHandoffCancellationLead(null)}
        onCancelled={() => {
          setHandoffCancellationLead(null);
          void invalidate();
        }}
      />
      <LeadAssignmentDialog
        key={`assignment-${assignmentLead?.id ?? 'none'}`}
        lead={assignmentLead}
        open={Boolean(assignmentLead)}
        onOpenChange={(open) => !open && setAssignmentLead(null)}
        onAssigned={invalidate}
      />
      <LeadEditDialog
        key={`edit-${editingLead?.lead.id ?? 'none'}-${editingLead?.preset?.lifecycleStatus ?? 'none'}-${editingLead?.preset?.temperature ?? 'none'}`}
        lead={editingLead?.lead ?? null}
        role={role}
        preset={editingLead?.preset}
        open={Boolean(editingLead)}
        onOpenChange={(open) => !open && setEditingLead(null)}
        onUpdated={invalidate}
      />
      <WorkCreateDialog
        key={`lead-followup-${followupShortcut?.lead.id ?? 'none'}-${followupShortcut?.reason ?? 'none'}`}
        kind="followups"
        open={Boolean(followupShortcut)}
        onOpenChange={(open) => !open && setFollowupShortcut(null)}
        initialFollowupReason={followupShortcut?.reason}
        lockInitialEntity
        initialEntity={
          followupShortcut
            ? {
                leadId: followupShortcut.lead.id,
                customerId: followupShortcut.lead.customer_id,
                branchId: followupShortcut.lead.branch_id,
                teamId: followupShortcut.lead.team_id,
                assignedUserId: followupShortcut.lead.assigned_user_id,
                assignedUserName: followupShortcut.lead.assigned_user_name,
                customerName: followupShortcut.lead.customer_name,
                phone: followupShortcut.lead.phone,
                interestedModel: followupShortcut.lead.interested_model,
                search: followupShortcut.lead.phone,
                label: `${followupShortcut.lead.customer_name} · ${followupShortcut.lead.phone}`,
              }
            : undefined
        }
        onCreated={async () => {
          if (role === 'sales-consultant' && followupShortcut)
            salesContactMutation.mutate({
              leadId: followupShortcut.lead.id,
              channel: 'FOLLOWUP',
            });
          await invalidate();
        }}
      />
      <WorkCreateDialog
        key={`lead-appointment-${appointmentShortcut?.lead.id ?? 'none'}-${appointmentShortcut?.type ?? 'none'}`}
        kind="appointments"
        open={Boolean(appointmentShortcut)}
        onOpenChange={(open) => !open && setAppointmentShortcut(null)}
        initialAppointmentType={appointmentShortcut?.type}
        lockInitialEntity
        initialEntity={
          appointmentShortcut
            ? {
                leadId: appointmentShortcut.lead.id,
                customerId: appointmentShortcut.lead.customer_id,
                branchId: appointmentShortcut.lead.branch_id,
                teamId: appointmentShortcut.lead.team_id,
                assignedUserId: appointmentShortcut.lead.assigned_user_id,
                assignedUserName: appointmentShortcut.lead.assigned_user_name,
                customerName: appointmentShortcut.lead.customer_name,
                phone: appointmentShortcut.lead.phone,
                interestedModel: appointmentShortcut.lead.interested_model,
                search: appointmentShortcut.lead.phone,
                label: `${appointmentShortcut.lead.customer_name} · ${appointmentShortcut.lead.phone}`,
              }
            : undefined
        }
        onCreated={async () => {
          if (role === 'sales-consultant' && appointmentShortcut)
            salesContactMutation.mutate({
              leadId: appointmentShortcut.lead.id,
              channel: 'APPOINTMENT',
            });
          await invalidate();
        }}
      />
      <CustomerMatchDialog
        key={`customer-match-${matchingLead?.id ?? 'none'}`}
        lead={matchingLead as MatchableLead | null}
        open={Boolean(matchingLead)}
        canCreate={Boolean(permissions?.canCreateCustomer)}
        onOpenChange={(open) => !open && setMatchingLead(null)}
        onResolved={(customerId) => {
          void invalidate();
          void queryClient.invalidateQueries({
            queryKey: ['customer-workspace', ...queryScope],
          });
          router.push(`/${role}/customers/${customerId}`);
        }}
      />
      <DuplicateLeadDeletionRequestDialog
        key={`duplicate-delete-${duplicateDeletionLead?.id ?? 'none'}`}
        lead={duplicateDeletionLead}
        open={Boolean(duplicateDeletionLead)}
        onOpenChange={(open) => !open && setDuplicateDeletionLead(null)}
      />
    </div>
  );
}
