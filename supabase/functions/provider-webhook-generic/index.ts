import { z } from 'npm:zod@4';
import { constantTimeEqual, decryptJson, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import type { StoredOAuthCredential } from '../_shared/provider-oauth.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { parseGoogleLeadEnvelope } from '../../../src/lib/providers/google-lead-form-adapter.ts';

const connectionIdSchema = z.uuid();

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > 256_000)
    return failure('PAYLOAD_TOO_LARGE', 'The webhook payload is too large.', requestId, 413);

  const url = new URL(request.url);
  const connectionId = connectionIdSchema.safeParse(url.searchParams.get('connection_id'));
  if (!connectionId.success)
    return failure(
      'INVALID_CONNECTION',
      'A valid provider connection is required.',
      requestId,
      400,
    );

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 256_000)
      return failure('PAYLOAD_TOO_LARGE', 'The webhook payload is too large.', requestId, 413);
    let envelope: ReturnType<typeof parseGoogleLeadEnvelope>;
    try {
      envelope = parseGoogleLeadEnvelope(JSON.parse(rawBody) as unknown);
    } catch {
      return failure('INVALID_PAYLOAD', 'The Google lead payload is invalid.', requestId, 400);
    }
    if (
      envelope.raw.user_column_data instanceof Array &&
      envelope.raw.user_column_data.length > 100
    )
      return failure(
        'TOO_MANY_FIELDS',
        'The Google lead payload has too many fields.',
        requestId,
        413,
      );
    const admin = serviceClient();
    const { data: connection, error: connectionError } = await admin
      .from('connected_accounts')
      .select('id,organization_id,provider_key,status')
      .eq('id', connectionId.data)
      .eq('provider_key', 'google_ads')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection)
      return failure(
        'CONNECTION_NOT_FOUND',
        'The Google Ads connection was not found.',
        requestId,
        404,
      );
    const { data: secret, error: secretError } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', connection.organization_id)
      .eq('connected_account_id', connection.id)
      .maybeSingle();
    if (secretError) throw secretError;
    if (!secret)
      return failure(
        'CREDENTIAL_NOT_CONFIGURED',
        'The webhook key is not configured.',
        requestId,
        409,
      );
    const credential = await decryptJson<StoredOAuthCredential & { google_webhook_key?: string }>(
      secret.encrypted_payload,
    );
    if (
      !credential.google_webhook_key ||
      !constantTimeEqual(envelope.googleKey, credential.google_webhook_key)
    )
      return failure('INVALID_WEBHOOK_KEY', 'The webhook key is invalid.', requestId, 403);

    const safePayload = { ...envelope.raw };
    delete safePayload.google_key;
    const providerEventId = `google-lead:${envelope.leadId}`;
    const { error: insertError } = await admin.from('provider_events').insert({
      organization_id: connection.organization_id,
      connected_account_id: connection.id,
      provider_event_id: providerEventId,
      event_type: envelope.isTest ? 'GOOGLE_LEAD_FORM_TEST' : 'GOOGLE_LEAD_FORM',
      payload_hash: await sha256Base64Url(rawBody),
      payload: safePayload,
      status: envelope.isTest ? 'TEST_VALIDATED' : 'RECEIVED',
      processed_at: envelope.isTest ? new Date().toISOString() : null,
    });
    if (insertError?.code === '23505')
      return success({ accepted: true, duplicate: true, test: envelope.isTest }, requestId);
    if (insertError) throw insertError;
    return success(
      {
        accepted: true,
        duplicate: false,
        test: envelope.isTest,
        queued: envelope.isTest ? 0 : 1,
      },
      requestId,
    );
  } catch {
    return failure(
      'GOOGLE_LEAD_WEBHOOK_FAILED',
      'The Google Ads lead webhook could not be accepted.',
      requestId,
      500,
    );
  }
});
