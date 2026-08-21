'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Link2,
  MoreVertical,
  Pencil,
  Phone,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  UserRoundCheck,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
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
import type { PageSpec } from '@/lib/domain';
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import {
  CustomerMatchDialog,
  type MatchableLead,
} from '@/features/customers/customer-match-dialog';
import {
  assignLead,
  createLead,
  fetchAssignableUsers,
  fetchLeadCreateOptions,
  fetchLeadWorkspace,
  fetchLeadWorkspacePermissions,
  updateLead,
  type LeadRecord,
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
  onQueryChange,
}: {
  data: Awaited<ReturnType<typeof fetchLeadWorkspace>>;
  query: LeadQuery;
  onQueryChange: (next: Partial<LeadQuery>) => void;
}) {
  const tabs: Array<{ label: string; value: LeadStatusFilter; count: number }> = [
    { label: 'All', value: 'all', count: data.kpis.total },
    { label: 'New', value: 'new', count: data.kpis.new_count },
    { label: 'Contacted', value: 'contacted', count: data.kpis.contacted_count },
    { label: 'Follow-up', value: 'follow-up', count: data.kpis.follow_up },
    { label: 'Hot', value: 'hot', count: data.kpis.hot },
    { label: 'Warm', value: 'warm', count: data.kpis.warm },
    { label: 'Cold', value: 'cold', count: data.kpis.cold },
    { label: 'Lost', value: 'lost', count: data.kpis.lost_count },
  ];

  return (
    <div
      role="tablist"
      aria-label="Lead quick views"
      className="flex h-10 gap-2 overflow-x-auto border-b"
    >
      {tabs.map((tab) => {
        const active = query.status === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onQueryChange({ status: tab.value, page: 1 })}
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
  const options = useQuery({
    queryKey: ['lead-create-options', organizationId],
    queryFn: fetchLeadCreateOptions,
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
  const users = useQuery({
    queryKey: ['lead-assignable-users'],
    queryFn: fetchAssignableUsers,
    enabled: open,
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
          <DialogTitle>{lead?.assigned_user_id ? 'Reassign lead' : 'Assign lead'}</DialogTitle>
          <DialogDescription>
            {lead
              ? `${lead.customer_name} · ${shortId(lead.id)}`
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
            Assignee
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
              The assignment could not be completed. The selected user must be active and eligible
              for this lead’s team.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!userId || mutation.isPending}>
              {mutation.isPending
                ? 'Saving…'
                : lead?.assigned_user_id
                  ? 'Reassign lead'
                  : 'Assign lead'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LeadEditDialog({
  lead,
  open,
  onOpenChange,
  onUpdated,
}: {
  lead: LeadRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  const [lifecycleStatus, setLifecycleStatus] = useState(() => lead?.lifecycle_status ?? 'New');
  const [temperature, setTemperature] = useState(() => lead?.temperature ?? 'none');
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
  const lifecycleChanged = lifecycleStatus !== lead.lifecycle_status;
  const temperatureChanged = temperature !== (lead.temperature ?? 'none');
  const hasChanges = lifecycleChanged || temperatureChanged;
  const isLost = lifecycleStatus === 'Lost';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update lead</DialogTitle>
          <DialogDescription>
            {lead.customer_name} · {shortId(lead.id)}. Lifecycle and temperature changes are
            recorded in lead history.
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
          <div className="grid gap-1.5 text-sm font-medium">
            Lifecycle
            <Select value={lifecycleStatus} onValueChange={setLifecycleStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {lifecycleOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 text-sm font-medium">
            Temperature
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
          </div>
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
              {mutation.isPending ? 'Saving…' : 'Save changes'}
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
  onQueryChange,
  canAssign,
  canUpdate,
  canLinkCustomer,
  isFetching,
  onAssign,
  onEdit,
  onMatchCustomer,
}: {
  role: string;
  data: Awaited<ReturnType<typeof fetchLeadWorkspace>>;
  query: LeadQuery;
  onQueryChange: (next: Partial<LeadQuery>) => void;
  canAssign: boolean;
  canUpdate: boolean;
  canLinkCustomer: boolean;
  isFetching: boolean;
  onAssign: (lead: LeadRecord) => void;
  onEdit: (lead: LeadRecord) => void;
  onMatchCustomer: (lead: LeadRecord) => void;
}) {
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [draftFollowupFrom, setDraftFollowupFrom] = useState('');
  const [draftFollowupTo, setDraftFollowupTo] = useState('');
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
        accessorKey: 'customer_name',
        header: 'Customer',
        cell: ({ row }) =>
          row.original.customer_id ? (
            <Link
              href={`/${role}/customers/${row.original.customer_id}`}
              className="font-semibold text-foreground hover:text-primary hover:underline"
            >
              {row.original.customer_name}
            </Link>
          ) : (
            <span>{row.original.customer_name}</span>
          ),
      },
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
        cell: ({ row }) => <TemperatureBadge value={row.original.temperature} />,
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
              >
                <WhatsAppIcon className="size-4" />
              </a>
            </Button>
            <Button asChild variant="ghost" size="icon" className="size-7 text-blue-600">
              <Link
                href={`/${role}/follow-ups?q=${encodeURIComponent(row.original.phone)}`}
                aria-label={`Open follow-ups for ${row.original.customer_name}`}
                title={`Open follow-ups for ${row.original.customer_name}`}
              >
                <CalendarDays className="size-3.5" />
              </Link>
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
              <DropdownMenuContent align="end">
                {row.original.customer_id ? (
                  <DropdownMenuItem asChild>
                    <Link href={`/${role}/customers/${row.original.customer_id}`}>
                      <Link2 className="size-4" /> Customer 360
                    </Link>
                  </DropdownMenuItem>
                ) : canLinkCustomer ? (
                  <DropdownMenuItem onSelect={() => onMatchCustomer(row.original)}>
                    <Link2 className="size-4" /> Review customer
                  </DropdownMenuItem>
                ) : null}
                {(canUpdate || canAssign) && <DropdownMenuSeparator />}
                {canUpdate && (
                  <DropdownMenuItem onSelect={() => onEdit(row.original)}>
                    <Pencil className="size-4" /> Update lead
                  </DropdownMenuItem>
                )}
                {canAssign && (
                  <DropdownMenuItem onSelect={() => onAssign(row.original)}>
                    <UserRoundCheck className="size-4" />
                    {row.original.assigned_user_id ? 'Reassign lead' : 'Assign lead'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [canAssign, canLinkCustomer, canUpdate, onAssign, onEdit, onMatchCustomer, role],
  );
  // TanStack Table returns an imperative model; React Compiler intentionally skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: data.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: data.total,
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

  return (
    <Card className="overflow-hidden border-slate-200 shadow-none">
      <CardHeader className="space-y-0 p-0">
        <div className="overflow-x-auto bg-white px-3 py-3 sm:px-4">
          <div className="grid min-w-[1100px] grid-cols-[1.45fr_.85fr_.8fr_.95fr_.9fr_1.25fr_108px] items-end gap-2.5">
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
                  {['all', ...lifecycleOptions, 'Test Drive', 'Quotation', 'Booking'].map(
                    (stage) => (
                      <SelectItem key={stage} value={stage}>
                        {stage === 'all' ? 'All lead stages' : stage}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </label>
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
            Showing {data.total ? (query.page - 1) * query.pageSize + 1 : 0} to{' '}
            {Math.min(query.page * query.pageSize, data.total)} of {data.total} leads
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fallbackStatus = getDefaultLeadStatus(slug);
  const [query, setQuery] = useState<LeadQuery>(() => parseLeadQuery(searchParams, fallbackStatus));
  const [createOpen, setCreateOpen] = useState(() => searchParams.get('action') === 'create');
  const [assignmentLead, setAssignmentLead] = useState<LeadRecord | null>(null);
  const [editingLead, setEditingLead] = useState<LeadRecord | null>(null);
  const [matchingLead, setMatchingLead] = useState<LeadRecord | null>(null);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: ['lead-workspace', requestQuery],
    queryFn: () => fetchLeadWorkspace(requestQuery),
    placeholderData: keepPreviousData,
  });
  const permissions = useQuery({
    queryKey: ['lead-workspace-permissions'],
    queryFn: fetchLeadWorkspacePermissions,
    staleTime: 60_000,
  });

  const onQueryChange = useCallback(
    (next: Partial<LeadQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toLeadQueryString(updated);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['lead-workspace'] }),
    [queryClient],
  );

  if (workspace.isPending) return <PageSkeleton />;
  if (workspace.isError || permissions.isError)
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
              void permissions.refetch();
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
            <span>My Leads</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#12213f] md:text-[28px]">
            My Leads
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            View and manage your leads, track progress and take timely actions.
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
      <LeadStatusTabs data={workspace.data} query={query} onQueryChange={onQueryChange} />
      <LeadTable
        role={role}
        data={workspace.data}
        query={query}
        onQueryChange={onQueryChange}
        canAssign={!spec.readOnly && Boolean(permissions.data?.canAssign)}
        canUpdate={!spec.readOnly && Boolean(permissions.data?.canUpdate)}
        canLinkCustomer={!spec.readOnly && Boolean(permissions.data?.canLinkCustomer)}
        isFetching={workspace.isFetching}
        onAssign={setAssignmentLead}
        onEdit={setEditingLead}
        onMatchCustomer={setMatchingLead}
      />
      {permissions.data?.canCreate && (
        <LeadCreateDialog
          organizationId={permissions.data.organizationId}
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
        key={`edit-${editingLead?.id ?? 'none'}`}
        lead={editingLead}
        open={Boolean(editingLead)}
        onOpenChange={(open) => !open && setEditingLead(null)}
        onUpdated={invalidate}
      />
      <CustomerMatchDialog
        key={`customer-match-${matchingLead?.id ?? 'none'}`}
        lead={matchingLead as MatchableLead | null}
        open={Boolean(matchingLead)}
        canCreate={Boolean(permissions.data?.canCreateCustomer)}
        onOpenChange={(open) => !open && setMatchingLead(null)}
        onResolved={(customerId) => {
          void invalidate();
          void queryClient.invalidateQueries({ queryKey: ['customer-workspace'] });
          router.push(`/${role}/customers/${customerId}`);
        }}
      />
    </div>
  );
}
