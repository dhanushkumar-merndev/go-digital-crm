import { z } from 'npm:zod@4';
import { decryptJson, encryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import {
  discoverProviderAssets,
  refreshOAuthCredential,
  type OAuthProviderKey,
  type StoredOAuthCredential,
} from '../_shared/provider-oauth.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  connection_id: z.uuid(),
  parent_asset_id: z.string().trim().min(1).max(255).optional(),
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
      return failure('INVALID_PAYLOAD', 'The asset request is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
      target_organization_id: parsed.data.organization_id,
      target_connection_id: parsed.data.connection_id,
      target_permission: 'integration.manage',
    });
    if (!permitted)
      return failure('PERMISSION_DENIED', 'You cannot inspect provider assets.', requestId, 403);

    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,provider_key,status')
      .eq('id', parsed.data.connection_id)
      .eq('organization_id', parsed.data.organization_id)
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    if (
      !connection ||
      !['meta', 'google_ads', 'google_business_profile'].includes(connection.provider_key)
    )
      return failure('CONNECTION_NOT_FOUND', 'The OAuth connection was not found.', requestId, 404);
    const { data: storedSecret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', parsed.data.organization_id)
      .eq('connected_account_id', connection.id)
      .maybeSingle();
    if (!storedSecret)
      return failure('CREDENTIAL_NOT_CONFIGURED', 'Reconnect this provider.', requestId, 409);
    const provider = connection.provider_key as OAuthProviderKey;
    const currentCredential = await decryptJson<StoredOAuthCredential>(
      storedSecret.encrypted_payload,
    );
    const refreshed = await refreshOAuthCredential(provider, currentCredential);
    if (refreshed.refreshed) {
      const { error: refreshError } = await admin
        .from('integration_credentials')
        .update({
          encrypted_payload: await encryptJson(refreshed.credential),
          expires_at: refreshed.credential.expires_at ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('connected_account_id', connection.id)
        .eq('organization_id', parsed.data.organization_id);
      if (refreshError) throw refreshError;
    }
    const discovered = await discoverProviderAssets(
      provider,
      refreshed.credential,
      parsed.data.parent_asset_id,
    );
    const { data: selectedMappings } = await admin
      .from('integration_branch_mappings')
      .select(
        'branch_id,team_id,external_resource_type,external_resource_id,external_resource_label,mapping_metadata',
      )
      .eq('organization_id', parsed.data.organization_id)
      .eq('connected_account_id', connection.id)
      .neq('external_resource_type', 'CONNECTION_SCOPE')
      .is('deleted_at', null);
    await admin.from('audit_logs').insert({
      organization_id: parsed.data.organization_id,
      actor_id: auth.user.id,
      action: 'integration.assets_listed',
      resource_type: 'connected_account',
      resource_id: connection.id,
      request_id: requestId,
      metadata: { provider_key: provider, asset_count: discovered.assets.length },
    });
    return success(
      {
        connection_id: connection.id,
        provider_key: provider,
        assets: discovered.assets,
        selected_mappings: selectedMappings ?? [],
      },
      requestId,
    );
  } catch {
    return failure(
      'ASSET_DISCOVERY_FAILED',
      'Provider assets could not be loaded. Reconnect or retry later.',
      requestId,
      502,
    );
  }
});
