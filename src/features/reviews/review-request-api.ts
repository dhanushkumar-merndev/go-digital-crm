import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { PerformanceDateRange } from '@/lib/performance-date-range';

const count = z.coerce.number().int().nonnegative();

const recordSchema = z.object({
  feedback_id: z.uuid(),
  lead_id: z.uuid().nullable(),
  customer_id: z.uuid().nullable(),
  customer_name: z.string(),
  phone: z.string().nullable(),
  interested_model: z.string().nullable(),
  channel: z.string(),
  state: z.enum(['AWAITING', 'FILLED', 'EXPIRED']),
  sent_at: z.string(),
  expires_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  rating: z.coerce.number().int().min(1).max(5).nullable(),
  comments: z.string().nullable(),
  keywords: z.array(z.string()).catch([]),
  sent_to_google: z.boolean(),
});

const workspaceSchema = z.object({
  kpis: z.object({
    sent: count,
    filled: count,
    awaiting: count,
    expired: count,
    average_rating: z.coerce.number().nullable(),
    five_star: count,
    low_rating: count,
    sent_to_google: count,
  }),
  ratings: z.array(z.object({ rating: z.coerce.number().int(), count })),
  daily: z.array(z.object({ day: z.string(), sent: count, filled: count })),
  total: count,
  records: z.array(recordSchema),
});

const createdSchema = z.object({
  feedback_id: z.uuid(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  expires_at: z.string(),
  lead_id: z.uuid(),
  customer_name: z.string().nullable(),
  phone: z.string().nullable(),
  branch: z.string().nullable(),
  reused: z.boolean(),
});

const pickerSchema = z.array(
  z.object({
    lead_id: z.uuid(),
    customer_name: z.string().nullable(),
    phone: z.string().nullable(),
    interested_model: z.string().nullable(),
    has_customer: z.boolean(),
  }),
);

export type ReviewRequestRecord = z.infer<typeof recordSchema>;
export type ReviewRequestWorkspaceData = z.infer<typeof workspaceSchema>;
export type CreatedReviewRequest = z.infer<typeof createdSchema>;
export type ReviewLeadOption = z.infer<typeof pickerSchema>[number];
export const reviewRequestViews = ['ALL', 'AWAITING', 'FILLED', 'EXPIRED'] as const;
export type ReviewRequestView = (typeof reviewRequestViews)[number];
export type ReviewChannel = 'WHATSAPP' | 'SMS' | 'LINK';

export const reviewRequestKeys = {
  all: ['review-requests'] as const,
  workspace: (
    scope: readonly unknown[],
    range: PerformanceDateRange,
    view: ReviewRequestView,
    search: string,
    page: number,
    pageSize: number,
  ) => ['review-requests', ...scope, range.from, range.to, view, search, page, pageSize] as const,
  picker: (scope: readonly unknown[], search: string) =>
    ['review-requests', 'picker', ...scope, search] as const,
};

export async function fetchMyReviewRequests(
  input: {
    range: PerformanceDateRange;
    view: ReviewRequestView;
    search: string;
    page: number;
    pageSize: 25 | 50 | 100;
  },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_my_review_requests', {
    target_from: input.range.from,
    target_to: input.range.to,
    target_view: input.view,
    target_search: input.search,
    target_page: input.page,
    target_page_size: input.pageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export async function searchReviewLeads(search: string, signal?: AbortSignal) {
  const request = createClient().rpc('search_review_request_leads', { target_search: search });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return pickerSchema.parse(data);
}

/** Sends a fresh link, or reissues the lead's open one. */
export async function createReviewRequest(input: {
  leadId?: string;
  customerId?: string;
  channel: ReviewChannel;
}) {
  const { data, error } = await createClient().rpc('create_lead_review_request', {
    target_lead_id: input.leadId ?? null,
    target_customer_id: input.customerId ?? null,
    target_channel: input.channel,
  });
  if (error) throw error;
  return createdSchema.parse(data);
}

export function reviewLinkFor(token: string) {
  return `${window.location.origin}/feedback/${token}`;
}

export function reviewRequestMessage(request: CreatedReviewRequest, link: string) {
  const name = request.customer_name?.split(' ')[0];
  const showroom = request.branch ? ` at ${request.branch}` : '';
  return `Hi${name ? ` ${name}` : ''}, thank you for visiting us${showroom}. Could you take a minute to share your experience? ${link}`;
}

export function getReviewRequestErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('REVIEW_LEAD_NOT_ACCESSIBLE'))
    return 'That lead is not in your records any more.';
  if (message.includes('REVIEW_REQUEST_RATE_LIMIT'))
    return 'You have sent a lot of requests in the last hour. Try again a little later.';
  if (message.includes('INVALID_REVIEW_RANGE')) return 'Pick a date range of one year or less.';
  if (message.includes('REVIEW_REQUEST_ACCESS_REQUIRED'))
    return 'Your role does not allow review requests.';
  return 'The review request could not be created. Try again in a moment.';
}
