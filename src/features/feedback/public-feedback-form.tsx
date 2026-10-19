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
              ? 'Your review is copied. On Google, tap the review box and paste it.'
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
    mutationFn: () =>
      rephrasePublicReview({ token, rating, keywords, notes: review.trim().slice(0, 1500) }),
    onSuccess: (text) => {
      setBeforeRephrase(review);
      setReview(text);
      setAiRemaining((current) => Math.max((current ?? open?.ai_remaining ?? 1) - 1, 0));
    },
    onError: (error) => {
      if (error instanceof ReviewRephraseError && error.code === 'REPHRASE_LIMIT_REACHED')
        setAiRemaining(0);
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

  if (done?.status === 'RECORDED' && reviewStep && done.review_url)
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

  const remaining = aiRemaining ?? form.data.ai_remaining;
  const canRephrase =
    reviewStep &&
    form.data.ai_available &&
    remaining > 0 &&
    rating > 0 &&
    (keywords.length > 0 || review.trim().length > 0);
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
            if (reviewStep && text) {
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
                  ? 'Type a few words in your own language. We can help you write it up.'
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
                    {beforeRephrase === null ? 'Help me write it' : 'Try another version'}
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
            {submit.isPending ? 'Sending…' : reviewStep ? 'Submit review' : 'Submit feedback'}
          </Button>
        </form>
      </CardContent>
    </Shell>
  );
}
