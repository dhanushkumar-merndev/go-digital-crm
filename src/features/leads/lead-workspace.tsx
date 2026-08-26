'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Pin,
  Phone,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  TriangleAlert,
  UserRoundCheck,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { replaceQueryString } from '@/lib/navigation/replace-query-string';
import { useCallback, useMemo, useState } from 'react';
import { LeadWorkspaceSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import { useSalesConsultantCache } from '@/features/sales-consultant/sales-consultant-cache';
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
import { roleHasNavigationSlug } from '@/config/navigation';
import type { PageSpec } from '@/lib/domain';
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import { cn } from '@/lib/utils';
import {
  CustomerMatchDialog,
  type MatchableLead,
} from '@/features/customers/customer-match-dialog';
import {
  WorkCreateDialog,
  appointmentTypes,
  followupReasons,
  type AppointmentType,
  type FollowupReason,
} from '@/features/work/workspace-dialogs';
import {
  assignLead,
  createLead,
  fetchAssignableUsers,
  fetchLeadCreateOptions,
  fetchLeadWorkspaceMeta,
  fetchLeadWorkspaceRecords,
  toLeadMetaQuery,
  fetchLeadWorkspacePermissions,
  fetchPersonalLeadFlags,
  recordSalesLeadContact,
  setPersonalLeadPreference,
  updateLead,
  type PersonalLeadFlag,
  type PersonalLeadFlags,
  type LeadRecord,
  type LeadWorkspaceResult,
  type LeadWorkspacePermissions,
} from './lead-workspace-api';
import {
  getDefaultLeadStatus,
  isLeadVersionConflict,
  parseLeadQuery,
  toLeadQueryString,
  type LeadQuery,
  type LeadStageFilter,
  type LeadStatusFilter,
  type LeadTemperatureFilter,
} from './lead-workspace-query';

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

const temperatureOptions = ['COLD', 'WARM', 'HOT'] as const;

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
  temperature?: 'COLD' | 'WARM' | 'HOT';
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

function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return phone;
  return `${digits.slice(0, 4)}****${digits.slice(-2)}`;
}

function formatLeadAge(createdAt: string) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 3_600_000));
  const days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : `${hours}h`;
}

function StageBadge({ value }: { value: string }) {
  const variant =
    value === 'New'
      ? 'info'
      : value === 'Contacted' || value === 'Booking'
        ? 'success'
        : value === 'Follow-up' || value === 'Quotation'
          ? 'warning'
          : value === 'Test Drive'
            ? 'default'
            : 'secondary';
  return (
    <Badge variant={variant} className="rounded px-2 py-0 text-[10px]">
      {value}
    </Badge>
  );
}

function TemperatureBadge({ value }: { value: LeadRecord['temperature'] }) {
  const variant = value === 'HOT' ? 'destructive' : value === 'WARM' ? 'warning' : 'info';
  return (
    <Badge variant={variant} className="rounded px-2 py-0 text-[10px]">
      {value ?? 'COLD'}
    </Badge>
  );
}

function LeadStatusTabs({
  data,
  query,
  role,
  personalFlags,
  personalView,
  onStatusChange,
  onPersonalViewChange,
}: {
  data: LeadWorkspaceResult;
  query: LeadQuery;
  role: string;
  personalFlags: PersonalLeadFlags;
  personalView: PersonalLeadView;
  onStatusChange: (status: LeadStatusFilter) => void;
  onPersonalViewChange: (view: PersonalLeadView) => void;
}) {
  const generalTabs: Array<{ label: string; value: LeadStatusFilter; count: number }> = [
    { label: 'All', value: 'all', count: data.kpis.total },
    { label: 'New', value: 'new', count: data.kpis.new_count },
    { label: 'Contacted', value: 'contacted', count: data.kpis.contacted_count },
    { label: 'Follow-up', value: 'follow-up', count: data.kpis.follow_up },
    { label: 'Hot', value: 'hot', count: data.kpis.hot },
    { label: 'Warm', value: 'warm', count: data.kpis.warm },
    { label: 'Cold', value: 'cold', count: data.kpis.cold },
    { label: 'Lost', value: 'lost', count: data.kpis.lost_count },
  ];
  const salesConsultantTabs: Array<{ label: string; value: LeadStatusFilter; count: number }> = [
    { label: 'Leads', value: 'all', count: data.kpis.total },
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
  const tabs = role === 'sales-consultant' ? salesConsultantTabs : generalTabs;
  const starredCount = Object.values(personalFlags).filter((flag) => flag.starred).length;

  return (
    <div
      role="tablist"
      aria-label="Lead quick views"
      className="flex h-10 gap-2 overflow-x-auto border-b"
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
        [{ label: 'Starred', value: 'starred' as const, count: starredCount, icon: Star }] as const
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
  const mutation = useMutation({
    mutationFn: createLead,
    onSuccess: () => {
      onOpenChange(false);
      onCreated();
    },
  });
  const selectedBranchId = branchId || options.data?.branches[0]?.id || '';
  const teams = options.data?.teams.filter((team) => team.branch_id === selectedBranchId) ?? [];

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
              teamId: teamId === 'none' ? null : teamId,
              source,
              customerName: String(form.get('customerName') ?? ''),
              phone: String(form.get('phone') ?? ''),
              email: String(form.get('email') ?? ''),
              sourceDetail: String(form.get('sourceDetail') ?? ''),
              campaign: String(form.get('campaign') ?? ''),
              interestedModel: String(form.get('interestedModel') ?? ''),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Customer name
            <Input name="customerName" required minLength={2} maxLength={160} autoComplete="name" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Phone
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
            Email <span className="font-normal text-muted-foreground">(optional)</span>
            <Input name="email" type="email" maxLength={320} autoComplete="email" />
          </label>
          <div className="grid gap-1.5 text-sm font-medium">
            Source
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
          <div className="grid gap-1.5 text-sm font-medium">
            Branch
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
          <div className="grid gap-1.5 text-sm font-medium">
            Team <span className="font-normal text-muted-foreground">(optional)</span>
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
          <label className="grid gap-1.5 text-sm font-medium">
            Interested model <span className="font-normal text-muted-foreground">(optional)</span>
            <Input name="interestedModel" maxLength={160} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Source detail <span className="font-normal text-muted-foreground">(optional)</span>
            <Input name="sourceDetail" maxLength={200} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Campaign <span className="font-normal text-muted-foreground">(optional)</span>
            <Input name="campaign" maxLength={200} />
          </label>
          {options.isError && (
            <p className="text-sm text-destructive">
              Branch options could not be loaded for your current scope.
            </p>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              The lead could not be created. Check the permitted branch and required fields, then
              try again.
            </p>
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

function LeadTable({
  role,
  data,
  query,
  personalFlags,
  personalView,
  personalFlagsPending,
  onQueryChange,
  onPersonalFlagChange,
  canAssign,
  canUpdate,
  canScheduleFollowups,
  canScheduleAppointments,
  canScheduleTestDrives,
  canLinkCustomer,
  isFetching,
  onAssign,
  onEdit,
  onScheduleFollowup,
  onScheduleAppointment,
  onMatchCustomer,
  onSalesContact,
}: {
  role: string;
  data: LeadWorkspaceResult;
  query: LeadQuery;
  personalFlags: PersonalLeadFlags;
  personalView: PersonalLeadView;
  personalFlagsPending: boolean;
  onQueryChange: (next: Partial<LeadQuery>) => void;
  onPersonalFlagChange: (leadId: string, flag: PersonalLeadToggle, active: boolean) => void;
  canAssign: boolean;
  canUpdate: boolean;
  canScheduleFollowups: boolean;
  canScheduleAppointments: boolean;
  canScheduleTestDrives: boolean;
  canLinkCustomer: boolean;
  isFetching: boolean;
  onAssign: (lead: LeadRecord) => void;
  onEdit: (lead: LeadRecord, preset?: LeadEditPreset) => void;
  onScheduleFollowup: (lead: LeadRecord, reason: FollowupReason) => void;
  onScheduleAppointment: (lead: LeadRecord, type: AppointmentType) => void;
  onMatchCustomer: (lead: LeadRecord) => void;
  onSalesContact: (lead: LeadRecord, channel: 'CALL' | 'WHATSAPP') => void;
}) {
  const isManagerView = ['team-manager', 'showroom-manager', 'gm-sales'].includes(role);
  const showLeadStageFilter = role !== 'sales-consultant';
  const leadStageOptions =
    role === 'sales-consultant'
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
  const canOpenFollowups = roleHasNavigationSlug(role, 'follow-ups');
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [draftFollowupFrom, setDraftFollowupFrom] = useState('');
  const [draftFollowupTo, setDraftFollowupTo] = useState('');
  const visibleRecords = useMemo(() => {
    const matchingRecords =
      personalView === 'all'
        ? data.records
        : data.records.filter((lead) => personalFlags[lead.id]?.starred === true);

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
  }, [data.records, personalFlags, personalView]);
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
        header: 'Lead ID',
        cell: ({ row }) => (
          <Link
            href={`/${role}/leads/${row.original.id}`}
            className="font-medium text-muted-foreground hover:text-primary hover:underline"
          >
            L-{shortId(row.original.id)}
          </Link>
        ),
      },
      {
        accessorKey: 'customer_name',
        header: 'Customer',
        cell: ({ row }) => (
          <Link
            href={`/${role}/leads/${row.original.id}`}
            className="font-semibold text-foreground hover:text-primary hover:underline"
          >
            {row.original.customer_name}
          </Link>
        ),
      },
      ...(isManagerView
        ? [
            {
              id: 'assigned_consultant',
              header: 'Consultant',
              cell: ({ row }: { row: { original: LeadRecord } }) => (
                <span className="whitespace-nowrap font-medium">
                  {row.original.assigned_user_name ?? 'Unassigned'}
                </span>
              ),
            } satisfies ColumnDef<LeadRecord>,
          ]
        : []),
      {
        accessorKey: 'phone',
        header: 'Mobile',
        cell: ({ getValue }) => (
          <span className="font-medium text-[#263550]">{maskPhone(String(getValue()))}</span>
        ),
      },
      {
        accessorKey: 'interested_model',
        header: 'Model',
        cell: ({ getValue }) => String(getValue() ?? '—'),
      },
      { accessorKey: 'source', header: 'Source' },
      {
        accessorKey: 'lead_stage',
        header: 'Lead stage',
        cell: ({ getValue }) => <StageBadge value={String(getValue())} />,
      },
      {
        accessorKey: 'temperature',
        header: 'Temperature',
        cell: ({ row }) =>
          canUpdate ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-6 px-0 hover:bg-transparent"
                  aria-label={`Change temperature for ${row.original.customer_name}`}
                >
                  <TemperatureBadge value={row.original.temperature} />
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
          ) : (
            <TemperatureBadge value={row.original.temperature} />
          ),
      },
      {
        accessorKey: 'updated_at',
        header: 'Last activity',
        cell: ({ getValue }) => <span>{formatCompactDate(String(getValue()))}</span>,
      },
      {
        accessorKey: 'next_followup_at',
        header: 'Next follow-up',
        cell: ({ row }) => <span>{formatCompactDate(row.original.next_followup_at)}</span>,
      },
      {
        accessorKey: 'created_at',
        header: 'Lead age',
        cell: ({ getValue }) => <span>{formatLeadAge(String(getValue()))}</span>,
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <Button asChild variant="ghost" size="icon" className="size-7 text-emerald-600">
              <a
                href={`tel:${row.original.phone}`}
                aria-label={`Call ${row.original.customer_name}`}
                onClick={() => {
                  if (role === 'sales-consultant') onSalesContact(row.original, 'CALL');
                }}
              >
                <Phone className="size-3.5" />
              </a>
            </Button>
            <Button asChild variant="ghost" size="icon" className="size-7 text-emerald-600">
              <a
                href={toWhatsAppClickToChatUrl(row.original.phone)}
                target="_blank"
                rel="noreferrer"
                aria-label={`WhatsApp ${row.original.customer_name}`}
                title={`WhatsApp ${row.original.customer_name}`}
                onClick={() => {
                  if (role === 'sales-consultant') onSalesContact(row.original, 'WHATSAPP');
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
                      onSelect={() => onScheduleFollowup(row.original, reason)}
                    >
                      <CalendarDays className="size-4" /> {reason}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : canOpenFollowups ? (
              <Button asChild variant="ghost" size="icon" className="size-7 text-blue-600">
                <Link
                  href={`/${role}/follow-ups?q=${encodeURIComponent(row.original.phone)}`}
                  aria-label={`Open follow-ups for ${row.original.customer_name}`}
                  title={`Open follow-ups for ${row.original.customer_name}`}
                >
                  <CalendarDays className="size-3.5" />
                </Link>
              </Button>
            ) : null}
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
                        onSelect={() => onScheduleAppointment(row.original, type)}
                      >
                        <CalendarDays className="size-4" /> {type}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
                {row.original.customer_id && canScheduleTestDrives && (
                  <>
                    {(canUpdate || canScheduleAppointments) && <DropdownMenuSeparator />}
                    <DropdownMenuItem asChild>
                      <Link
                        href={`/${role}/test-drives?action=create&lead=${encodeURIComponent(row.original.id)}&q=${encodeURIComponent(row.original.phone)}`}
                      >
                        <CalendarDays className="size-4" /> Schedule test drive
                      </Link>
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
                    <DropdownMenuItem asChild>
                      <Link
                        href={`/${role}/quotations?action=create&lead=${encodeURIComponent(row.original.id)}`}
                      >
                        Create quotation
                      </Link>
                    </DropdownMenuItem>
                  </>
                )}
                {roleHasNavigationSlug(role, 'bookings') && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link
                        href={`/${role}/bookings?action=create&lead=${encodeURIComponent(row.original.id)}`}
                      >
                        Create booking
                      </Link>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [
      canAssign,
      canOpenFollowups,
      canScheduleFollowups,
      canScheduleAppointments,
      canScheduleTestDrives,
      canUpdate,
      isManagerView,
      onEdit,
      onScheduleFollowup,
      onScheduleAppointment,
      onSalesContact,
      onPersonalFlagChange,
      personalFlagsPending,
      role,
      personalFlags,
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
    rowCount: personalView === 'all' ? data.total : visibleRecords.length,
  });
  const pages = Math.max(
    1,
    Math.ceil((personalView === 'all' ? data.total : visibleRecords.length) / query.pageSize),
  );
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

  return (
    <Card className="overflow-hidden border-slate-200 shadow-none">
      <CardHeader className="space-y-0 p-0">
        <div className="overflow-x-auto bg-white px-3 py-3 sm:px-4">
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
                  {data.filters.sources.map((source) => (
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-8 w-full whitespace-nowrap px-2 text-[10px]">
                  <SlidersHorizontal className="size-3.5" /> Saved Filters
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem disabled>No saved filters yet</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!hasFilters}
                  onSelect={() =>
                    onQueryChange({
                      search: '',
                      model: '',
                      source: '',
                      stage: 'all',
                      temperature: 'all',
                      followupFrom: '',
                      followupTo: '',
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
              ? 'overflow-x-auto opacity-65 transition-opacity'
              : 'overflow-x-auto transition-opacity'
          }
        >
          <Table className="min-w-[1220px]">
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
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} className="hover:bg-slate-50/70">
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className="whitespace-nowrap px-4 py-3 text-xs text-[#263550]"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
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
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm lg:flex-row lg:items-center lg:justify-between">
          <p className="text-xs text-[#526079]">
            {personalView === 'all' ? (
              <>
                Showing {data.total ? (query.page - 1) * query.pageSize + 1 : 0} to{' '}
                {Math.min(query.page * query.pageSize, data.total)} of {data.total} leads
              </>
            ) : (
              <>
                Showing {visibleRecords.length} {personalView} lead
                {visibleRecords.length === 1 ? '' : 's'} on this page
              </>
            )}
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
                value={draftFollowupTo}
                min={draftFollowupFrom || undefined}
                onChange={(event) => setDraftFollowupTo(event.target.value)}
              />
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
        canCreateAppointment: hasWorkspacePermission(workspaceSession, 'appointment.create'),
        canManageTestDrive: hasWorkspacePermission(workspaceSession, 'test_drive.manage'),
        canCreateCustomer: hasWorkspacePermission(workspaceSession, 'customer.create'),
        canLinkCustomer: hasWorkspacePermission(workspaceSession, 'customer.link'),
      }
    : undefined;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
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
  const [personalView, setPersonalView] = useState<PersonalLeadView>(() =>
    parsePersonalLeadView(searchParams),
  );
  const [createOpen, setCreateOpen] = useState(() => searchParams.get('action') === 'create');
  const [assignmentLead, setAssignmentLead] = useState<LeadRecord | null>(null);
  const [editingLead, setEditingLead] = useState<LeadEditRequest | null>(null);
  const [followupShortcut, setFollowupShortcut] = useState<FollowupShortcut | null>(null);
  const [appointmentShortcut, setAppointmentShortcut] = useState<AppointmentShortcut | null>(null);
  const [matchingLead, setMatchingLead] = useState<LeadRecord | null>(null);
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
  const personalLeadPreferences = useQuery({
    queryKey: personalPreferenceKey,
    queryFn: ({ signal }) => fetchPersonalLeadFlags(signal),
    enabled: Boolean(workspaceSession?.organizationId && workspaceSession.userId),
    staleTime: 60_000,
  });
  const personalFlags = personalLeadPreferences.data ?? emptyPersonalLeadFlags;
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
    onError: (_error, _variables, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData<PersonalLeadFlags>(personalPreferenceKey, context.snapshot);
      }
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
  const onQueryChange = (next: Partial<LeadQuery>) => {
    const updated = { ...query, ...next };
    setQuery(updated);
    replaceLeadWorkspaceUrl(updated);
  };
  const onStatusChange = (status: LeadStatusFilter) => {
    const updated = { ...query, status, page: 1 };
    setQuery(updated);
    setPersonalView('all');
    replaceLeadWorkspaceUrl(updated, 'all');
  };
  const onPersonalViewChange = (view: PersonalLeadView) => {
    const updated = view === 'all' ? query : { ...query, status: 'all' as const, page: 1 };
    if (view !== 'all') setQuery(updated);
    setPersonalView(view);
    replaceLeadWorkspaceUrl(updated, view);
  };
  const onPersonalFlagChange = (leadId: string, flag: PersonalLeadToggle, active: boolean) => {
    if (!workspaceSession?.organizationId || !workspaceSession.userId) return;
    personalLeadFlagMutation.mutate({ leadId, flag, active });
  };
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['lead-workspace', ...queryScope] }),
    [queryClient, queryScope],
  );
  const salesContactMutation = useMutation({
    mutationFn: recordSalesLeadContact,
    onSuccess: (_result, input) => {
      salesConsultantCache.invalidate('lead.updated', { leadId: input.leadId });
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
        <Button
          variant="outline"
          className="shrink-0"
          onClick={() => void workspace.refetch()}
          disabled={workspace.isFetching}
        >
          <RefreshCw className={`size-4 ${workspace.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      {(personalLeadFlagMutation.isError || personalLeadPreferences.isError) && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <TriangleAlert className="size-4 shrink-0" />
          Could not save your pin and star list. They are personal to you and no lead data was
          changed. Refresh and try again.
        </p>
      )}
      <LeadStatusTabs
        data={workspace.data}
        query={query}
        role={role}
        personalFlags={personalFlags}
        personalView={personalView}
        onStatusChange={onStatusChange}
        onPersonalViewChange={onPersonalViewChange}
      />
      <LeadTable
        role={role}
        data={workspace.data}
        query={query}
        personalFlags={personalFlags}
        personalView={personalView}
        personalFlagsPending={personalLeadFlagMutation.isPending}
        onQueryChange={onQueryChange}
        onPersonalFlagChange={onPersonalFlagChange}
        canAssign={!spec.readOnly && role === 'team-manager' && Boolean(permissions?.canAssign)}
        canUpdate={!spec.readOnly && Boolean(permissions?.canUpdate)}
        canScheduleFollowups={!spec.readOnly && Boolean(permissions?.canCreateFollowup)}
        canScheduleAppointments={!spec.readOnly && Boolean(permissions?.canCreateAppointment)}
        canScheduleTestDrives={
          !spec.readOnly &&
          Boolean(permissions?.canManageTestDrive) &&
          roleHasNavigationSlug(role, 'test-drives')
        }
        canLinkCustomer={!spec.readOnly && Boolean(permissions?.canLinkCustomer)}
        isFetching={workspace.isFetching}
        onAssign={setAssignmentLead}
        onEdit={(lead, preset) => setEditingLead({ lead, preset })}
        onScheduleFollowup={(lead, reason) => setFollowupShortcut({ lead, reason })}
        onScheduleAppointment={(lead, type) => setAppointmentShortcut({ lead, type })}
        onMatchCustomer={setMatchingLead}
        onSalesContact={(lead, channel) =>
          salesContactMutation.mutate({ leadId: lead.id, channel })
        }
      />
      {permissions?.canCreate && (
        <LeadCreateDialog
          organizationId={permissions.organizationId}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={invalidate}
        />
      )}
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
        onCreated={invalidate}
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
        onCreated={invalidate}
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
    </div>
  );
}
