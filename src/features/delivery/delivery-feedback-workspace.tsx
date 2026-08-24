'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Star,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  workspaceQueryScope,
  useWorkspaceSession,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { DeliveryFeedbackSkeleton } from '@/components/skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import {
  captureDeliveryFeedback,
  deliveryFeedbackPageSizes,
  deliveryFeedbackStatuses,
  fetchDeliveryFeedbackWorkspace,
  requestDeliveryFeedback,
  type DeliveryFeedbackPageSize,
  type DeliveryFeedbackRecord,
  type DeliveryFeedbackStatus,
} from './delivery-feedback-workspace-api';

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function ratingLabel(value: number | null) {
  return value === null ? '—' : `${value.toFixed(1)} / 5`;
}

function requestError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('DELIVERY_FEEDBACK_ALREADY_COMPLETED'))
    return 'Feedback has already been captured for this delivery.';
  if (message.includes('DELIVERY_FEEDBACK_VERSION_CONFLICT'))
    return 'This feedback record changed in another session. Refresh before capturing it.';
  if (message.includes('DELIVERY_FEEDBACK_REQUEST_REQUIRED'))
    return 'Create the feedback follow-up first, then capture the response.';
  return 'The delivery or feedback record may have changed, or is outside your authorized branch scope.';
}

export function DeliveryFeedbackWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const queryScope = workspaceQueryScope(session);
  const [status, setStatus] = useState<DeliveryFeedbackStatus>('PENDING');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<DeliveryFeedbackPageSize>(25);
  const [captureTarget, setCaptureTarget] = useState<DeliveryFeedbackRecord | null>(null);
  const [rating, setRating] = useState('5');
  const [comments, setComments] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const query = useQuery({
    queryKey: ['delivery-feedback', ...queryScope, status, debouncedSearch, page, pageSize],
    queryFn: ({ signal }) =>
      fetchDeliveryFeedbackWorkspace({ status, search: debouncedSearch, page, pageSize }, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['delivery-feedback'] });
  };
  const requestMutation = useMutation({
    mutationFn: (record: DeliveryFeedbackRecord) =>
      requestDeliveryFeedback({
        deliveryCaseId: record.delivery_case_id,
        channel: 'MANUAL',
        requestId: crypto.randomUUID(),
      }),
    onSuccess: async () => {
      await invalidate();
      toast.add({
        type: 'success',
        title: 'Feedback follow-up created',
        description: 'No provider message was sent. Record the customer response after contact.',
      });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Feedback follow-up was not created',
        description: requestError(error),
      }),
  });
  const captureMutation = useMutation({
    mutationFn: () => {
      if (!captureTarget) throw new Error('DELIVERY_FEEDBACK_REQUEST_REQUIRED');
      return captureDeliveryFeedback({
        deliveryCaseId: captureTarget.delivery_case_id,
        expectedVersion: captureTarget.version,
        rating: Number(rating),
        comments,
        requestId: crypto.randomUUID(),
      });
    },
    onSuccess: async () => {
      setCaptureTarget(null);
      setComments('');
      await invalidate();
      toast.add({
        type: 'success',
        title: 'Feedback captured',
        description: 'The delivery feedback record and audit trail were updated.',
      });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Feedback was not captured',
        description: requestError(error),
      }),
  });
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize));
  const metrics = useMemo(() => {
    const kpis = query.data?.kpis;
    if (!kpis) return [];
    return [
      {
        label: 'Delivered in scope',
        value: String(kpis.eligible_deliveries),
        helper: 'Eligible for feedback',
      },
      {
        label: 'Not requested',
        value: String(kpis.not_requested),
        helper: 'Follow-up not yet created',
      },
      { label: 'Pending response', value: String(kpis.pending), helper: 'Awaiting manual capture' },
      {
        label: 'Completed',
        value: String(kpis.completed),
        helper: `Average ${ratingLabel(kpis.average_rating)}`,
      },
    ];
  }, [query.data?.kpis]);

  if (query.isPending) return <DeliveryFeedbackSkeleton />;
  if (query.isError)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <h1 className="font-semibold">Delivery feedback is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm your Delivery Manager role, branch access and delivery permission.
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <KpiGrid metrics={metrics} />
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b p-4">
          <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
            <div>
              <CardTitle className="text-base">Delivery feedback queue</CardTitle>
              <CardDescription>
                Only completed deliveries inside your authorized branches. Creating a follow-up
                never sends a provider message.
              </CardDescription>
            </div>
            <Badge variant="outline">{query.data.total} records</Badge>
          </div>
          <div className="flex flex-col gap-3 pt-1 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1 lg:max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                maxLength={160}
                className="pl-9"
                placeholder="Customer, booking number or exact phone"
              />
            </div>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value) as DeliveryFeedbackPageSize);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {deliveryFeedbackPageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} rows
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Tabs
            value={status}
            onValueChange={(value) => {
              setStatus(value as DeliveryFeedbackStatus);
              setPage(1);
            }}
          >
            <TabsList className="h-auto flex-wrap justify-start">
              {deliveryFeedbackStatuses.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {value.replace('_', ' ')}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className={`p-0 transition-opacity ${query.isFetching ? 'opacity-60' : ''}`}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Delivery / booking</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Delivered</TableHead>
                  <TableHead>Follow-up</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.records.map((record) => (
                  <TableRow key={record.delivery_case_id}>
                    <TableCell>
                      <p className="font-medium">{record.booking_number}</p>
                      <p className="text-xs text-muted-foreground">
                        #{record.delivery_case_id.slice(0, 8).toUpperCase()}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{record.customer_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {record.phone ?? 'Phone unavailable'}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(record.delivered_at)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={record.status} />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {record.channel ?? 'Not selected'}
                      </p>
                    </TableCell>
                    <TableCell>
                      {record.rating ? (
                        <span className="inline-flex items-center gap-1 font-medium">
                          <Star className="size-3.5 fill-amber-400 text-amber-500" />
                          {record.rating}/5
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <p className="whitespace-nowrap">{formatDate(record.completed_at)}</p>
                      {record.comments ? (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {record.comments}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {record.status === 'NOT_REQUESTED' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={requestMutation.isPending}
                          onClick={() => requestMutation.mutate(record)}
                        >
                          <MessageSquarePlus className="size-4" /> Create follow-up
                        </Button>
                      ) : null}
                      {record.status === 'PENDING' ? (
                        <Button
                          size="sm"
                          disabled={captureMutation.isPending}
                          onClick={() => {
                            setCaptureTarget(record);
                            setRating('5');
                            setComments('');
                          }}
                        >
                          Capture feedback
                        </Button>
                      ) : null}
                      {record.status === 'COMPLETED' ? (
                        <span className="text-xs text-muted-foreground">Recorded</span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
                {!query.data.records.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-44 text-center text-sm text-muted-foreground"
                    >
                      No delivered customers match this feedback queue.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                <ChevronLeft className="size-4" /> Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <Dialog
        open={captureTarget !== null}
        onOpenChange={(open) => {
          if (!open && !captureMutation.isPending) setCaptureTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Capture delivery feedback</DialogTitle>
            <DialogDescription>
              Record the customer response after a real contact. This does not send any message.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="delivery-feedback-rating">
                Rating
              </label>
              <Select value={rating} onValueChange={setRating}>
                <SelectTrigger id="delivery-feedback-rating">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[5, 4, 3, 2, 1].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value} / 5
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="delivery-feedback-comments">
                Customer comments{' '}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id="delivery-feedback-comments"
                value={comments}
                maxLength={4000}
                onChange={(event) => setComments(event.target.value)}
                placeholder="What did the customer say?"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={captureMutation.isPending}
              onClick={() => setCaptureTarget(null)}
            >
              Cancel
            </Button>
            <Button disabled={captureMutation.isPending} onClick={() => captureMutation.mutate()}>
              {captureMutation.isPending ? 'Saving…' : 'Save feedback'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
