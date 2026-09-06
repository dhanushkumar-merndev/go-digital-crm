import { z } from 'npm:zod@4';
import { encryptJson } from '../_shared/crypto.ts';
import {
  testAiProviderCredential,
  type AiProviderKey,
  type AiProviderModels,
} from '../_shared/ai-provider.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const modelSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[a-zA-Z0-9._/-]+$/);
const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    provider_key: z.enum(['openrouter', 'groq']),
    display_name: z.string().trim().min(2).max(120),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    text_model: modelSchema.optional(),
    image_model: modelSchema.optional(),
    transcription_model: modelSchema.optional(),
    analysis_model: modelSchema.optional(),
    api_key: z.string().trim().min(10).max(512),
  })
  .superRefine((input, context) => {
    if (
      !input.text_model &&
      !input.image_model &&
      !input.transcription_model &&
      !input.analysis_model
    )
      context.addIssue({
        code: 'custom',
        path: ['text_model'],
        message: 'Choose a text or image model.',
      });
    if (new Set(input.branch_ids).size !== input.branch_ids.length)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Duplicate branch.' });
    if (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select one branch.' });
    if (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length < 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select branches.' });
    if (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Clear branches.' });
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
      return failure('INVALID_PAYLOAD', 'AI provider settings are invalid.', requestId, 422);
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: scopePermitted } = await client.rpc('authorize_integration_scope', {
      target_organization_id: input.organization_id,
      target_permission: 'integration.manage',
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
    });
    if (!scopePermitted)
      return failure(
        'BRANCH_SCOPE_DENIED',
        'The connection scope exceeds your authority.',
        requestId,
        403,
      );
    if (input.connection_id) {
      const { data: connectionPermitted } = await client.rpc(
        'authorize_integration_connection_action',
        {
          target_organization_id: input.organization_id,
          target_connection_id: input.connection_id,
          target_permission: 'integration.manage',
        },
      );
      if (!connectionPermitted)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot replace this connection.',
          requestId,
          403,
        );
    }

    const models: AiProviderModels = {
      ...(input.text_model ? { text_model: input.text_model } : {}),
      ...(input.image_model ? { image_model: input.image_model } : {}),
      ...(input.transcription_model ? { transcription_model: input.transcription_model } : {}),
      ...(input.analysis_model ? { analysis_model: input.analysis_model } : {}),
    };
    const testedProvider = await testAiProviderCredential(
      input.provider_key as AiProviderKey,
      { api_key: input.api_key },
      models,
    );
    const now = new Date().toISOString();
    const admin = serviceClient();
    let connectionId = input.connection_id;
    const connectionConfig = {
      connection_type: 'AI_PROVIDER',
      capabilities: [
        ...(models.text_model ? ['TEXT_GENERATION'] : []),
        ...(models.image_model ? ['IMAGE_GENERATION'] : []),
        ...(models.transcription_model ? ['AUDIO_TRANSCRIPTION'] : []),
        ...(models.analysis_model ? ['AI_CALL_ANALYSIS'] : []),
      ],
      models,
    };
    if (connectionId) {
      const { data: existing } = await admin
        .from('connected_accounts')
        .select('id')
        .eq('id', connectionId)
        .eq('organization_id', input.organization_id)
        .eq('provider_key', input.provider_key)
        .is('deleted_at', null)
        .maybeSingle();
      if (!existing)
        return failure(
          'CONNECTION_NOT_FOUND',
          'The AI provider connection was not found.',
          requestId,
          404,
        );
      const { error } = await admin
        .from('connected_accounts')
        .update({
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          auth_type: 'API_KEY',
          external_account_id: testedProvider.providerAccountLabel,
          connection_config: connectionConfig,
          connected_at: now,
          last_tested_at: now,
          last_error_code: null,
        })
        .eq('id', connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin
        .from('connected_accounts')
        .insert({
          organization_id: input.organization_id,
          provider_key: input.provider_key,
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          auth_type: 'API_KEY',
          external_account_id: testedProvider.providerAccountLabel,
          connection_config: connectionConfig,
          connected_at: now,
          last_tested_at: now,
          created_by: auth.user.id,
        })
        .select('id')
        .single();
      if (error) throw error;
      connectionId = created.id;
    }
    const { data: previousSecret } = await admin
      .from('integration_credentials')
      .select('key_version')
      .eq('connected_account_id', connectionId)
      .maybeSingle();
    const { error: credentialError } = await admin.from('integration_credentials').upsert(
      {
        organization_id: input.organization_id,
        connected_account_id: connectionId,
        encrypted_payload: await encryptJson({ api_key: input.api_key }),
        key_version: (previousSecret?.key_version ?? 0) + 1,
        cipher_version: 'AES-256-GCM-v1',
        replaced_by: auth.user.id,
        updated_at: now,
      },
      { onConflict: 'connected_account_id' },
    );
    if (credentialError) throw credentialError;

    await admin
      .from('integration_branch_mappings')
      .update({ deleted_at: now })
      .eq('connected_account_id', connectionId)
      .is('deleted_at', null);
    if (input.scope_mode !== 'ALL_BRANCHES') {
      const { error } = await admin.from('integration_branch_mappings').upsert(
        input.branch_ids.map((branchId) => ({
          organization_id: input.organization_id,
          connected_account_id: connectionId,
          branch_id: branchId,
          external_resource_type: 'CONNECTION_SCOPE',
          external_resource_id: branchId,
          deleted_at: null,
        })),
        {
          onConflict: 'connected_account_id,branch_id,external_resource_type,external_resource_id',
        },
      );
      if (error) throw error;
    }
    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: input.connection_id ? 'ai_provider.credential_replaced' : 'ai_provider.connected',
      resource_type: 'connected_account',
      resource_id: connectionId,
      request_id: requestId,
      metadata: {
        provider_key: input.provider_key,
        models,
        credential_version: (previousSecret?.key_version ?? 0) + 1,
      },
    });
    return success(
      { connection_id: connectionId, provider_key: input.provider_key, models, tested_at: now },
      requestId,
      input.connection_id ? 200 : 201,
    );
  } catch {
    return failure(
      'AI_PROVIDER_CONNECTION_FAILED',
      'The AI provider could not be verified or saved. Verify the key and selected model names.',
      requestId,
      502,
    );
  }
});
