'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Star } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import type { PageSpec } from '@/lib/domain';
import {
  approveReviewInvite,
  fetchReviewApprovalQueue,
  getReviewInviteErrorMessage,
  reviewApprovalKey,
  type ReviewApprovalRecord,
  type ReviewQueueView,
} from './review-approval-api';

function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          className={
            value <= rating ? 'size-3.5 fill-amber-400 text-amber-400' : 'size-3.5 text-muted'
          }
        />
      ))}
    </span>
  );
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function InviteDialog({ record, onClose }: { record: ReviewApprovalRecord; onClose: () => void }) {
  const client = useQueryClient();
  const approve = useMutation({
    mutationFn: approveReviewInvite,
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: result.replayed ? 'Already invited' : 'Review invitation queued',
        description: 'It will be sent by email on the next dispatch pass.',
      });
      void client.invalidateQueries({ queryKey: ['review-approval-queue'] });
      onClose();
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Invitation was not queued',
        description: getReviewInviteErrorMessage(error),
      }),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite {record.customer} to review</DialogTitle>
          <DialogDescription>
            This queues an email containing your Google review link. It does not write the review.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between">
            <Stars rating={record.rating} />
            <span className="text-xs text-muted-foreground">{record.branch}</span>
          </div>
          {record.comments ? (
            <p className="mt-2 text-xs text-muted-foreground">{record.comments}</p>
          ) : null}
        </div>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            approve.mutate({
              feedbackId: record.feedback_id,
              message: String(form.get('message') ?? ''),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Message
            <Textarea
              name="message"
              required
              rows={4}
              maxLength={4000}
              defaultValue={`Thank you for your feedback, ${record.customer}. If you have a moment, would you share your experience on Google? It genuinely helps our team.`}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={approve.isPending}>
              <Send /> {approve.isPending ? 'Queueing…' : 'Send invitation'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewApprovalWorkspace({ spec }: { spec: PageSpec }) {
  const [view, setView] = useState<ReviewQueueView>('AWAITING');
  const [page, setPage] = useState(1);
  const [inviting, setInviting] = useState<ReviewApprovalRecord | null>(null);
  const queue = useQuery({
    queryKey: reviewApprovalKey(view, page),
    queryFn: ({ signal }) => fetchReviewApprovalQueue(view, page, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  if (queue.isError)
    return (
      <div className="space-y-5">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Alert>
          <AlertTitle>Reviews are unavailable</AlertTitle>
          <AlertDescription>Confirm customer-care access, then refresh.</AlertDescription>
        </Alert>
      </div>
    );

  const records = queue.data?.records ?? [];
  const total = queue.data?.total ?? 0;
  const counts = queue.data?.counts;
  const pages = Math.max(1, Math.ceil(total / 25));
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <Card className="shadow-none">
        <CardHeader className="border-b p-4">
          <Tabs
            value={view}
            onValueChange={(value) => {
              setView(value as ReviewQueueView);
              setPage(1);
            }}
          >
            <TabsList>
              <TabsTrigger value="AWAITING">
                Awaiting invite {counts ? `(${counts.awaiting})` : ''}
              </TabsTrigger>
              <TabsTrigger value="INVITED">
                Invited {counts ? `(${counts.invited})` : ''}
              </TabsTrigger>
              <TabsTrigger value="ALL">All</TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="mt-2 text-xs text-muted-foreground">
            Feedback the customer has submitted. Inviting sends your Google review link by email —
            it is offered on every rating, because filtering by score is review gating and against
            Google&apos;s policy.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Comments</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length ? (
                records.map((record) => (
                  <TableRow key={record.feedback_id}>
                    <TableCell className="font-medium">{record.customer}</TableCell>
                    <TableCell>{record.branch}</TableCell>
                    <TableCell>
                      <Stars rating={record.rating} />
                    </TableCell>
                    <TableCell className="max-w-72 truncate text-muted-foreground">
                      {record.comments ?? '—'}
                    </TableCell>
                    <TableCell>{formatDate(record.completed_at)}</TableCell>
                    <TableCell className="text-right">
                      {record.review_request_id ? (
                        <span className="text-xs text-muted-foreground">
                          Invited {formatDate(record.approved_at)}
                        </span>
                      ) : (
                        <Button size="sm" onClick={() => setInviting(record)}>
                          <Send /> Invite to review
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="h-28 text-center text-muted-foreground">
                    No submitted feedback in this view yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className="flex items-center justify-between border-t p-3 text-sm text-muted-foreground">
          <span>{total} submissions</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </Button>
            <span>
              Page {page} / {pages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
      {inviting && <InviteDialog record={inviting} onClose={() => setInviting(null)} />}
    </div>
  );
}
