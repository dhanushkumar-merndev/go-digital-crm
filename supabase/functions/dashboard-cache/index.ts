import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';
import {
  CacheBusyError,
  enforceManualRefresh,
  readWorkspaceCache,
  type WorkspaceCacheResource,
} from '../_shared/workspace-cache.ts';

const schema = z.object({
  resource: z.enum(['tenant-dashboard', 'inventory-dashboard', 'platform-dashboard']),
  manual_refresh: z.boolean().optional().default(false),
});

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
  resource: WorkspaceCacheResource,
) {
  if (resource === 'tenant-dashboard') {
    const { data, error } = await client.rpc('get_tenant_dashboard_summary', {
      target_days: 14,
      target_timezone: 'Asia/Kolkata',
    });
    if (error) throw error;
    return data;
  }
  if (resource === 'inventory-dashboard') {
    const { data, error } = await client.rpc('get_inventory_dashboard');
    if (error) throw error;
    return data;
  }
  const { data, error } = await client.rpc('get_platform_dashboard');
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
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The dashboard cache request is invalid.', requestId, 422);

    const client = authenticatedClient(request);
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);

    let manualRefreshBudget: Awaited<ReturnType<typeof enforceManualRefresh>> | null = null;
    if (parsed.data.manual_refresh) {
      manualRefreshBudget = await enforceManualRefresh(auth.user.id, parsed.data.resource);
      if (!manualRefreshBudget.allowed)
        return failure(
          'MANUAL_REFRESH_LIMITED',
          'Refresh limit reached. Try again after the current ten-minute window.',
          requestId,
          429,
        );
    }

    const { data: rawContext, error: contextError } = await client.rpc(
      'get_workspace_cache_context',
      {
        target_resource_key: parsed.data.resource,
      },
    );
    if (contextError)
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);
    const context = cacheContextSchema.parse(rawContext);
    const result = await readWorkspaceCache({
      resource: parsed.data.resource,
      version: context.version,
      fingerprintInput: {
        resource: context.resource,
        scope_key: context.scope_key,
        scope_subject: context.scope_subject,
        role_key: context.role_key,
        permissions_fingerprint: context.permissions_fingerprint,
        version: context.version,
        query: { days: 14, timezone: 'Asia/Kolkata', schema: 1 },
      },
      forceRefresh: parsed.data.manual_refresh,
      load: () => loadResource(client, parsed.data.resource),
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
  } catch (error) {
    if (error instanceof CacheBusyError)
      return failure(
        'CACHE_REBUILDING',
        'The dashboard is being refreshed. Retry shortly.',
        requestId,
        503,
      );
    return failure(
      'DASHBOARD_CACHE_FAILED',
      'The dashboard could not be loaded. Retry shortly.',
      requestId,
      502,
    );
  }
});
