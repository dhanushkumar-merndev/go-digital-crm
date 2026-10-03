import {
  constantTimeEqual,
  decryptJson,
  hmacSha256Hex,
  sha256Base64Url,
} from '../_shared/crypto.ts';
import {
  failure,
  jsonHeaders,
  preflight,
  requestId as getRequestId,
  success,
} from '../_shared/http.ts';
import {
  recordUnmappedProviderAssets,
  resolveProviderAssetRoutes,
} from '../_shared/provider-routing.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { extractMetaLeadEvents } from '../../../src/lib/providers/meta-lead-adapter.ts';

type DirectMetaCredential = {
  connection_type?: string;
  app_secret?: string;
  page_id?: string;
  webhook_verify_token?: string;
};

async function directRoute(admin: ReturnType<typeof serviceClient>, routeToken: string) {
  const routeHash = await sha256Base64Url(routeToken);
  const { data: connections, error } = await admin
    .from('connected_accounts')
    .select('id,organization_id')
    .eq('provider_key', 'meta')
    .eq('status', 'CONNECTED')
    .contains('connection_config', {
      connection_type: 'META_DIRECT',
      webhook_route_hash: routeHash,
    })
    .is('deleted_at', null)
    .limit(2);
  if (error || connections?.length !== 1) return null;
  const connection = connections[0];
  const { data: stored } = await admin
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('organization_id', connection.organization_id)
    .eq('connected_account_id', connection.id)
    .maybeSingle();
  if (!stored) return null;
  const credential = await decryptJson<DirectMetaCredential>(stored.encrypted_payload);
  if (
    credential.connection_type !== 'META_DIRECT' ||
    !credential.app_secret ||
    !credential.page_id ||
    !credential.webhook_verify_token
  )
    return null;
  return {
    connectionId: String(connection.id),
    organizationId: String(connection.organization_id),
    credential,
  };
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  const url = new URL(request.url);
  const routeToken = url.searchParams.get('route_token')?.trim() ?? '';

  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token') ?? '';
    const challenge = url.searchParams.get('hub.challenge');
    const direct = routeToken ? await directRoute(serviceClient(), routeToken) : null;
    if (routeToken && !direct)
      return failure('WEBHOOK_ROUTE_INVALID', 'Webhook route is invalid.', requestId, 403);
    const expectedToken =
      direct?.credential.webhook_verify_token ?? Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') ?? '';
    if (
      mode !== 'subscribe' ||
      !challenge ||
      !expectedToken ||
      !constantTimeEqual(token, expectedToken)
    )
      return failure('WEBHOOK_VERIFICATION_FAILED', 'Webhook verification failed.', requestId, 403);
    return new Response(challenge, {
      status: 200,
      headers: { ...jsonHeaders, 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only GET and POST are supported.', requestId, 405);

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > 1_000_000)
    return failure('PAYLOAD_TOO_LARGE', 'The webhook payload is too large.', requestId, 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 1_000_000)
    return failure('PAYLOAD_TOO_LARGE', 'The webhook payload is too large.', requestId, 413);
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const admin = serviceClient();
  const direct = routeToken ? await directRoute(admin, routeToken) : null;
  if (routeToken && !direct)
    return failure('WEBHOOK_ROUTE_INVALID', 'Webhook route is invalid.', requestId, 403);
  const appSecret = direct?.credential.app_secret ?? Deno.env.get('META_APP_SECRET') ?? '';
  if (!appSecret || !signature.startsWith('sha256='))
    return failure('INVALID_SIGNATURE', 'Webhook signature is invalid.', requestId, 401);
  const expectedSignature = `sha256=${await hmacSha256Hex(appSecret, rawBody)}`;
  if (!constantTimeEqual(signature, expectedSignature))
    return failure('INVALID_SIGNATURE', 'Webhook signature is invalid.', requestId, 401);

  try {
    const events = extractMetaLeadEvents(JSON.parse(rawBody) as unknown);
    if (events.length > 100)
      return failure('TOO_MANY_EVENTS', 'The webhook event batch is too large.', requestId, 413);
    if (events.length === 0) return success({ accepted: true, queued: 0 }, requestId);

    if (direct && events.some((event) => event.pageId !== direct.credential.page_id))
      return failure(
        'WEBHOOK_ROUTE_MISMATCH',
        'Webhook route does not match this Page.',
        requestId,
        403,
      );
    const routes = await resolveProviderAssetRoutes(
      admin,
      'meta',
      'META_PAGE',
      events.map((event) => event.pageId),
    );
    if (
      direct &&
      Array.from(routes.values()).some((route) => route.connectionId !== direct.connectionId)
    )
      return failure(
        'WEBHOOK_CONNECTION_MISMATCH',
        'Webhook route does not match this connection.',
        requestId,
        403,
      );
    const payloadHash = await sha256Base64Url(rawBody);
    const receipts = events.flatMap((event) => {
      const route = routes.get(event.pageId);
      return route
        ? [
            {
              organization_id: route.organizationId,
              connected_account_id: route.connectionId,
              provider_event_id: event.eventId,
              event_type: 'META_LEADGEN',
              payload_hash: payloadHash,
              payload: { event },
              status: 'RECEIVED',
            },
          ]
        : [];
    });
    const unmappedPageIds = events
      .filter((event) => !routes.has(event.pageId))
      .map((event) => event.pageId);
    await recordUnmappedProviderAssets(
      admin,
      'provider-webhook-meta',
      'META_PAGE',
      unmappedPageIds,
    );
    if (receipts.length === 0)
      return success({ accepted: true, queued: 0, unmapped: events.length }, requestId);
    const { data: inserted, error } = await admin
      .from('provider_events')
      .upsert(receipts, {
        onConflict: 'organization_id,connected_account_id,provider_event_id',
        ignoreDuplicates: true,
      })
      .select('id');
    if (error) throw error;
    const queued = inserted?.length ?? 0;
    return success(
      {
        accepted: true,
        queued,
        duplicates: receipts.length - queued,
        unmapped: unmappedPageIds.length,
      },
      requestId,
    );
  } catch {
    return failure(
      'META_WEBHOOK_FAILED',
      'The provider webhook could not be accepted.',
      requestId,
      500,
    );
  }
});
