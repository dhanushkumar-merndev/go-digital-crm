import { z } from 'npm:zod@4';
import { decryptJson } from '../_shared/crypto.ts';
import {
  testAiProviderCredential,
  type AiProviderCredential,
  type AiProviderKey,
  type AiProviderModels,
} from '../_shared/ai-provider.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({ organization_id: z.uuid(), connection_id: z.uuid() });

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'AI provider test request is invalid.', requestId, 422);
    const input = parsed.data;
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
        'You cannot test this provider connection.',
        requestId,
        403,
      );
    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,provider_key,connection_config')
      .eq('id', input.connection_id)
      .eq('organization_id', input.organization_id)
      .in('provider_key', ['openrouter', 'groq'])
      .is('deleted_at', null)
      .maybeSingle();
    if (!connection)
      return failure(
        'CONNECTION_NOT_FOUND',
        'The AI provider connection was not found.',
        requestId,
        404,
      );
    const { data: secret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('connected_account_id', connection.id)
      .eq('organization_id', input.organization_id)
      .maybeSingle();
    if (!secret)
      return failure(
        'CREDENTIAL_NOT_CONFIGURED',
        'This provider credential has not been configured.',
        requestId,
        409,
      );
    const config = connection.connection_config as { models?: AiProviderModels } | null;
    const models = config?.models;
    if (!models)
      return failure('AI_MODEL_CONFIG_MISSING', 'No AI model is configured.', requestId, 409);
    const credential = await decryptJson<AiProviderCredential>(secret.encrypted_payload);
    await testAiProviderCredential(connection.provider_key as AiProviderKey, credential, models);
    const now = new Date().toISOString();
    await admin
      .from('connected_accounts')
      .update({ status: 'CONNECTED', last_tested_at: now, last_error_code: null })
      .eq('id', connection.id);
    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'ai_provider.test_succeeded',
      resource_type: 'connected_account',
      resource_id: connection.id,
      request_id: requestId,
      metadata: { provider_key: connection.provider_key, models },
    });
    return success({ connection_id: connection.id, tested_at: now }, requestId);
  } catch {
    return failure(
      'AI_PROVIDER_TEST_FAILED',
      'The AI provider test failed. Replace the key or choose models available to that key.',
      requestId,
      502,
    );
  }
});
