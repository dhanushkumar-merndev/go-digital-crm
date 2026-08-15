'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronLeft,
  ChevronRight,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
  UserRoundCheck,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import type { Metric, PageSpec } from '@/lib/domain';
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
  type LeadStatusFilter,
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

const statusOptions: Array<{ value: LeadStatusFilter; label: string }> = [
  { value: 'all', label: 'All leads' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'appointment-scheduled', label: 'Appointment scheduled' },
  { value: 'transferred-to-sales', label: 'Transferred to sales' },
  { value: 'lost', label: 'Lost' },
  { value: 'new-today', label: 'New today' },
  { value: 'pending', label: 'Pending' },
  { value: 'sla-risk', label: 'SLA risk' },
];

const lifecycleOptions = [
  'New',
  'Contacted',
  'Qualified',
  'Appointment Scheduled',
  'Transferred to Sales',
  'Lost',
] as const;

const temperatureOptions = ['COLD', 'WARM', 'HOT'] as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase();
}

function toMetrics(kpis: Awaited<ReturnType<typeof fetchLeadWorkspace>>['kpis']): Metric[] {
  return [
    { label: 'New today', value: kpis.new_today.toLocaleString(), helper: 'Uncontacted under 24h' },
    { label: 'Pending', value: kpis.pending.toLocaleString(), helper: 'Uncontacted ≥24h' },
    {
      label: 'SLA risk',
      value: kpis.sla_risk.toLocaleString(),
      helper: 'Needs immediate action',
      trend: kpis.sla_risk ? 'down' : 'neutral',
    },
    {
      label: 'Qualified',
      value: kpis.qualified.toLocaleString(),
      helper: 'Current in-scope leads',
    },
  ];
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
  const columns = useMemo<ColumnDef<LeadRecord>[]>(
    () => [
      {
        accessorKey: 'id',
        header: 'Lead ID',
        cell: ({ row }) => <span className="font-semibold">{shortId(row.original.id)}</span>,
      },
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
        header: 'Phone',
        cell: ({ getValue }) => (
          <span className="font-medium text-blue-700">{String(getValue())}</span>
        ),
      },
      { accessorKey: 'source', header: 'Source' },
      {
        accessorKey: 'interested_model',
        header: 'Interested model',
        cell: ({ getValue }) => String(getValue() ?? '—'),
      },
      {
        accessorKey: 'assigned_user_name',
        header: 'Assigned to',
        cell: ({ row }) =>
          row.original.assigned_user_name ??
          (row.original.assigned_user_id ? 'Assigned user' : 'Unassigned'),
      },
      {
        accessorKey: 'work_state',
        header: 'Work state',
        cell: ({ getValue }) =>
          getValue() ? (
            <StatusBadge value={String(getValue())} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: 'lifecycle_status',
        header: 'Lifecycle',
        cell: ({ getValue }) => <StatusBadge value={String(getValue())} />,
      },
      {
        accessorKey: 'updated_at',
        header: 'Last activity',
        cell: ({ getValue }) => (
          <span className="text-xs text-muted-foreground">{formatDate(String(getValue()))}</span>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) =>
          canAssign || canUpdate || canLinkCustomer || row.original.customer_id ? (
            <div className="flex gap-2">
              {row.original.customer_id ? (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/${role}/customers/${row.original.customer_id}`}>
                    <Link2 className="size-3.5" /> Customer 360
                  </Link>
                </Button>
              ) : canLinkCustomer ? (
                <Button size="sm" variant="outline" onClick={() => onMatchCustomer(row.original)}>
                  <Link2 className="size-3.5" /> Review customer
                </Button>
              ) : null}
              {canUpdate && (
                <Button size="sm" variant="outline" onClick={() => onEdit(row.original)}>
                  <Pencil className="size-3.5" />
                  Update
                </Button>
              )}
              {canAssign && (
                <Button size="sm" variant="outline" onClick={() => onAssign(row.original)}>
                  <UserRoundCheck className="size-3.5" />
                  {row.original.assigned_user_id ? 'Reassign' : 'Assign'}
                </Button>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">No lead action access</span>
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

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1 lg:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              placeholder="Search lead ID, customer or phone…"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={query.status}
              onValueChange={(status) =>
                onQueryChange({ status: status as LeadStatusFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-[178px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(sort) => onQueryChange({ sort: sort as LeadQuery['sort'], page: 1 })}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated:desc">Last activity: newest</SelectItem>
                <SelectItem value="updated:asc">Last activity: oldest</SelectItem>
                <SelectItem value="created:desc">Created: newest</SelectItem>
                <SelectItem value="created:asc">Created: oldest</SelectItem>
                <SelectItem value="customer:asc">Customer: A–Z</SelectItem>
                <SelectItem value="customer:desc">Customer: Z–A</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as LeadQuery['pageSize'], page: 1 })
              }
            >
              <SelectTrigger className="w-[105px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
              </SelectContent>
            </Select>
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
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id} className="whitespace-nowrap">
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
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="whitespace-nowrap">
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
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {data.total ? (query.page - 1) * query.pageSize + 1 : 0}–
            {Math.min(query.page * query.pageSize, data.total)} of {data.total}
          </p>
          <div className="flex items-center gap-2">
            <span className="mr-2 text-xs text-muted-foreground">
              Page {query.page} of {pages}
            </span>
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
          </div>
        </div>
      </CardContent>
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
  const [createOpen, setCreateOpen] = useState(false);
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

  const chartData = [
    { name: 'New', value: workspace.data.kpis.new_count },
    { name: 'Contacted', value: workspace.data.kpis.contacted_count },
    { name: 'Qualified', value: workspace.data.kpis.qualified },
    { name: 'Appointment', value: workspace.data.kpis.appointment_scheduled_count },
    { name: 'Transferred', value: workspace.data.kpis.transferred_to_sales_count },
  ];

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <div className="shrink-0 sm:pt-7">
          {!spec.readOnly && permissions.data?.canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Add lead
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-6">
        <KpiGrid metrics={toMetrics(workspace.data.kpis)} />
        <Card className="shadow-none">
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Lead lifecycle</CardTitle>
            <CardDescription>Current in-scope opportunity distribution</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="funnel" data={chartData} className="h-[280px]" />
          </CardContent>
        </Card>
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
      </div>
      {permissions.data?.canCreate && (
        <LeadCreateDialog
          organizationId={permissions.data.organizationId}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={invalidate}
        />
      )}
      <LeadAssignmentDialog
        key={assignmentLead?.id ?? 'none'}
        lead={assignmentLead}
        open={Boolean(assignmentLead)}
        onOpenChange={(open) => !open && setAssignmentLead(null)}
        onAssigned={invalidate}
      />
      <LeadEditDialog
        key={editingLead?.id ?? 'none'}
        lead={editingLead}
        open={Boolean(editingLead)}
        onOpenChange={(open) => !open && setEditingLead(null)}
        onUpdated={invalidate}
      />
      <CustomerMatchDialog
        key={matchingLead?.id ?? 'none'}
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
