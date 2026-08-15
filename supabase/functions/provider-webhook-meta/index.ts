import { constantTimeEqual, hmacSha256Hex, sha256Base64Url } from '../_shared/crypto.ts';
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

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token') ?? '';
    const challenge = url.searchParams.get('hub.challenge');
    const expectedToken = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') ?? '';
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
  const appSecret = Deno.env.get('META_APP_SECRET') ?? '';
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

    const admin = serviceClient();
    const routes = await resolveProviderAssetRoutes(
      admin,
      'meta',
      'META_PAGE',
      events.map((event) => event.pageId),
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
