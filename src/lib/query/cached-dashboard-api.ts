import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

// Mirrors supabase/functions/dashboard-cache/registry.ts.
const cachedDashboardResources = [
  'tenant-dashboard',
  'inventory-dashboard',
  'platform-dashboard',
  'telecaller-performance',
  'sales-consultant-performance',
  'team-manager-performance',
  'gm-sales-analytics',
  'business-sales-overview',
  'business-showroom-performance',
  'business-showroom-analytics',
  'business-operations-overview',
] as const;
export type CachedDashboardResource = (typeof cachedDashboardResources)[number];

export const cacheDiagnosticSchema = z.object({
  status: z.enum(['HIT', 'STALE', 'MISS', 'COALESCED', 'BYPASS', 'FALLBACK']),
  resource: z.enum(cachedDashboardResources),
  version: z.coerce.number().int().positive(),
  age_seconds: z.coerce.number().int().nonnegative().nullable(),
  // nullish, not nullable: an edge function deployed before this field
  // existed omits it entirely, and a client that hard-fails on that turns
  // a routine deploy skew into a blank dashboard.
  synced_at: z.string().nullish(),
});
export type CacheDiagnostic = z.infer<typeof cacheDiagnosticSchema>;

const envelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    result: z.unknown(),
    cache: cacheDiagnosticSchema,
    manual_refresh: z
      .object({
        enforced: z.boolean(),
        remaining: z.coerce.number().int().nonnegative().nullable(),
        retry_after_ms: z.coerce.number().int().nonnegative().nullable(),
      })
      .nullable(),
  }),
  error: z.null(),
  request_id: z.string().uuid(),
});

export class ManualDashboardRefreshLimitError extends Error {
  constructor(readonly retryAfterMs: number | null = null) {
    super('MANUAL_REFRESH_LIMITED');
  }
}

async function edgeErrorCode(error: unknown) {
  const response = (error as { context?: unknown } | null)?.context;
  if (!(response instanceof Response)) return null;
  try {
    const payload = (await response.clone().json()) as { error?: { code?: string } };
    return payload.error?.code ?? null;
  } catch {
    return null;
  }
}

export async function fetchCachedDashboard<T>(input: {
  resource: CachedDashboardResource;
  schema: z.ZodType<T>;
  params?: Record<string, unknown>;
  manualRefresh?: boolean;
  signal?: AbortSignal;
}) {
  const { data, error } = await createClient().functions.invoke('dashboard-cache', {
    body: {
      resource: input.resource,
      params: input.params ?? {},
      manual_refresh: Boolean(input.manualRefresh),
    },
    signal: input.signal,
  });
  if (error) {
    if ((await edgeErrorCode(error)) === 'MANUAL_REFRESH_LIMITED')
      throw new ManualDashboardRefreshLimitError();
    throw error;
  }
  const envelope = envelopeSchema.parse(data);
  return {
    result: input.schema.parse(envelope.data.result),
    cache: envelope.data.cache,
    manualRefresh: envelope.data.manual_refresh,
  };
}

/**
 * Read an aggregate through Redis, falling back to its direct RPC when the Edge
 * function is unreachable (cold start, deploy, outage) so the page never blanks.
 * A rejected manual refresh is rethrown: that is a quota answer, not an outage.
 */
export async function fetchCachedAggregate<T>(input: {
  resource: CachedDashboardResource;
  schema: z.ZodType<T>;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  direct: () => Promise<T>;
}): Promise<T> {
  try {
    const { result } = await fetchCachedDashboard(input);
    return result;
  } catch (error) {
    if (input.signal?.aborted || error instanceof ManualDashboardRefreshLimitError) throw error;
    return input.direct();
  }
}
