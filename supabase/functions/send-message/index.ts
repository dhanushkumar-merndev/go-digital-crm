import { z } from 'npm:zod@4';
import { decryptJson, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

type WhatsAppCredential = {
  access_token: string;
  phone_number_id: string;
  whatsapp_business_account_id: string;
};

const content = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), body: z.string().trim().min(1).max(4096) }),
  z.object({
    type: z.literal('template'),
    name: z.string().trim().min(1).max(512),
    language_code: z.string().trim().min(2).max(20),
    components: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  }),
]);
const schema = z.object({
  organization_id: z.uuid(),
  conversation_id: z.uuid(),
  application_message_id: z.uuid(),
  content,
});

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  let activeMessage:
    | { id: string; organizationId: string; connectionId: string; applicationMessageId: string }
    | undefined;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Message request is invalid.', requestId, 422);
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: conversation } = await client
      .from('conversations')
      .select(
        'id,organization_id,branch_id,connection_id,external_contact,service_window_expires_at,channel,status',
      )
      .eq('id', input.conversation_id)
      .eq('organization_id', input.organization_id)
      .maybeSingle();
    if (!conversation)
      return failure('CONVERSATION_NOT_FOUND', 'The conversation was not found.', requestId, 404);
    const { data: permitted } = await client.rpc('authorize_action', {
      target_organization_id: input.organization_id,
      target_permission: 'message.send',
      target_branch_id: conversation.branch_id,
    });
    if (!permitted)
      return failure('PERMISSION_DENIED', 'You cannot send this message.', requestId, 403);
    if (conversation.channel !== 'WHATSAPP_BUSINESS' || conversation.status !== 'OPEN')
      return failure(
        'CONVERSATION_NOT_SENDABLE',
        'This conversation cannot accept an outbound message.',
        requestId,
        409,
      );
    if (
      input.content.type === 'text' &&
      (!conversation.service_window_expires_at ||
        new Date(conversation.service_window_expires_at).getTime() <= Date.now())
    )
      return failure(
        'WHATSAPP_TEMPLATE_REQUIRED',
        'The customer-service window has closed; select an approved template.',
        requestId,
        409,
      );
    const recipient = String(conversation.external_contact ?? '').replace(/\D/g, '');
    if (recipient.length < 7 || recipient.length > 20)
      return failure(
        'RECIPIENT_NOT_CONFIGURED',
        'The conversation recipient is invalid.',
        requestId,
        409,
      );

    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,provider_key,status')
      .eq('id', conversation.connection_id)
      .eq('organization_id', input.organization_id)
      .eq('provider_key', 'whatsapp_cloud')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    const { data: secret } = connection
      ? await admin
          .from('integration_credentials')
          .select('encrypted_payload')
          .eq('connected_account_id', connection.id)
          .maybeSingle()
      : { data: null };
    if (!connection || !secret)
      return failure(
        'WHATSAPP_CONNECTION_UNAVAILABLE',
        'The WhatsApp connection is unavailable.',
        requestId,
        409,
      );
    const credential = await decryptJson<WhatsAppCredential>(secret.encrypted_payload);
    const graphVersion = Deno.env.get('META_GRAPH_API_VERSION')?.trim();
    if (!graphVersion) throw new Error('META_GRAPH_API_VERSION_MISSING');
    const requestHash = await sha256Base64Url(
      JSON.stringify({ conversation_id: conversation.id, recipient, content: input.content }),
    );

    const { data: existing } = await admin
      .from('conversation_messages')
      .select('id,provider_message_id,delivery_status,request_hash,last_attempt_at,attempt_count')
      .eq('organization_id', input.organization_id)
      .eq('application_message_id', input.application_message_id)
      .maybeSingle();
    let message: { id: string } | null = null;
    if (existing) {
      if (existing.request_hash !== requestHash)
        return failure(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'This message key was already used for different content.',
          requestId,
          409,
        );
      if (existing.delivery_status === 'RETRY') {
        const { data: claimed } = await admin
          .from('conversation_messages')
          .update({
            delivery_status: 'PENDING',
            safe_error_code: null,
            attempt_count: (existing.attempt_count ?? 0) + 1,
            last_attempt_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .eq('delivery_status', 'RETRY')
          .select('id')
          .maybeSingle();
        if (claimed) message = claimed;
      }
      if (!message) {
        const stalePending =
          existing.delivery_status === 'PENDING' &&
          existing.last_attempt_at &&
          new Date(existing.last_attempt_at).getTime() < Date.now() - 2 * 60_000;
        if (stalePending) {
          await admin
            .from('conversation_messages')
            .update({
              delivery_status: 'PENDING_RECONCILIATION',
              safe_error_code: 'SEND_RESULT_UNKNOWN',
            })
            .eq('id', existing.id)
            .eq('delivery_status', 'PENDING');
          await admin.from('domain_outbox').insert({
            organization_id: input.organization_id,
            event_type: 'message.status.reconcile',
            aggregate_type: 'conversation_message',
            aggregate_id: existing.id,
            payload: {
              connection_id: connection.id,
              application_message_id: input.application_message_id,
            },
          });
        }
        return success(
          {
            message_id: existing.id,
            provider_message_id: existing.provider_message_id,
            status: stalePending ? 'PENDING_RECONCILIATION' : existing.delivery_status,
            duplicate: true,
          },
          requestId,
          202,
        );
      }
    }
    const sentAt = new Date().toISOString();
    if (!message) {
      const { data: createdMessage, error: messageError } = await admin
        .from('conversation_messages')
        .insert({
          organization_id: input.organization_id,
          conversation_id: conversation.id,
          application_message_id: input.application_message_id,
          direction: 'OUTBOUND',
          body: input.content.type === 'text' ? input.content.body : null,
          delivery_status: 'PENDING',
          sent_by: auth.user.id,
          sent_at: sentAt,
          request_hash: requestHash,
          attempt_count: 1,
          last_attempt_at: sentAt,
          metadata:
            input.content.type === 'template'
              ? {
                  message_type: 'template',
                  template_name: input.content.name,
                  language_code: input.content.language_code,
                  components: input.content.components,
                }
              : { message_type: 'text' },
        })
        .select('id')
        .single();
      if (messageError) {
        if (messageError.code === '23505')
          return success({ duplicate: true, status: 'PENDING' }, requestId, 202);
        throw messageError;
      }
      message = createdMessage;
    }
    activeMessage = {
      id: message.id,
      organizationId: input.organization_id,
      connectionId: connection.id,
      applicationMessageId: input.application_message_id,
    };
    const providerBody =
      input.content.type === 'text'
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'text',
            text: { preview_url: false, body: input.content.body },
            biz_opaque_callback_data: input.application_message_id,
          }
        : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'template',
            template: {
              name: input.content.name,
              language: { code: input.content.language_code },
              components: input.content.components,
            },
            biz_opaque_callback_data: input.application_message_id,
          };
    const provider = await fetch(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(credential.phone_number_id)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(providerBody),
      },
    );
    const providerResult = (await provider.json().catch(() => null)) as {
      messages?: Array<{ id?: string }>;
    } | null;
    const providerMessageId = providerResult?.messages?.[0]?.id;
    if (!provider.ok || !providerMessageId) {
      const retryable = provider.status === 429 || provider.status >= 500;
      const { error: failureUpdateError } = await admin
        .from('conversation_messages')
        .update({
          delivery_status: retryable ? 'RETRY' : 'FAILED',
          safe_error_code: 'WHATSAPP_PROVIDER_REJECTED',
        })
        .eq('id', message.id);
      if (failureUpdateError) throw failureUpdateError;
      if (retryable)
        await admin.from('domain_outbox').insert({
          organization_id: input.organization_id,
          event_type: 'message.send.retry',
          aggregate_type: 'conversation_message',
          aggregate_id: message.id,
          payload: {
            connection_id: connection.id,
            application_message_id: input.application_message_id,
          },
        });
      activeMessage = undefined;
      return success(
        {
          message_id: message.id,
          provider_message_id: null,
          status: retryable ? 'RETRY' : 'FAILED',
          duplicate: false,
        },
        requestId,
        retryable ? 202 : 422,
      );
    }
    const { error: sentUpdateError } = await admin
      .from('conversation_messages')
      .update({ provider_message_id: providerMessageId, delivery_status: 'SENT' })
      .eq('id', message.id);
    if (sentUpdateError) throw sentUpdateError;
    await admin.from('conversations').update({ last_message_at: sentAt }).eq('id', conversation.id);
    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'message.sent',
      resource_type: 'conversation_message',
      resource_id: message.id,
      branch_id: conversation.branch_id,
      request_id: requestId,
      metadata: { channel: 'WHATSAPP_BUSINESS', content_type: input.content.type },
    });
    activeMessage = undefined;
    return success(
      {
        message_id: message.id,
        provider_message_id: providerMessageId,
        status: 'SENT',
        duplicate: false,
      },
      requestId,
      202,
    );
  } catch {
    if (activeMessage) {
      const admin = serviceClient();
      await admin
        .from('conversation_messages')
        .update({
          delivery_status: 'PENDING_RECONCILIATION',
          safe_error_code: 'SEND_RESULT_UNKNOWN',
        })
        .eq('id', activeMessage.id);
      await admin.from('domain_outbox').insert({
        organization_id: activeMessage.organizationId,
        event_type: 'message.status.reconcile',
        aggregate_type: 'conversation_message',
        aggregate_id: activeMessage.id,
        payload: {
          connection_id: activeMessage.connectionId,
          application_message_id: activeMessage.applicationMessageId,
        },
      });
      return success(
        {
          message_id: activeMessage.id,
          provider_message_id: null,
          status: 'PENDING_RECONCILIATION',
          duplicate: false,
        },
        requestId,
        202,
      );
    }
    return failure(
      'MESSAGE_SEND_FAILED',
      'The message could not be sent. Use the reference ID when contacting support.',
      requestId,
      500,
    );
  }
});
