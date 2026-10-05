import { decryptJson, encryptJson, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId } from '../_shared/http.ts';
import {
  oauthCallbackFailureUpdate,
  prepareMetaOAuthReconnect,
} from '../../../src/lib/providers/meta-oauth-reconnect.ts';
import {
  discoverProviderAssets,
  exchangeOAuthCode,
  metaGraphApiVersion,
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

type ConnectionSnapshot = {
  id: string;
  provider_key: string;
  status: string;
  external_account_id: string | null;
  connection_config: Record<string, unknown>;
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
  let previousConnection: ConnectionSnapshot | null = null;
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

    const { data: connection, error: connectionLookupError } = await admin
      .from('connected_accounts')
      .select('id,provider_key,status,external_account_id,connection_config')
      .eq('id', claimedState.connected_account_id)
      .eq('organization_id', claimedState.organization_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (
      connectionLookupError ||
      !connection ||
      connection.provider_key !== claimedState.provider_key
    )
      throw new Error('OAUTH_CONNECTION_MISMATCH');
    previousConnection = connection as ConnectionSnapshot;

    if (providerError || !code) throw new Error('PROVIDER_AUTHORIZATION_DENIED');
    const callbackUrl = Deno.env.get('INTEGRATION_OAUTH_CALLBACK_URL')?.trim();
    if (!callbackUrl) throw new Error('INTEGRATION_OAUTH_CALLBACK_URL_MISSING');
    const verifierEnvelope = claimedState.code_verifier_encrypted;
    const verifier = verifierEnvelope
      ? (await decryptJson<{ verifier: string }>(verifierEnvelope)).verifier
      : undefined;
    const exchangedCredential = await exchangeOAuthCode(claimedState.provider_key, {
      code,
      redirectUri: callbackUrl,
      codeVerifier: verifier,
    });

    let credential: StoredOAuthCredential = exchangedCredential;
    let connectionUpdate: Record<string, unknown> = {
      status: 'CONNECTED',
      auth_type: 'OAUTH2',
      external_account_id: exchangedCredential.external_account_id,
      token_expires_at: exchangedCredential.expires_at ?? null,
      last_error_code: null,
    };
    if (
      claimedState.provider_key === 'meta' &&
      ['META_DIRECT', 'META_OAUTH'].includes(
        String(previousConnection.connection_config.connection_type),
      )
    ) {
      const discovered = await discoverProviderAssets('meta', exchangedCredential);
      const replacement = prepareMetaOAuthReconnect({
        credential: exchangedCredential,
        connection: previousConnection,
        graphApiVersion: metaGraphApiVersion(exchangedCredential),
        assets: discovered.assets,
        assetAccessTokens: discovered.assetAccessTokens,
      });
      credential = replacement.credential;
      connectionUpdate = replacement.connectionUpdate;
    }

    const now = new Date().toISOString();
    const { error: completionError } = await admin.rpc('complete_integration_oauth_connection', {
      target_organization_id: claimedState.organization_id,
      target_connection_id: claimedState.connected_account_id,
      target_encrypted_payload: await encryptJson(credential),
      target_cipher_version: 'AES-256-GCM-v1',
      target_expires_at: credential.expires_at ?? null,
      target_replaced_by: claimedState.requested_by,
      target_external_account_id:
        typeof connectionUpdate.external_account_id === 'string'
          ? connectionUpdate.external_account_id
          : null,
      target_connection_config:
        (connectionUpdate.connection_config as Record<string, unknown> | undefined) ??
        previousConnection.connection_config,
      target_token_expires_at:
        typeof connectionUpdate.token_expires_at === 'string'
          ? connectionUpdate.token_expires_at
          : null,
      target_connected_at: now,
      target_last_tested_at: now,
    });
    if (completionError) throw completionError;

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
        .update(oauthCallbackFailureUpdate(previousConnection?.status ?? 'AUTHORIZING'))
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
