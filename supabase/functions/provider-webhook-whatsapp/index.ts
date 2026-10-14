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
import { enqueueTriggerTask } from '../_shared/trigger-task.ts';
import { extractWhatsAppEvents } from '../../../src/lib/providers/whatsapp-cloud-adapter.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

type DealershipWebhookCredential = { app_secret?: string; webhook_verify_token?: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A dealership on its own Meta app points the webhook at
// `?connection=<id>`; that connection's stored verify token and app secret are
// used instead of the platform ones, and only its own phone numbers are
// accepted from that callback. Without the parameter the platform app applies.
async function dealershipRoute(admin: ReturnType<typeof serviceClient>, connectionId: string) {
  if (!uuidPattern.test(connectionId)) return null;
  const { data: connection } = await admin
    .from('connected_accounts')
    .select('id,organization_id')
    .eq('id', connectionId)
    .eq('provider_key', 'whatsapp_cloud')
    .eq('status', 'CONNECTED')
    .contains('connection_config', { webhook_mode: 'DEALERSHIP_APP' })
    .is('deleted_at', null)
    .maybeSingle();
  if (!connection) return null;
  const { data: stored } = await admin
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('organization_id', connection.organization_id)
    .eq('connected_account_id', connection.id)
    .maybeSingle();
  if (!stored) return null;
  const credential = await decryptJson<DealershipWebhookCredential>(stored.encrypted_payload);
  if (!credential.app_secret || !credential.webhook_verify_token) return null;
  return {
    connectionId: String(connection.id),
    appSecret: credential.app_secret,
    verifyToken: credential.webhook_verify_token,
  };
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  const url = new URL(request.url);
  const routeConnectionId = url.searchParams.get('connection')?.trim() ?? '';
  const loadDealership = async () => {
    const route = routeConnectionId
      ? await dealershipRoute(serviceClient(), routeConnectionId)
      : null;
    return { route, invalid: Boolean(routeConnectionId) && !route };
  };

  if (request.method === 'GET') {
    const dealership = await loadDealership();
    if (dealership.invalid)
      return failure('WEBHOOK_ROUTE_INVALID', 'Webhook route is invalid.', requestId, 403);
    const expectedToken =
      dealership.route?.verifyToken ?? Deno.env.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN') ?? '';
    const suppliedToken = url.searchParams.get('hub.verify_token') ?? '';
    const challenge = url.searchParams.get('hub.challenge');
    if (
      url.searchParams.get('hub.mode') !== 'subscribe' ||
      !challenge ||
      !expectedToken ||
      !constantTimeEqual(suppliedToken, expectedToken)
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
  const dealership = await loadDealership();
  if (dealership.invalid)
    return failure('WEBHOOK_ROUTE_INVALID', 'Webhook route is invalid.', requestId, 401);
  const appSecret = dealership.route?.appSecret ?? Deno.env.get('META_APP_SECRET') ?? '';
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  if (
    !appSecret ||
    !signature.startsWith('sha256=') ||
    !constantTimeEqual(signature, `sha256=${await hmacSha256Hex(appSecret, rawBody)}`)
  )
    return failure('INVALID_SIGNATURE', 'Webhook signature is invalid.', requestId, 401);

  try {
    const events = extractWhatsAppEvents(JSON.parse(rawBody) as unknown);
    const eventCount = events.messages.length + events.statuses.length;
    if (eventCount > 100)
      return failure('TOO_MANY_EVENTS', 'The webhook event batch is too large.', requestId, 413);
    if (eventCount === 0) return success({ accepted: true, queued: 0 }, requestId);
    const admin = serviceClient();
    const routes = await resolveProviderAssetRoutes(
      admin,
      'whatsapp_cloud',
      'WHATSAPP_PHONE_NUMBER',
      [
        ...events.messages.map((message) => message.phoneNumberId),
        ...events.statuses.map((status) => status.phoneNumberId),
      ],
    );
    // A dealership callback is signed with that dealership's app secret, so it
    // may only deliver events for its own connection.
    const routeFor = (phoneNumberId: string) => {
      const route = routes.get(phoneNumberId);
      return route && (!dealership.route || route.connectionId === dealership.route.connectionId)
        ? route
        : undefined;
    };
    const payloadHash = await sha256Base64Url(rawBody);
    const receipts = [
      ...events.messages.flatMap((message) => {
        const route = routeFor(message.phoneNumberId);
        return route
          ? [
              {
                organization_id: route.organizationId,
                connected_account_id: route.connectionId,
                provider_event_id: message.eventId,
                event_type: 'WHATSAPP_INBOUND_MESSAGE',
                payload_hash: payloadHash,
                payload: {
                  phone_number_id: message.phoneNumberId,
                  sender_name: message.senderName,
                  provider_payload: message.providerPayload,
                },
                status: 'RECEIVED',
              },
            ]
          : [];
      }),
      ...events.statuses.flatMap((status) => {
        const route = routeFor(status.phoneNumberId);
        return route
          ? [
              {
                organization_id: route.organizationId,
                connected_account_id: route.connectionId,
                provider_event_id: status.eventId,
                event_type: 'WHATSAPP_MESSAGE_STATUS',
                payload_hash: payloadHash,
                payload: {
                  phone_number_id: status.phoneNumberId,
                  provider_payload: status.providerPayload,
                },
                status: 'RECEIVED',
              },
            ]
          : [];
      }),
    ];
    const unmappedPhoneIds = [
      ...events.messages.map((message) => message.phoneNumberId),
      ...events.statuses.map((status) => status.phoneNumberId),
    ].filter((phoneNumberId) => !routes.has(phoneNumberId));
    await recordUnmappedProviderAssets(
      admin,
      'provider-webhook-whatsapp',
      'WHATSAPP_PHONE_NUMBER',
      unmappedPhoneIds,
    );
    if (receipts.length === 0)
      return success({ accepted: true, queued: 0, unmapped: eventCount }, requestId);
    const { data: inserted, error } = await admin
      .from('provider_events')
      .upsert(receipts, {
        onConflict: 'organization_id,connected_account_id,provider_event_id',
        ignoreDuplicates: true,
      })
      .select('id');
    if (error) throw error;
    const queued = inserted?.length ?? 0;
    if (queued > 0) {
      // Acknowledge durable receipt storage promptly; waking the worker must
      // not hold Meta's response open. If enqueue fails or the runtime stops,
      // the existing minute schedule still claims these RECEIVED events.
      EdgeRuntime.waitUntil(
        (async () => {
          try {
            const eventIds = inserted!.map((event) => String(event.id));
            await enqueueTriggerTask(
              'provider-event-dispatch-now',
              { eventIds },
              `provider-events:${await sha256Base64Url(JSON.stringify([...eventIds].sort()))}`,
            );
          } catch {
            console.warn('WHATSAPP_IMMEDIATE_DISPATCH_NOT_QUEUED');
          }
        })(),
      );
    }
    return success(
      {
        accepted: true,
        queued,
        duplicates: receipts.length - queued,
        unmapped: unmappedPhoneIds.length,
      },
      requestId,
    );
  } catch {
    return failure(
      'WHATSAPP_WEBHOOK_FAILED',
      'The WhatsApp webhook could not be accepted.',
      requestId,
      500,
    );
  }
});
