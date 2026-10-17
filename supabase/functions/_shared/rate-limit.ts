import type { serviceClient } from './supabase.ts';
import { cacheFingerprint, upstashConfiguration, UpstashRest } from './workspace-cache.ts';

type AdminClient = ReturnType<typeof serviceClient>;

export type RateLimitRule = { bucket: string; limit: number; windowSeconds: number };
export type RateLimitResult = { allowed: boolean; retry_after_ms: number };

// Public-boundary rate limits. Upstash first (no database write per request);
// when it is disabled or unreachable the SQL fixed window in
// consume_public_rate_limit takes over, so a Redis outage never removes the limit.
export async function consumeRateLimit(
  admin: AdminClient,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const bucket = `public-rl:${await cacheFingerprint(rule.bucket)}`;
  const config = upstashConfiguration();
  if (config.enabled && config.url && config.token) {
    try {
      const redis = new UpstashRest(config.url, config.token);
      const result = await redis.consumeWindow(
        `${config.prefix}:${bucket}`,
        rule.windowSeconds * 1_000,
      );
      return { allowed: result.count <= rule.limit, retry_after_ms: result.retry_after_ms };
    } catch {
      // Fall through to PostgreSQL.
    }
  }
  const { data, error } = await admin.rpc('consume_public_rate_limit', {
    target_bucket: bucket,
    window_seconds: rule.windowSeconds,
    max_hits: rule.limit,
  });
  if (error) throw error;
  const result = data as { allowed?: boolean; retry_after_ms?: number } | null;
  return { allowed: result?.allowed === true, retry_after_ms: Number(result?.retry_after_ms ?? 0) };
}

export async function consumeRateLimits(admin: AdminClient, rules: RateLimitRule[]) {
  for (const rule of rules) {
    const result = await consumeRateLimit(admin, rule);
    if (!result.allowed) return result;
  }
  return { allowed: true, retry_after_ms: 0 };
}

export function clientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip');
}
