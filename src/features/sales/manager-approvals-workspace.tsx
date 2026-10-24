'use client';

import { CircleCheck, CircleX, Clock3, Hourglass, WalletCards } from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { formatCurrency, formatNumber } from '@/lib/format';
import { ErrorState, EmptyState } from '@/components/shared/page-states';
import type { PageSpec } from '@/lib/domain';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { TablePagination, type TablePageSize } from '@/components/shared/table-pagination';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, Search, X, ShieldAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { ManagerApprovalsSkeleton } from '@/components/skeletons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  decideQuotationApproval,
  fetchQuotationApprovalSummary,
  fetchSalesDocumentWorkspace,
  type QuotationRecord,
} from './sales-document-api';
import { defaultSalesDocumentQuery } from './sales-document-query';

function dateTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function discountOf(record: QuotationRecord) {
  return record.items.reduce((total, item) => total + Math.abs(Math.min(item.adjustment, 0)), 0);
}

export function ManagerApprovalsWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const queryScope = workspaceQueryScope(session);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<TablePageSize>(25);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const requestId = useRef<string | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300);
  const query = useQuery({
    queryKey: ['manager-approvals', ...queryScope, debouncedSearch, page, pageSize],
    queryFn: ({ signal }) =>
      fetchSalesDocumentWorkspace(
        'quotations',
        {
          ...defaultSalesDocumentQuery(),
          status: 'pending-approval',
          search: debouncedSearch,
          page,
          pageSize,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const summary = useQuery({
    queryKey: ['manager-approvals', ...queryScope, 'summary'],
    queryFn: ({ signal }) => fetchQuotationApprovalSummary(signal),
    staleTime: 30_000,
  });
  const records = useMemo(() => query.data?.records ?? [], [query.data]);
  const selected = useMemo(
    () => records.find((record) => record.id === selectedId) ?? records[0] ?? null,
    [records, selectedId],
  );
  const canDecide = hasWorkspacePermission(session, 'approval.decide');
  const decide = useMutation({
    meta: { toast: false },
    mutationFn: (decision: 'APPROVED' | 'REJECTED') => {
      if (!selected) throw new Error('APPROVAL_NOT_READY');
      requestId.current ??= crypto.randomUUID();
      return decideQuotationApproval({
        quotationId: selected.id,
        expectedVersion: selected.version,
        decision,
        comment: comment.trim(),
        requestId: requestId.current,
      });
    },
    onSuccess: async (_, decision) => {
      requestId.current = null;
      setComment('');
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: ['manager-approvals'] });
      await queryClient.invalidateQueries({
        queryKey: ['sales-document-workspace', ...queryScope],
      });
      toast.add({
        type: 'success',
        title: decision === 'APPROVED' ? 'Discount approved' : 'Discount rejected',
        description: 'The quotation decision is saved and audited.',
      });
    },
    onError: () => {
      requestId.current = null;
      toast.add({
        type: 'error',
        title: 'Decision was not saved',
        description:
          'The quotation may have changed, be outside scope, or require a different approver.',
      });
    },
  });

  if (!canDecide)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <EmptyState
          icon={ShieldAlert}
          title="Approval permission is required"
          description="Your current role can view sales work but cannot make approval decisions."
        />
      </PageShell>
    );
  if (query.isPending) return <ManagerApprovalsSkeleton />;
  if (query.isError)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState title="Approvals are unavailable" onRetry={() => void query.refetch()} />
      </PageShell>
    );

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description="Quotation discounts waiting for your decision. A request always needs an approver other than the person who raised it."
      />
      <KpiGrid
        metrics={[
          {
            label: 'Pending requests',
            value: formatNumber(query.data?.total ?? 0),
            helper: 'Quotation discounts awaiting a decision',
            icon: Clock3,
            tone: 'amber',
          },
          {
            label: 'Waiting over a day',
            value: summary.data ? formatNumber(summary.data.waiting_over_day) : '—',
            helper: 'Requested more than 24 hours ago',
            icon: Hourglass,
            tone: 'rose',
          },
          {
            label: 'Approved today',
            value: summary.data ? formatNumber(summary.data.approved_today) : '—',
            helper: 'Discounts approved since midnight',
            icon: CircleCheck,
            tone: 'emerald',
          },
          {
            label: 'Rejected today',
            value: summary.data ? formatNumber(summary.data.rejected_today) : '—',
            helper: 'Discounts rejected since midnight',
            icon: CircleX,
            tone: 'orange',
          },
          {
            // Across the whole pending queue, not only the rows on screen.
            label: 'Discount requested',
            value: summary.data ? formatCurrency(summary.data.discount_requested) : '—',
            helper: 'Total discount awaiting a decision',
            icon: WalletCards,
            tone: 'violet',
          },
        ]}
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="overflow-hidden shadow-none">
          <CardHeader className="border-b">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Search quotation, customer or mobile"
              />
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Quotation</th>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Consultant</th>
                  <th className="px-4 py-3 font-medium">Discount</th>
                  <th className="px-4 py-3 font-medium">Value</th>
                  <th className="px-4 py-3 font-medium">Requested</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr
                    key={record.id}
                    className={`border-b last:border-0 ${selected?.id === record.id ? 'bg-blue-50/70' : ''}`}
                  >
                    <td className="px-4 py-3 font-semibold">{record.quotation_number}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{record.customer_name}</p>
                      <p className="text-xs text-muted-foreground">{record.phone ?? 'No phone'}</p>
                    </td>
                    <td className="px-4 py-3">{record.assigned_user_name}</td>
                    <td className="px-4 py-3 text-rose-600">
                      {formatCurrency(discountOf(record))}
                    </td>
                    <td className="px-4 py-3 font-medium">{formatCurrency(record.total_amount)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {dateTime(record.updated_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        onClick={() => setSelectedId(record.id)}
                        aria-label="View request"
                      >
                        <Eye className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
                {!records.length && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      No pending quotation approvals in your current scope.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={query.data?.total ?? 0}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </Card>
        <Card className="h-fit shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Request details</CardTitle>
            <CardDescription>
              {selected ? selected.quotation_number : 'Select a request'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected ? (
              <>
                <div className="rounded-lg border p-3">
                  <p className="font-semibold">{selected.customer_name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {selected.interested_model ?? 'Model not recorded'} · {selected.branch_name}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Requested by {selected.assigned_user_name}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">On-road price</p>
                    <p className="mt-1 font-semibold">{formatCurrency(selected.total_amount)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Requested discount</p>
                    <p className="mt-1 font-semibold text-rose-600">
                      {formatCurrency(discountOf(selected))}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="approval-comment">
                    Decision comment {''}
                    <span className="font-normal text-muted-foreground">
                      (required when rejecting)
                    </span>
                  </Label>
                  <Textarea
                    id="approval-comment"
                    value={comment}
                    maxLength={500}
                    rows={4}
                    onChange={(event) => {
                      requestId.current = null;
                      setComment(event.target.value);
                    }}
                    placeholder="Explain the decision for the sales consultant."
                  />
                </div>
                <div className="grid gap-2">
                  <Button disabled={decide.isPending} onClick={() => decide.mutate('APPROVED')}>
                    <Check className="size-4" /> Approve discount
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decide.isPending || !comment.trim()}
                    onClick={() => decide.mutate('REJECTED')}
                  >
                    <X className="size-4" /> Reject with reason
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  This runs the audited quotation approval transaction. Unsupported approval types
                  are intentionally not displayed here.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Choose a pending request to review the real quotation value and discounts.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
