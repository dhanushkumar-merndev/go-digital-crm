import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

export type CachedDashboardResource =
  'tenant-dashboard' | 'inventory-dashboard' | 'platform-dashboard';

const envelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    result: z.unknown(),
    cache: z.object({
      status: z.enum(['HIT', 'MISS', 'COALESCED', 'BYPASS', 'FALLBACK']),
      resource: z.enum(['tenant-dashboard', 'inventory-dashboard', 'platform-dashboard']),
      version: z.coerce.number().int().positive(),
      age_seconds: z.coerce.number().int().nonnegative().nullable(),
    }),
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
  constructor() {
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
  manualRefresh?: boolean;
}) {
  const { data, error } = await createClient().functions.invoke('dashboard-cache', {
    body: { resource: input.resource, manual_refresh: Boolean(input.manualRefresh) },
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
