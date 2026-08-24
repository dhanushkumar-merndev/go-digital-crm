'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Check, Search, TriangleAlert } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { RoleKey } from '@/config/navigation/types';
import { SalesEscalationSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  fetchSalesEscalationPermissions,
  fetchSalesEscalationWorkspace,
  resolveSalesEscalation,
  type SalesEscalationRecord,
} from './sales-escalation-api';
import {
  parseSalesEscalationQuery,
  salesEscalationPageSizes,
  salesEscalationSeverities,
  salesEscalationSorts,
  salesEscalationStatuses,
  toSalesEscalationQueryString,
  type SalesEscalationQuery,
} from './sales-escalation-query';

const workspaceKey = ['sales-escalations'] as const;

function dateTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function severityVariant(value: SalesEscalationRecord['severity']) {
  if (value === 'CRITICAL') return 'destructive' as const;
  if (value === 'HIGH') return 'warning' as const;
  if (value === 'MEDIUM') return 'info' as const;
  return 'secondary' as const;
}

function statusVariant(value: SalesEscalationRecord['status']) {
  return value === 'OPEN' ? ('warning' as const) : ('success' as const);
}

function ResolveEscalationDialog({
  record,
  canResolve,
  open,
  onOpenChange,
  onResolved,
}: {
  record: SalesEscalationRecord | null;
  canResolve: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: () => void;
}) {
  const [resolution, setResolution] = useState('');
  const mutation = useMutation({
    mutationFn: () => {
      if (!record) throw new Error('ESCALATION_NOT_SELECTED');
      return resolveSalesEscalation({
        escalationId: record.id,
        expectedVersion: record.version,
        resolution: resolution.trim(),
        requestId: crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      setResolution('');
      onOpenChange(false);
      onResolved();
      toast.add({
        type: 'success',
        title: 'Escalation resolved',
        description: 'The resolution is saved in the auditable manager queue.',
      });
    },
    onError: (error) => {
      toast.add({
        type: 'error',
        title: 'Escalation was not resolved',
        description:
          error instanceof Error && error.message === 'SALES_ESCALATION_VERSION_CONFLICT'
            ? 'This escalation changed in another session. Refresh and try again.'
            : 'Check your scope and resolution note, then try again.',
      });
    },
  });
  const isOpen = record?.status === 'OPEN';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setResolution('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Escalation details</DialogTitle>
          <DialogDescription>
            {record ? `${record.reference} · ${record.customer_name}` : 'Select an escalation'}
          </DialogDescription>
        </DialogHeader>
        {record && (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={severityVariant(record.severity)}>
                  {titleCase(record.severity)}
                </Badge>
                <Badge variant={statusVariant(record.status)}>{titleCase(record.status)}</Badge>
                <span className="text-xs text-muted-foreground">{record.resource_label}</span>
              </div>
              <p className="mt-3 font-medium">{record.reason}</p>
              {record.subject && <p className="mt-1 text-muted-foreground">{record.subject}</p>}
              <p className="mt-3 text-xs text-muted-foreground">
                Owner: {record.assigned_user_name ?? 'Unassigned'}
                {record.team_name ? ` · ${record.team_name}` : ''}
              </p>
            </div>
            {isOpen && canResolve && (
              <div className="space-y-2">
                <label htmlFor="sales-escalation-resolution" className="text-sm font-medium">
                  Resolution note
                </label>
                <Textarea
                  id="sales-escalation-resolution"
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  minLength={5}
                  maxLength={2000}
                  placeholder="Describe the decision, customer action, or next accountable step."
                  className="min-h-28"
                />
                <p className="text-xs text-muted-foreground">
                  At least 5 characters. This note is auditable.
                </p>
              </div>
            )}
            {!isOpen && (
              <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                Resolved {dateTime(record.resolved_at)}.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {isOpen && canResolve && (
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || resolution.trim().length < 5}
            >
              <Check className="mr-2 size-4" />
              Mark resolved
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SalesEscalationWorkspace({ role }: { role: RoleKey }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const query = useMemo(() => parseSalesEscalationQuery(searchParams), [searchParams]);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const [selected, setSelected] = useState<SalesEscalationRecord | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const permissions = useQuery({
    queryKey: ['sales-escalation-permissions'],
    queryFn: fetchSalesEscalationPermissions,
    staleTime: 60_000,
  });
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const workspace = useQuery({
    queryKey: [
      workspaceKey,
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      requestQuery,
    ],
    queryFn: ({ signal }) => fetchSalesEscalationWorkspace(requestQuery, signal),
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  const updateQuery = useCallback(
    (next: Partial<SalesEscalationQuery>) => {
      const updated = { ...query, ...next };
      const nextSearch = toSalesEscalationQueryString(updated);
      router.replace(nextSearch ? `${pathname}?${nextSearch}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );
  const columns = useMemo<ColumnDef<SalesEscalationRecord>[]>(
    () => [
      {
        accessorKey: 'reference',
        header: 'Reference',
        cell: ({ row }) => (
          <button
            type="button"
            className="text-left font-semibold text-blue-700 hover:underline"
            onClick={() => {
              setSelected(row.original);
              setDialogOpen(true);
            }}
          >
            {row.original.reference}
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              {row.original.resource_label}
            </span>
          </button>
        ),
      },
      {
        accessorKey: 'customer_name',
        header: 'Customer',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.customer_name}</p>
            <p className="text-xs text-muted-foreground">{row.original.team_name ?? 'No team'}</p>
          </div>
        ),
      },
      {
        accessorKey: 'reason',
        header: 'Escalation',
        cell: ({ row }) => (
          <p className="max-w-xs truncate" title={row.original.reason}>
            {row.original.reason}
          </p>
        ),
      },
      {
        accessorKey: 'severity',
        header: 'Severity',
        cell: ({ getValue }) => {
          const value = getValue() as SalesEscalationRecord['severity'];
          return <Badge variant={severityVariant(value)}>{titleCase(value)}</Badge>;
        },
      },
      {
        accessorKey: 'assigned_user_name',
        header: 'Owner',
        cell: ({ getValue }) => String(getValue() ?? 'Unassigned'),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => {
          const value = getValue() as SalesEscalationRecord['status'];
          return <Badge variant={statusVariant(value)}>{titleCase(value)}</Badge>;
        },
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">{dateTime(String(getValue()))}</span>
        ),
      },
    ],
    [],
  );
  // TanStack Table exposes an imperative row model; React Compiler intentionally skips it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: workspace.data?.records ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: workspace.data?.total ?? 0,
  });
  const pages = Math.max(1, Math.ceil((workspace.data?.total ?? 0) / query.pageSize));
  const roleLabel =
    role === 'gm-sales' ? 'GM Sales' : role === 'showroom-manager' ? 'Showroom' : 'Team';

  if (permissions.isLoading || workspace.isLoading) return <SalesEscalationSkeleton />;
  if (permissions.isError || workspace.isError || !workspace.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <TriangleAlert className="mx-auto size-8 text-destructive" />
          <h1 className="mt-4 font-semibold">Escalations are unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your role may not have escalation access, or the latest data could not be loaded.
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void workspace.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );

  const kpis = workspace.data.kpis;
  const canResolve = permissions.data?.canResolve ?? false;
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div>
        <div className="mb-2 text-xs">
          <span className="text-primary">Dashboard</span>
          <span className="mx-2 text-muted-foreground">›</span>
          <span className="text-muted-foreground">Escalations</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Sales escalations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {roleLabel} exceptions that need a named manager decision, in your authorized scope.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ['Open', kpis.open, 'Awaiting a manager decision'],
          ['Critical', kpis.critical, 'Immediate attention'],
          ['High priority', kpis.high, 'Needs same-day review'],
          ['Unassigned', kpis.unassigned, 'No accountable owner'],
          ['Resolved today', kpis.resolved_today, 'Completed in this scope'],
        ].map(([label, value, helper]) => (
          <Card key={String(label)} className="shadow-none">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 text-2xl font-bold">{value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="gap-3 border-b p-4 lg:flex-row lg:items-center">
          <CardTitle className="mr-auto text-base">Escalation queue</CardTitle>
          <div className="grid gap-2 sm:grid-cols-2 lg:flex">
            <div className="relative min-w-0 lg:w-64">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={query.search}
                maxLength={160}
                onChange={(event) => updateQuery({ search: event.target.value, page: 1 })}
                placeholder="Reference, customer or owner"
              />
            </div>
            <Select
              value={query.status}
              onValueChange={(value) =>
                updateQuery({ status: value as SalesEscalationQuery['status'], page: 1 })
              }
            >
              <SelectTrigger className="lg:w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {salesEscalationStatuses.map((value) => (
                  <SelectItem key={value} value={value}>
                    {titleCase(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.severity}
              onValueChange={(value) =>
                updateQuery({ severity: value as SalesEscalationQuery['severity'], page: 1 })
              }
            >
              <SelectTrigger className="lg:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {salesEscalationSeverities.map((value) => (
                  <SelectItem key={value} value={value}>
                    {titleCase(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(value) =>
                updateQuery({ sort: value as SalesEscalationQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="lg:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {salesEscalationSorts.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value === 'updated:desc'
                      ? 'Recently updated'
                      : value === 'created:desc'
                        ? 'Recently created'
                        : 'Severity first'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {table.getFlatHeaders().map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!table.getRowModel().rows.length && (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-32 text-center text-muted-foreground"
                  >
                    No escalations match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center">
          <span className="text-muted-foreground">
            {workspace.data.total} escalation{workspace.data.total === 1 ? '' : 's'} in scope
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                updateQuery({
                  pageSize: Number(value) as SalesEscalationQuery['pageSize'],
                  page: 1,
                })
              }
            >
              <SelectTrigger className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {salesEscalationPageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="whitespace-nowrap text-muted-foreground">
              Page {query.page} of {pages}
            </span>
            <Button
              variant="outline"
              size="icon"
              disabled={query.page <= 1}
              onClick={() => updateQuery({ page: query.page - 1 })}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              disabled={query.page >= pages}
              onClick={() => updateQuery({ page: query.page + 1 })}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </Card>
      <ResolveEscalationDialog
        record={selected}
        open={dialogOpen}
        canResolve={canResolve}
        onOpenChange={setDialogOpen}
        onResolved={() => {
          void queryClient.invalidateQueries({ queryKey: workspaceKey });
          setSelected(null);
        }}
      />
    </div>
  );
}
