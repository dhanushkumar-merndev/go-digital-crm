'use client';

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Coins,
  Plus,
  ScrollText,
  Search,
  Sparkles,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { StatusBadge } from '@/components/shared/status-badge';
import { PlatformAiUsageSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
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
  fetchPlatformAiCreditLedger,
  fetchPlatformAiUsage,
  grantPlatformAiCredits,
  type PlatformAiCreditLedgerCursor,
  type PlatformAiUsage,
} from './platform-ai-usage-workspace-api';
import {
  classifyPlatformAiCreditAllocationFailure,
  platformAiCreditAllocationFailureDescription,
} from './platform-ai-usage-query';

type Organization = PlatformAiUsage['organizations'][number];

function requestId() {
  return globalThis.crypto.randomUUID();
}

function formatCreditEntryDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function CreditAllocationDialog({
  organization,
  onClose,
}: {
  organization: Organization;
  onClose: () => void;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [allocationRequestId, setAllocationRequestId] = useState(requestId);
  const [prevOrgId, setPrevOrgId] = useState(organization.id);
  if (prevOrgId !== organization.id) {
    setPrevOrgId(organization.id);
    setAmount('');
    setReason('');
    setAllocationRequestId(requestId());
  }
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: grantPlatformAiCredits,
    onSuccess: async (result) => {
      toast.add({
        type: 'success',
        title: 'AI credits added',
        description: `${result.amount.toLocaleString()} credits allocated to ${organization.name}.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['platform-ai-usage-workspace'] });
      await queryClient.invalidateQueries({
        queryKey: ['platform-ai-credit-ledger', organization.id],
      });
      onClose();
    },
    onError: (error) => {
      const failure = classifyPlatformAiCreditAllocationFailure(error);
      toast.add({
        type: 'error',
        title:
          failure === 'UNKNOWN' ? 'AI credit allocation not confirmed' : 'AI credits not added',
        description: platformAiCreditAllocationFailureDescription(failure),
        actionProps:
          failure === 'MFA_REQUIRED'
            ? {
                children: 'Verify MFA',
                onClick: () => router.push('/access/mfa'),
              }
            : undefined,
      });
      if (failure === 'ORGANIZATION_NOT_ACTIVE') {
        void queryClient.invalidateQueries({ queryKey: ['platform-ai-usage-workspace'] });
        onClose();
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add AI credits</DialogTitle>
          <DialogDescription>
            Add an immutable platform-funded AI-credit allocation to {organization.name}. This
            action is audited and cannot be edited or deleted.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({
              organizationId: organization.id,
              amount: Number(amount),
              reason,
              requestId: allocationRequestId,
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Credits
            <Input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              type="number"
              min={1}
              max={1_000_000}
              step={1}
              inputMode="numeric"
              placeholder="Example: 500"
              required
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Allocation reason
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={5}
              maxLength={500}
              placeholder="Example: August AI-credit package"
              required
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              <Plus className="size-4" />
              {mutation.isPending ? 'Adding…' : 'Add credits'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreditLedgerSheet({
  organization,
  onClose,
}: {
  organization: Organization;
  onClose: () => void;
}) {
  const [cursorHistory, setCursorHistory] = useState<Array<PlatformAiCreditLedgerCursor | null>>([
    null,
  ]);
  const [prevOrgId, setPrevOrgId] = useState(organization.id);
  if (prevOrgId !== organization.id) {
    setPrevOrgId(organization.id);
    setCursorHistory([null]);
  }
  const cursor = cursorHistory[cursorHistory.length - 1] ?? null;
  const page = cursorHistory.length;
  const query = useQuery({
    queryKey: ['platform-ai-credit-ledger', organization.id, cursor],
    queryFn: ({ signal }) =>
      fetchPlatformAiCreditLedger({ organizationId: organization.id, cursor, signal }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full max-w-3xl overflow-y-auto sm:w-[720px]">
        <SheetHeader>
          <SheetTitle>{organization.name} · AI credit ledger</SheetTitle>
          <SheetDescription>
            Append-only ledger history. Current balance: {data?.balance.toLocaleString() ?? '…'}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-5">
          {query.isError ? (
            <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
              Ledger is unavailable. Confirm Super Admin MFA access and deploy the credit migration.
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Credits</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatCreditEntryDate(entry.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={entry.amount > 0 ? 'success' : 'secondary'}>
                        {entry.transaction_type}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className={entry.amount > 0 ? 'font-medium text-emerald-700' : 'font-medium'}
                    >
                      {entry.amount > 0 ? '+' : ''}
                      {entry.amount.toLocaleString()}
                    </TableCell>
                    <TableCell className="min-w-48 text-sm">{entry.reason}</TableCell>
                  </TableRow>
                ))}
                {data && !data.entries.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No AI-credit activity yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || query.isFetching}
              onClick={() => setCursorHistory((value) => value.slice(0, -1))}
            >
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <span className="text-xs text-muted-foreground">Page {page} · cursor-paginated</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.has_more || !data.next_cursor || query.isFetching}
              onClick={() => {
                if (data?.next_cursor) {
                  setCursorHistory((value) => [...value, data.next_cursor]);
                }
              }}
            >
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function PlatformAiUsageWorkspace({ spec }: { spec: PageSpec }) {
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [allocationOrganization, setAllocationOrganization] = useState<Organization | null>(null);
  const [ledgerOrganization, setLedgerOrganization] = useState<Organization | null>(null);
  const search = useDebouncedValue(searchInput, 300);
  const query = useQuery({
    queryKey: ['platform-ai-usage-workspace', days, page, search],
    queryFn: ({ signal }) => fetchPlatformAiUsage({ days, page, search, signal }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const metrics: Metric[] = data
    ? [
        {
          label: `AI credits used · ${data.days}d`,
          value: data.kpis.used_period.toLocaleString(),
          icon: BrainCircuit,
        },
        { label: 'AI credits remaining', value: data.kpis.remaining.toLocaleString(), icon: Coins },
        { label: 'Credits allocated', value: data.kpis.allocated.toLocaleString(), icon: Sparkles },
        { label: 'Average daily usage', value: data.kpis.average_daily_usage.toLocaleString() },
      ]
    : [];
  const hasNext = Boolean(data && page * 25 < data.total);

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">Platform › Credits</div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Immutable platform-wide AI-credit ledger activity. New allocations are available only
            for Active or Support Maintenance dealerships. Cost is intentionally not estimated
            because no rate card is stored.
          </p>
        </div>
        <Select
          value={String(days)}
          onValueChange={(value) => {
            setDays(Number(value) as 7 | 14 | 30);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="14">Last 14 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {query.isPending ? <PlatformAiUsageSkeleton /> : null}
      {data ? <KpiGrid metrics={metrics} className="xl:grid-cols-4" /> : null}
      {data ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">AI credit usage over time</CardTitle>
              <CardDescription>Consumption recorded by day</CardDescription>
            </CardHeader>
            <CardContent>
              <EChart kind="line" data={data.daily} className="h-[300px]" />
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Usage by feature</CardTitle>
              <CardDescription>Only recorded ledger feature labels</CardDescription>
            </CardHeader>
            <CardContent>
              <EChart kind="donut" data={data.features} className="h-[300px]" />
            </CardContent>
          </Card>
        </div>
      ) : null}
      <Card className="shadow-none">
        <CardContent className="p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
                setPage(1);
              }}
              className="pl-9"
              placeholder="Search dealership"
              aria-label="Search dealership AI usage"
            />
          </div>
        </CardContent>
      </Card>
      {query.isError ? (
        <Card className="shadow-none">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            AI usage data is unavailable. Confirm Super Admin MFA access and deploy the AI usage
            migration.
          </CardContent>
        </Card>
      ) : null}
      {data ? (
        <Card className="overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle className="text-base">AI usage by dealership</CardTitle>
            <CardDescription>25 dealerships per server page</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dealership</TableHead>
                  <TableHead>Credits used · {data.days}d</TableHead>
                  <TableHead>Daily average</TableHead>
                  <TableHead>AI credit balance</TableHead>
                  <TableHead>Dealership status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.organizations.map((organization) => (
                  <TableRow key={organization.id}>
                    <TableCell className="font-medium">{organization.name}</TableCell>
                    <TableCell>{organization.used_period.toLocaleString()}</TableCell>
                    <TableCell>{organization.daily_average.toLocaleString()}</TableCell>
                    <TableCell>{organization.balance.toLocaleString()}</TableCell>
                    <TableCell>
                      <StatusBadge value={organization.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setLedgerOrganization(organization)}
                        >
                          <ScrollText className="size-4" /> Ledger
                        </Button>
                        <Button
                          size="sm"
                          disabled={!organization.credit_allocation_allowed}
                          title={
                            organization.credit_allocation_allowed
                              ? 'Add AI credits'
                              : 'Available after dealership activation'
                          }
                          onClick={() => setAllocationOrganization(organization)}
                        >
                          <Plus className="size-4" /> Add credits
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!data.organizations.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No dealerships match this server-side search.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
          <CardContent className="flex items-center justify-between border-t py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || query.isFetching}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <p className="text-xs text-muted-foreground">
              Page {page} · {data.total} dealerships
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || query.isFetching}
              onClick={() => setPage((value) => value + 1)}
            >
              Next <ChevronRight className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {allocationOrganization ? (
        <CreditAllocationDialog
          organization={allocationOrganization}
          onClose={() => setAllocationOrganization(null)}
        />
      ) : null}
      {ledgerOrganization ? (
        <CreditLedgerSheet
          organization={ledgerOrganization}
          onClose={() => setLedgerOrganization(null)}
        />
      ) : null}
    </div>
  );
}
