import { z } from 'npm:zod@4';
import { sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  recipient: z.email(),
  template_id: z.int().positive(),
  variables: z
    .record(z.string().max(100), z.string().max(2000))
    .refine((value) => Object.keys(value).length <= 100, 'Too many template variables.'),
  idempotency_key: z.uuid(),
});

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  let activeMessage: { id: string; organizationId: string; idempotencyKey: string } | undefined;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Email request is invalid.', requestId, 422);
    const input = parsed.data;
    const apiKey = Deno.env.get('BREVO_API_KEY')?.trim();
    if (!apiKey)
      return failure(
        'EMAIL_PROVIDER_NOT_CONFIGURED',
        'Transactional email is not configured.',
        requestId,
        503,
      );
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted } = await client.rpc('authorize_action', {
      target_organization_id: input.organization_id,
      target_permission: 'email.send',
      target_branch_id: null,
    });
    if (!permitted)
      return failure('PERMISSION_DENIED', 'You cannot send this email.', requestId, 403);

    const admin = serviceClient();
    const { data: approvedTemplate } = await admin
      .from('templates')
      .select('id')
      .eq('organization_id', input.organization_id)
      .eq('channel', 'EMAIL')
      .eq('provider_template_id', String(input.template_id))
      .eq('status', 'APPROVED')
      .maybeSingle();
    if (!approvedTemplate)
      return failure(
        'EMAIL_TEMPLATE_NOT_APPROVED',
        'Select an approved transactional email template.',
        requestId,
        422,
      );
    const requestHash = await sha256Base64Url(
      JSON.stringify({
        organization_id: input.organization_id,
        recipient: input.recipient.toLocaleLowerCase(),
        template_id: input.template_id,
        variables: Object.entries(input.variables).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      }),
    );
    const { data: existing } = await admin
      .from('email_messages')
      .select('id,status,provider_message_id,request_hash,attempt_count,last_attempt_at')
      .eq('organization_id', input.organization_id)
      .eq('application_message_id', input.idempotency_key)
      .maybeSingle();

    let message: { id: string } | null = null;
    if (existing) {
      if (existing.request_hash !== requestHash)
        return failure(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'This email key was already used for a different request.',
          requestId,
          409,
        );
      const stalePending =
        existing.status === 'PENDING' &&
        existing.last_attempt_at &&
        new Date(existing.last_attempt_at).getTime() < Date.now() - 2 * 60_000;
      if (existing.status === 'RETRY' || stalePending) {
        const { data: claimed } = await admin
          .from('email_messages')
          .update({
            status: 'PENDING',
            error_code: null,
            error_message: null,
            attempt_count: (existing.attempt_count ?? 0) + 1,
            last_attempt_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .eq('status', existing.status)
          .select('id')
          .maybeSingle();
        message = claimed;
      }
      if (!message)
        return success(
          {
            message_id: existing.id,
            provider_message_id: existing.provider_message_id,
            status: existing.status,
            duplicate: true,
          },
          requestId,
          202,
        );
    }

    if (!message) {
      const minuteAgo = new Date(Date.now() - 60_000).toISOString();
      const { count, error: countError } = await admin
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', input.organization_id)
        .eq('requested_by', auth.user.id)
        .gte('created_at', minuteAgo);
      if (countError) throw countError;
      if ((count ?? 0) >= 10)
        return failure(
          'EMAIL_RATE_LIMITED',
          'Too many emails were requested. Try again in one minute.',
          requestId,
          429,
        );
      const now = new Date().toISOString();
      const { data: created, error: insertError } = await admin
        .from('email_messages')
        .insert({
          organization_id: input.organization_id,
          application_message_id: input.idempotency_key,
          template_id: String(input.template_id),
          recipient: input.recipient.toLocaleLowerCase(),
          requested_by: auth.user.id,
          status: 'PENDING',
          request_hash: requestHash,
          template_variables: input.variables,
          attempt_count: 1,
          last_attempt_at: now,
        })
        .select('id')
        .single();
      if (insertError) {
        if (insertError.code === '23505')
          return success({ duplicate: true, status: 'PENDING' }, requestId, 202);
        throw insertError;
      }
      message = created;
    }
    activeMessage = {
      id: message.id,
      organizationId: input.organization_id,
      idempotencyKey: input.idempotency_key,
    };

    const provider = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
        'idempotency-key': input.idempotency_key,
      },
      body: JSON.stringify({
        to: [{ email: input.recipient }],
        templateId: input.template_id,
        params: input.variables,
        tags: ['go-digital-crm'],
      }),
    });
    const providerBody = (await provider.json().catch(() => null)) as {
      messageId?: string;
      code?: string;
    } | null;
    if (!provider.ok || !providerBody?.messageId) {
      const retryable = provider.status === 429 || provider.status >= 500;
      const { error: failureUpdateError } = await admin
        .from('email_messages')
        .update({
          status: retryable ? 'RETRY' : 'FAILED',
          error_code: providerBody?.code ?? String(provider.status),
          error_message: 'Transactional email provider rejected the request.',
        })
        .eq('id', message.id);
      if (failureUpdateError) throw failureUpdateError;
      if (retryable)
        await admin.from('domain_outbox').insert({
          organization_id: input.organization_id,
          event_type: 'email.send.retry',
          aggregate_type: 'email_message',
          aggregate_id: message.id,
          payload: { application_message_id: input.idempotency_key },
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
    const acceptedAt = new Date().toISOString();
    const { error: acceptedUpdateError } = await admin
      .from('email_messages')
      .update({
        status: 'ACCEPTED',
        provider_message_id: providerBody.messageId,
        accepted_at: acceptedAt,
        error_code: null,
        error_message: null,
      })
      .eq('id', message.id);
    if (acceptedUpdateError) throw acceptedUpdateError;
    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'email.accepted',
      resource_type: 'email_message',
      resource_id: message.id,
      request_id: requestId,
      metadata: { template_id: input.template_id },
    });
    activeMessage = undefined;
    return success(
      {
        message_id: message.id,
        application_message_id: input.idempotency_key,
        provider_message_id: providerBody.messageId,
        status: 'ACCEPTED',
        duplicate: false,
      },
      requestId,
      202,
    );
  } catch {
    if (activeMessage) {
      const admin = serviceClient();
      await admin
        .from('email_messages')
        .update({ status: 'RETRY', error_code: 'EMAIL_SEND_RESULT_UNKNOWN' })
        .eq('id', activeMessage.id);
      await admin.from('domain_outbox').insert({
        organization_id: activeMessage.organizationId,
        event_type: 'email.send.retry',
        aggregate_type: 'email_message',
        aggregate_id: activeMessage.id,
        payload: { application_message_id: activeMessage.idempotencyKey },
      });
      return success(
        {
          message_id: activeMessage.id,
          provider_message_id: null,
          status: 'RETRY',
          duplicate: false,
        },
        requestId,
        202,
      );
    }
    return failure(
      'EMAIL_SEND_FAILED',
      'The email could not be sent. Use the reference ID when contacting support.',
      requestId,
      500,
    );
  }
});
