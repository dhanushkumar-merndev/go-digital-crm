import { z } from 'npm:zod@4';
import { encryptJson } from '../_shared/crypto.ts';
import { normalizedE164 } from '../_shared/twilio-voice.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    account_sid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
    api_key_sid: z.string().regex(/^SK[0-9a-fA-F]{32}$/),
    api_key_secret: z.string().trim().min(20).max(512),
    auth_token: z.string().trim().min(20).max(512),
    phone_number: z.string().trim().min(8).max(20),
  })
  .superRefine((input, context) => {
    if (new Set(input.branch_ids).size !== input.branch_ids.length)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Duplicate branch.' });
    if (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select one branch.' });
    if (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length < 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select branches.' });
    if (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Clear branches.' });
    try {
      normalizedE164(input.phone_number);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['phone_number'],
        message: 'Use an E.164 caller number.',
      });
    }
  });

function basicAuthorization(keySid: string, secret: string) {
  return `Basic ${btoa(`${keySid}:${secret}`)}`;
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Twilio IVR settings are invalid.', requestId, 422);
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
      const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
        target_organization_id: input.organization_id,
        target_connection_id: input.connection_id,
        target_permission: 'integration.manage',
      });
      if (!permitted)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot replace this connection.',
          requestId,
          403,
        );
    }
    const providerResponse = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(input.account_sid)}.json`,
      {
        headers: { authorization: basicAuthorization(input.api_key_sid, input.api_key_secret) },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!providerResponse.ok)
      return failure(
        'TWILIO_CONNECTION_TEST_FAILED',
        'Twilio rejected these account credentials.',
        requestId,
        422,
      );
    const admin = serviceClient();
    const now = new Date().toISOString();
    const config = {
      connection_type: 'IVR_PROVIDER',
      capabilities: ['IVR_CALLING', 'CALL_RECORDING', 'AI_VOICE_CALLING'],
    };
    let connectionId = input.connection_id;
    if (connectionId) {
      const { error } = await admin
        .from('connected_accounts')
        .update({
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          auth_type: 'API_KEY',
          external_account_id: input.account_sid,
          connection_config: config,
          connected_at: now,
          last_tested_at: now,
          last_error_code: null,
        })
        .eq('id', connectionId)
        .eq('organization_id', input.organization_id)
        .eq('provider_key', 'twilio_voice');
      if (error) throw error;
    } else {
      const { data, error } = await admin
        .from('connected_accounts')
        .insert({
          organization_id: input.organization_id,
          provider_key: 'twilio_voice',
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          auth_type: 'API_KEY',
          external_account_id: input.account_sid,
          connection_config: config,
          connected_at: now,
          last_tested_at: now,
          created_by: auth.user.id,
        })
        .select('id')
        .single();
      if (error || !data) throw error ?? new Error('TWILIO_CONNECTION_CREATE_FAILED');
      connectionId = data.id;
    }
    const { data: previous } = await admin
      .from('integration_credentials')
      .select('key_version')
      .eq('organization_id', input.organization_id)
      .eq('connected_account_id', connectionId)
      .maybeSingle();
    const { error: credentialError } = await admin.from('integration_credentials').upsert(
      {
        organization_id: input.organization_id,
        connected_account_id: connectionId,
        encrypted_payload: await encryptJson({
          account_sid: input.account_sid,
          api_key_sid: input.api_key_sid,
          api_key_secret: input.api_key_secret,
          auth_token: input.auth_token,
          phone_number: normalizedE164(input.phone_number),
        }),
        key_version: (previous?.key_version ?? 0) + 1,
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
      action: input.connection_id ? 'integration.credential_replaced' : 'integration.connected',
      resource_type: 'connected_account',
      resource_id: connectionId,
      request_id: requestId,
      metadata: {
        provider_key: 'twilio_voice',
        credential_version: (previous?.key_version ?? 0) + 1,
        scope_mode: input.scope_mode,
      },
    });
    return success(
      {
        connection_id: connectionId,
        provider_key: 'twilio_voice',
        credential_status: 'CONFIGURED',
        tested_at: now,
      },
      requestId,
      input.connection_id ? 200 : 201,
    );
  } catch {
    return failure(
      'TWILIO_CONNECTION_FAILED',
      'The Twilio IVR connection could not be saved.',
      requestId,
      502,
    );
  }
});
