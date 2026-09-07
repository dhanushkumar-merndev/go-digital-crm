import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();

const recordSchema = z.object({
  delivery_case_id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  booking_id: z.uuid(),
  customer_id: z.uuid(),
  delivered_at: nullableString,
  delivery_updated_at: z.string(),
  booking_number: z.string(),
  customer_name: z.string(),
  phone: nullableString,
  feedback_request_id: nullableUuid,
  status: z.enum(['NOT_REQUESTED', 'PENDING', 'COMPLETED']),
  channel: nullableString,
  sent_at: nullableString,
  completed_at: nullableString,
  rating: z.coerce.number().int().min(1).max(5).nullable(),
  comments: nullableString,
  version: z.coerce.number().int().nonnegative(),
  updated_at: nullableString,
});

export type DeliveryFeedbackRecord = z.infer<typeof recordSchema>;

const workspaceSchema = z.object({
  organization_id: z.uuid(),
  records: z.array(recordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    eligible_deliveries: z.coerce.number().int().nonnegative(),
    not_requested: z.coerce.number().int().nonnegative(),
    pending: z.coerce.number().int().nonnegative(),
    completed: z.coerce.number().int().nonnegative(),
    average_rating: z.coerce.number().min(0).max(5),
  }),
});

export type DeliveryFeedbackWorkspace = z.infer<typeof workspaceSchema>;
export const deliveryFeedbackStatuses = ['ALL', 'NOT_REQUESTED', 'PENDING', 'COMPLETED'] as const;
export type DeliveryFeedbackStatus = (typeof deliveryFeedbackStatuses)[number];
export const deliveryFeedbackPageSizes = [25, 50, 100] as const;
export type DeliveryFeedbackPageSize = (typeof deliveryFeedbackPageSizes)[number];

export async function fetchDeliveryFeedbackWorkspace(
  input: {
    status: DeliveryFeedbackStatus;
    search: string;
    page: number;
    pageSize: DeliveryFeedbackPageSize;
  },
  signal?: AbortSignal,
): Promise<DeliveryFeedbackWorkspace> {
  const request = createClient().rpc('get_delivery_feedback_workspace_page', {
    target_status: input.status,
    target_search: input.search.trim().slice(0, 160),
    target_page: input.page,
    target_page_size: input.pageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

const mutationSchema = z.object({
  delivery_case_id: z.uuid(),
  feedback_request_id: z.uuid(),
  status: z.enum(['PENDING', 'COMPLETED']),
  version: z.coerce.number().int().positive(),
  replayed: z.boolean(),
});

export async function requestDeliveryFeedback(input: {
  deliveryCaseId: string;
  channel: 'MANUAL' | 'SMS' | 'WHATSAPP' | 'EMAIL';
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('request_delivery_feedback', {
    target_delivery_case_id: input.deliveryCaseId,
    target_channel: input.channel,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationSchema.parse(data);
}

export async function captureDeliveryFeedback(input: {
  deliveryCaseId: string;
  expectedVersion: number;
  rating: number;
  comments?: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('capture_delivery_feedback', {
    target_delivery_case_id: input.deliveryCaseId,
    expected_version: input.expectedVersion,
    target_rating: input.rating,
    target_comments: input.comments?.trim() || null,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationSchema.parse(data);
}

export async function submitCustomerFeedbackWithSentimentRouting(input: {
  feedbackId: string;
  rating: number;
  comments?: string;
}): Promise<{
  feedback_id: string;
  rating: number;
  status: string;
  outcome: 'POSITIVE_REVIEW' | 'DETRACTOR_ESCALATED';
  redirect_review_url?: string | null;
  complaint_id?: string | null;
}> {
  const { data, error } = await createClient().rpc('submit_customer_feedback', {
    target_feedback_id: input.feedbackId,
    target_rating: input.rating,
    target_comments: input.comments?.trim() || null,
  });
  if (error) throw error;
  return z
    .object({
      feedback_id: z.uuid(),
      rating: z.coerce.number().int().min(1).max(5),
      status: z.string(),
      outcome: z.enum(['POSITIVE_REVIEW', 'DETRACTOR_ESCALATED']),
      redirect_review_url: z.string().nullish(),
      complaint_id: z.uuid().nullish(),
    })
    .parse(data);
}

export async function setGoogleReviewUrl(url: string): Promise<boolean> {
  const { error } = await createClient().rpc('set_organization_google_review_url', {
    target_url: url.trim(),
  });
  if (error) throw error;
  return true;
}
