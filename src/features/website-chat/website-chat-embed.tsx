'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, RotateCcw, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  MODEL_NOT_SURE,
  normalizeWebsiteOrigin,
  validateWebsiteAnswer,
  type WebsiteQuestion,
} from '@/lib/providers/website-lead-adapter';
import { cn } from '@/lib/utils';
import {
  fetchWebsiteWidgetConfig,
  submitWebsiteChat,
  WebsiteChatError,
  type PublicWebsiteWidgetConfig,
} from './website-chat-api';
import { TurnstileChallenge } from './turnstile-challenge';

type AnswerValue = string | boolean;
// null marks an optional question the visitor skipped.
type Answers = Record<string, AnswerValue | null>;
type Phase = 'asking' | 'verifying' | 'sending' | 'done';

const MANY_OPTIONS = 10;
const noSubscription = () => () => {};

// The page that framed this chat, as the browser reports it: ancestorOrigins
// where supported, else the referrer (the loader sets a policy that keeps the
// origin). The `origin` query parameter is never trusted for this, since any
// site could put a dealer's domain in it. Unknown means not allowed.
function framingOrigin() {
  if (window.parent === window) return null;
  const ancestors = window.location.ancestorOrigins;
  const reported = ancestors && ancestors.length > 0 ? ancestors[0] : document.referrer;
  if (!reported) return null;
  try {
    return normalizeWebsiteOrigin(new URL(reported).origin);
  } catch {
    return null;
  }
}

function displayAnswer(
  question: WebsiteQuestion,
  value: AnswerValue | null,
  config: PublicWebsiteWidgetConfig,
) {
  if (value === null) return 'Skipped';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (question.type === 'branch_picker')
    return config.branches.find((branch) => branch.id === value)?.name ?? value;
  return value;
}

function choicesFor(question: WebsiteQuestion, config: PublicWebsiteWidgetConfig) {
  if (question.type === 'choice') return question.options.map((value) => ({ value, label: value }));
  if (question.type === 'yes_no')
    return [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ];
  if (question.type === 'branch_picker')
    return config.branches.map((branch) => ({ value: branch.id, label: branch.name }));
  if (question.type === 'model_picker' && config.models.length > 0)
    return [...config.models, MODEL_NOT_SURE].map((value) => ({ value, label: value }));
  return null;
}

function Bubble({
  from,
  accent,
  children,
}: {
  from: 'bot' | 'visitor';
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex', from === 'visitor' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap',
          from === 'bot' ? 'rounded-bl-sm bg-muted text-foreground' : 'rounded-br-sm text-white',
        )}
        style={from === 'visitor' ? { backgroundColor: accent } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

export function WebsiteChatEmbed({ publicKey, pageUrl }: { publicKey: string; pageUrl?: string }) {
  // Server render assumes the standalone preview; the browser knows if it is framed.
  const embedded = useSyncExternalStore(
    noSubscription,
    () => window.parent !== window,
    () => false,
  );
  const parentOrigin = useSyncExternalStore(noSubscription, framingOrigin, () => null);

  const config = useQuery({
    queryKey: ['website-chat-config', publicKey],
    queryFn: () => fetchWebsiteWidgetConfig(publicKey),
    retry: 1,
  });
  const trustedParent =
    embedded && parentOrigin && config.data?.allowed_origins.includes(parentOrigin)
      ? parentOrigin
      : null;
  const preview = !embedded;

  const postToParent = useCallback(
    (message: Record<string, unknown>) => {
      if (trustedParent) window.parent.postMessage(message, trustedParent);
    },
    [trustedParent],
  );

  useEffect(() => {
    if (!embedded) return;
    // Carries no data, so it is safe to send to whichever page framed us.
    if (config.isError || (config.data && !trustedParent))
      window.parent.postMessage({ type: 'gdm:unavailable' }, '*');
    else if (config.data && trustedParent)
      postToParent({ type: 'gdm:ready', accentColor: config.data.accent_color });
  }, [config.data, config.isError, embedded, postToParent, trustedParent]);

  const [chatId, setChatId] = useState(() => crypto.randomUUID());
  const [answers, setAnswers] = useState<Answers>({});
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('asking');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [honeypot, setHoneypot] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const questions = useMemo(() => config.data?.questions ?? [], [config.data]);
  const current = questions.find((question) => !(question.id in answers));
  const answeredQuestions = questions.filter((question) => question.id in answers);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!trustedParent || event.origin !== trustedParent || event.source !== window.parent)
        return;
      if ((event.data as { type?: string } | null)?.type === 'gdm:open') inputRef.current?.focus();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [trustedParent]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [answers, phase, submitError]);

  const submit = useMutation({
    mutationFn: (turnstileToken?: string) =>
      submitWebsiteChat({
        publicKey,
        chatId,
        answers: Object.fromEntries(
          Object.entries(answers).filter(
            (entry): entry is [string, AnswerValue] => entry[1] !== null,
          ),
        ),
        turnstileToken,
        honeypot,
        parentOrigin: trustedParent ?? undefined,
        pageUrl,
      }),
    meta: { toast: false },
    onSuccess: () => {
      setPhase('done');
      postToParent({ type: 'gdm:submitted' });
    },
    onError: (error) => {
      if (error instanceof WebsiteChatError && error.questionId) {
        // Re-ask the one answer the server rejected; everything else is kept.
        setAnswers((previous) => {
          const next = { ...previous };
          delete next[error.questionId!];
          return next;
        });
        setInputError(error.message);
        setPhase('asking');
        return;
      }
      setSubmitError(
        error instanceof WebsiteChatError
          ? error.message
          : 'We could not send your details. Please try again.',
      );
      setPhase('asking');
    },
  });

  const finish = useCallback(() => {
    if (!config.data) return;
    setSubmitError(null);
    if (preview) {
      setPhase('done');
      return;
    }
    if (config.data.turnstile_site_key) setPhase('verifying');
    else {
      setPhase('sending');
      submit.mutate(undefined);
    }
  }, [config.data, preview, submit]);

  function record(question: WebsiteQuestion, raw: unknown) {
    if (!config.data) return;
    const result = validateWebsiteAnswer(question, raw, config.data);
    if (!result.ok) {
      setInputError(result.error);
      return;
    }
    setInputError(null);
    setDraft('');
    setFilter('');
    const next = { ...answers, [question.id]: result.value === undefined ? null : result.value };
    setAnswers(next);
    if (questions.every((candidate) => candidate.id in next)) finish();
    else requestAnimationFrame(() => inputRef.current?.focus());
  }

  function restart() {
    setAnswers({});
    setDraft('');
    setInputError(null);
    setSubmitError(null);
    setPhase('asking');
    setChatId(crypto.randomUUID());
  }

  if (config.isPending)
    return (
      <div className="grid h-dvh place-items-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading chat" />
      </div>
    );
  if (config.isError || !config.data || (embedded && !trustedParent))
    return (
      <div className="grid h-dvh place-items-center bg-background p-6 text-center text-sm text-muted-foreground">
        Chat is not available right now.
      </div>
    );

  const data = config.data;
  const accent = data.accent_color;
  const choices = current ? choicesFor(current, data) : null;
  const visibleChoices =
    choices && choices.length > MANY_OPTIONS && filter.trim()
      ? choices.filter((choice) => choice.label.toLowerCase().includes(filter.trim().toLowerCase()))
      : choices;
  const awaitingRetry = Boolean(submitError) && !current && phase === 'asking';

  const chat = (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header
        className="flex items-center gap-3 px-4 py-3 text-white"
        style={{ backgroundColor: accent }}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{data.title}</p>
          {preview ? <p className="text-xs opacity-80">Preview — answers are not sent</p> : null}
        </div>
        {answeredQuestions.length > 0 && phase !== 'sending' ? (
          <button
            type="button"
            onClick={restart}
            className="rounded-md p-1.5 hover:bg-white/15"
            aria-label="Start over"
          >
            <RotateCcw className="size-4" />
          </button>
        ) : null}
        {embedded ? (
          <button
            type="button"
            onClick={() => postToParent({ type: 'gdm:close' })}
            className="rounded-md p-1.5 hover:bg-white/15"
            aria-label="Close chat"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2.5 p-4" aria-live="polite">
          <Bubble from="bot" accent={accent}>
            {data.greeting}
          </Bubble>
          {answeredQuestions.map((question) => (
            <div key={question.id} className="space-y-2.5">
              <Bubble from="bot" accent={accent}>
                {question.prompt}
              </Bubble>
              <Bubble from="visitor" accent={accent}>
                {displayAnswer(question, answers[question.id] ?? null, data)}
              </Bubble>
            </div>
          ))}
          {current && phase === 'asking' ? (
            <Bubble from="bot" accent={accent}>
              {current.prompt}
              {!current.required ? (
                <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
              ) : null}
            </Bubble>
          ) : null}
          {phase === 'done' ? (
            <Bubble from="bot" accent={accent}>
              {data.success_message}
            </Bubble>
          ) : null}
          {submitError ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {submitError}
            </p>
          ) : null}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <footer className="border-t p-3">
        {/* Honeypot: hidden from people and screen readers, filled only by bots. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="absolute -left-[9999px] h-0 w-0 opacity-0"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
        />
        {phase === 'done' ? (
          <div className="flex items-center justify-between gap-2">
            <Badge variant="success">{preview ? 'Preview complete' : 'Details sent'}</Badge>
            <Button variant="ghost" size="sm" onClick={restart}>
              New enquiry
            </Button>
          </div>
        ) : phase === 'sending' ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Sending your details…
          </p>
        ) : phase === 'verifying' && data.turnstile_site_key ? (
          <TurnstileChallenge
            siteKey={data.turnstile_site_key}
            onToken={(token) => {
              setPhase('sending');
              submit.mutate(token);
            }}
            onError={() => {
              setSubmitError('Verification failed. Please try again.');
              setPhase('asking');
            }}
          />
        ) : awaitingRetry ? (
          <Button
            className="w-full text-white"
            style={{ backgroundColor: accent }}
            onClick={finish}
          >
            Try again
          </Button>
        ) : current ? (
          <div className="space-y-2">
            {choices ? (
              <>
                {choices.length > MANY_OPTIONS ? (
                  <Input
                    ref={inputRef}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Search…"
                    aria-label="Search options"
                    className="h-9"
                  />
                ) : null}
                <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                  {visibleChoices?.map((choice) => (
                    <Button
                      key={choice.value}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-full"
                      style={{ borderColor: accent, color: accent }}
                      onClick={() => record(current, choice.value)}
                    >
                      {choice.label}
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  record(current, draft);
                }}
              >
                <Input
                  ref={inputRef}
                  autoFocus
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setInputError(null);
                  }}
                  type={
                    current.type === 'email' ? 'email' : current.type === 'phone' ? 'tel' : 'text'
                  }
                  inputMode={current.type === 'phone' ? 'tel' : undefined}
                  autoComplete={
                    current.field === 'customer_name'
                      ? 'name'
                      : current.type === 'phone'
                        ? 'tel'
                        : current.type === 'email'
                          ? 'email'
                          : 'off'
                  }
                  maxLength={200}
                  placeholder="Type your answer…"
                  aria-label={current.prompt}
                  aria-invalid={Boolean(inputError)}
                  className="h-10"
                />
                <Button
                  type="submit"
                  size="icon"
                  className="size-10 shrink-0 text-white"
                  style={{ backgroundColor: accent }}
                  aria-label="Send"
                >
                  <Send className="size-4" />
                </Button>
              </form>
            )}
            {inputError ? <p className="text-xs text-destructive">{inputError}</p> : null}
            {!current.required ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => record(current, '')}
              >
                Skip this question
              </button>
            ) : null}
          </div>
        ) : null}
      </footer>
    </div>
  );

  if (embedded) return <div className="h-dvh">{chat}</div>;
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 p-4">
      <div className="h-[600px] w-full max-w-[380px] overflow-hidden rounded-2xl border shadow-lg">
        {chat}
      </div>
    </main>
  );
}
