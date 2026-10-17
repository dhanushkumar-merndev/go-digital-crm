import { WEBSITE_PUBLIC_KEY_PATTERN } from '@/lib/providers/website-lead-adapter';

// The chat iframe may only be framed by the dealer websites listed on its
// connection. The browser enforces that through CSP frame-ancestors, built per
// widget key. Origins change rarely, so each server instance keeps them for a minute.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { origins: string[]; expiresAt: number }>();

export function websiteWidgetConfigUrl(key: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  return base ? `${base}/functions/v1/website-widget-config?key=${encodeURIComponent(key)}` : null;
}

async function allowedOrigins(key: string): Promise<string[]> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.origins;
  const url = websiteWidgetConfigUrl(key);
  if (!url) return [];
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const body = (await response.json()) as { ok?: boolean; data?: { allowed_origins?: unknown } };
    const origins =
      body.ok && Array.isArray(body.data?.allowed_origins)
        ? body.data.allowed_origins.filter(
            (origin): origin is string =>
              typeof origin === 'string' && /^https?:\/\/[a-z0-9.:-]+$/.test(origin),
          )
        : [];
    if (cache.size > 500) cache.clear();
    cache.set(key, { origins, expiresAt: Date.now() + CACHE_TTL_MS });
    return origins;
  } catch {
    // Fail closed: only the CRM itself (the admin preview) may frame the chat.
    return [];
  }
}

export async function embedChatFrameAncestors(pathname: string) {
  const key = pathname.split('/')[3] ?? '';
  const origins = WEBSITE_PUBLIC_KEY_PATTERN.test(key) ? await allowedOrigins(key) : [];
  return ["'self'", ...origins].join(' ');
}
