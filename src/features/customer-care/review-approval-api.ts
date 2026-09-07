import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const recordSchema = z.object({
  feedback_id: z.uuid(),
  customer: z.string(),
  branch: z.string(),
  rating: z.coerce.number().int().min(1).max(5),
  comments: z.string().nullable(),
  completed_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  review_request_id: z.uuid().nullable(),
});
const queueSchema = z.object({
  records: z.array(recordSchema),
  total: z.coerce.number().int().nonnegative(),
  counts: z.object({
    awaiting: z.coerce.number().int().nonnegative(),
    invited: z.coerce.number().int().nonnegative(),
  }),
});

export type ReviewApprovalRecord = z.infer<typeof recordSchema>;
export const reviewQueueViews = ['AWAITING', 'INVITED', 'ALL'] as const;
export type ReviewQueueView = (typeof reviewQueueViews)[number];
export const reviewApprovalKey = (view: ReviewQueueView, page: number) =>
  ['review-approval-queue', view, page] as const;

export async function fetchReviewApprovalQueue(
  view: ReviewQueueView,
  page: number,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_review_approval_queue', {
    target_view: view,
    target_page: page,
    target_page_size: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return queueSchema.parse(data);
}

/** Queues the Google review invitation as an email for this customer. */
export async function approveReviewInvite(input: { feedbackId: string; message: string }) {
  const { data, error } = await createClient().rpc('approve_feedback_review_invite', {
    target_feedback_id: input.feedbackId,
    target_message: input.message,
    target_request_id: globalThis.crypto.randomUUID(),
  });
  if (error) throw error;
  return z
    .object({ feedback_id: z.uuid(), review_request_id: z.uuid(), replayed: z.boolean() })
    .parse(data);
}

export function getReviewInviteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('REVIEW_INVITE_PERMISSION_REQUIRED'))
    return 'You are not allowed to send review invitations.';
  if (message.includes('FEEDBACK_SCOPE_DENIED'))
    return 'That feedback belongs to a branch outside your scope.';
  if (message.includes('FEEDBACK_NOT_SUBMITTED'))
    return 'The customer has not submitted their feedback yet.';
  return 'The review invitation could not be queued. Try again in a moment.';
}
