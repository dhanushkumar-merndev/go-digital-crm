'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import { usePlatformRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { fetchDealerships, provisionDealership, type DealershipRecord } from './dealership-api';
import {
  dealershipStatuses,
  parseDealershipQuery,
  toDealershipQueryString,
  toOrganizationSlug,
  type DealershipQuery,
  type DealershipStatus,
} from './dealership-query';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value));
}

function toMetrics(kpis: Awaited<ReturnType<typeof fetchDealerships>>['kpis']): Metric[] {
  return [
    { label: 'Total dealerships', value: kpis.total.toLocaleString(), helper: 'All tenants' },
    { label: 'Active', value: kpis.active.toLocaleString(), helper: 'CRM access enabled' },
    {
      label: 'Onboarding',
      value: kpis.onboarding.toLocaleString(),
      helper: 'Setup or review in progress',
    },
    {
      label: 'Requires attention',
      value: kpis.attention.toLocaleString(),
      helper: 'Suspended, rejected or soft deleted',
    },
  ];
}

function ProvisionDealershipDialog({
  open,
  onOpenChange,
  onProvisioned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProvisioned: () => void;
}) {
  const [organizationName, setOrganizationName] = useState('');
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const mutation = useMutation({
    mutationFn: provisionDealership,
    onSuccess: () => {
      onProvisioned();
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create dealership tenant</DialogTitle>
          <DialogDescription>
            Creates an isolated onboarding tenant and sends a one-time Supabase Auth invitation to
            its initial Business Owner.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            mutation.mutate({
              organizationName,
              organizationSlug,
              legalName: String(form.get('legalName') ?? ''),
              gstNumber: String(form.get('gstNumber') ?? ''),
              ownerName: String(form.get('ownerName') ?? ''),
              ownerEmail: String(form.get('ownerEmail') ?? ''),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Dealership name
            <Input
              value={organizationName}
              onChange={(event) => {
                const value = event.target.value;
                setOrganizationName(value);
                if (!slugEdited) setOrganizationSlug(toOrganizationSlug(value));
              }}
              required
              minLength={2}
              maxLength={160}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Tenant slug
            <Input
              value={organizationSlug}
              onChange={(event) => {
                setSlugEdited(true);
                setOrganizationSlug(toOrganizationSlug(event.target.value));
              }}
              required
              minLength={3}
              maxLength={63}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              autoCapitalize="none"
            />
            <span className="text-xs font-normal text-muted-foreground">
              Permanent lowercase tenant identifier; verify it before creating the tenant.
            </span>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Legal name <span className="font-normal text-muted-foreground">(optional)</span>
            <Input name="legalName" maxLength={200} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            GST number <span className="font-normal text-muted-foreground">(optional)</span>
            <Input
              name="gstNumber"
              maxLength={15}
              pattern="[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][1-9A-Za-z]Z[0-9A-Za-z]"
              className="uppercase"
            />
          </label>
          <div className="mt-1 border-t pt-4">
            <p className="text-sm font-semibold">Initial Business Owner</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This identity must complete password setup and TOTP MFA before onboarding.
            </p>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Owner name
            <Input name="ownerName" required minLength={2} maxLength={160} autoComplete="name" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Owner email
            <Input name="ownerEmail" type="email" required maxLength={254} autoComplete="email" />
          </label>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>Tenant was not created</AlertTitle>
              <AlertDescription>
                Check the unique slug, owner email, and required environment configuration. No
                usable orphan invitation is retained when provisioning fails.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={organizationSlug.length < 3 || mutation.isPending}>
              {mutation.isPending ? 'Creating and inviting…' : 'Create tenant & invite owner'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DealershipTable({
  data,
  query,
  onQueryChange,
  isFetching,
}: {
  data: Awaited<ReturnType<typeof fetchDealerships>>;
  query: DealershipQuery;
  onQueryChange: (next: Partial<DealershipQuery>) => void;
  isFetching: boolean;
}) {
  const columns = useMemo<ColumnDef<DealershipRecord>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Dealership',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.name}</p>
            <p className="text-xs text-muted-foreground">{row.original.slug}</p>
          </div>
        ),
      },
      {
        accessorKey: 'legal_name',
        header: 'Legal entity',
        cell: ({ getValue }) => String(getValue() ?? '—'),
      },
      {
        accessorKey: 'owner_name',
        header: 'Business Owner',
        cell: ({ row }) => (
          <div>
            <p>{row.original.owner_name ?? 'Not assigned'}</p>
            <p className="text-xs text-muted-foreground">{row.original.owner_email ?? '—'}</p>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Tenant status',
        cell: ({ getValue }) => <StatusBadge value={String(getValue())} />,
      },
      {
        accessorKey: 'created_at',
        header: 'Created',
        cell: ({ getValue }) => (
          <span className="text-xs text-muted-foreground">{formatDate(String(getValue()))}</span>
        ),
      },
      {
        id: 'action',
        header: 'Action',
        cell: ({ row }) =>
          row.original.status === 'UNDER_REVIEW' ? (
            <Button asChild size="sm" variant="outline">
              <Link
                href={`/super-admin/onboarding-reviews?q=${encodeURIComponent(row.original.name)}`}
              >
                Review
              </Link>
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Managed by status workflow</span>
          ),
      },
    ],
    [],
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
              placeholder="Search dealership, slug, legal name or GST…"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={query.status}
              onValueChange={(status) =>
                onQueryChange({ status: status as DealershipStatus, page: 1 })
              }
            >
              <SelectTrigger className="w-[185px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dealershipStatuses.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status === 'all'
                      ? 'All statuses'
                      : status.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase())}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(sort) =>
                onQueryChange({ sort: sort as DealershipQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-[165px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created:desc">Created: newest</SelectItem>
                <SelectItem value="created:asc">Created: oldest</SelectItem>
                <SelectItem value="name:asc">Name: A–Z</SelectItem>
                <SelectItem value="name:desc">Name: Z–A</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as DealershipQuery['pageSize'], page: 1 })
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
                      <TableCell key={cell.id} className="whitespace-nowrap">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <p className="font-medium">No dealerships match this view</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Try another tenant status or page-local search.
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

export function DealershipWorkspace({ spec }: { spec: PageSpec }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  usePlatformRealtimeInvalidation([
    { resource: 'dealerships', queryKeys: [['platform-dealerships']] },
  ]);
  const [query, setQuery] = useState<DealershipQuery>(() => parseDealershipQuery(searchParams));
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const dealerships = useQuery({
    queryKey: ['platform-dealerships', requestQuery],
    queryFn: () => fetchDealerships(requestQuery),
    placeholderData: keepPreviousData,
  });
  const changeQuery = useCallback(
    (next: Partial<DealershipQuery>) => {
      setQuery((current) => {
        const updated = { ...current, ...next };
        const queryString = toDealershipQueryString(updated);
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
        return updated;
      });
    },
    [pathname, router],
  );

  if (dealerships.isPending) return <PageSkeleton />;
  if (dealerships.isError || !dealerships.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <p className="font-semibold">Dealership management is unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            A Super Admin AAL2 session and the platform workspace migration are required.
          </p>
        </CardContent>
      </Card>
    );

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <div className="shrink-0 sm:pt-7">
          <Button onClick={() => setProvisionOpen(true)}>
            <Plus className="size-4" />
            Add dealership
          </Button>
        </div>
      </div>
      <div className="space-y-6">
        {inviteSent && (
          <Alert>
            <AlertTitle>Tenant created</AlertTitle>
            <AlertDescription>
              The Business Owner invitation was sent. CRM access remains gated until MFA, onboarding
              evidence, and Super Admin approval are complete.
            </AlertDescription>
          </Alert>
        )}
        <KpiGrid metrics={toMetrics(dealerships.data.kpis)} />
        <DealershipTable
          data={dealerships.data}
          query={query}
          onQueryChange={changeQuery}
          isFetching={dealerships.isFetching}
        />
      </div>
      <ProvisionDealershipDialog
        open={provisionOpen}
        onOpenChange={setProvisionOpen}
        onProvisioned={() => {
          setInviteSent(true);
          void queryClient.invalidateQueries({ queryKey: ['platform-dealerships'] });
        }}
      />
    </div>
  );
}
