'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { Check, ChevronLeft, ChevronRight, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { leadDetailHref } from '@/lib/navigation/record-links';
import type { PageSpec } from '@/lib/domain';
import {
  decideDuplicateLeadDeletion,
  fetchDuplicateLeadDeletionRequests,
  type DuplicateDeletionRequest,
  type DuplicateDeletionStatus,
} from './duplicate-lead-deletion-api';

const statuses: Array<{ value: DuplicateDeletionStatus; label: string }> = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

function shortLeadId(id: string) {
  return `L-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusBadge(status: DuplicateDeletionStatus) {
  if (status === 'APPROVED')
    return <Badge className="bg-emerald-50 text-emerald-700 hover:bg-emerald-50">Approved</Badge>;
  if (status === 'REJECTED')
    return <Badge className="bg-rose-50 text-rose-700 hover:bg-rose-50">Rejected</Badge>;
  return <Badge className="bg-amber-50 text-amber-700 hover:bg-amber-50">Pending</Badge>;
}

type DecisionState = {
  request: DuplicateDeletionRequest;
  decision: 'APPROVED' | 'REJECTED';
} | null;

export function DuplicateLeadDeletionWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const queryScope = workspaceQueryScope(session);
  const [status, setStatus] = useState<DuplicateDeletionStatus>('PENDING');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const [decisionState, setDecisionState] = useState<DecisionState>(null);
  const [reviewNote, setReviewNote] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const canDecide = hasWorkspacePermission(session, 'lead.update');

  const requests = useQuery({
    queryKey: [
      'duplicate-lead-deletion-requests',
      ...queryScope,
      status,
      debouncedSearch,
      page,
      pageSize,
    ],
    queryFn: ({ signal }) =>
      fetchDuplicateLeadDeletionRequests(
        { status, search: debouncedSearch, page, pageSize },
        signal,
      ),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const decide = useMutation({
    mutationFn: () => {
      if (!decisionState) throw new Error('DUPLICATE_DECISION_NOT_READY');
      return decideDuplicateLeadDeletion({
        requestId: decisionState.request.id,
        decision: decisionState.decision,
        reviewNote: reviewNote.trim(),
      });
    },
    onSuccess: async (result) => {
      setDecisionState(null);
      setReviewNote('');
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['duplicate-lead-deletion-requests', ...queryScope],
        }),
        queryClient.invalidateQueries({ queryKey: ['lead-workspace', ...queryScope] }),
        queryClient.invalidateQueries({ queryKey: ['lead-workspace-meta', ...queryScope] }),
        queryClient.invalidateQueries({ queryKey: ['lead-phone-history', ...queryScope] }),
      ]);
      toast.add({
        type: 'success',
        title: result.status === 'APPROVED' ? 'Duplicate lead removed' : 'Request rejected',
        description:
          result.status === 'APPROVED'
            ? 'The duplicate is soft-deleted. The retained lead and audit history are unchanged.'
            : 'The lead remains active and the rejection is recorded.',
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : '';
      toast.add({
        type: 'error',
        title: 'Decision was not saved',
        description: message.includes('LEAD_NO_LONGER_ELIGIBLE')
          ? 'Work has now been recorded on this lead, so it can no longer be removed as an untouched duplicate.'
          : 'The request may already be decided, outside your team scope, or no longer eligible.',
      });
    },
  });

  const openDecision = (request: DuplicateDeletionRequest, decision: 'APPROVED' | 'REJECTED') => {
    setReviewNote('');
    setDecisionState({ request, decision });
  };

  const columns = useMemo<ColumnDef<DuplicateDeletionRequest>[]>(
    () => [
      {
        id: 'duplicate_lead',
        header: 'Duplicate lead',
        cell: ({ row }) => (
          <div className="min-w-40">
            {row.original.status === 'PENDING' ? (
              <Link
                className="font-semibold text-primary hover:underline"
                href={leadDetailHref('team-manager', row.original.lead_id)}
              >
                {shortLeadId(row.original.lead_id)}
              </Link>
            ) : (
              <span className="font-semibold text-muted-foreground">
                {shortLeadId(row.original.lead_id)}
              </span>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.source} · {row.original.interested_model ?? 'No model'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'customer_name',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-40">
            <p className="font-medium">{row.original.customer_name}</p>
            <p className="text-xs text-muted-foreground">{row.original.phone}</p>
          </div>
        ),
      },
      {
        id: 'retained_lead',
        header: 'Lead retained',
        cell: ({ row }) => (
          <div className="min-w-40">
            <Link
              className="font-semibold text-primary hover:underline"
              href={leadDetailHref('team-manager', row.original.retained_lead_id)}
            >
              {shortLeadId(row.original.retained_lead_id)}
            </Link>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.retained_lifecycle_status} · {row.original.retained_source}
            </p>
          </div>
        ),
      },
      {
        id: 'scope',
        header: 'Team',
        cell: ({ row }) => (
          <div className="min-w-36">
            <p>{row.original.team_name ?? 'No team'}</p>
            <p className="text-xs text-muted-foreground">{row.original.branch_name}</p>
          </div>
        ),
      },
      {
        accessorKey: 'reason',
        header: 'Reason',
        cell: ({ row }) => (
          <p className="max-w-64 whitespace-normal text-sm" title={row.original.reason}>
            {row.original.reason}
          </p>
        ),
      },
      {
        id: 'requester',
        header: 'Requested by',
        cell: ({ row }) => (
          <div className="min-w-36">
            <p>{row.original.requester_name}</p>
            <p className="whitespace-nowrap text-xs text-muted-foreground">
              {formatDate(row.original.requested_at)}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <div>
            {statusBadge(row.original.status)}
            {row.original.reviewer_name ? (
              <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                by {row.original.reviewer_name}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) =>
          row.original.status === 'PENDING' && canDecide ? (
            <div className="flex justify-end gap-1">
              <Button
                size="sm"
                variant="outline"
                className="text-rose-700"
                onClick={() => openDecision(row.original, 'REJECTED')}
              >
                <X className="size-4" /> Reject
              </Button>
              <Button size="sm" onClick={() => openDecision(row.original, 'APPROVED')}>
                <Check className="size-4" /> Approve
              </Button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              {row.original.review_note || 'Decision recorded'}
            </span>
          ),
      },
    ],
    [canDecide],
  );

  // TanStack Table returns an imperative model; React Compiler intentionally skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: requests.data?.records ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  const pageCount = Math.max(1, Math.ceil((requests.data?.total ?? 0) / pageSize));
  const rejectNoteInvalid = decisionState?.decision === 'REJECTED' && reviewNote.trim().length < 5;

  if (!canDecide)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <ShieldCheck className="mx-auto size-9 text-muted-foreground" />
          <h1 className="mt-4 font-semibold">Team Manager approval is required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Only a Team Manager with access to the lead&apos;s team can review duplicate deletion
            requests.
          </p>
        </CardContent>
      </Card>
    );

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">
            <Link href="/team-manager/dashboard" className="text-primary hover:underline">
              Dashboard
            </Link>
            <span className="mx-2">›</span>
            <span>{spec.title}</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Duplicate Lead Approvals</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Approve only untouched newer leads that duplicate an earlier lead with the same mobile
            number.
          </p>
        </div>
        <Button variant="outline" disabled={requests.isFetching} onClick={() => requests.refetch()}>
          <RefreshCw className={`size-4 ${requests.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="shadow-none">
          <CardContent className="p-5">
            <p className="text-xs text-muted-foreground">Current queue</p>
            <p className="mt-2 text-2xl font-bold">{requests.data?.total ?? 0}</p>
          </CardContent>
        </Card>
        <Card className="shadow-none sm:col-span-2">
          <CardContent className="flex gap-3 p-5">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-blue-700" />
            <div>
              <p className="text-sm font-semibold">Approval is revalidated at decision time</p>
              <p className="mt-1 text-xs text-muted-foreground">
                If any contact, follow-up, stage change or sales work is added after the request,
                approval is blocked automatically.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1">
              {statuses.map((item) => (
                <Button
                  key={item.value}
                  size="sm"
                  variant={status === item.value ? 'default' : 'ghost'}
                  onClick={() => {
                    setStatus(item.value);
                    setPage(1);
                  }}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <div className="relative w-full lg:w-80">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                className="pl-9"
                placeholder="Search lead, customer, mobile or requester"
              />
            </div>
          </div>

          {requests.isError ? (
            <div className="p-10 text-center">
              <p className="font-semibold">Duplicate requests are unavailable</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Refresh the page or confirm your Team Manager scope.
              </p>
              <Button className="mt-4" variant="outline" onClick={() => requests.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/30">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <TableHead key={header.id} className="whitespace-nowrap text-xs uppercase">
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {requests.isPending ? (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="h-40 text-center">
                        Loading approval requests…
                      </TableCell>
                    </TableRow>
                  ) : table.getRowModel().rows.length ? (
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
                      <TableCell colSpan={columns.length} className="h-40 text-center">
                        No {status.toLowerCase()} duplicate requests.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              Showing {requests.data?.records.length ?? 0} of {requests.data?.total ?? 0} requests
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                size="icon"
                variant="outline"
                className="size-8"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="min-w-16 text-center text-sm">
                {page} / {pageCount}
              </span>
              <Button
                size="icon"
                variant="outline"
                className="size-8"
                disabled={page >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                aria-label="Next page"
              >
                <ChevronRight className="size-4" />
              </Button>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value) as 25 | 50 | 100);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-28">
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
      </Card>

      <Dialog
        open={Boolean(decisionState)}
        onOpenChange={(open) => {
          if (!open && !decide.isPending) {
            setDecisionState(null);
            setReviewNote('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decisionState?.decision === 'APPROVED'
                ? 'Approve duplicate removal?'
                : 'Reject duplicate removal?'}
            </DialogTitle>
            <DialogDescription>
              {decisionState?.decision === 'APPROVED'
                ? `${shortLeadId(decisionState.request.lead_id)} will disappear from active lead lists. It remains recoverable in the database as a soft-deleted duplicate of ${shortLeadId(decisionState.request.retained_lead_id)}.`
                : 'The lead will remain active. Add a short explanation for the requester.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="duplicate-review-note">
              Review note {decisionState?.decision === 'REJECTED' ? '(required)' : '(optional)'}
            </Label>
            <Textarea
              id="duplicate-review-note"
              value={reviewNote}
              maxLength={500}
              rows={4}
              onChange={(event) => setReviewNote(event.target.value)}
              placeholder={
                decisionState?.decision === 'REJECTED'
                  ? 'Explain why this lead must remain active'
                  : 'Optional approval note'
              }
            />
            <p className="text-right text-xs text-muted-foreground">{reviewNote.length}/500</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={decide.isPending}
              onClick={() => setDecisionState(null)}
            >
              Cancel
            </Button>
            <Button
              variant={decisionState?.decision === 'REJECTED' ? 'destructive' : 'default'}
              disabled={decide.isPending || rejectNoteInvalid}
              onClick={() => decide.mutate()}
            >
              {decisionState?.decision === 'APPROVED' ? (
                <Check className="size-4" />
              ) : (
                <X className="size-4" />
              )}
              {decide.isPending
                ? 'Saving…'
                : decisionState?.decision === 'APPROVED'
                  ? 'Approve soft deletion'
                  : 'Reject request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
