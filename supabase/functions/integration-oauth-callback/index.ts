import { decryptJson, encryptJson, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId } from '../_shared/http.ts';
import {
  exchangeOAuthCode,
  type OAuthProviderKey,
  type StoredOAuthCredential,
} from '../_shared/provider-oauth.ts';
import { serviceClient } from '../_shared/supabase.ts';

type OAuthState = {
  id: string;
  organization_id: string;
  connected_account_id: string;
  requested_by: string;
  provider_key: OAuthProviderKey;
  code_verifier_encrypted: string | Uint8Array | null;
  redirect_path: string;
};

function appRedirect(path: string, parameters: Record<string, string>) {
  const base = Deno.env.get('APP_BASE_URL')?.trim();
  if (!base) throw new Error('APP_BASE_URL_MISSING');
  const baseUrl = new URL(base);
  const target = new URL(path, baseUrl.origin);
  if (target.origin !== baseUrl.origin) throw new Error('INVALID_REDIRECT_PATH');
  for (const [name, value] of Object.entries(parameters)) target.searchParams.set(name, value);
  return Response.redirect(target.toString(), 302);
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'GET')
    return failure('METHOD_NOT_ALLOWED', 'Only GET is supported.', requestId, 405);

  const url = new URL(request.url);
  const stateToken = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const providerError = url.searchParams.get('error');
  if (!stateToken)
    return failure('INVALID_OAUTH_STATE', 'The authorization state is missing.', requestId, 400);

  const admin = serviceClient();
  let claimedState: OAuthState | null = null;
  try {
    const claimedAt = new Date().toISOString();
    const { data, error } = await admin
      .from('integration_oauth_states')
      .update({ used_at: claimedAt })
      .eq('state_hash', await sha256Base64Url(stateToken))
      .is('used_at', null)
      .gt('expires_at', claimedAt)
      .select(
        'id,organization_id,connected_account_id,requested_by,provider_key,code_verifier_encrypted,redirect_path',
      )
      .maybeSingle();
    if (error || !data)
      return failure(
        'OAUTH_STATE_EXPIRED_OR_USED',
        'This authorization request has expired or was already used.',
        requestId,
        409,
      );
    claimedState = data as OAuthState;

    if (providerError || !code) throw new Error('PROVIDER_AUTHORIZATION_DENIED');
    const callbackUrl = Deno.env.get('INTEGRATION_OAUTH_CALLBACK_URL')?.trim();
    if (!callbackUrl) throw new Error('INTEGRATION_OAUTH_CALLBACK_URL_MISSING');
    const verifierEnvelope = claimedState.code_verifier_encrypted;
    const verifier = verifierEnvelope
      ? (await decryptJson<{ verifier: string }>(verifierEnvelope)).verifier
      : undefined;
    const credential = await exchangeOAuthCode(claimedState.provider_key, {
      code,
      redirectUri: callbackUrl,
      codeVerifier: verifier,
    });

    const { error: credentialError } = await admin.from('integration_credentials').upsert(
      {
        organization_id: claimedState.organization_id,
        connected_account_id: claimedState.connected_account_id,
        encrypted_payload: await encryptJson(credential),
        key_version: 1,
        cipher_version: 'AES-256-GCM-v1',
        expires_at: credential.expires_at ?? null,
        replaced_by: claimedState.requested_by,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'connected_account_id' },
    );
    if (credentialError) throw credentialError;

    const now = new Date().toISOString();
    const { error: connectionError } = await admin
      .from('connected_accounts')
      .update({
        status: 'CONNECTED',
        external_account_id: credential.external_account_id,
        connected_at: now,
        token_expires_at: credential.expires_at ?? null,
        last_tested_at: now,
        last_error_code: null,
      })
      .eq('id', claimedState.connected_account_id)
      .eq('organization_id', claimedState.organization_id);
    if (connectionError) throw connectionError;

    await admin.from('audit_logs').insert({
      organization_id: claimedState.organization_id,
      actor_id: claimedState.requested_by,
      action: 'integration.connected',
      resource_type: 'connected_account',
      resource_id: claimedState.connected_account_id,
      request_id: requestId,
      metadata: {
        provider_key: claimedState.provider_key,
        external_account_id: credential.external_account_id,
      },
    });
    return appRedirect(claimedState.redirect_path, {
      integration: 'connected',
      connection: claimedState.connected_account_id,
    });
  } catch {
    if (claimedState) {
      await admin
        .from('connected_accounts')
        .update({ status: 'ERROR', last_error_code: 'OAUTH_CALLBACK_FAILED' })
        .eq('id', claimedState.connected_account_id);
      await admin.from('audit_logs').insert({
        organization_id: claimedState.organization_id,
        actor_id: claimedState.requested_by,
        action: 'integration.connection_failed',
        resource_type: 'connected_account',
        resource_id: claimedState.connected_account_id,
        request_id: requestId,
        metadata: { safe_code: 'OAUTH_CALLBACK_FAILED' },
      });
      try {
        return appRedirect(claimedState.redirect_path, {
          integration: 'error',
          code: 'OAUTH_CALLBACK_FAILED',
        });
      } catch {
        // Fall through to the safe JSON response when the application URL itself is absent.
      }
    }
    return failure(
      'OAUTH_CALLBACK_FAILED',
      'The provider authorization could not be completed.',
      requestId,
      400,
    );
  }
});
