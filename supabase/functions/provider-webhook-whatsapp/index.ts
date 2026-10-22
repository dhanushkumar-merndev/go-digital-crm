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

type StoredReceipt = {
  id: string;
  organization_id: string;
  connected_account_id: string;
  provider_event_id: string;
  event_type: string;
};

// Database errors that a retry cannot fix (bad input, constraint), as in the
// Trigger.dev dispatcher.
function permanentDatabaseError(error: { code?: string } | null) {
  return Boolean(error?.code && (error.code.startsWith('22') || error.code.startsWith('23')));
}

/**
 * Applies the receipts of this callback before the request ends, so a customer
 * message reaches the inbox in about a second instead of waiting for a worker.
 * Each step is one database call. Receipts are claimed with the same lease as
 * the Trigger.dev dispatcher, so the two never process one event twice; any
 * receipt that fails here is released to RETRY and picked up by that worker.
 */
async function applyReceiptsInline(
  admin: ReturnType<typeof serviceClient>,
  stored: StoredReceipt[],
  events: ReturnType<typeof extractWhatsAppEvents>,
) {
  const workerId = `edge:whatsapp-webhook:${crypto.randomUUID()}`;
  const { data: claimed, error: claimError } = await admin.rpc('claim_provider_event_receipts', {
    target_worker_id: workerId,
    target_event_ids: stored.map((receipt) => receipt.id),
  });
  if (claimError) throw claimError;
  const messages = new Map(events.messages.map((message) => [message.eventId, message]));
  const statuses = new Map(events.statuses.map((status) => [status.eventId, status]));
  const branches = new Map<string, string | null>();
  const branchFor = async (receipt: StoredReceipt, phoneNumberId: string) => {
    const key = `${receipt.connected_account_id}:${phoneNumberId}`;
    if (!branches.has(key)) {
      const { data } = await admin
        .from('integration_branch_mappings')
        .select('branch_id')
        .eq('organization_id', receipt.organization_id)
        .eq('connected_account_id', receipt.connected_account_id)
        .eq('external_resource_type', 'WHATSAPP_PHONE_NUMBER')
        .eq('external_resource_id', phoneNumberId)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();
      branches.set(key, data?.branch_id ? String(data.branch_id) : null);
    }
    return branches.get(key) ?? null;
  };
  const finish = (
    receipt: StoredReceipt,
    status: 'PROCESSED' | 'UNMAPPED',
    patch = {},
    code?: string,
  ) =>
    admin.rpc('complete_provider_event', {
      target_event_id: receipt.id,
      target_worker_id: workerId,
      target_status: status,
      target_safe_error_code: code ?? null,
      target_payload_patch: patch,
    });
  const release = (receipt: StoredReceipt, code: string, permanent: boolean) =>
    admin.rpc('retry_provider_event', {
      target_event_id: receipt.id,
      target_worker_id: workerId,
      target_safe_error_code: code,
      // A status can arrive before send-message has stored the provider ID; a
      // short delay lets that settle without waiting for the minute pass.
      target_delay_seconds: 5,
      target_permanent: permanent,
    });

  // In arrival order, so a reply is stored before the receipts that follow it.
  for (const receipt of (claimed ?? []) as StoredReceipt[]) {
    try {
      if (receipt.event_type === 'WHATSAPP_INBOUND_MESSAGE') {
        const message = messages.get(receipt.provider_event_id);
        if (!message) {
          await release(receipt, 'WHATSAPP_INBOUND_RECEIPT_INVALID', false);
          continue;
        }
        const branchId = await branchFor(receipt, message.phoneNumberId);
        if (!branchId) {
          await finish(receipt, 'UNMAPPED', {}, 'WHATSAPP_NUMBER_NOT_MAPPED');
          continue;
        }
        const { data, error } = await admin.rpc('ingest_whatsapp_inbound_message', {
          target_organization_id: receipt.organization_id,
          target_connection_id: receipt.connected_account_id,
          target_branch_id: branchId,
          target_phone_number_id: message.phoneNumberId,
          target_provider_message_id: message.eventId.replace(/^whatsapp-message:/, ''),
          target_sender: message.sender,
          target_sender_name: message.senderName ?? null,
          target_sent_at: message.sentAt,
          target_message_type: message.messageType,
          target_body: message.body ?? null,
          target_provider_payload: message.providerPayload,
        });
        if (error) {
          if (String(error.message).includes('WHATSAPP_NUMBER_NOT_MAPPED'))
            await finish(receipt, 'UNMAPPED', {}, 'WHATSAPP_NUMBER_NOT_MAPPED');
          else
            await release(
              receipt,
              'WHATSAPP_INBOUND_MESSAGE_REJECTED',
              permanentDatabaseError(error),
            );
          continue;
        }
        const result = (data ?? {}) as {
          conversation_id?: string;
          message_id?: string;
          duplicate?: boolean;
        };
        await finish(receipt, 'PROCESSED', {
          conversation_id: result.conversation_id ?? null,
          message_id: result.message_id ?? null,
          duplicate: result.duplicate ?? false,
        });
      } else if (receipt.event_type === 'WHATSAPP_MESSAGE_STATUS') {
        const status = statuses.get(receipt.provider_event_id);
        if (!status || !['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(status.status)) {
          // A missing status is a parsing mismatch worth retrying; an unknown
          // state ("deleted", "warning") never becomes valid.
          await release(receipt, 'WHATSAPP_STATUS_RECEIPT_INVALID', Boolean(status));
          continue;
        }
        const applicationMessageId =
          status.applicationMessageId && uuidPattern.test(status.applicationMessageId)
            ? status.applicationMessageId
            : null;
        const apply = () =>
          admin.rpc('apply_whatsapp_message_status', {
            target_organization_id: receipt.organization_id,
            target_connection_id: receipt.connected_account_id,
            target_provider_message_id: status.providerMessageId,
            target_application_message_id: applicationMessageId,
            target_delivery_status: status.status,
            target_occurred_at: status.occurredAt,
          });
        let { data, error } = await apply();
        // Meta can report SENT before send-message has stored the provider ID.
        if (!error && !(data as { matched?: boolean } | null)?.matched) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          ({ data, error } = await apply());
        }
        if (error) {
          await release(receipt, 'WHATSAPP_MESSAGE_STATUS_REJECTED', permanentDatabaseError(error));
          continue;
        }
        const result = (data ?? {}) as {
          matched?: boolean;
          updated?: boolean;
          message_id?: string;
        };
        if (!result.matched) {
          await release(receipt, 'WHATSAPP_OUTBOUND_MESSAGE_NOT_FOUND', false);
          continue;
        }
        await finish(receipt, 'PROCESSED', {
          message_id: result.message_id ?? null,
          stale_status_ignored: result.updated === false,
        });
      } else {
        await release(receipt, 'PROVIDER_EVENT_TYPE_UNSUPPORTED', true);
      }
    } catch {
      // Network or runtime failure: release it for the worker to retry.
      try {
        await release(receipt, 'PROVIDER_EVENT_PROCESSING_RETRY', false);
      } catch {
        // The lease lapses on its own; the worker reclaims the receipt.
      }
    }
  }
}

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
      .select('id,organization_id,connected_account_id,provider_event_id,event_type');
    if (error) throw error;
    const queued = inserted?.length ?? 0;
    if (queued > 0) {
      // Acknowledge durable receipt storage promptly, then apply the receipts
      // here. Only if that fails is the Trigger.dev worker woken; the minute
      // schedule still claims anything left RECEIVED or RETRY.
      EdgeRuntime.waitUntil(
        (async () => {
          const receipts = inserted as StoredReceipt[];
          try {
            await applyReceiptsInline(admin, receipts, events);
            return;
          } catch {
            console.warn('WHATSAPP_INLINE_APPLY_FAILED');
          }
          try {
            const eventIds = receipts.map((event) => String(event.id));
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
