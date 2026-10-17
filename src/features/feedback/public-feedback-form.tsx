'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchPublicFeedbackForm,
  fetchPublicFeedbackLogo,
  submitPublicFeedback,
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

export function PublicFeedbackForm({ token }: { token: string }) {
  const [rating, setRating] = useState(0);
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
  const submit = useMutation({
    mutationFn: submitPublicFeedback,
    onSuccess: setDone,
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

  const { branch, organization, brand_color } = form.data;
  const branding: Branding = {
    color: brand_color,
    logoUrl: logo.data ?? null,
    name: organization,
  };

  if (done?.status === 'RECORDED')
    return (
      <ThankYou
        branding={branding}
        branch={branch}
        result={done}
        comment={submit.variables?.comments.trim() ?? ''}
      />
    );

  return (
    <Shell branding={branding}>
      <CardHeader className="text-center">
        <CardTitle className="text-lg">How was your experience?</CardTitle>
        <CardDescription>
          {organization} · {branch}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!rating) return;
            const data = new FormData(event.currentTarget);
            submit.mutate({ token, rating, comments: String(data.get('comments') ?? '') });
          }}
        >
          <fieldset className="flex justify-center gap-1.5" aria-label="Rating out of five">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                aria-label={`${value} star${value === 1 ? '' : 's'}`}
                aria-pressed={rating === value}
                onClick={() => setRating(value)}
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
          <label className="grid gap-1.5 text-sm font-medium">
            Anything you would like to tell us?
            <Textarea
              name="comments"
              rows={4}
              maxLength={4000}
              placeholder="Optional"
              aria-label="Your comments"
            />
          </label>
          {submit.isError ? (
            <p className="text-center text-sm text-destructive">
              That could not be submitted. Please try again.
            </p>
          ) : null}
          <Button className="w-full" disabled={!rating || submit.isPending}>
            {submit.isPending ? 'Sending…' : 'Submit feedback'}
          </Button>
        </form>
      </CardContent>
    </Shell>
  );
}
