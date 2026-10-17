// Cloudflare Turnstile server-side validation.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
// Tokens are single use and valid for 300 s, so the widget fetches a fresh one per submit.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const WEBSITE_CHAT_TURNSTILE_ACTION = 'website_chat';

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
};

export function turnstileSiteKey() {
  const siteKey = Deno.env.get('TURNSTILE_SITE_KEY')?.trim();
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')?.trim();
  return siteKey && secret ? siteKey : null;
}

export type TurnstileOutcome = { ok: true; enforced: boolean } | { ok: false; code: string };

export async function verifyTurnstile(
  token: unknown,
  remoteIp: string | null,
  expectedAction: string,
): Promise<TurnstileOutcome> {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')?.trim();
  // Not configured: the widget renders no challenge and rate limits remain the guard.
  if (!secret || !turnstileSiteKey()) return { ok: true, enforced: false };
  if (typeof token !== 'string' || !token || token.length > 2048)
    return { ok: false, code: 'CAPTCHA_REQUIRED' };
  const body: Record<string, string> = {
    secret,
    response: token,
    idempotency_key: crypto.randomUUID(),
  };
  if (remoteIp) body.remoteip = remoteIp;
  let result: SiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, code: 'CAPTCHA_UNAVAILABLE' };
    result = (await response.json()) as SiteverifyResponse;
  } catch {
    return { ok: false, code: 'CAPTCHA_UNAVAILABLE' };
  }
  if (!result.success) return { ok: false, code: 'CAPTCHA_FAILED' };
  if (result.action && result.action !== expectedAction)
    return { ok: false, code: 'CAPTCHA_FAILED' };
  const crmBase = Deno.env.get('PUBLIC_CRM_BASE_URL') ?? Deno.env.get('APP_BASE_URL');
  if (crmBase && result.hostname) {
    try {
      if (new URL(crmBase).hostname !== result.hostname)
        return { ok: false, code: 'CAPTCHA_FAILED' };
    } catch {
      // A malformed PUBLIC_CRM_BASE_URL is a deployment error; the token itself was valid.
    }
  }
  return { ok: true, enforced: true };
}
