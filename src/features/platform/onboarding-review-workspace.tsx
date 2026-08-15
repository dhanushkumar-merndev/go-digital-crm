'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
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
  createOnboardingDocumentDownload,
  fetchOnboardingDocuments,
  fetchOnboardingReviews,
  reviewTenantOnboarding,
  type OnboardingSubmission,
} from './onboarding-review-api';
import {
  parseOnboardingReviewQuery,
  toOnboardingReviewQueryString,
  type OnboardingReviewQuery,
  type OnboardingReviewStatus,
} from './onboarding-review-query';

const statusOptions: Array<{ value: OnboardingReviewStatus; label: string }> = [
  { value: 'all', label: 'All submissions' },
  { value: 'submitted', label: 'Awaiting review' },
  { value: 'changes-required', label: 'Changes required' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function toMetrics(kpis: Awaited<ReturnType<typeof fetchOnboardingReviews>>['kpis']): Metric[] {
  return [
    { label: 'Awaiting review', value: kpis.submitted.toLocaleString(), helper: 'Action required' },
    {
      label: 'Changes required',
      value: kpis.changes_required.toLocaleString(),
      helper: 'Returned to Business Owner',
    },
    { label: 'Approved', value: kpis.approved.toLocaleString(), helper: 'Tenant activated' },
    { label: 'Rejected', value: kpis.rejected.toLocaleString(), helper: 'Closed submissions' },
  ];
}

function ReviewSheet({
  submission,
  onClose,
  onReviewed,
}: {
  submission: OnboardingSubmission | null;
  onClose: () => void;
  onReviewed: () => void;
}) {
  const [decision, setDecision] = useState<'APPROVE' | 'REQUEST_CHANGES' | 'REJECT'>('APPROVE');
  const [reviewNote, setReviewNote] = useState('');
  const [downloadError, setDownloadError] = useState(false);
  const documents = useQuery({
    queryKey: ['platform-onboarding-documents', submission?.id],
    queryFn: () => fetchOnboardingDocuments(submission!.id),
    enabled: Boolean(submission),
  });
  const review = useMutation({
    mutationFn: reviewTenantOnboarding,
    onSuccess: () => {
      onReviewed();
      onClose();
    },
  });
  const noteRequired = decision !== 'APPROVE';
  const dealer = submission?.dealer_information ?? {};

  return (
    <Sheet open={Boolean(submission)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full max-w-2xl overflow-y-auto p-6 sm:w-[620px]">
        <SheetTitle className="pr-10 text-xl">Onboarding evidence review</SheetTitle>
        <SheetDescription className="mt-1">
          Validate dealership identity and private evidence before changing tenant access.
        </SheetDescription>
        {submission && (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
              <div>
                <p className="font-semibold">{submission.organization_name}</p>
                <p className="text-sm text-muted-foreground">{submission.legal_name}</p>
              </div>
              <StatusBadge value={submission.status} />
            </div>

            <div className="grid gap-4 rounded-lg border p-4 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  GST number
                </p>
                <p className="mt-1 font-medium">{submission.gst_number}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Submission
                </p>
                <p className="mt-1 font-medium">
                  Version {submission.version} · {formatDate(submission.submitted_at)}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Registered address
                </p>
                <p className="mt-1">{dealer.registered_address || 'Not supplied'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Dealership licence
                </p>
                <p className="mt-1">{dealer.dealership_license_number || 'Not supplied'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Manufacturers
                </p>
                <p className="mt-1">{dealer.manufacturer_names || 'Not supplied'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Contact phone
                </p>
                <p className="mt-1">{dealer.contact_phone || 'Not supplied'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Contact email
                </p>
                <p className="mt-1 break-all">{dealer.contact_email || 'Not supplied'}</p>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold">Private documents</h3>
              <div className="mt-2 divide-y rounded-lg border">
                {documents.isPending && (
                  <p className="p-4 text-sm text-muted-foreground">Loading documents…</p>
                )}
                {documents.isError && (
                  <p className="p-4 text-sm text-destructive">Documents could not be loaded.</p>
                )}
                {documents.data?.map((document) => (
                  <div key={document.id} className="flex items-center justify-between gap-3 p-3">
                    <div>
                      <p className="text-sm font-medium">
                        {document.document_type.replaceAll('_', ' ')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Uploaded {formatDate(document.created_at)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        setDownloadError(false);
                        try {
                          const download = await createOnboardingDocumentDownload(
                            document.object_file_id,
                          );
                          window.open(download.download_url, '_blank', 'noopener,noreferrer');
                        } catch {
                          setDownloadError(true);
                        }
                      }}
                    >
                      <Download className="size-3.5" />
                      Review
                    </Button>
                  </div>
                ))}
              </div>
              {downloadError && (
                <p className="mt-2 text-sm text-destructive">
                  A secure document link could not be generated. Try again.
                </p>
              )}
            </div>

            {submission.status === 'SUBMITTED' ? (
              <form
                className="space-y-4 rounded-lg border p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (noteRequired && reviewNote.trim().length < 10) return;
                  review.mutate({ submissionId: submission.id, decision, reviewNote });
                }}
              >
                <div className="grid gap-1.5 text-sm font-medium">
                  Decision
                  <Select
                    value={decision}
                    onValueChange={(value) =>
                      setDecision(value as 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT')
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="APPROVE">Approve and activate</SelectItem>
                      <SelectItem value="REQUEST_CHANGES">Request changes</SelectItem>
                      <SelectItem value="REJECT">Reject onboarding</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label className="grid gap-1.5 text-sm font-medium">
                  Review note {noteRequired && <span className="text-destructive">(required)</span>}
                  <Textarea
                    value={reviewNote}
                    onChange={(event) => setReviewNote(event.target.value)}
                    minLength={noteRequired ? 10 : undefined}
                    maxLength={1000}
                    rows={4}
                    placeholder="Record the evidence checked and any correction required."
                  />
                </label>
                {review.isError && (
                  <p className="text-sm text-destructive">
                    The decision was not saved. The submission may already have been reviewed.
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant={decision === 'REJECT' ? 'destructive' : 'default'}
                    disabled={review.isPending || (noteRequired && reviewNote.trim().length < 10)}
                  >
                    {review.isPending ? 'Saving…' : 'Confirm decision'}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="rounded-lg border p-4 text-sm">
                <p className="font-medium">Review completed {formatDate(submission.reviewed_at)}</p>
                <p className="mt-2 text-muted-foreground">
                  {submission.review_note || 'No review note was recorded.'}
                </p>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReviewTable({
  data,
  query,
  onQueryChange,
  onSelect,
  isFetching,
}: {
  data: Awaited<ReturnType<typeof fetchOnboardingReviews>>;
  query: OnboardingReviewQuery;
  onQueryChange: (next: Partial<OnboardingReviewQuery>) => void;
  onSelect: (submission: OnboardingSubmission) => void;
  isFetching: boolean;
}) {
  const columns = useMemo<ColumnDef<OnboardingSubmission>[]>(
    () => [
      { accessorKey: 'organization_name', header: 'Dealership' },
      { accessorKey: 'legal_name', header: 'Legal entity' },
      { accessorKey: 'gst_number', header: 'GST number' },
      {
        accessorKey: 'version',
        header: 'Version',
        cell: ({ getValue }) => `v${String(getValue())}`,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge value={String(getValue())} />,
      },
      {
        accessorKey: 'submitted_at',
        header: 'Submitted',
        cell: ({ getValue }) => (
          <span className="text-xs text-muted-foreground">{formatDate(String(getValue()))}</span>
        ),
      },
      {
        id: 'actions',
        header: 'Action',
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => onSelect(row.original)}>
            {row.original.status === 'SUBMITTED' ? 'Review' : 'View'}
          </Button>
        ),
      },
    ],
    [onSelect],
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
              placeholder="Search dealership, legal name or GST…"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={query.status}
              onValueChange={(status) =>
                onQueryChange({ status: status as OnboardingReviewStatus, page: 1 })
              }
            >
              <SelectTrigger className="w-[180px]">
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
              onValueChange={(sort) =>
                onQueryChange({ sort: sort as OnboardingReviewQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-[178px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="submitted:desc">Submitted: newest</SelectItem>
                <SelectItem value="submitted:asc">Submitted: oldest</SelectItem>
                <SelectItem value="dealership:asc">Dealership: A–Z</SelectItem>
                <SelectItem value="dealership:desc">Dealership: Z–A</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({
                  pageSize: Number(value) as OnboardingReviewQuery['pageSize'],
                  page: 1,
                })
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
                    <p className="font-medium">No onboarding submissions match this view</p>
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

export function OnboardingReviewWorkspace({ spec }: { spec: PageSpec }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  usePlatformRealtimeInvalidation([
    { resource: 'onboarding', queryKeys: [['platform-onboarding-reviews']] },
  ]);
  const [query, setQuery] = useState<OnboardingReviewQuery>(() =>
    parseOnboardingReviewQuery(searchParams),
  );
  const [selected, setSelected] = useState<OnboardingSubmission | null>(null);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const effectiveQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const reviews = useQuery({
    queryKey: ['platform-onboarding-reviews', effectiveQuery],
    queryFn: () => fetchOnboardingReviews(effectiveQuery),
    placeholderData: keepPreviousData,
  });

  const changeQuery = useCallback(
    (next: Partial<OnboardingReviewQuery>) => {
      setQuery((current) => {
        const updated = { ...current, ...next };
        const queryString = toOnboardingReviewQueryString(updated);
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
        return updated;
      });
    },
    [pathname, router],
  );

  if (reviews.isPending) return <PageSkeleton />;
  if (reviews.isError || !reviews.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="p-8 text-center">
            <p className="font-semibold">The onboarding review queue is unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Confirm your Super Admin MFA session and deployed onboarding migrations.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  return (
    <div className="space-y-6">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <KpiGrid metrics={toMetrics(reviews.data.kpis)} />
      <ReviewTable
        data={reviews.data}
        query={query}
        onQueryChange={changeQuery}
        onSelect={setSelected}
        isFetching={reviews.isFetching}
      />
      <ReviewSheet
        key={selected?.id ?? 'closed'}
        submission={selected}
        onClose={() => setSelected(null)}
        onReviewed={() =>
          queryClient.invalidateQueries({ queryKey: ['platform-onboarding-reviews'] })
        }
      />
    </div>
  );
}
