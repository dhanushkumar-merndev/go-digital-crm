import { z } from 'npm:zod@4';
import { decryptJson, encryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import type { StoredOAuthCredential } from '../_shared/provider-oauth.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  connection_id: z.uuid(),
  webhook_key: z.string().min(24).max(128),
});

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Webhook configuration is invalid.', requestId, 422);
    const input = parsed.data;
    const functionBase = Deno.env.get('PUBLIC_EDGE_FUNCTION_BASE_URL')?.replace(/\/$/, '');
    if (!functionBase) throw new Error('PUBLIC_EDGE_FUNCTION_BASE_URL_MISSING');
    new URL(functionBase);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
      target_organization_id: input.organization_id,
      target_connection_id: input.connection_id,
      target_permission: 'integration.manage',
    });
    if (!permitted)
      return failure(
        'PERMISSION_DENIED',
        'You cannot replace this webhook credential.',
        requestId,
        403,
      );
    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,provider_key')
      .eq('id', input.connection_id)
      .eq('organization_id', input.organization_id)
      .eq('provider_key', 'google_ads')
      .is('deleted_at', null)
      .maybeSingle();
    if (!connection)
      return failure(
        'CONNECTION_NOT_FOUND',
        'The Google Ads connection was not found.',
        requestId,
        404,
      );
    const { data: secret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload,key_version')
      .eq('connected_account_id', connection.id)
      .eq('organization_id', input.organization_id)
      .maybeSingle();
    if (!secret)
      return failure(
        'CREDENTIAL_NOT_CONFIGURED',
        'Connect Google Ads with OAuth first.',
        requestId,
        409,
      );
    const credential = await decryptJson<StoredOAuthCredential & { google_webhook_key?: string }>(
      secret.encrypted_payload,
    );
    credential.google_webhook_key = input.webhook_key;
    const now = new Date().toISOString();
    const { error: updateError } = await admin
      .from('integration_credentials')
      .update({
        encrypted_payload: await encryptJson(credential),
        key_version: secret.key_version + 1,
        replaced_by: auth.user.id,
        updated_at: now,
      })
      .eq('connected_account_id', connection.id);
    if (updateError) throw updateError;
    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'integration.credential_replaced',
      resource_type: 'connected_account',
      resource_id: connection.id,
      request_id: requestId,
      metadata: { credential_type: 'google_lead_webhook_key' },
    });
    return success(
      {
        connection_id: connection.id,
        webhook_url: `${functionBase}/provider-webhook-generic?connection_id=${connection.id}`,
        credential_status: 'CONFIGURED',
        replaced_at: now,
      },
      requestId,
    );
  } catch {
    return failure(
      'WEBHOOK_CONFIGURATION_FAILED',
      'The webhook credential could not be replaced.',
      requestId,
      500,
    );
  }
});
