'use client';

import { useEffect, useRef } from 'react';

// Cloudflare Turnstile, explicit rendering:
// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// Must match WEBSITE_CHAT_TURNSTILE_ACTION in supabase/functions/_shared/turnstile.ts.
const ACTION = 'website_chat';

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: 'auto';
      size: 'flexible';
      callback: (token: string) => void;
      'error-callback': () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('TURNSTILE_UNAVAILABLE'));
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('TURNSTILE_UNAVAILABLE'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function TurnstileChallenge({
  siteKey,
  onToken,
  onError,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Callbacks change every render; the widget is rendered once.
  const handlers = useRef({ onToken, onError });
  useEffect(() => {
    handlers.current = { onToken, onError };
  });

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: ACTION,
          theme: 'auto',
          size: 'flexible',
          callback: (token) => handlers.current.onToken(token),
          'error-callback': () => handlers.current.onError(),
        });
      })
      .catch(() => {
        if (!cancelled) handlers.current.onError();
      });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey]);

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">One quick check before we send your details…</p>
      <div ref={containerRef} />
    </div>
  );
}
