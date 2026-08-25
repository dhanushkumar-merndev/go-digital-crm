import { GetObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import {
  enforceManualRefresh,
  getManualRefreshStatus,
  readWorkspaceCache,
} from '../_shared/workspace-cache.ts';
import { tigrisClient } from '../_shared/tigris.ts';

// Held for 24 hours. Manual Refresh removes this entry and rebuilds it from
// PostgreSQL before writing the replacement value back to Redis.
const SALES_DASHBOARD_CACHE_TTL_SECONDS = 24 * 60 * 60;
const SALES_DASHBOARD_CACHE_SCHEMA_VERSION = 2;
const SALES_DASHBOARD_RESPONSE_VERSION = 2;
const SALES_DASHBOARD_TIMEZONE = 'Asia/Kolkata';

const schema = z.object({
  manual_refresh: z.boolean().optional().default(false),
  response_version: z.literal(SALES_DASHBOARD_RESPONSE_VERSION).optional(),
});
const metricShape = z.object({
  value: z.coerce.number(),
  change: z.coerce.number(),
  comparison: z.string(),
});
const countItemShape = z.object({ key: z.string(), value: z.coerce.number() });
const pipelineItemShape = z.object({ name: z.string(), value: z.coerce.number() });
const taskDueCountShape = z.coerce.number().int().nonnegative();
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
  schedule: z.array(z.unknown()).max(50),
  recent_leads: z.array(z.unknown()).max(5),
});
const dashboardShape = dashboardSummaryShape.extend({
  schedule: dashboardLiveShape.shape.schedule,
  recent_leads: dashboardLiveShape.shape.recent_leads,
});
const legacyTaskWorkspaceShape = z.object({
  kpis: z.object({ today: taskDueCountShape }),
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

function isMissingTaskCountRpc(error: { code?: string } | null) {
  // PGRST202 is returned while PostgREST has not seen the new function in its
  // schema cache; 42883 is PostgreSQL's undefined_function code. Fall back
  // only for those rollout states, never for permission or query failures.
  return error?.code === 'PGRST202' || error?.code === '42883';
}

async function loadTaskDueCount(client: ReturnType<typeof authenticatedClient>) {
  const taskDueResponse = await client.rpc('get_sales_consultant_task_due_count', {
    target_timezone: SALES_DASHBOARD_TIMEZONE,
  });
  if (!taskDueResponse.error) return taskDueCountShape.parse(taskDueResponse.data);
  if (!isMissingTaskCountRpc(taskDueResponse.error)) throw new SalesDashboardAccessError();

  // Keep Edge and database deploys rolling-compatible. The prior task
  // workspace RPC computes the same owner, active-branch and local-day KPI.
  const fallbackResponse = await client.rpc('get_task_workspace_page', {
    target_search: '',
    target_status: 'TODAY',
    target_priority: 'ALL',
    target_page: 1,
    target_page_size: 25,
    target_sort: 'due:asc',
    target_timezone: SALES_DASHBOARD_TIMEZONE,
  });
  if (fallbackResponse.error) throw new SalesDashboardAccessError();
  return legacyTaskWorkspaceShape.parse(fallbackResponse.data).kpis.today;
}

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

    let manualRefreshBudget: {
      enabled: boolean;
      allowed: boolean;
      remaining: number | null;
      retry_after_ms: number | null;
    } | null = null;
    if (parsed.data.manual_refresh) {
      manualRefreshBudget = await enforceManualRefresh(userId, 'sales-consultant-dashboard');
      if (!manualRefreshBudget.allowed)
        return failure(
          'MANUAL_REFRESH_LIMITED',
          'Refresh limit reached for this dashboard.',
          requestId,
          429,
          { retry_after_ms: manualRefreshBudget.retry_after_ms },
        );
    } else manualRefreshBudget = await getManualRefreshStatus(userId, 'sales-consultant-dashboard');

    const useTaskAlerts = parsed.data.response_version === SALES_DASHBOARD_RESPONSE_VERSION;
    const contextResponse = await client.rpc('get_workspace_bootstrap');
    if (contextResponse.error)
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);

    const parsedContext = workspaceBootstrapShape.safeParse(contextResponse.data);
    if (
      !parsedContext.success ||
      parsedContext.data.user_id !== userId ||
      !parsedContext.data.permissions.includes('lead.view')
    )
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);
    const context = parsedContext.data;

    // The cache is isolated by authenticated user plus exact tenant/scope identity. It includes
    // only the bounded dashboard view, while presigned vehicle-image URLs are always generated
    // after the cache read and are never stored in Redis. Manual Refresh invalidates this entry
    // and always rebuilds the database bundle before storing its replacement.
    const cachedDashboard = await readWorkspaceCache({
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
      load: async () => {
        const [summary, liveResponse, taskDueCount] = await Promise.all([
          loadDashboardSummary(client),
          client.rpc('get_sales_consultant_dashboard_live', {
            target_timezone: SALES_DASHBOARD_TIMEZONE,
          }),
          useTaskAlerts ? loadTaskDueCount(client) : Promise.resolve(null),
        ]);
        if (liveResponse.error) throw new SalesDashboardAccessError();
        const live = dashboardLiveShape.parse(liveResponse.data);
        if (live.organization_id !== context.organization_id) throw new SalesDashboardAccessError();

        return dashboardShape.parse({
          ...summary,
          generated_at: live.generated_at,
          schedule: live.schedule,
          recent_leads: live.recent_leads,
          alerts: useTaskAlerts
            ? [
                { key: 'TASKS_DUE', value: taskDueCount },
                ...summary.alerts.filter((item) => item.key !== 'FOLLOWUPS_DUE'),
              ].slice(0, 5)
            : summary.alerts,
        });
      },
    });

    const result = await attachInventoryImages(cachedDashboard.value);
    return success(
      {
        result,
        cache: cachedDashboard.diagnostic,
        manual_refresh: {
          enforced: manualRefreshBudget?.enabled ?? false,
          remaining: manualRefreshBudget?.remaining ?? null,
          retry_after_ms: manualRefreshBudget?.retry_after_ms ?? null,
        },
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
