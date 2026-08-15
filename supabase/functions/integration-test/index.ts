import { z } from 'npm:zod@4';
import { decryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import {
  testOAuthCredential,
  type OAuthProviderKey,
  type StoredOAuthCredential,
} from '../_shared/provider-oauth.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({ organization_id: z.uuid(), connection_id: z.uuid() });

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const input = schema.safeParse(await request.json());
    if (!input.success)
      return failure('INVALID_PAYLOAD', 'Connection test request is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
      target_organization_id: input.data.organization_id,
      target_connection_id: input.data.connection_id,
      target_permission: 'integration.manage',
    });
    if (!permitted)
      return failure(
        'PERMISSION_DENIED',
        'You cannot test this provider connection.',
        requestId,
        403,
      );

    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,provider_key')
      .eq('id', input.data.connection_id)
      .eq('organization_id', input.data.organization_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (!connection)
      return failure(
        'CONNECTION_NOT_FOUND',
        'The provider connection was not found.',
        requestId,
        404,
      );
    if (!['meta', 'google_ads', 'google_business_profile'].includes(connection.provider_key))
      return failure(
        'UNSUPPORTED_PROVIDER',
        'This provider does not use the OAuth connection test.',
        requestId,
        422,
      );
    const { data: secret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('connected_account_id', connection.id)
      .eq('organization_id', input.data.organization_id)
      .maybeSingle();
    if (!secret)
      return failure(
        'CREDENTIAL_NOT_CONFIGURED',
        'This provider credential has not been configured.',
        requestId,
        409,
      );
    const credential = await decryptJson<StoredOAuthCredential>(secret.encrypted_payload);
    const tested = await testOAuthCredential(
      connection.provider_key as OAuthProviderKey,
      credential,
    );
    const now = new Date().toISOString();
    await admin
      .from('connected_accounts')
      .update({ status: 'CONNECTED', last_tested_at: now, last_error_code: null })
      .eq('id', connection.id);
    await admin.from('audit_logs').insert({
      organization_id: input.data.organization_id,
      actor_id: auth.user.id,
      action: 'integration.test_succeeded',
      resource_type: 'connected_account',
      resource_id: connection.id,
      request_id: requestId,
      metadata: { provider_key: connection.provider_key },
    });
    return success(
      { connection_id: connection.id, account_label: tested.accountLabel, tested_at: now },
      requestId,
    );
  } catch {
    return failure(
      'CONNECTION_TEST_FAILED',
      'The provider connection test failed. Reconnect or replace the credential.',
      requestId,
      502,
    );
  }
});
