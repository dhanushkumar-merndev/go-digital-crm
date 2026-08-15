'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Clock3, Plus, Search, ShieldCheck } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  usePlatformRealtimeInvalidation,
  useTenantRealtimeInvalidation,
} from '@/lib/realtime/use-realtime-invalidation';
import {
  createSupportRequest,
  decideSupportRequest,
  fetchSupportCapabilities,
  fetchSupportWorkspace,
  searchSupportTenants,
  terminateSupportSession,
  type SupportSessionRecord,
  type SupportTenantOption,
  type SupportWorkspaceResult,
} from './support-session-api';
import {
  parseSupportWorkspaceQuery,
  supportStatusValues,
  toSupportWorkspaceQueryString,
  type SupportStatusFilter,
  type SupportWorkspaceQuery,
} from './support-session-query';

type SupportWorkspaceRole = 'super-admin' | 'business-owner';

const statusLabels: Record<SupportStatusFilter, string> = {
  all: 'All requests',
  pending: 'Awaiting decision',
  active: 'Active sessions',
  rejected: 'Rejected',
  ended: 'Ended',
  expired: 'Expired',
};

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function toMetrics(kpis: SupportWorkspaceResult['kpis']): Metric[] {
  return [
    {
      label: 'Pending requests',
      value: kpis.pending.toLocaleString(),
      helper: 'Awaiting tenant decision',
    },
    {
      label: 'Active sessions',
      value: kpis.active.toLocaleString(),
      helper: 'Approved maintenance windows',
    },
    {
      label: 'Expiring soon',
      value: kpis.expiring_soon.toLocaleString(),
      helper: 'Within 10 minutes',
    },
    {
      label: 'Sessions this month',
      value: kpis.sessions_this_month.toLocaleString(),
      helper: 'Approved support access',
    },
  ];
}

function PlatformRealtimeBridge() {
  usePlatformRealtimeInvalidation([{ resource: 'support', queryKeys: [['support-workspace']] }]);
  return null;
}

function TenantRealtimeBridge({ organizationId }: { organizationId: string }) {
  useTenantRealtimeInvalidation(organizationId, [
    { resource: 'support', queryKeys: [['support-workspace']] },
  ]);
  return null;
}

function SupportRequestDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tenantSearch, setTenantSearch] = useState('');
  const [selectedTenant, setSelectedTenant] = useState<SupportTenantOption | null>(null);
  const [purpose, setPurpose] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [permissionSearch, setPermissionSearch] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const debouncedTenantSearch = useDebouncedValue(tenantSearch, 300);
  const tenantOptions = useQuery({
    queryKey: ['support-tenant-options', debouncedTenantSearch],
    queryFn: () => searchSupportTenants(debouncedTenantSearch),
    enabled: debouncedTenantSearch.trim().length >= 2,
  });
  const capabilities = useQuery({
    queryKey: ['support-capabilities'],
    queryFn: fetchSupportCapabilities,
  });
  const normalizedPermissionSearch = permissionSearch.trim().toLowerCase();
  const filteredCapabilities = (capabilities.data ?? []).filter(
    (capability) =>
      !normalizedPermissionSearch ||
      capability.permission_key.toLowerCase().includes(normalizedPermissionSearch) ||
      capability.module.toLowerCase().includes(normalizedPermissionSearch) ||
      capability.description.toLowerCase().includes(normalizedPermissionSearch),
  );
  const mutation = useMutation({
    mutationFn: createSupportRequest,
    onSuccess: () => {
      onCreated();
      onClose();
    },
  });
  const valid =
    Boolean(selectedTenant) &&
    purpose.trim().length >= 10 &&
    purpose.trim().length <= 500 &&
    selectedPermissions.length > 0 &&
    selectedPermissions.length <= 20;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Request tenant support access</DialogTitle>
          <DialogDescription>
            The Business Owner must approve this exact capability set and time limit before any
            tenant access is granted.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedTenant || !valid) return;
            mutation.mutate({
              organizationId: selectedTenant.id,
              purpose,
              permissions: selectedPermissions,
              durationMinutes,
            });
          }}
        >
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="support-tenant-search">
              Dealership
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="support-tenant-search"
                value={tenantSearch}
                onChange={(event) => {
                  setTenantSearch(event.target.value);
                  setSelectedTenant(null);
                }}
                className="pl-9"
                minLength={2}
                maxLength={80}
                placeholder="Search an active dealership…"
                autoComplete="off"
              />
            </div>
            {selectedTenant ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-3 text-sm">
                <span className="font-medium">{selectedTenant.name}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedTenant(null)}
                >
                  Change
                </Button>
              </div>
            ) : debouncedTenantSearch.trim().length >= 2 ? (
              <div className="max-h-36 divide-y overflow-y-auto rounded-lg border">
                {tenantOptions.isPending && (
                  <p className="p-3 text-sm text-muted-foreground">Searching dealerships…</p>
                )}
                {tenantOptions.isError && (
                  <p className="p-3 text-sm text-destructive">Dealership search is unavailable.</p>
                )}
                {tenantOptions.data?.map((tenant) => (
                  <Button
                    key={tenant.id}
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start rounded-none px-3 py-2 text-left font-normal"
                    onClick={() => {
                      setSelectedTenant(tenant);
                      setTenantSearch(tenant.name);
                    }}
                  >
                    {tenant.name}
                  </Button>
                ))}
                {tenantOptions.data?.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No active dealership matched.</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Enter at least two characters.</p>
            )}
          </div>

          <label className="grid gap-1.5 text-sm font-medium">
            Support purpose
            <Textarea
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              minLength={10}
              maxLength={500}
              rows={3}
              required
              placeholder="Describe the exact issue and why tenant access is required."
            />
            <span className="text-xs font-normal text-muted-foreground">
              {purpose.trim().length}/500 characters; recorded in the audit trail.
            </span>
          </label>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-sm font-medium" htmlFor="support-capability-search">
                Approved capabilities ({selectedPermissions.length}/20)
              </label>
              <Input
                id="support-capability-search"
                value={permissionSearch}
                onChange={(event) => setPermissionSearch(event.target.value)}
                className="h-8 w-full sm:w-56"
                maxLength={80}
                placeholder="Filter capabilities"
              />
            </div>
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-3">
              {capabilities.isPending && (
                <p className="text-sm text-muted-foreground">Loading capability catalog…</p>
              )}
              {capabilities.isError && (
                <p className="text-sm text-destructive">Capability catalog is unavailable.</p>
              )}
              {filteredCapabilities.map((capability) => {
                const selected = selectedPermissions.includes(capability.permission_key);
                const selectionLimitReached = selectedPermissions.length >= 20 && !selected;
                return (
                  <Button
                    key={capability.permission_key}
                    type="button"
                    disabled={selectionLimitReached}
                    aria-pressed={selected}
                    variant={selected ? 'secondary' : 'outline'}
                    className="h-auto w-full flex-col items-stretch whitespace-normal p-3 text-left"
                    onClick={() =>
                      setSelectedPermissions((current) =>
                        selected
                          ? current.filter((key) => key !== capability.permission_key)
                          : [...current, capability.permission_key],
                      )
                    }
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{capability.permission_key}</span>
                      <Badge variant="outline">{capability.module}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {capability.description}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>

          <label className="grid gap-1.5 text-sm font-medium">
            Access duration
            <Select
              value={String(durationMinutes)}
              onValueChange={(value) => setDurationMinutes(Number(value))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[5, 15, 30, 45, 60].map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutes} minutes
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {mutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>Support request not created</AlertTitle>
              <AlertDescription>
                The tenant may already have a pending request, or your MFA session may need renewal.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending ? 'Requesting…' : 'Send approval request'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SupportDecisionDialog({
  record,
  onClose,
  onDecided,
}: {
  record: SupportSessionRecord;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [decisionNote, setDecisionNote] = useState('');
  const mutation = useMutation({
    mutationFn: decideSupportRequest,
    onSuccess: () => {
      onDecided();
      onClose();
    },
  });
  const noteValid = decision === 'APPROVE' || decisionNote.trim().length >= 3;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review support access</DialogTitle>
          <DialogDescription>
            This decision changes the dealership to maintenance mode for the approved window.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-semibold">{record.requester_name}</p>
            <p className="mt-1 text-muted-foreground">{record.purpose}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {record.permissions.map((permission) => (
                <Badge key={permission} variant="outline">
                  {permission}
                </Badge>
              ))}
            </div>
            <p className="mt-3 text-xs font-medium text-muted-foreground">
              Requested window: {record.duration_minutes} minutes
            </p>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Decision
            <Select
              value={decision}
              onValueChange={(value) => setDecision(value as typeof decision)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="APPROVE">Approve time-limited access</SelectItem>
                <SelectItem value="REJECT">Reject request</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Decision note{' '}
            {decision === 'REJECT' && <span className="text-destructive">Required</span>}
            <Textarea
              value={decisionNote}
              onChange={(event) => setDecisionNote(event.target.value)}
              minLength={decision === 'REJECT' ? 3 : undefined}
              maxLength={500}
              rows={3}
              placeholder="Record the decision context."
            />
          </label>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>Decision not saved</AlertTitle>
              <AlertDescription>
                The request may already be decided, or another support session is active.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={decision === 'REJECT' ? 'destructive' : 'default'}
              disabled={!noteValid || mutation.isPending}
              onClick={() => mutation.mutate({ requestId: record.id, decision, decisionNote })}
            >
              {mutation.isPending ? 'Saving…' : 'Confirm decision'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EndSupportDialog({
  record,
  onClose,
  onEnded,
}: {
  record: SupportSessionRecord;
  onClose: () => void;
  onEnded: () => void;
}) {
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: terminateSupportSession,
    onSuccess: () => {
      onEnded();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End support session</DialogTitle>
          <DialogDescription>
            Access is revoked immediately and normal dealership access is restored when no other
            approved support session remains.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-semibold">{record.organization_name}</p>
            <p className="mt-1 text-muted-foreground">Expires {formatDate(record.expires_at)}</p>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Termination reason
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={3}
              maxLength={500}
              rows={3}
              required
              placeholder="Record why this session is being ended."
            />
          </label>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>Session not ended</AlertTitle>
              <AlertDescription>
                The session may already have ended, or your authorization changed.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={reason.trim().length < 3 || mutation.isPending}
              onClick={() =>
                record.session_id && mutation.mutate({ sessionId: record.session_id, reason })
              }
            >
              {mutation.isPending ? 'Ending…' : 'End access now'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SupportSessionTable({
  data,
  query,
  isFetching,
  role,
  onQueryChange,
  onReview,
  onEnd,
}: {
  data: SupportWorkspaceResult;
  query: SupportWorkspaceQuery;
  isFetching: boolean;
  role: SupportWorkspaceRole;
  onQueryChange: (next: Partial<SupportWorkspaceQuery>) => void;
  onReview: (record: SupportSessionRecord) => void;
  onEnd: (record: SupportSessionRecord) => void;
}) {
  const columns = useMemo<ColumnDef<SupportSessionRecord>[]>(
    () => [
      {
        accessorKey: 'id',
        header: 'Request',
        cell: ({ row }) => (
          <span className="font-mono text-xs">SUP-{row.original.id.slice(0, 8).toUpperCase()}</span>
        ),
      },
      { accessorKey: 'organization_name', header: 'Dealership' },
      {
        accessorKey: 'requester_name',
        header: 'Requested by',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.requester_name}</p>
            <p className="text-xs text-muted-foreground">{formatDate(row.original.created_at)}</p>
          </div>
        ),
      },
      {
        accessorKey: 'purpose',
        header: 'Purpose / capabilities',
        cell: ({ row }) => (
          <div className="max-w-[320px]">
            <p className="line-clamp-2 text-sm">{row.original.purpose}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.original.permissions.slice(0, 2).join(', ')}
              {row.original.permissions.length > 2
                ? ` +${row.original.permissions.length - 2}`
                : ''}
            </p>
          </div>
        ),
      },
      {
        id: 'approver',
        header: 'Approved by',
        cell: ({ row }) => row.original.approver_name ?? '—',
      },
      {
        id: 'expires',
        header: 'Expires / ended',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {formatDate(row.original.ended_at ?? row.original.expires_at)}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge value={row.original.status} />,
      },
      {
        id: 'actions',
        header: 'Action',
        cell: ({ row }) => {
          const record = row.original;
          if (role === 'business-owner' && record.status === 'PENDING')
            return (
              <Button size="sm" variant="outline" onClick={() => onReview(record)}>
                Review
              </Button>
            );
          if (record.status === 'ACTIVE' && record.session_id && record.can_end)
            return (
              <Button size="sm" variant="outline" onClick={() => onEnd(record)}>
                End session
              </Button>
            );
          return <span className="text-xs text-muted-foreground">No action</span>;
        },
      },
    ],
    [onEnd, onReview, role],
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
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              maxLength={120}
              placeholder="Search this support list"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={query.status}
              onValueChange={(value) =>
                onQueryChange({ status: value as SupportStatusFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {supportStatusValues.map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabels[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(value) =>
                onQueryChange({ sort: value as SupportWorkspaceQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created_desc">Newest requested</SelectItem>
                <SelectItem value="created_asc">Oldest requested</SelectItem>
                <SelectItem value="tenant_asc">Dealership A–Z</SelectItem>
                <SelectItem value="expires_asc">Expiring first</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className={isFetching ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}>
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
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-36 text-center">
                    <p className="font-medium">No support request matches this view</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Change the page-local search or status filter.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {data.total ? (query.page - 1) * query.pageSize + 1 : 0}–
            {Math.min(query.page * query.pageSize, data.total)} of {data.total}
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
              }
            >
              <SelectTrigger className="h-8 w-[82px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              Page {query.page} of {pages}
            </span>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              disabled={query.page <= 1}
              onClick={() => onQueryChange({ page: query.page - 1 })}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
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

export function SupportSessionWorkspace({
  spec,
  role,
}: {
  spec: PageSpec;
  role: SupportWorkspaceRole;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParameters = useSearchParams();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState<SupportWorkspaceQuery>(() =>
    parseSupportWorkspaceQuery(searchParameters),
  );
  const [requestOpen, setRequestOpen] = useState(false);
  const [reviewRecord, setReviewRecord] = useState<SupportSessionRecord | null>(null);
  const [endRecord, setEndRecord] = useState<SupportSessionRecord | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const effectiveQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const workspace = useQuery({
    queryKey: ['support-workspace', role, effectiveQuery],
    queryFn: () => fetchSupportWorkspace(effectiveQuery),
    placeholderData: keepPreviousData,
  });
  const changeQuery = useCallback(
    (next: Partial<SupportWorkspaceQuery>) => {
      setQuery((current) => {
        const updated = { ...current, ...next };
        const queryString = toSupportWorkspaceQueryString(updated);
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
        return updated;
      });
    },
    [pathname, router],
  );
  const refresh = useCallback(
    (message: string) => {
      setSuccessMessage(message);
      void queryClient.invalidateQueries({ queryKey: ['support-workspace'] });
    },
    [queryClient],
  );

  if (workspace.isPending) return <PageSkeleton />;
  const expectedMode = role === 'super-admin' ? 'PLATFORM' : 'TENANT';
  if (
    workspace.isError ||
    !workspace.data ||
    workspace.data.viewer.mode !== expectedMode ||
    (role === 'business-owner' && !workspace.data.viewer.can_decide)
  )
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="p-8 text-center">
            <p className="font-semibold">Support controls are unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              A current MFA session and the required platform or Business Owner authority are
              required.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      {role === 'super-admin' ? (
        <PlatformRealtimeBridge />
      ) : (
        workspace.data.viewer.organization_id && (
          <TenantRealtimeBridge organizationId={workspace.data.viewer.organization_id} />
        )
      )}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        {role === 'super-admin' && workspace.data.viewer.can_request && (
          <div className="shrink-0 sm:pt-7">
            <Button onClick={() => setRequestOpen(true)}>
              <Plus className="size-4" />
              Request support
            </Button>
          </div>
        )}
      </div>
      {successMessage && (
        <Alert variant="success">
          <ShieldCheck className="size-4" />
          <AlertTitle>{successMessage}</AlertTitle>
          <AlertDescription>The audited support state is being refreshed.</AlertDescription>
        </Alert>
      )}
      {workspace.data.kpis.active > 0 && (
        <Alert>
          <Clock3 className="size-4" />
          <AlertTitle>Time-limited support access is active</AlertTitle>
          <AlertDescription>
            Access ends automatically at the approved expiry and can be terminated early below.
          </AlertDescription>
        </Alert>
      )}
      <KpiGrid metrics={toMetrics(workspace.data.kpis)} />
      <SupportSessionTable
        data={workspace.data}
        query={query}
        isFetching={workspace.isFetching}
        role={role}
        onQueryChange={changeQuery}
        onReview={setReviewRecord}
        onEnd={setEndRecord}
      />
      {requestOpen && (
        <SupportRequestDialog
          onClose={() => setRequestOpen(false)}
          onCreated={() => refresh('Support approval request sent')}
        />
      )}
      {reviewRecord && (
        <SupportDecisionDialog
          record={reviewRecord}
          onClose={() => setReviewRecord(null)}
          onDecided={() => refresh('Support decision recorded')}
        />
      )}
      {endRecord && (
        <EndSupportDialog
          record={endRecord}
          onClose={() => setEndRecord(null)}
          onEnded={() => refresh('Support access ended')}
        />
      )}
    </div>
  );
}
