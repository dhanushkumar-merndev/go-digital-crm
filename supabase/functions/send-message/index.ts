import { z } from 'npm:zod@4';
import { decryptJson, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { personalError, personalGateway } from '../_shared/personal-whatsapp.ts';

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
  // An approved template registered in the CRM. The server resolves the Meta
  // name and body itself, so the client cannot send an unapproved template or
  // record a body that differs from what the customer received.
  z.object({
    type: z.literal('crm_template'),
    template_id: z.uuid(),
    variables: z.record(z.string().max(40), z.string().trim().min(1).max(1024)).default({}),
  }),
]);

type ResolvedTemplate = { name: string; languageCode: string; body: string; components: unknown[] };

// Meta numbers template placeholders positionally. CRM bodies name them, in the
// {{1}}, {{2}} convention, so they are ordered the way the drip dispatcher
// orders them: numerically by key.
function orderedPlaceholders(placeholders: string[]) {
  return [...new Set(placeholders)].sort((left, right) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
}
const schema = z.object({
  organization_id: z.uuid(),
  conversation_id: z.uuid(),
  application_message_id: z.uuid(),
  expected_lead_id: z.uuid().nullable().optional(),
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
    // These three are independent reads, run together to keep a reply fast.
    // Each one carries the caller's JWT, so PostgREST still rejects an invalid
    // token; the user check below only decides which error to return.
    const conversationLookup = client
      .from('conversations')
      .select(
        'id,organization_id,branch_id,connection_id,external_contact,service_window_expires_at,channel,status',
      )
      .eq('id', input.conversation_id)
      .eq('organization_id', input.organization_id)
      .maybeSingle();
    const personalPrepare =
      input.content.type === 'text'
        ? client.rpc(
            input.expected_lead_id === undefined
              ? 'personal_whatsapp_send_prepare'
              : 'personal_whatsapp_send_for_lead',
            {
              target_conversation_id: input.conversation_id,
              target_application_message_id: input.application_message_id,
              target_body: input.content.body,
              ...(input.expected_lead_id === undefined
                ? {}
                : { expected_lead_id: input.expected_lead_id }),
            },
          )
        : null;
    const [{ data: auth }, prepareResult, conversationResult] = await Promise.all([
      client.auth.getUser(),
      personalPrepare,
      conversationLookup,
    ]);
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    // The prepare RPC already verifies the authenticated owner, eligible role,
    // message permission, branch/record scope, reply window and rate limits.
    if (input.content.type === 'text' && prepareResult) {
      let prepared:
        | {
            message_id: string;
            connection_id: string;
            generation: string;
            status: string;
            duplicate: boolean;
          }
        | undefined;
      try {
        const { data, error } = prepareResult;
        if (error) {
          if (error.message === 'PERSONAL_WHATSAPP_NOT_FOUND') {
            prepared = undefined;
          } else {
            throw error;
          }
        }
        if (!data) {
          // This is not a personal conversation; continue to the official
          // WhatsApp path below without exposing whether an inaccessible row exists.
        } else {
          prepared = data;
          if (prepared?.duplicate) return success(prepared, requestId, 202);
          const result = await personalGateway('POST', '/v1/messages', prepared);
          return success(result, requestId, 202);
        }
      } catch (error) {
        if (prepared) {
          // These gateway rejections happen before the provider call. Network
          // failures and ambiguous results must still remain UNKNOWN.
          const rejectedBeforeSend = [
            'PERSONAL_WHATSAPP_SEND_DENIED',
            'PERSONAL_WHATSAPP_DISCONNECTED',
            'PERSONAL_WHATSAPP_SESSION_REVOKED',
            'PERSONAL_WHATSAPP_LEASE_LOST',
          ].includes(personalError(error));
          await serviceClient().rpc('personal_whatsapp_send_result', {
            target_connection_id: prepared.connection_id,
            target_message_id: prepared.message_id,
            target_status: rejectedBeforeSend ? 'FAILED' : 'UNKNOWN',
          });
          if (rejectedBeforeSend)
            return failure(
              personalError(error),
              'WhatsApp rejected the send before dispatch.',
              requestId,
              409,
            );
          return success({ message_id: prepared.message_id, status: 'UNKNOWN' }, requestId, 202);
        }
        return failure(
          personalError(error),
          'Personal WhatsApp reply is unavailable.',
          requestId,
          409,
        );
      }
    }
    const { data: conversation } = conversationResult;
    if (!conversation)
      return failure('CONVERSATION_NOT_FOUND', 'The conversation was not found.', requestId, 404);
    // Started with the permission check and awaited only after it passes, so
    // nothing they read is returned to a caller who may not send.
    const admin = serviceClient();
    const connectionLookup = admin
      .from('connected_accounts')
      .select('id,provider_key,status')
      .eq('id', conversation.connection_id)
      .eq('organization_id', input.organization_id)
      .eq('provider_key', 'whatsapp_cloud')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    const secretLookup = admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('connected_account_id', conversation.connection_id)
      .maybeSingle();
    const existingLookup = admin
      .from('conversation_messages')
      .select('id,provider_message_id,delivery_status,request_hash,last_attempt_at,attempt_count')
      .eq('organization_id', input.organization_id)
      .eq('application_message_id', input.application_message_id)
      .maybeSingle();
    const [{ data: permitted }, connectionResult, secretResult, existingResult] = await Promise.all(
      [
        client.rpc('authorize_action', {
          target_organization_id: input.organization_id,
          target_permission: 'message.send',
          target_branch_id: conversation.branch_id,
        }),
        connectionLookup,
        secretLookup,
        existingLookup,
      ],
    );
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
    let resolvedTemplate: ResolvedTemplate | undefined;
    if (input.content.type === 'crm_template') {
      const variables = input.content.variables;
      const fill = (text: string, prefix: string) =>
        text.replace(
          /\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}/g,
          (match: string, name: string) => variables[`${prefix}${name}`]?.trim() ?? match,
        );
      const missingFields = (names: string[]) => names.some((name) => !variables[name]?.trim());
      const variablesRequired = () =>
        failure(
          'WHATSAPP_TEMPLATE_VARIABLES_REQUIRED',
          'Fill in every template field before sending.',
          requestId,
          422,
        );
      const { data: template } = await serviceClient()
        .from('templates')
        .select('id,provider_template_id,content,placeholders,channel,status')
        .eq('organization_id', input.organization_id)
        .eq('id', input.content.template_id)
        .is('deleted_at', null)
        .maybeSingle();
      // A template synced from Meta and switched on for this conversation's
      // own WhatsApp connection by an admin.
      const { data: metaTemplate } = template
        ? { data: null }
        : await serviceClient()
            .from('whatsapp_business_templates')
            .select('name,language,parameter_format,header_text,body,footer_text,fields')
            .eq('organization_id', input.organization_id)
            .eq('id', input.content.template_id)
            .eq('connected_account_id', conversation.connection_id)
            .eq('enabled', true)
            .eq('supported', true)
            .eq('meta_status', 'APPROVED')
            .is('removed_from_meta_at', null)
            .maybeSingle();
      const body = typeof template?.content?.body === 'string' ? template.content.body : null;
      if (
        template &&
        body &&
        template.provider_template_id &&
        String(template.status).toUpperCase() === 'APPROVED' &&
        ['WHATSAPP', 'WHATSAPP_BUSINESS'].includes(String(template.channel).toUpperCase())
      ) {
        const placeholders = orderedPlaceholders(
          Array.isArray(template.placeholders) ? template.placeholders.map(String) : [],
        );
        if (missingFields(placeholders)) return variablesRequired();
        resolvedTemplate = {
          name: template.provider_template_id,
          languageCode: Deno.env.get('META_TEMPLATE_LANGUAGE')?.trim() || 'en',
          body: fill(body, ''),
          components: placeholders.length
            ? [
                {
                  type: 'body',
                  parameters: placeholders.map((name) => ({
                    type: 'text',
                    text: variables[name]!.trim(),
                  })),
                },
              ]
            : [],
        };
      } else if (metaTemplate) {
        // `fields` is already in Meta's order: header first, then body.
        const fields: string[] = Array.isArray(metaTemplate.fields)
          ? metaTemplate.fields.map(String)
          : [];
        if (missingFields(fields)) return variablesRequired();
        const named = metaTemplate.parameter_format === 'NAMED';
        const parametersFor = (prefix: string) =>
          fields
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({
              type: 'text',
              ...(named ? { parameter_name: key.slice(prefix.length) } : {}),
              text: variables[key]!.trim(),
            }));
        const header = parametersFor('header:');
        const bodyParameters = parametersFor('body:');
        resolvedTemplate = {
          name: metaTemplate.name,
          languageCode: metaTemplate.language,
          body: [
            metaTemplate.header_text ? fill(metaTemplate.header_text, 'header:') : null,
            fill(metaTemplate.body ?? '', 'body:'),
            metaTemplate.footer_text,
          ]
            .filter(Boolean)
            .join('\n\n'),
          components: [
            ...(header.length ? [{ type: 'header', parameters: header }] : []),
            ...(bodyParameters.length ? [{ type: 'body', parameters: bodyParameters }] : []),
          ],
        };
      } else {
        return failure(
          'WHATSAPP_TEMPLATE_NOT_APPROVED',
          'Select an approved WhatsApp template.',
          requestId,
          422,
        );
      }
    }
    const recipient = String(conversation.external_contact ?? '').replace(/\D/g, '');
    if (recipient.length < 7 || recipient.length > 20)
      return failure(
        'RECIPIENT_NOT_CONFIGURED',
        'The conversation recipient is invalid.',
        requestId,
        409,
      );

    const connection = connectionResult.data;
    const secret = connection ? secretResult.data : null;
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

    const { data: existing } = existingResult;
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
          body:
            input.content.type === 'text' ? input.content.body : (resolvedTemplate?.body ?? null),
          delivery_status: 'PENDING',
          sent_by: auth.user.id,
          sent_at: sentAt,
          request_hash: requestHash,
          attempt_count: 1,
          last_attempt_at: sentAt,
          metadata: {
            ...(input.expected_lead_id === undefined
              ? {}
              : { expected_lead_id: input.expected_lead_id }),
            ...(input.content.type === 'template'
              ? {
                  message_type: 'template',
                  template_name: input.content.name,
                  language_code: input.content.language_code,
                  components: input.content.components,
                }
              : input.content.type === 'crm_template' && resolvedTemplate
                ? {
                    message_type: 'template',
                    template_id: input.content.template_id,
                    template_name: resolvedTemplate.name,
                    language_code: resolvedTemplate.languageCode,
                  }
                : { message_type: 'text' }),
          },
        })
        .select('id')
        .single();
      if (messageError) {
        if (messageError.message === 'LEAD_CONTEXT_CHANGED')
          return failure(
            'LEAD_CONTEXT_CHANGED',
            'The working lead changed. Review it before sending.',
            requestId,
            409,
          );
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
            template:
              input.content.type === 'template'
                ? {
                    name: input.content.name,
                    language: { code: input.content.language_code },
                    components: input.content.components,
                  }
                : {
                    name: resolvedTemplate!.name,
                    language: { code: resolvedTemplate!.languageCode },
                    components: resolvedTemplate!.components,
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
      error?: {
        code?: number;
        error_subcode?: number;
        message?: string;
        error_data?: { details?: string };
      };
    } | null;
    const providerMessageId = providerResult?.messages?.[0]?.id;
    if (!provider.ok || !providerMessageId) {
      const retryable = provider.status === 429 || provider.status >= 500;
      // Meta's own reason (e.g. 131030 recipient not in the test number's
      // allowed list, 132001 template/language not found, 131042 payment).
      // Codes and their public descriptions only; never the request or token.
      const providerError = providerResult?.error
        ? {
            code: providerResult.error.code ?? null,
            subcode: providerResult.error.error_subcode ?? null,
            title: String(providerResult.error.message ?? '').slice(0, 200),
            details: String(providerResult.error.error_data?.details ?? '').slice(0, 300),
            http_status: provider.status,
          }
        : { code: null, subcode: null, title: '', details: '', http_status: provider.status };
      const { data: failedRow } = await admin
        .from('conversation_messages')
        .select('metadata')
        .eq('id', message.id)
        .maybeSingle();
      const { error: failureUpdateError } = await admin
        .from('conversation_messages')
        .update({
          delivery_status: retryable ? 'RETRY' : 'FAILED',
          safe_error_code: 'WHATSAPP_PROVIDER_REJECTED',
          metadata: { ...(failedRow?.metadata ?? {}), provider_error: providerError },
        })
        .eq('id', message.id)
        .is('provider_status_at', null);
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
          provider_error_code: providerError.code,
          provider_error: providerError.details || providerError.title || null,
        },
        requestId,
        retryable ? 202 : 422,
      );
    }
    const [{ error: sentUpdateError }] = await Promise.all([
      admin
        .from('conversation_messages')
        .update({ provider_message_id: providerMessageId, delivery_status: 'SENT' })
        .eq('id', message.id)
        // A callback can finish before Meta's send response. It has already set
        // the provider ID and final status; never overwrite that receipt.
        .is('provider_status_at', null),
      admin.from('conversations').update({ last_message_at: sentAt }).eq('id', conversation.id),
      admin.from('audit_logs').insert({
        organization_id: input.organization_id,
        actor_id: auth.user.id,
        action: 'message.sent',
        resource_type: 'conversation_message',
        resource_id: message.id,
        branch_id: conversation.branch_id,
        request_id: requestId,
        metadata: { channel: 'WHATSAPP_BUSINESS', content_type: input.content.type },
      }),
    ]);
    if (sentUpdateError) throw sentUpdateError;
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
        .eq('id', activeMessage.id)
        .is('provider_status_at', null);
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
