import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const formSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('OPEN'), branch: z.string(), organization: z.string() }),
  z.object({ status: z.literal('INVALID') }),
  z.object({ status: z.literal('EXPIRED') }),
  z.object({ status: z.literal('ALREADY_SUBMITTED') }),
]);

const submitSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('RECORDED'),
    rating: z.coerce.number().int().min(1).max(5),
    review_url: z.string().nullable(),
  }),
  z.object({ status: z.literal('INVALID') }),
  z.object({ status: z.literal('EXPIRED') }),
  z.object({ status: z.literal('ALREADY_SUBMITTED') }),
]);

export type PublicFeedbackForm = z.infer<typeof formSchema>;
export type PublicFeedbackResult = z.infer<typeof submitSchema>;

/** Called without a session. The token is the only credential the caller has. */
export async function fetchPublicFeedbackForm(token: string) {
  const { data, error } = await createClient().rpc('get_public_feedback_form', {
    target_token: token,
  });
  if (error) throw error;
  return formSchema.parse(data);
}

export async function submitPublicFeedback(input: {
  token: string;
  rating: number;
  comments: string;
}) {
  const { data, error } = await createClient().rpc('submit_public_feedback', {
    target_token: input.token,
    target_rating: input.rating,
    target_comments: input.comments,
  });
  if (error) throw error;
  return submitSchema.parse(data);
}
