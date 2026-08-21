const CACHE_TTL_SECONDS = 60 * 60;
const LOCK_TTL_MS = 15_000;
const COALESCED_WAIT_MS = 10_000;
const COALESCED_POLL_MS = 200;
const MANUAL_REFRESH_LIMIT = 3;
const MANUAL_REFRESH_WINDOW_MS = 10 * 60_000;

export type WorkspaceCacheResource =
  'tenant-dashboard' | 'inventory-dashboard' | 'platform-dashboard';
export type ManualRefreshResource = WorkspaceCacheResource | 'sales-consultant-dashboard';

export type CacheDiagnostic = {
  status: 'HIT' | 'MISS' | 'COALESCED' | 'BYPASS' | 'FALLBACK';
  resource: WorkspaceCacheResource;
  version: number;
  age_seconds: number | null;
};

type CacheEntry<T> = { value: T; created_at: string };
type RedisResponse = { result?: unknown; error?: string };

export class CacheBusyError extends Error {
  constructor() {
    super('CACHE_REBUILDING');
  }
}

function configuration() {
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

class UpstashRest {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async command<T>(command: unknown[]): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([command]),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error('UPSTASH_UNAVAILABLE');
    const payload = (await response.json()) as RedisResponse[];
    const entry = payload[0];
    if (!entry || entry.error) throw new Error('UPSTASH_UNAVAILABLE');
    return entry.result as T;
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.command<unknown>(['GET', key]);
    if (result === null || result === undefined) return null;
    if (typeof result === 'string') return JSON.parse(result) as T;
    return result as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number) {
    await this.command(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]);
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

function cacheKey(prefix: string, resource: WorkspaceCacheResource, fingerprint: string) {
  return `${prefix}:workspace-cache:v1:${resource}:${fingerprint}`;
}

function entryAgeSeconds(entry: CacheEntry<unknown>) {
  const createdAt = Date.parse(entry.created_at);
  return Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1_000))
    : null;
}

export async function enforceManualRefresh(userId: string, resource: ManualRefreshResource) {
  const config = configuration();
  if (!config.enabled || !config.url || !config.token)
    return { enabled: false, allowed: true, remaining: null, retry_after_ms: null };
  const redis = new UpstashRest(config.url, config.token);
  const fingerprint = await cacheFingerprint({ userId, resource });
  const result = await redis.consumeManualRefresh(
    `${config.prefix}:workspace-refresh:v1:${fingerprint}`,
  );
  return { enabled: true, ...result };
}

export async function readWorkspaceCache<T>(input: {
  resource: WorkspaceCacheResource;
  fingerprintInput: unknown;
  version: number;
  forceRefresh?: boolean;
  load: () => Promise<T>;
}): Promise<{ value: T; diagnostic: CacheDiagnostic }> {
  const config = configuration();
  if (!config.enabled || !config.url || !config.token) {
    const value = await input.load();
    return {
      value,
      diagnostic: {
        status: 'BYPASS',
        resource: input.resource,
        version: input.version,
        age_seconds: null,
      },
    };
  }

  const redis = new UpstashRest(config.url, config.token);
  const fingerprint = await cacheFingerprint(input.fingerprintInput);
  const key = cacheKey(config.prefix, input.resource, fingerprint);
  const refreshStartedAt = Date.now();
  try {
    const existing = await redis.get<CacheEntry<T>>(key);
    if (existing && !input.forceRefresh) {
      return {
        value: existing.value,
        diagnostic: {
          status: 'HIT',
          resource: input.resource,
          version: input.version,
          age_seconds: entryAgeSeconds(existing),
        },
      };
    }

    const lockKey = `${key}:lock`;
    const lockToken = crypto.randomUUID();
    if (await redis.setNx(lockKey, lockToken, LOCK_TTL_MS)) {
      try {
        const value = await input.load();
        await redis.set(key, { value, created_at: new Date().toISOString() }, CACHE_TTL_SECONDS);
        return {
          value,
          diagnostic: {
            status: 'MISS',
            resource: input.resource,
            version: input.version,
            age_seconds: 0,
          },
        };
      } finally {
        try {
          await redis.releaseLock(lockKey, lockToken);
        } catch {
          // The bounded lock naturally expires; cache correctness never relies on release.
        }
      }
    }

    const deadline = Date.now() + COALESCED_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, COALESCED_POLL_MS));
      const rebuilt = await redis.get<CacheEntry<T>>(key);
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
          },
        };
      }
    }
    throw new CacheBusyError();
  } catch (error) {
    if (error instanceof CacheBusyError) throw error;
    const value = await input.load();
    return {
      value,
      diagnostic: {
        status: 'FALLBACK',
        resource: input.resource,
        version: input.version,
        age_seconds: null,
      },
    };
  }
}
