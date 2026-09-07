'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchPublicFeedbackForm,
  submitPublicFeedback,
  type PublicFeedbackResult,
} from './public-feedback-api';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/30 p-4">
      <Card className="w-full max-w-md shadow-none">{children}</Card>
    </main>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <CardContent className="p-10 text-center">
        <p className="font-semibold">{title}</p>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
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

  if (done?.status === 'RECORDED')
    return (
      <Shell>
        <CardContent className="space-y-4 p-10 text-center">
          <p className="text-lg font-semibold">Thank you for your feedback</p>
          <p className="text-sm text-muted-foreground">
            {done.rating >= 4
              ? 'We are glad the experience went well.'
              : 'We are sorry it fell short. The team has been notified and will follow up.'}
          </p>
          {/* Offered on every rating. Showing it only to happy customers is
              review gating, which Google's review policy prohibits. */}
          {done.review_url ? (
            <Button asChild className="w-full">
              <a href={done.review_url} target="_blank" rel="noreferrer noopener">
                Share your experience on Google
              </a>
            </Button>
          ) : null}
        </CardContent>
      </Shell>
    );

  const { branch, organization } = form.data;
  return (
    <Shell>
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
