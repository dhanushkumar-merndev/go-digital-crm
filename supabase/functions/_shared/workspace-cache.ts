import { classifyCacheEntry } from './cache-freshness.ts';

const DEFAULT_CACHE_TTL_SECONDS = 60 * 60;
// An entry whose data version has moved on is still served for this long after
// it was built. However many writes or viewers arrive, one scope key is rebuilt
// from PostgreSQL at most once per interval.
const DEFAULT_MIN_REBUILD_INTERVAL_MS = 60_000;
const LOCK_TTL_MS = 15_000;
const COALESCED_WAIT_MS = 500;
const COALESCED_POLL_MS = 100;
const REDIS_COMMAND_TIMEOUT_MS = 500;
const MANUAL_REFRESH_LIMIT = 3;
// Dashboard rebuilds are deliberately limited to three per 30 minutes, per
// user and resource. Normal reads remain inexpensive Redis reads.
const MANUAL_REFRESH_WINDOW_MS = 30 * 60_000;
export const MANUAL_REFRESH_POLICY = {
  limit: MANUAL_REFRESH_LIMIT,
  window_ms: MANUAL_REFRESH_WINDOW_MS,
} as const;

// Resources served by the dashboard-cache Edge function (see its registry.ts).
export type WorkspaceCacheResource =
  | 'tenant-dashboard'
  | 'inventory-dashboard'
  | 'platform-dashboard'
  | 'telecaller-performance'
  | 'sales-consultant-performance'
  | 'team-manager-performance'
  | 'gm-sales-analytics'
  | 'business-sales-overview'
  | 'business-showroom-performance'
  | 'business-showroom-analytics'
  | 'business-operations-overview';
export type EdgeCacheResource =
  WorkspaceCacheResource | 'sales-consultant-dashboard' | 'sales-consultant-ai-summary';
export type ManualRefreshResource = EdgeCacheResource;

export type CacheDiagnostic = {
  // STALE: served an entry whose data has since changed, because it was built
  // inside the minimum rebuild interval or another request is rebuilding it.
  status: 'HIT' | 'STALE' | 'MISS' | 'COALESCED' | 'BYPASS' | 'FALLBACK';
  resource: EdgeCacheResource;
  version: number;
  age_seconds: number | null;
  // When the cached payload was actually built. The client shows this as the
  // last sync time, so a day-old dashboard never reads as live.
  synced_at: string | null;
};

// data_version is absent on entries written before stale-while-revalidate.
// Those keys embedded the version in their fingerprint, so they match by construction.
type CacheEntry<T> = { value: T; created_at: string; data_version?: number };
type RedisResponse = { result?: unknown; error?: string };

export function upstashConfiguration() {
  const enabled = Deno.env.get('UPSTASH_REDIS_ENABLED') === 'true';
  const url = Deno.env.get('UPSTASH_REDIS_REST_URL');
  const token = Deno.env.get('UPSTASH_REDIS_REST_TOKEN');
  const prefix = Deno.env.get('UPSTASH_REDIS_CACHE_PREFIX')?.trim() || 'go-digital';
  return { enabled: enabled && Boolean(url && token), url, token, prefix };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export async function cacheFingerprint(value: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}

export class UpstashRest {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async command<T>(command: unknown[], timeoutMs = REDIS_COMMAND_TIMEOUT_MS): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([command]),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('UPSTASH_UNAVAILABLE');
    const payload = (await response.json()) as RedisResponse[];
    const entry = payload[0];
    if (!entry || entry.error) throw new Error('UPSTASH_UNAVAILABLE');
    return entry.result as T;
  }

  async get<T>(key: string, timeoutMs?: number): Promise<T | null> {
    const result = await this.command<unknown>(['GET', key], timeoutMs);
    if (result === null || result === undefined) return null;
    if (typeof result === 'string') return JSON.parse(result) as T;
    return result as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number) {
    await this.command(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]);
  }

  async delete(key: string) {
    await this.command(['DEL', key]);
  }

  async setNx(key: string, value: string, ttlMs: number) {
    return (await this.command<unknown>(['SET', key, value, 'NX', 'PX', ttlMs])) === 'OK';
  }

  async releaseLock(key: string, token: string) {
    const script = `
      #!lua flags=allow-key-locking
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      end
      return 0
    `;
    await this.command(['EVAL', script, 1, key, token]);
  }

  // Fixed-window counter: the first hit starts the window.
  async consumeWindow(key: string, windowMs: number) {
    const script = `
      #!lua flags=allow-key-locking
      local count = redis.call('incr', KEYS[1])
      if count == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end
      return {count, redis.call('pttl', KEYS[1])}
    `;
    const result = await this.command<unknown>(['EVAL', script, 1, key, String(windowMs)]);
    if (!Array.isArray(result)) throw new Error('UPSTASH_UNAVAILABLE');
    return { count: Number(result[0]), retry_after_ms: Math.max(0, Number(result[1])) };
  }

  async consumeManualRefresh(key: string) {
    const script = `
      #!lua flags=allow-key-locking
      local count = redis.call('incr', KEYS[1])
      if count == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end
      return {count, redis.call('pttl', KEYS[1])}
    `;
    const result = await this.command<unknown>([
      'EVAL',
      script,
      1,
      key,
      String(MANUAL_REFRESH_WINDOW_MS),
    ]);
    if (!Array.isArray(result)) throw new Error('UPSTASH_UNAVAILABLE');
    const used = Number(result[0]);
    const retryAfterMs = Math.max(0, Number(result[1]));
    return {
      allowed: used <= MANUAL_REFRESH_LIMIT,
      remaining: Math.max(0, MANUAL_REFRESH_LIMIT - used),
      retry_after_ms: retryAfterMs,
    };
  }
}

function cacheKey(prefix: string, resource: EdgeCacheResource, fingerprint: string) {
  return `${prefix}:workspace-cache:v1:${resource}:${fingerprint}`;
}

function entryAgeSeconds(entry: CacheEntry<unknown>) {
  const createdAt = Date.parse(entry.created_at);
  return Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1_000))
    : null;
}

export async function enforceManualRefresh(userId: string, resource: ManualRefreshResource) {
  const config = upstashConfiguration();
  if (!config.enabled || !config.url || !config.token)
    return { enabled: false, allowed: true, remaining: null, retry_after_ms: null };
  const redis = new UpstashRest(config.url, config.token);
  const fingerprint = await cacheFingerprint({ userId, resource });
  try {
    const result = await redis.consumeManualRefresh(
      `${config.prefix}:workspace-refresh:v1:${fingerprint}`,
    );
    return { enabled: true, ...result };
  } catch {
    // Redis is an optimization and refresh guard, never a page availability dependency.
    return { enabled: false, allowed: true, remaining: null, retry_after_ms: null };
  }
}

/** Read the current refresh quota without consuming one of its attempts. */
export async function getManualRefreshStatus(userId: string, resource: ManualRefreshResource) {
  const config = upstashConfiguration();
  if (!config.enabled || !config.url || !config.token)
    return { enabled: false, allowed: true, remaining: null, retry_after_ms: null };

  const redis = new UpstashRest(config.url, config.token);
  const fingerprint = await cacheFingerprint({ userId, resource });
  const key = `${config.prefix}:workspace-refresh:v1:${fingerprint}`;
  try {
    const rawCount = await redis.command<unknown>(['GET', key]);
    const used = Math.max(0, Number(rawCount ?? 0));
    const remaining = Math.max(0, MANUAL_REFRESH_LIMIT - used);
    const retryAfterMs =
      remaining === 0 ? Math.max(0, Number(await redis.command<unknown>(['PTTL', key]))) : null;
    return { enabled: true, allowed: remaining > 0, remaining, retry_after_ms: retryAfterMs };
  } catch {
    return { enabled: false, allowed: true, remaining: null, retry_after_ms: null };
  }
}

export async function readWorkspaceCache<T>(input: {
  resource: EdgeCacheResource;
  fingerprintInput: unknown;
  version: number;
  ttlSeconds?: number;
  minRebuildIntervalMs?: number;
  forceRefresh?: boolean;
  load: () => Promise<T>;
}): Promise<{ value: T; diagnostic: CacheDiagnostic }> {
  const loadWithoutCache = async (status: 'BYPASS' | 'FALLBACK') => {
    const value = await input.load();
    return {
      value,
      diagnostic: {
        status,
        resource: input.resource,
        version: input.version,
        age_seconds: 0,
        synced_at: new Date().toISOString(),
      } satisfies CacheDiagnostic,
    };
  };
  const config = upstashConfiguration();
  if (!config.enabled || !config.url || !config.token) return loadWithoutCache('BYPASS');

  const redis = new UpstashRest(config.url, config.token);
  const ttlSeconds =
    input.ttlSeconds === undefined
      ? DEFAULT_CACHE_TTL_SECONDS
      : Math.max(1, Math.floor(input.ttlSeconds));
  const fingerprint = await cacheFingerprint(input.fingerprintInput);
  const key = cacheKey(config.prefix, input.resource, fingerprint);
  const refreshStartedAt = Date.now();

  let existing: CacheEntry<T> | null;
  try {
    existing = await redis.get<CacheEntry<T>>(key);
  } catch {
    return loadWithoutCache('FALLBACK');
  }
  const serveExisting = (entry: CacheEntry<T>, status: 'HIT' | 'STALE') => ({
    value: entry.value,
    diagnostic: {
      status,
      resource: input.resource,
      version: input.version,
      age_seconds: entryAgeSeconds(entry),
      synced_at: entry.created_at,
    } satisfies CacheDiagnostic,
  });
  if (existing && !input.forceRefresh) {
    const decision = classifyCacheEntry(
      existing,
      input.version,
      refreshStartedAt,
      input.minRebuildIntervalMs ?? DEFAULT_MIN_REBUILD_INTERVAL_MS,
    );
    if (decision === 'HIT') return serveExisting(existing, 'HIT');
    if (decision === 'STALE_SERVE') return serveExisting(existing, 'STALE');
  }

  // A user-triggered Refresh is intentionally stronger than a cache bypass:
  // remove the old Redis value before rebuilding so no later read can be
  // handed the stale dashboard while the database load is in progress.
  if (input.forceRefresh && existing) {
    try {
      await redis.delete(key);
    } catch {
      // Continue with the database rebuild. Redis is never allowed to turn a
      // refresh into an unavailable dashboard.
    }
  }

  const lockKey = `${key}:lock`;
  const lockToken = crypto.randomUUID();
  let lockAcquired: boolean;
  try {
    lockAcquired = await redis.setNx(lockKey, lockToken, LOCK_TTL_MS);
  } catch {
    if (existing && !input.forceRefresh) return serveExisting(existing, 'STALE');
    return loadWithoutCache('FALLBACK');
  }
  // Someone else is already rebuilding an out-of-date entry. Serve what exists
  // rather than queueing more readers behind the same database aggregate.
  if (!lockAcquired && existing && !input.forceRefresh) return serveExisting(existing, 'STALE');
  if (lockAcquired) {
    let value: T;
    try {
      value = await input.load();
    } catch (error) {
      try {
        await redis.releaseLock(lockKey, lockToken);
      } catch {
        // The bounded lock naturally expires; cache correctness never relies on release.
      }
      // A failed rebuild of an out-of-date entry keeps the last good aggregate on screen.
      if (existing && !input.forceRefresh) return serveExisting(existing, 'STALE');
      throw error;
    }

    let cacheStored = true;
    const createdAt = new Date().toISOString();
    try {
      // input.version was read before load(), so a write that commits during the
      // rebuild leaves this entry already out of date and the next read rebuilds.
      await redis.set(
        key,
        { value, created_at: createdAt, data_version: input.version } satisfies CacheEntry<T>,
        ttlSeconds,
      );
    } catch {
      // Do not repeat an expensive successful load just because Redis could not store it.
      cacheStored = false;
    } finally {
      try {
        await redis.releaseLock(lockKey, lockToken);
      } catch {
        // The bounded lock naturally expires; cache correctness never relies on release.
      }
    }
    return {
      value,
      diagnostic: {
        status: cacheStored ? 'MISS' : 'FALLBACK',
        resource: input.resource,
        version: input.version,
        age_seconds: 0,
        synced_at: createdAt,
      },
    };
  }

  const deadline = Date.now() + COALESCED_WAIT_MS;
  while (Date.now() < deadline) {
    const sleepMs = Math.min(COALESCED_POLL_MS, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    let rebuilt: CacheEntry<T> | null;
    try {
      rebuilt = await redis.get<CacheEntry<T>>(key, remainingMs);
    } catch {
      return loadWithoutCache('FALLBACK');
    }
    // A force refresh must not immediately return the entry that existed
    // before the lock holder began rebuilding it.
    if (rebuilt && (!input.forceRefresh || Date.parse(rebuilt.created_at) >= refreshStartedAt)) {
      return {
        value: rebuilt.value,
        diagnostic: {
          status: 'COALESCED',
          resource: input.resource,
          version: input.version,
          age_seconds: entryAgeSeconds(rebuilt),
          synced_at: rebuilt.created_at,
        },
      };
    }
  }

  // A slow lock holder must not turn into a 10-second page stall or a 503.
  return loadWithoutCache('FALLBACK');
}
