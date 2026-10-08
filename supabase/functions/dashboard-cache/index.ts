import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';
import { enforceManualRefresh, readWorkspaceCache } from '../_shared/workspace-cache.ts';
import {
  DASHBOARD_CACHE_RESOURCES,
  isDashboardCacheResource,
  type DashboardCacheResource,
} from './registry.ts';

const schema = z.object({
  resource: z.string(),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  manual_refresh: z.boolean().optional().default(false),
});

// A ceiling for idle keys only. Freshness comes from the database data version:
// an out-of-date entry is rebuilt on the next read, at most once per minute.
const DASHBOARD_CACHE_TTL_SECONDS = 30 * 60;

const cacheContextSchema = z.object({
  resource: z.enum(['tenant-dashboard', 'inventory-dashboard', 'platform-dashboard']),
  scope_key: z.string().min(1),
  scope_subject: z.record(z.string(), z.unknown()),
  role_key: z.string().min(1),
  permissions_fingerprint: z.string().min(1),
  version: z.coerce.number().int().positive(),
});

async function loadResource(
  client: ReturnType<typeof authenticatedClient>,
  resource: DashboardCacheResource,
  args: Record<string, unknown>,
) {
  const { data, error } = await client.rpc(DASHBOARD_CACHE_RESOURCES[resource].rpc, args);
  if (error) throw error;
  return data;
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success || !isDashboardCacheResource(parsed.data.resource))
      return failure('INVALID_PAYLOAD', 'The dashboard cache request is invalid.', requestId, 422);
    const resource = parsed.data.resource;
    const definition = DASHBOARD_CACHE_RESOURCES[resource];
    const params = definition.params.safeParse(parsed.data.params);
    if (!params.success)
      return failure('INVALID_PAYLOAD', 'The dashboard cache request is invalid.', requestId, 422);
    const rpcArgs = params.data as Record<string, unknown>;

    const client = authenticatedClient(request);
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    // Verified locally against the project JWKS, so the read path costs no Auth
    // round trip. A revoked or deleted user is still refused by
    // get_workspace_cache_context below, which runs under RLS as this subject.
    const { data: claimsData, error: claimsError } = await client.auth.getClaims(accessToken);
    const subject = z.uuid().safeParse(claimsData?.claims?.sub);
    if (claimsError || !subject.success)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const userId = subject.data;

    let manualRefreshBudget: Awaited<ReturnType<typeof enforceManualRefresh>> | null = null;
    if (parsed.data.manual_refresh) {
      manualRefreshBudget = await enforceManualRefresh(userId, resource);
      if (!manualRefreshBudget.allowed)
        return failure(
          'MANUAL_REFRESH_LIMITED',
          'Refresh limit reached. Try again after the current one-minute window.',
          requestId,
          429,
        );
    }

    const { data: rawContext, error: contextError } = await client.rpc(
      'get_workspace_cache_context',
      { target_resource_key: definition.versionKey },
    );
    if (contextError)
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);
    const context = cacheContextSchema.parse(rawContext);
    const result = await readWorkspaceCache({
      resource,
      // Read before the rebuild and stored with the entry: a write committed
      // during the load leaves the new entry already out of date.
      version: context.version,
      ttlSeconds: DASHBOARD_CACHE_TTL_SECONDS,
      // Every aggregate here filters on auth.uid() somewhere (own records next
      // to branch scope, managed teams, performance rows), so two users with an
      // identical scope can still see different numbers. Entries are per user.
      // The data version is deliberately not part of the identity, so an
      // out-of-date entry can still be served while one request rebuilds it.
      fingerprintInput: {
        resource,
        user_id: userId,
        scope_key: context.scope_key,
        scope_subject: context.scope_subject,
        role_key: context.role_key,
        permissions_fingerprint: context.permissions_fingerprint,
        params: rpcArgs,
        schema: definition.schema,
      },
      forceRefresh: parsed.data.manual_refresh,
      load: () => loadResource(client, resource, rpcArgs),
    });
    return success(
      {
        result: result.value,
        cache: result.diagnostic,
        manual_refresh: parsed.data.manual_refresh
          ? {
              enforced: manualRefreshBudget?.enabled ?? false,
              remaining: manualRefreshBudget?.remaining ?? null,
              retry_after_ms: manualRefreshBudget?.retry_after_ms ?? null,
            }
          : null,
      },
      requestId,
    );
  } catch {
    return failure(
      'DASHBOARD_CACHE_FAILED',
      'The dashboard could not be loaded. Retry shortly.',
      requestId,
      502,
    );
  }
});
