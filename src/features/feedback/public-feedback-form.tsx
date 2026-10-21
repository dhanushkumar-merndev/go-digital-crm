'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Loader2, Sparkles, Star, Undo2 } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchPublicFeedbackForm,
  fetchPublicFeedbackLogo,
  rephrasePublicReview,
  ReviewRephraseError,
  submitPublicFeedback,
  submitPublicFeedbackReview,
  type PublicFeedbackResult,
} from './public-feedback-api';

type Branding = { color: string | null; logoUrl: string | null; name: string | null };

/** Dark text on a light brand colour, white on a dark one (WCAG relative luminance). */
function readableForeground(hex: string) {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? '#0f172a' : '#ffffff';
}

function Shell({ branding, children }: { branding?: Branding; children: React.ReactNode }) {
  // The branch colour replaces the CRM primary for this page only, the same way
  // .auth-page-content re-themes the sign-in pages.
  const style = branding?.color
    ? ({
        '--primary': branding.color,
        '--primary-foreground': readableForeground(branding.color),
        '--ring': branding.color,
      } as CSSProperties)
    : undefined;
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/30 p-4" style={style}>
      <Card className="w-full max-w-md overflow-hidden pt-0 shadow-none">
        <div className="h-1.5 bg-primary" aria-hidden />
        {branding?.logoUrl ? (
          <div className="flex justify-center px-6 pt-6">
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived presigned URL */}
            <img
              src={branding.logoUrl}
              alt={branding.name ? `${branding.name} logo` : 'Showroom logo'}
              className="h-14 w-auto max-w-[220px] object-contain"
            />
          </div>
        ) : branding?.name ? (
          // No logo uploaded: the showroom's initials keep the card from opening
          // on a bare heading, in the showroom's own colour.
          <div className="flex justify-center px-6 pt-6" aria-hidden>
            <span className="grid size-12 place-items-center rounded-full bg-primary text-base font-bold text-primary-foreground">
              {branding.name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((word) => word[0]?.toUpperCase())
                .join('')}
            </span>
          </div>
        ) : null}
        {children}
      </Card>
    </main>
  );
}

function Message({ branding, title, body }: { branding?: Branding; title: string; body: string }) {
  return (
    <Shell branding={branding}>
      <CardContent className="p-10 text-center">
        <p className="font-semibold">{title}</p>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Shell>
  );
}

function ThankYou({
  branding,
  branch,
  result,
  comment,
}: {
  branding: Branding;
  branch: string;
  result: Extract<PublicFeedbackResult, { status: 'RECORDED' }>;
  comment: string;
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Shell branding={branding}>
      <CardContent className="space-y-4 p-8 text-center">
        <p className="text-lg font-semibold">Thank you for your feedback</p>
        <p className="text-sm text-muted-foreground">
          {result.rating >= 4
            ? 'We are glad the experience went well.'
            : `We are sorry we let you down. Our customer relations team at ${branch} will call you shortly to make it right.`}
        </p>
        {/* Offered on every rating. Showing it only to happy customers is
            review gating, which Google's review policy prohibits. */}
        {result.review_url ? (
          <div className="space-y-3 text-left">
            {comment ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Your comment, which we copy for you so you can paste it on Google:
                </p>
                <blockquote className="max-h-40 overflow-y-auto rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap select-all">
                  {comment}
                </blockquote>
              </>
            ) : null}
            <Button asChild className="w-full">
              {/* A real link, so the new tab opens inside the tap and is never
                  popup-blocked; the copy starts in the same gesture. */}
              <a
                href={result.review_url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => {
                  if (!comment) return;
                  if (!navigator.clipboard) {
                    setCopy('failed');
                    return;
                  }
                  navigator.clipboard.writeText(comment).then(
                    () => setCopy('copied'),
                    () => setCopy('failed'),
                  );
                }}
              >
                Share your experience on Google
              </a>
            </Button>
            {copy === 'copied' ? (
              <p className="text-center text-xs text-muted-foreground" role="status">
                Comment copied. On Google, tap the review box and paste it.
              </p>
            ) : copy === 'failed' ? (
              <p className="text-center text-xs text-muted-foreground" role="status">
                Copying did not work on this device. Press and hold your comment above to copy it.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Shell>
  );
}

/** Copies the review and opens Google. Shown briefly so the customer knows to paste. */
function OpeningGoogle({
  branding,
  reviewUrl,
  review,
  copied,
}: {
  branding: Branding;
  reviewUrl: string;
  review: string;
  copied: boolean | null;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => window.location.assign(reviewUrl), 1800);
    return () => window.clearTimeout(timer);
  }, [reviewUrl]);
  return (
    <Shell branding={branding}>
      <CardContent className="space-y-4 p-8 text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-primary" aria-hidden />
        <p className="text-lg font-semibold">Thank you! Opening Google…</p>
        <p className="text-sm text-muted-foreground" role="status">
          {copied === false
            ? 'Copying did not work on this device. Press and hold your review below to copy it, then paste it on Google.'
            : review
              ? 'Your review is copied. On Google, tap the stars, then paste your review and post it.'
              : 'Tap the stars on Google and share a few words.'}
        </p>
        {review ? (
          <blockquote className="max-h-40 overflow-y-auto rounded-md border bg-muted/40 p-3 text-left text-sm whitespace-pre-wrap select-all">
            {review}
          </blockquote>
        ) : null}
        <Button asChild className="w-full">
          <a href={reviewUrl} rel="noreferrer noopener">
            Open Google now
          </a>
        </Button>
      </CardContent>
    </Shell>
  );
}

function StarPicker({ rating, onChange }: { rating: number; onChange: (value: number) => void }) {
  return (
    <fieldset className="flex justify-center gap-1.5" aria-label="Rating out of five">
      {[1, 2, 3, 4, 5].map((value) => (
        <button
          key={value}
          type="button"
          aria-label={`${value} star${value === 1 ? '' : 's'}`}
          aria-pressed={rating === value}
          onClick={() => onChange(value)}
          className="rounded-md p-1 transition-transform hover:scale-110"
        >
          <Star
            className={
              value <= rating
                ? 'size-9 fill-amber-400 text-amber-400'
                : 'size-9 text-muted-foreground/40'
            }
          />
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A review written from the customer's own words and picked keywords, for when
 * the AI rewrite is not connected or this link has used its five. Their words
 * lead; the keywords only fill in what they did not say. Nothing is invented.
 */
export function composeReview({
  rating,
  keywords,
  notes,
  branch,
  sender,
}: {
  rating: number;
  keywords: string[];
  notes: string;
  branch: string;
  sender: string | null;
}) {
  const sentence = (text: string) => {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (!trimmed) return '';
    const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return /[.!?]$/.test(capital) ? capital : `${capital}.`;
  };
  const list = keywords.map((keyword) => keyword.toLowerCase());
  const joined =
    list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
  const parts = [
    rating >= 5
      ? `Excellent experience at ${branch}!`
      : rating === 4
        ? `Good experience at ${branch}.`
        : `My experience at ${branch}.`,
    sentence(notes),
    joined ? sentence(rating >= 4 ? `${joined} stood out` : `${joined} could be better`) : '',
    rating >= 4 && sender ? `Thanks to ${sender} for the help.` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

// The last four keywords in review_keyword_options describe a problem; they
// lead the list for a low rating so the customer does not scroll past praise.
const IMPROVEMENT_KEYWORDS = 4;

export function PublicFeedbackForm({ token }: { token: string }) {
  const [rating, setRating] = useState(0);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [review, setReview] = useState('');
  const [beforeRephrase, setBeforeRephrase] = useState<string | null>(null);
  const [aiRemaining, setAiRemaining] = useState<number | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [done, setDone] = useState<PublicFeedbackResult | null>(null);
  const form = useQuery({
    queryKey: ['public-feedback-form', token],
    queryFn: () => fetchPublicFeedbackForm(token),
    retry: false,
  });
  const open = form.data?.status === 'OPEN' ? form.data : null;
  // Loaded while the token is live; submission spends it. The page renders
  // without the logo while it loads or if it fails.
  const logo = useQuery({
    queryKey: ['public-feedback-logo', token],
    queryFn: () => fetchPublicFeedbackLogo(token),
    enabled: Boolean(open?.has_logo),
    retry: false,
    staleTime: 9 * 60_000,
  });
  const reviewStep = Boolean(open?.keywords.length);
  const submit = useMutation({
    mutationFn: (input: { rating: number; review: string; keywords: string[] }) =>
      reviewStep
        ? submitPublicFeedbackReview({ token, ...input })
        : submitPublicFeedback({ token, rating: input.rating, comments: input.review }),
    onSuccess: setDone,
  });
  const rephrase = useMutation({
    // Generate always produces a review: the AI rewrite when this tenant has it
    // and the link has rewrites left, otherwise (or if the AI call fails) one
    // composed locally from the customer's own words and keywords.
    mutationFn: async (): Promise<{ text: string; usedAi: boolean }> => {
      // Generating again starts from the customer's own words, not the last draft.
      const notes = (beforeRephrase ?? review).trim().slice(0, 1500);
      const local = () =>
        composeReview({
          rating,
          keywords,
          notes,
          branch: open?.branch ?? 'the showroom',
          sender: open?.sender_first_name ?? null,
        });
      if (open?.ai_available && (aiRemaining ?? open.ai_remaining) > 0) {
        try {
          return {
            text: await rephrasePublicReview({ token, rating, keywords, notes }),
            usedAi: true,
          };
        } catch (error) {
          if (error instanceof ReviewRephraseError && error.code === 'REPHRASE_LIMIT_REACHED')
            setAiRemaining(0);
        }
      }
      return { text: local(), usedAi: false };
    },
    onSuccess: ({ text, usedAi }) => {
      setBeforeRephrase((current) => current ?? review);
      setReview(text);
      if (usedAi)
        setAiRemaining((current) => Math.max((current ?? open?.ai_remaining ?? 1) - 1, 0));
    },
  });

  if (form.isPending) return <Message title="Loading" body="One moment." />;
  if (form.isError || form.data.status === 'INVALID')
    return (
      <Message
        title="This link is not valid"
        body="Please use the most recent link sent to you, or contact the showroom."
      />
    );
  if (form.data.status === 'EXPIRED')
    return (
      <Message title="This link has expired" body="Ask the showroom to send a new feedback link." />
    );
  if (form.data.status === 'ALREADY_SUBMITTED')
    return <Message title="Thank you" body="Your feedback has already been received." />;

  const { branch, organization, brand_color, sender_first_name } = form.data;
  const branding: Branding = {
    color: brand_color,
    logoUrl: logo.data ?? null,
    name: organization,
  };
  const submittedReview = submit.variables?.review.trim() ?? '';

  // A happy customer goes straight to Google with the review on the clipboard.
  // A lower rating stays with the care team first; ThankYou still offers the
  // Google link, because withholding it is review gating (Google policy).
  if (done?.status === 'RECORDED' && reviewStep && done.review_url && done.rating >= 4)
    return (
      <OpeningGoogle
        branding={branding}
        reviewUrl={done.review_url}
        review={submittedReview}
        copied={copied}
      />
    );
  if (done?.status === 'RECORDED')
    return <ThankYou branding={branding} branch={branch} result={done} comment={submittedReview} />;

  const canRephrase = reviewStep && rating > 0 && (keywords.length > 0 || review.trim().length > 0);
  const orderedKeywords =
    rating > 0 && rating <= 3
      ? [
          ...form.data.keywords.slice(-IMPROVEMENT_KEYWORDS),
          ...form.data.keywords.slice(0, -IMPROVEMENT_KEYWORDS),
        ]
      : form.data.keywords;

  return (
    <Shell branding={branding}>
      <CardHeader className="text-center">
        <CardTitle className="text-lg">How was your experience?</CardTitle>
        <CardDescription>
          {organization} · {branch}
          {sender_first_name ? ` · with ${sender_first_name}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!rating) return;
            const text = review.trim();
            // Started inside the tap: browsers only allow clipboard writes from
            // a user gesture, and the Google page opens after the save returns.
            if (reviewStep && text && rating >= 4) {
              if (navigator.clipboard)
                navigator.clipboard.writeText(text).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              else setCopied(false);
            }
            submit.mutate({ rating, review: text, keywords });
          }}
        >
          <StarPicker rating={rating} onChange={setRating} />
          {reviewStep && rating > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">What stood out?</p>
              <div className="flex flex-wrap gap-1.5">
                {orderedKeywords.map((keyword) => {
                  const selected = keywords.includes(keyword);
                  return (
                    <button
                      key={keyword}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setKeywords((current) =>
                          selected
                            ? current.filter((value) => value !== keyword)
                            : [...current, keyword],
                        )
                      }
                      className={
                        selected
                          ? 'inline-flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs font-medium text-primary'
                          : 'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-muted-foreground hover:border-primary/50'
                      }
                    >
                      {selected ? <Check className="size-3" aria-hidden /> : null}
                      {keyword}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <label className="grid gap-1.5 text-sm font-medium">
            {reviewStep ? 'Your review' : 'Anything you would like to tell us?'}
            <Textarea
              name="comments"
              rows={5}
              maxLength={4000}
              value={review}
              onChange={(event) => setReview(event.target.value)}
              placeholder={
                reviewStep
                  ? rating > 0 && rating <= 3
                    ? 'Tell us what went wrong. Our team will call you.'
                    : 'Type a few words in your own language, then tap Generate review.'
                  : 'Optional'
              }
              aria-label="Your review"
            />
          </label>
          {canRephrase || beforeRephrase !== null || rephrase.isError ? (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {canRephrase || rephrase.isPending ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={rephrase.isPending}
                    onClick={() => rephrase.mutate()}
                  >
                    {rephrase.isPending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Sparkles className="size-4" aria-hidden />
                    )}
                    {beforeRephrase === null ? 'Generate review' : 'Generate again'}
                  </Button>
                ) : null}
                {beforeRephrase !== null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReview(beforeRephrase);
                      setBeforeRephrase(null);
                    }}
                  >
                    <Undo2 className="size-4" aria-hidden /> My words
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground" role="status">
                {rephrase.isError
                  ? rephrase.error.message
                  : beforeRephrase !== null
                    ? 'Written from your words. Change anything before you submit.'
                    : rating >= 4
                      ? 'Pick what stood out, add a few words, then generate. You can edit it before you submit.'
                      : 'Uses only the words you picked and typed.'}
              </p>
            </div>
          ) : null}
          {submit.isError ? (
            <p className="text-center text-sm text-destructive">
              That could not be submitted. Please try again.
            </p>
          ) : null}
          <Button className="w-full" disabled={!rating || submit.isPending}>
            {submit.isPending
              ? 'Sending…'
              : reviewStep && rating >= 4
                ? 'Submit and post on Google'
                : reviewStep
                  ? 'Submit review'
                  : 'Submit feedback'}
          </Button>
        </form>
      </CardContent>
    </Shell>
  );
}
