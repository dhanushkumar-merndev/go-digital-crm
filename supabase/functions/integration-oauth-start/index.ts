import { z } from 'npm:zod@4';
import { encryptJson, randomBase64Url, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authorizationUrl, type OAuthProviderKey } from '../_shared/provider-oauth.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    provider_key: z.enum(['meta', 'google_ads', 'google_business_profile']),
    display_name: z.string().trim().min(2).max(120),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    redirect_path: z
      .string()
      .regex(/^\/[a-zA-Z0-9/_-]*$/)
      .default('/client-admin/settings/integrations'),
  })
  .superRefine((input, context) => {
    const uniqueBranches = new Set(input.branch_ids);
    if (uniqueBranches.size !== input.branch_ids.length)
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

  let pendingConnectionId: string | undefined;
  try {
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Connection settings are invalid.', requestId, 422);
    const input = parsed.data;
    const { data: permitted } = await client.rpc('authorize_integration_scope', {
      target_organization_id: input.organization_id,
      target_permission: 'integration.manage',
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
    });
    if (!permitted)
      return failure(
        'PERMISSION_DENIED',
        'You cannot manage integrations for this organization.',
        requestId,
        403,
      );
    const callbackUrl = Deno.env.get('INTEGRATION_OAUTH_CALLBACK_URL')?.trim();
    if (!callbackUrl) throw new Error('INTEGRATION_OAUTH_CALLBACK_URL_MISSING');
    new URL(callbackUrl);

    const admin = serviceClient();
    const { data: connection, error: connectionError } = await admin
      .from('connected_accounts')
      .insert({
        organization_id: input.organization_id,
        provider_key: input.provider_key,
        display_name: input.display_name,
        scope_mode: input.scope_mode,
        status: 'AUTHORIZING',
        auth_type: 'OAUTH2',
        created_by: auth.user.id,
      })
      .select('id')
      .single();
    if (connectionError) throw connectionError;
    pendingConnectionId = connection.id;

    if (input.branch_ids.length > 0) {
      const { error: mappingError } = await admin.from('integration_branch_mappings').insert(
        input.branch_ids.map((branchId) => ({
          organization_id: input.organization_id,
          connected_account_id: connection.id,
          branch_id: branchId,
          external_resource_type: 'CONNECTION_SCOPE',
          external_resource_id: branchId,
        })),
      );
      if (mappingError) throw mappingError;
    }

    const state = randomBase64Url(32);
    const verifier = randomBase64Url(64);
    const codeChallenge = await sha256Base64Url(verifier);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const { error: stateError } = await admin.from('integration_oauth_states').insert({
      organization_id: input.organization_id,
      connected_account_id: connection.id,
      requested_by: auth.user.id,
      provider_key: input.provider_key,
      state_hash: await sha256Base64Url(state),
      code_verifier_encrypted: await encryptJson({ verifier }),
      redirect_path: input.redirect_path,
      expires_at: expiresAt,
    });
    if (stateError) throw stateError;

    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'integration.oauth_started',
      resource_type: 'connected_account',
      resource_id: connection.id,
      request_id: requestId,
      metadata: { provider_key: input.provider_key, scope_mode: input.scope_mode },
    });

    return success(
      {
        connection_id: connection.id,
        authorization_url: authorizationUrl(input.provider_key as OAuthProviderKey, {
          state,
          redirectUri: callbackUrl,
          codeChallenge,
        }),
        expires_at: expiresAt,
      },
      requestId,
      201,
    );
  } catch {
    if (pendingConnectionId) {
      await serviceClient()
        .from('connected_accounts')
        .update({ status: 'ERROR', last_error_code: 'OAUTH_START_FAILED' })
        .eq('id', pendingConnectionId);
    }
    return failure(
      'OAUTH_START_FAILED',
      'The provider authorization could not be started.',
      requestId,
      500,
    );
  }
});
