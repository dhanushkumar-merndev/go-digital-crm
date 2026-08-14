import { z } from 'npm:zod@4';
import { failure, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  recipient: z.email(),
  template_id: z.int().positive(),
  variables: z.record(z.string(), z.string()),
  idempotency_key: z.uuid(),
});
Deno.serve(async (request) => {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  const input = schema.safeParse(await request.json());
  if (!input.success)
    return failure('INVALID_PAYLOAD', 'Email request is invalid.', requestId, 422);
  try {
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted } = await client.rpc('authorize_action', {
      target_organization_id: input.data.organization_id,
      target_permission: 'email.send',
      target_branch_id: null,
    });
    if (!permitted)
      return failure('PERMISSION_DENIED', 'You cannot send this email.', requestId, 403);
    const admin = serviceClient();
    const { data: message, error: insertError } = await admin
      .from('email_messages')
      .upsert(
        {
          organization_id: input.data.organization_id,
          application_message_id: input.data.idempotency_key,
          template_id: String(input.data.template_id),
          recipient: input.data.recipient,
          requested_by: auth.user.id,
        },
        { onConflict: 'application_message_id', ignoreDuplicates: true },
      )
      .select('id,status,provider_message_id')
      .maybeSingle();
    if (insertError) throw insertError;
    if (!message) return success({ duplicate: true }, requestId);
    const apiKey = Deno.env.get('BREVO_API_KEY');
    if (!apiKey) throw new Error('BREVO_CONFIGURATION_MISSING');
    const provider = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
        'idempotency-key': input.data.idempotency_key,
      },
      body: JSON.stringify({
        to: [{ email: input.data.recipient }],
        templateId: input.data.template_id,
        params: input.data.variables,
        tags: ['go-digital-crm'],
      }),
    });
    const providerBody = (await provider.json()) as { messageId?: string; code?: string };
    if (!provider.ok || !providerBody.messageId) {
      await admin
        .from('email_messages')
        .update({
          status: 'FAILED',
          error_code: providerBody.code ?? String(provider.status),
          error_message: 'Transactional email provider rejected the request.',
        })
        .eq('id', message.id);
      return failure(
        'EMAIL_PROVIDER_REJECTED',
        'The email provider rejected the request.',
        requestId,
        502,
      );
    }
    await admin
      .from('email_messages')
      .update({
        status: 'ACCEPTED',
        provider_message_id: providerBody.messageId,
        accepted_at: new Date().toISOString(),
      })
      .eq('id', message.id);
    return success(
      {
        application_message_id: input.data.idempotency_key,
        provider_message_id: providerBody.messageId,
      },
      requestId,
      202,
    );
  } catch {
    return failure(
      'EMAIL_SEND_FAILED',
      'The email could not be sent. Use the reference ID when contacting support.',
      requestId,
      500,
    );
  }
});
