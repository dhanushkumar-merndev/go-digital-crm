import { GetObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { enforceManualRefresh, readWorkspaceCache } from '../_shared/workspace-cache.ts';
import { tigrisClient } from '../_shared/tigris.ts';

const SALES_DASHBOARD_CACHE_TTL_SECONDS = 60;
const SALES_DASHBOARD_CACHE_SCHEMA_VERSION = 1;
const SALES_DASHBOARD_TIMEZONE = 'Asia/Kolkata';

const schema = z.object({ manual_refresh: z.boolean().optional().default(false) });
const metricShape = z.object({
  value: z.coerce.number(),
  change: z.coerce.number(),
  comparison: z.string(),
});
const countItemShape = z.object({ key: z.string(), value: z.coerce.number() });
const pipelineItemShape = z.object({ name: z.string(), value: z.coerce.number() });
const topModelShape = z.object({
  model_id: z.uuid().nullable(),
  name: z.string(),
  bookings: z.coerce.number(),
  change: z.coerce.number(),
  available_stock: z.coerce.number(),
  image_object_file_id: z.uuid().nullable(),
});
const dashboardSummaryShape = z.object({
  organization_id: z.uuid(),
  generated_at: z.string(),
  local_date: z.string(),
  timezone: z.string(),
  metrics: z.object({
    leads_assigned_today: metricShape,
    hot_leads: metricShape,
    followups_today: metricShape,
    calls_pending: metricShape,
    test_drives_today: metricShape,
    quotations_pending: metricShape,
    bookings_month: metricShape,
    target_achievement: metricShape,
  }),
  attention: z.array(countItemShape).max(5),
  pipeline: z.array(pipelineItemShape).max(5),
  top_models: z.array(topModelShape).max(5),
  alerts: z.array(countItemShape).max(5),
});
const dashboardLiveShape = z.object({
  organization_id: z.uuid(),
  generated_at: z.string(),
  local_date: z.string(),
  timezone: z.string(),
  schedule: z.array(z.unknown()).max(8),
  recent_leads: z.array(z.unknown()).max(5),
});
const dashboardShape = dashboardSummaryShape.extend({
  schedule: dashboardLiveShape.shape.schedule,
  recent_leads: dashboardLiveShape.shape.recent_leads,
});
const workspaceBootstrapShape = z.object({
  destination: z.literal('CRM'),
  user_id: z.uuid(),
  role_key: z.literal('sales-consultant'),
  scope_key: z.string().min(1),
  organization_id: z.uuid(),
  permissions: z.array(z.string()),
});

class SalesDashboardAccessError extends Error {}

async function loadDashboardSummary(client: ReturnType<typeof authenticatedClient>) {
  const { data, error } = await client.rpc('get_sales_consultant_dashboard_summary', {
    target_timezone: SALES_DASHBOARD_TIMEZONE,
  });
  if (error) throw new SalesDashboardAccessError();
  // Parsing here strips any unexpected fields before the value can enter Redis.
  return dashboardSummaryShape.parse(data);
}

async function attachInventoryImages(rawDashboard: unknown) {
  const dashboard = dashboardShape.parse(rawDashboard);
  const objectFileIds = [
    ...new Set(
      dashboard.top_models
        .map((model) => model.image_object_file_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!objectFileIds.length)
    return {
      ...dashboard,
      top_models: dashboard.top_models.map((model) => ({ ...model, image_url: null })),
    };

  try {
    const { data: files, error } = await serviceClient()
      .from('object_files')
      .select('id,bucket,object_key,mime_type')
      .eq('organization_id', dashboard.organization_id)
      .in('id', objectFileIds)
      .is('deleted_at', null);
    if (error || !files) throw error ?? new Error('INVENTORY_IMAGES_UNAVAILABLE');
    const signedImages = new Map(
      await Promise.all(
        files.map(
          async (file) =>
            [
              file.id,
              await getSignedUrl(
                tigrisClient(),
                new GetObjectCommand({
                  Bucket: file.bucket,
                  Key: file.object_key,
                  ResponseContentType: file.mime_type,
                }),
                { expiresIn: 5 * 60 },
              ),
            ] as const,
        ),
      ),
    );
    return {
      ...dashboard,
      top_models: dashboard.top_models.map((model) => ({
        ...model,
        image_url: model.image_object_file_id
          ? (signedImages.get(model.image_object_file_id) ?? null)
          : null,
      })),
    };
  } catch {
    // An unavailable image must never make the operational dashboard unavailable.
    return {
      ...dashboard,
      top_models: dashboard.top_models.map((model) => ({ ...model, image_url: null })),
    };
  }
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
      return failure('INVALID_PAYLOAD', 'The dashboard request is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: claimsData, error: claimsError } = await client.auth.getClaims(accessToken);
    const subject = z.uuid().safeParse(claimsData?.claims?.sub);
    if (claimsError || !subject.success)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const userId = subject.data;

    let manualRefreshBudget: Awaited<ReturnType<typeof enforceManualRefresh>> | null = null;
    if (parsed.data.manual_refresh) {
      manualRefreshBudget = await enforceManualRefresh(userId, 'sales-consultant-dashboard');
      if (!manualRefreshBudget.allowed)
        return failure(
          'MANUAL_REFRESH_LIMITED',
          'Refresh limit reached. Try again after the current one-minute window.',
          requestId,
          429,
        );
    }

    const [contextResponse, liveResponse] = await Promise.all([
      client.rpc('get_workspace_bootstrap'),
      client.rpc('get_sales_consultant_dashboard_live', {
        target_timezone: SALES_DASHBOARD_TIMEZONE,
      }),
    ]);
    if (contextResponse.error || liveResponse.error)
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);

    const parsedContext = workspaceBootstrapShape.safeParse(contextResponse.data);
    if (
      !parsedContext.success ||
      parsedContext.data.user_id !== userId ||
      !parsedContext.data.permissions.includes('lead.view')
    )
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);
    const context = parsedContext.data;
    const live = dashboardLiveShape.parse(liveResponse.data);
    if (live.organization_id !== context.organization_id)
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);

    // Redis receives only the explicitly parsed, aggregate summary. The cache is isolated by
    // authenticated user plus exact tenant/scope/permission identity and expires after 60 seconds.
    // Bounded schedule/recent-lead PII stays on the live RPC path, and signed image URLs are added
    // only after the cache read, so neither can ever be persisted in Redis.
    const cachedSummary = await readWorkspaceCache({
      resource: 'sales-consultant-dashboard',
      version: SALES_DASHBOARD_CACHE_SCHEMA_VERSION,
      ttlSeconds: SALES_DASHBOARD_CACHE_TTL_SECONDS,
      fingerprintInput: {
        resource: 'sales-consultant-dashboard',
        user_id: userId,
        organization_id: context.organization_id,
        scope_key: context.scope_key,
        query: {
          timezone: SALES_DASHBOARD_TIMEZONE,
          schema: SALES_DASHBOARD_CACHE_SCHEMA_VERSION,
        },
      },
      forceRefresh: parsed.data.manual_refresh,
      load: () => loadDashboardSummary(client),
    });

    const result = await attachInventoryImages({
      ...cachedSummary.value,
      generated_at: live.generated_at,
      schedule: live.schedule,
      recent_leads: live.recent_leads,
    });
    return success(
      {
        result,
        cache: cachedSummary.diagnostic,
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
    if (error instanceof SalesDashboardAccessError)
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);
    return failure(
      'SALES_DASHBOARD_FAILED',
      'The Sales Consultant dashboard could not be loaded.',
      requestId,
      502,
    );
  }
});
