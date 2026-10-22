import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const formSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('OPEN'),
    branch: z.string(),
    organization: z.string(),
    brand_color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/)
      .nullable()
      .catch(null),
    has_logo: z.boolean().catch(false),
    // Added by 202610182000. Before it is applied the keys are absent and the
    // form falls back to the rating-and-comment version.
    sender_first_name: z.string().nullable().catch(null),
    keywords: z.array(z.string()).catch([]),
    ai_available: z.boolean().catch(false),
    ai_remaining: z.coerce.number().int().nonnegative().catch(0),
    // Added by 202610221753: rounds of 10 with a 10-minute pause between them.
    ai_round_remaining: z.coerce.number().int().nonnegative().nullable().catch(null),
    ai_locked_until: z.string().nullable().catch(null),
  }),
  z.object({ status: z.literal('INVALID') }),
  z.object({ status: z.literal('EXPIRED') }),
  z.object({ status: z.literal('ALREADY_SUBMITTED') }),
]);

const submitSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('RECORDED'),
    rating: z.coerce.number().int().min(1).max(5),
    review_url: z.string().nullable().transform(googleWriteReviewUrl),
  }),
  z.object({ status: z.literal('INVALID') }),
  z.object({ status: z.literal('EXPIRED') }),
  z.object({ status: z.literal('ALREADY_SUBMITTED') }),
]);

/**
 * Google's "write a review" form for the listing, when the stored link names
 * it: a place ID becomes the writereview link and a g.page short link gets its
 * /review path, so the customer lands on the stars instead of the listing.
 * Any other Google link is kept as it is.
 */
export function googleWriteReviewUrl(url: string | null) {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const placeId =
    parsed.searchParams.get('placeid') ??
    parsed.searchParams.get('place_id') ??
    parsed.searchParams.get('query_place_id');
  if (placeId && /^[\w-]+$/.test(placeId))
    return `https://search.google.com/local/writereview?placeid=${placeId}`;
  const shortLink = parsed.hostname === 'g.page' && parsed.pathname.match(/^\/r\/([\w-]+)\/?$/);
  if (shortLink) return `https://g.page/r/${shortLink[1]}/review`;
  return url;
}

const logoEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ logo_url: z.url(), expires_at: z.string() }),
});

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

/**
 * Presigned branch logo for the page. It is fetched while the token is still
 * live, before submission spends it, and the URL lasts ten minutes.
 */
export async function fetchPublicFeedbackLogo(token: string) {
  const { data, error } = await createClient().functions.invoke('public-feedback-logo', {
    body: { token },
  });
  if (error) throw error;
  return logoEnvelopeSchema.parse(data).data.logo_url;
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

export async function submitPublicFeedbackReview(input: {
  token: string;
  rating: number;
  review: string;
  keywords: string[];
}) {
  const { data, error } = await createClient().rpc('submit_public_feedback_review', {
    target_token: input.token,
    target_rating: input.rating,
    target_review: input.review,
    target_keywords: input.keywords,
  });
  if (error) throw error;
  return submitSchema.parse(data);
}

export class ReviewRephraseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Set on REPHRASE_COOLDOWN: when writing help is back. */
    readonly lockedUntil: string | null = null,
  ) {
    super(message);
  }
}

const rephraseEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ review: z.string().min(1) }),
});

/**
 * Turns the customer's own keywords and notes into a short review. Each call
 * spends one of the link's rephrases (three rounds of 10, a 10-minute pause
 * between rounds); a failed one is refunded.
 */
export async function rephrasePublicReview(input: {
  token: string;
  rating: number;
  keywords: string[];
  notes: string;
}) {
  const { data, error } = await createClient().functions.invoke('public-review-rephrase', {
    body: { ...input, request_id: globalThis.crypto.randomUUID() },
  });
  if (error) {
    // supabase-js never parses a non-2xx body; the reason is in the Response.
    const context = (error as { context?: unknown }).context;
    const body =
      context instanceof Response
        ? await context
            .clone()
            .json()
            .catch(() => null)
        : null;
    const failure = z
      .object({
        error: z.object({
          code: z.string(),
          message: z.string(),
          details: z.object({ locked_until: z.string().optional() }).optional(),
        }),
      })
      .safeParse(body);
    throw failure.success
      ? new ReviewRephraseError(
          failure.data.error.code,
          failure.data.error.message,
          failure.data.error.details?.locked_until ?? null,
        )
      : new ReviewRephraseError('REPHRASE_FAILED', 'Writing help did not work this time.');
  }
  return rephraseEnvelopeSchema.parse(data).data.review;
}
