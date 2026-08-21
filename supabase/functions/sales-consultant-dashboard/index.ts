import { GetObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { enforceManualRefresh } from '../_shared/workspace-cache.ts';
import { tigrisClient } from '../_shared/tigris.ts';

const schema = z.object({ manual_refresh: z.boolean().optional().default(false) });
const dashboardShape = z
  .object({
    top_models: z
      .array(z.object({ image_object_file_id: z.uuid().nullable() }).passthrough())
      .max(5),
  })
  .passthrough();

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
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);

    let manualRefreshBudget: Awaited<ReturnType<typeof enforceManualRefresh>> | null = null;
    if (parsed.data.manual_refresh) {
      manualRefreshBudget = await enforceManualRefresh(auth.user.id, 'sales-consultant-dashboard');
      if (!manualRefreshBudget.allowed)
        return failure(
          'MANUAL_REFRESH_LIMITED',
          'Refresh limit reached. Try again after the current ten-minute window.',
          requestId,
          429,
        );
    }

    const [dashboardResponse, topModelsResponse] = await Promise.all([
      client.rpc('get_sales_consultant_dashboard', { target_timezone: 'Asia/Kolkata' }),
      client.rpc('get_sales_consultant_top_models', { target_timezone: 'Asia/Kolkata' }),
    ]);
    if (dashboardResponse.error || topModelsResponse.error)
      return failure('PERMISSION_DENIED', 'Dashboard access is not available.', requestId, 403);
    const dashboard = dashboardResponse.data as Record<string, unknown> | null;
    const result = await attachInventoryImages({
      ...(dashboard ?? {}),
      top_models: topModelsResponse.data ?? [],
    });
    return success(
      {
        result,
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
      'SALES_DASHBOARD_FAILED',
      'The Sales Consultant dashboard could not be loaded.',
      requestId,
      502,
    );
  }
});
