'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import { usePlatformRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  extendTenantRetention,
  fetchRetentionTenantOptions,
  fetchRetentionWorkspace,
  requestTenantDeletion,
  requeueFailedTenantPurge,
  restoreSoftDeletedTenant,
  reviewTenantDeletion,
  setTenantDeletionLegalHold,
  type RetentionRecord,
} from './retention-api';
import {
  parseRetentionQuery,
  retentionStatuses,
  toRetentionQueryString,
  type RetentionQuery,
  type RetentionStatusFilter,
} from './retention-query';

const statusLabels: Record<RetentionStatusFilter, string> = {
  open: 'Open requests',
  all: 'All requests',
  'pending-approval': 'Awaiting approval',
  approved: 'Approved',
  'legal-hold': 'Legal hold',
  purging: 'Purge in progress',
  failed: 'Failed',
  restored: 'Restored',
  rejected: 'Rejected',
  purged: 'Purged',
};

type RetentionActionKind = 'review' | 'restore' | 'hold' | 'extend' | 'requeue';
type RetentionAction = { kind: RetentionActionKind; record: RetentionRecord };

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function purgeWindowLabel(record: RetentionRecord) {
  if (record.status === 'PURGED') return 'Completed';
  if (record.legal_hold) return 'Paused by legal hold';
  const milliseconds = new Date(record.purge_after).getTime() - Date.now();
  if (milliseconds <= 0) return 'Eligible now';
  const days = Math.ceil(milliseconds / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'} remaining`;
}

function toMetrics(kpis: Awaited<ReturnType<typeof fetchRetentionWorkspace>>['kpis']): Metric[] {
  return [
    {
      label: 'Awaiting approval',
      value: kpis.awaiting_approval.toLocaleString(),
      helper: 'Requires a different Super Admin',
    },
    {
      label: 'Scheduled',
      value: kpis.scheduled.toLocaleString(),
      helper: 'Approved and not on hold',
    },
    {
      label: 'Legal hold',
      value: kpis.on_hold.toLocaleString(),
      helper: 'Purge eligibility paused',
    },
    {
      label: 'Requires attention',
      value: kpis.attention.toLocaleString(),
      helper: 'Purging or failed',
    },
  ];
}

function RequestDeletionDialog({
  open,
  onOpenChange,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}) {
  const [tenantSearch, setTenantSearch] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [reason, setReason] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [confirmation, setConfirmation] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const debouncedSearch = useDebouncedValue(tenantSearch, 300);
  const tenants = useQuery({
    queryKey: ['platform-retention-tenant-options', debouncedSearch],
    queryFn: () => fetchRetentionTenantOptions(debouncedSearch),
    enabled: open,
  });
  const selectedTenant = tenants.data?.find((tenant) => tenant.id === organizationId) ?? null;
  const mutation = useMutation({
    mutationFn: requestTenantDeletion,
    onSuccess: () => {
      setTenantSearch('');
      setOrganizationId('');
      setReason('');
      setRetentionDays(30);
      setConfirmation('');
      setIdempotencyKey('');
      onCompleted();
      onOpenChange(false);
    },
  });
  const canSubmit =
    Boolean(selectedTenant) &&
    confirmation === selectedTenant?.name &&
    reason.trim().length >= 10 &&
    retentionDays >= 1 &&
    retentionDays <= 3650;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Request tenant deletion</DialogTitle>
          <DialogDescription>
            Access is suspended immediately. A different Super Admin must approve the permanent
            purge, which cannot start before the retention date.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || !selectedTenant) return;
            const stableIdempotencyKey = idempotencyKey || crypto.randomUUID();
            setIdempotencyKey(stableIdempotencyKey);
            mutation.mutate({
              organizationId: selectedTenant.id,
              reason,
              retentionDays,
              idempotencyKey: stableIdempotencyKey,
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Find eligible dealership
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={tenantSearch}
                onChange={(event) => {
                  setTenantSearch(event.target.value);
                  setOrganizationId('');
                  setConfirmation('');
                  setIdempotencyKey('');
                }}
                className="pl-9"
                maxLength={160}
                placeholder="Search dealership name or tenant slug…"
              />
            </div>
          </label>
          <div className="max-h-44 overflow-y-auto rounded-lg border">
            {tenants.isPending && (
              <p className="p-4 text-sm text-muted-foreground">Loading eligible tenants…</p>
            )}
            {tenants.isError && (
              <p className="p-4 text-sm text-destructive">Eligible tenants could not be loaded.</p>
            )}
            {tenants.data?.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                No eligible dealership matches this search.
              </p>
            )}
            {tenants.data?.map((tenant) => (
              <Button
                type="button"
                key={tenant.id}
                variant="ghost"
                className={`h-auto w-full justify-between rounded-none border-b px-4 py-3 text-left text-sm last:border-b-0 ${
                  tenant.id === organizationId ? 'bg-accent' : ''
                }`}
                onClick={() => {
                  setOrganizationId(tenant.id);
                  setConfirmation('');
                  setIdempotencyKey('');
                }}
              >
                <span>
                  <span className="block font-medium">{tenant.name}</span>
                  <span className="block text-xs text-muted-foreground">{tenant.slug}</span>
                </span>
                <StatusBadge value={tenant.status} />
              </Button>
            ))}
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Retention window (days)
            <Input
              type="number"
              value={retentionDays}
              onChange={(event) => {
                setRetentionDays(Number(event.target.value));
                setIdempotencyKey('');
              }}
              min={1}
              max={3650}
              required
            />
            <span className="text-xs font-normal text-muted-foreground">
              Restoration is available only before this window expires and before purge starts.
            </span>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Business and compliance reason
            <Textarea
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setIdempotencyKey('');
              }}
              minLength={10}
              maxLength={1000}
              rows={4}
              required
              placeholder="Record the authorized reason without including credentials or secrets."
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Type {selectedTenant ? `“${selectedTenant.name}”` : 'the selected dealership name'} to
            confirm
            <Input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={!selectedTenant}
              autoComplete="off"
            />
          </label>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>Deletion request was not created</AlertTitle>
              <AlertDescription>
                The tenant may have an active support session, maintenance state, or another open
                deletion request. No partial suspension was committed.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canSubmit || mutation.isPending}>
              {mutation.isPending ? 'Suspending tenant…' : 'Suspend & request deletion'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function defaultExtensionValue(purgeAfter: string) {
  const current = new Date(purgeAfter).getTime();
  const next = new Date(Math.max(current, Date.now()) + 7 * 86_400_000);
  const local = new Date(next.getTime() - next.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function actionTitle(action: RetentionAction, decision: 'APPROVE' | 'REJECT') {
  if (action.kind === 'review')
    return decision === 'APPROVE' ? 'Approve permanent purge' : 'Reject deletion request';
  if (action.kind === 'restore') return 'Restore tenant access';
  if (action.kind === 'hold')
    return action.record.legal_hold ? 'Release legal hold' : 'Apply legal hold';
  if (action.kind === 'extend') return 'Extend retention window';
  return 'Requeue failed purge';
}

function RetentionActionDialog({
  action,
  onClose,
  onCompleted,
}: {
  action: RetentionAction;
  onClose: () => void;
  onCompleted: (message: string) => void;
}) {
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [purgeAfter, setPurgeAfter] = useState(defaultExtensionValue(action.record.purge_after));
  const mutation = useMutation({
    mutationFn: async () => {
      if (action.kind === 'review')
        return reviewTenantDeletion({ requestId: action.record.id, decision, reason });
      if (action.kind === 'restore')
        return restoreSoftDeletedTenant({ requestId: action.record.id, reason });
      if (action.kind === 'hold')
        return setTenantDeletionLegalHold({
          requestId: action.record.id,
          enabled: !action.record.legal_hold,
          reason,
        });
      if (action.kind === 'extend')
        return extendTenantRetention({
          requestId: action.record.id,
          purgeAfter: new Date(purgeAfter).toISOString(),
          reason,
        });
      return requeueFailedTenantPurge({ requestId: action.record.id, reason });
    },
    onSuccess: () => {
      onCompleted(
        `${actionTitle(action, decision)} completed for ${action.record.organization_name}.`,
      );
      onClose();
    },
  });
  const extensionIsValid =
    action.kind !== 'extend' ||
    (Boolean(purgeAfter) &&
      new Date(purgeAfter).getTime() > new Date(action.record.purge_after).getTime());
  const destructive =
    (action.kind === 'review' && decision === 'APPROVE') || action.kind === 'requeue';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{actionTitle(action, decision)}</DialogTitle>
          <DialogDescription>
            {action.record.organization_name} · request {action.record.id.slice(0, 8)}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim().length >= 10 && extensionIsValid) mutation.mutate();
          }}
        >
          {action.kind === 'review' && (
            <div className="grid gap-1.5 text-sm font-medium">
              Decision
              <Select
                value={decision}
                onValueChange={(value) => setDecision(value as 'APPROVE' | 'REJECT')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="APPROVE">Approve scheduled purge</SelectItem>
                  <SelectItem value="REJECT">Reject and restore tenant</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs font-normal text-muted-foreground">
                The requesting Super Admin cannot approve their own request.
              </span>
            </div>
          )}
          {action.kind === 'extend' && (
            <label className="grid gap-1.5 text-sm font-medium">
              New purge date
              <Input
                type="datetime-local"
                value={purgeAfter}
                onChange={(event) => setPurgeAfter(event.target.value)}
                min={defaultExtensionValue(action.record.purge_after)}
                required
              />
              <span className="text-xs font-normal text-muted-foreground">
                Current date: {formatDate(action.record.purge_after)}. Retention can only be
                extended.
              </span>
            </label>
          )}
          <label className="grid gap-1.5 text-sm font-medium">
            Audited reason
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={10}
              maxLength={1000}
              rows={4}
              required
              placeholder="Record the approval, legal, recovery, or compliance basis."
            />
          </label>
          {action.kind === 'review' && decision === 'APPROVE' && (
            <Alert variant="destructive">
              <AlertTitle>Irreversible after the retention date</AlertTitle>
              <AlertDescription>
                The background worker will delete private Tigris objects and Auth identities before
                final data purge and manifest completion.
              </AlertDescription>
            </Alert>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              This transition was not saved. The request state or purge eligibility may have
              changed.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={reason.trim().length < 10 || !extensionIsValid || mutation.isPending}
            >
              {mutation.isPending ? 'Saving…' : 'Confirm audited action'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function canRestore(record: RetentionRecord) {
  return (
    ['PENDING', 'PENDING_APPROVAL', 'APPROVED'].includes(record.status) &&
    new Date(record.purge_after).getTime() > Date.now()
  );
}

function RetentionActions({
  record,
  onAction,
}: {
  record: RetentionRecord;
  onAction: (action: RetentionAction) => void;
}) {
  const reviewable = record.status === 'PENDING' || record.status === 'PENDING_APPROVAL';
  const retentionAdjustable = reviewable || record.status === 'APPROVED';
  const holdable = retentionAdjustable || record.status === 'PURGING' || record.status === 'FAILED';
  const requeueable = record.status === 'FAILED' && !record.legal_hold;
  if (!reviewable && !holdable && !requeueable)
    return <span className="text-xs text-muted-foreground">—</span>;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="size-8" aria-label="Retention actions">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Controlled actions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {reviewable && (
          <DropdownMenuItem onSelect={() => onAction({ kind: 'review', record })}>
            Review request
          </DropdownMenuItem>
        )}
        {canRestore(record) && (
          <DropdownMenuItem onSelect={() => onAction({ kind: 'restore', record })}>
            Restore tenant
          </DropdownMenuItem>
        )}
        {holdable && (
          <DropdownMenuItem onSelect={() => onAction({ kind: 'hold', record })}>
            {record.legal_hold ? 'Release legal hold' : 'Apply legal hold'}
          </DropdownMenuItem>
        )}
        {retentionAdjustable && (
          <>
            <DropdownMenuItem onSelect={() => onAction({ kind: 'extend', record })}>
              Extend retention
            </DropdownMenuItem>
          </>
        )}
        {requeueable && (
          <DropdownMenuItem onSelect={() => onAction({ kind: 'requeue', record })}>
            Requeue failed purge
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RetentionTable({
  data,
  query,
  onQueryChange,
  onAction,
  isFetching,
}: {
  data: Awaited<ReturnType<typeof fetchRetentionWorkspace>>;
  query: RetentionQuery;
  onQueryChange: (next: Partial<RetentionQuery>) => void;
  onAction: (action: RetentionAction) => void;
  isFetching: boolean;
}) {
  const columns = useMemo<ColumnDef<RetentionRecord>[]>(
    () => [
      {
        accessorKey: 'organization_name',
        header: 'Dealership',
        cell: ({ row }) => (
          <div className="min-w-48">
            <p className="font-medium">{row.original.organization_name}</p>
            <p className="text-xs text-muted-foreground">{row.original.organization_slug}</p>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Request state',
        cell: ({ row }) => (
          <div className="flex min-w-32 flex-col items-start gap-1.5">
            <StatusBadge value={row.original.status} />
            {row.original.legal_hold && <Badge variant="warning">LEGAL HOLD</Badge>}
          </div>
        ),
      },
      {
        accessorKey: 'deleted_at',
        header: 'Soft deleted',
        cell: ({ row }) => (
          <div className="min-w-40 text-xs">
            <p>{formatDate(row.original.deleted_at)}</p>
            <p className="mt-1 text-muted-foreground">
              {row.original.deleted_by_name ?? 'Platform administrator'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'purge_after',
        header: 'Retention / purge',
        cell: ({ row }) => (
          <div className="min-w-44 text-xs">
            <p>{formatDate(row.original.purge_after)}</p>
            <p className="mt-1 text-muted-foreground">{purgeWindowLabel(row.original)}</p>
          </div>
        ),
      },
      {
        accessorKey: 'requested_by_name',
        header: 'Control owners',
        cell: ({ row }) => (
          <div className="min-w-44 text-xs">
            <p>Requested: {row.original.requested_by_name ?? 'Platform administrator'}</p>
            <p className="mt-1 text-muted-foreground">
              Approved: {row.original.approved_by_name ?? 'Awaiting approval'}
            </p>
          </div>
        ),
      },
      {
        id: 'processing',
        header: 'Purge evidence',
        cell: ({ row }) => (
          <div className="min-w-44 text-xs">
            <p>{row.original.purge_job_status ?? row.original.manifest_status ?? 'Not queued'}</p>
            <p className="mt-1 text-muted-foreground">
              {row.original.manifest_checksum
                ? `Manifest ${row.original.manifest_checksum.slice(0, 12)}…`
                : row.original.purge_last_error_code ||
                  row.original.failure_safe_code ||
                  `${row.original.purge_attempts ?? 0} attempts`}
            </p>
            {row.original.manifest_summary?.external_provider_token_revocation ===
              'NOT_EXECUTED_REQUIRES_PROVIDER_ADAPTER' && (
              <p className="mt-1 text-amber-700 dark:text-amber-400">
                External provider token revocation staged
              </p>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'reason',
        header: 'Reason',
        cell: ({ getValue }) => (
          <p className="max-w-64 whitespace-normal text-xs text-muted-foreground">
            {String(getValue())}
          </p>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => <RetentionActions record={row.original} onAction={onAction} />,
      },
    ],
    [onAction],
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
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="relative min-w-0 flex-1 xl:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              maxLength={160}
              placeholder="Search dealership, slug or request UUID…"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={query.status}
              onValueChange={(status) =>
                onQueryChange({ status: status as RetentionStatusFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {retentionStatuses.map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabels[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(sort) =>
                onQueryChange({ sort: sort as RetentionQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="purge:asc">Purge date: earliest</SelectItem>
                <SelectItem value="purge:desc">Purge date: latest</SelectItem>
                <SelectItem value="deleted:desc">Deleted: newest</SelectItem>
                <SelectItem value="dealership:asc">Dealership: A–Z</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as RetentionQuery['pageSize'], page: 1 })
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
        <div className={isFetching ? 'overflow-x-auto opacity-65' : 'overflow-x-auto'}>
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
                      <TableCell key={cell.id} className="align-top">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <p className="font-medium">No retention requests match this view</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Try another workflow state or page-local search.
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

export function RetentionWorkspace({ spec }: { spec: PageSpec }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  usePlatformRealtimeInvalidation([{ resource: 'retention', queryKeys: [['platform-retention']] }]);
  const [query, setQuery] = useState<RetentionQuery>(() => parseRetentionQuery(searchParams));
  const [requestOpen, setRequestOpen] = useState(false);
  const [action, setAction] = useState<RetentionAction | null>(null);
  const [successMessage, setSuccessMessage] = useState('');
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const retention = useQuery({
    queryKey: ['platform-retention', requestQuery],
    queryFn: () => fetchRetentionWorkspace(requestQuery),
    placeholderData: keepPreviousData,
  });
  const changeQuery = useCallback(
    (next: Partial<RetentionQuery>) => {
      setQuery((current) => {
        const updated = { ...current, ...next };
        const queryString = toRetentionQueryString(updated);
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
        return updated;
      });
    },
    [pathname, router],
  );
  const selectAction = useCallback((next: RetentionAction) => setAction(next), []);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['platform-retention'] });
    void queryClient.invalidateQueries({ queryKey: ['platform-retention-tenant-options'] });
    void queryClient.invalidateQueries({ queryKey: ['platform-dealerships'] });
  }, [queryClient]);

  if (retention.isPending) return <PageSkeleton />;
  if (retention.isError || !retention.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <p className="font-semibold">Data retention controls are unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            A Super Admin AAL2 session and the controlled-retention migrations are required.
          </p>
        </CardContent>
      </Card>
    );

  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <div className="shrink-0 sm:pt-7">
          <Button variant="destructive" onClick={() => setRequestOpen(true)}>
            <Trash2 className="size-4" />
            Request tenant deletion
          </Button>
        </div>
      </div>
      <div className="space-y-6">
        {successMessage && (
          <Alert>
            <AlertTitle>Retention workflow updated</AlertTitle>
            <AlertDescription>{successMessage}</AlertDescription>
          </Alert>
        )}
        <Alert>
          <ShieldAlert className="size-4" />
          <AlertTitle>Controlled deletion boundary</AlertTitle>
          <AlertDescription>
            Tenant access is soft-deleted first. Permanent purge requires dual control, an expired
            retention window, no legal hold, successful Tigris/Auth cleanup, and a final checksum
            manifest. Provider-owned OAuth revocation remains a separately staged adapter action and
            is recorded explicitly in that manifest; local encrypted credentials are still removed.
          </AlertDescription>
        </Alert>
        <KpiGrid metrics={toMetrics(retention.data.kpis)} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarClock className="size-4" />
          Purge execution is handled by the retry-safe scheduled worker; this page never deletes
          provider data directly.
        </div>
        <RetentionTable
          data={retention.data}
          query={query}
          onQueryChange={changeQuery}
          onAction={selectAction}
          isFetching={retention.isFetching}
        />
      </div>
      <RequestDeletionDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        onCompleted={() => {
          setSuccessMessage(
            'Tenant access was suspended and the deletion request awaits approval.',
          );
          refresh();
        }}
      />
      {action && (
        <RetentionActionDialog
          key={`${action.kind}:${action.record.id}`}
          action={action}
          onClose={() => setAction(null)}
          onCompleted={(message) => {
            setSuccessMessage(message);
            refresh();
          }}
        />
      )}
    </div>
  );
}
