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

const mappingSchema = z.object({
  asset_type: z.enum([
    'META_PAGE',
    'INSTAGRAM_ACCOUNT',
    'GOOGLE_ADS_CUSTOMER',
    'GOOGLE_ADS_CAMPAIGN',
    'GOOGLE_ADS_LEAD_FORM',
    'GBP_LOCATION',
  ]),
  asset_id: z.string().trim().min(1).max(255),
  branch_id: z.uuid(),
  team_id: z.uuid().nullable().optional(),
});
const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid(),
    parent_asset_id: z.string().trim().min(1).max(255).optional(),
    mappings: z.array(mappingSchema).max(200),
  })
  .superRefine((input, context) => {
    const keys = input.mappings.map(
      (mapping) => `${mapping.asset_type}:${mapping.asset_id}:${mapping.branch_id}`,
    );
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: 'custom', path: ['mappings'], message: 'Duplicate mapping.' });
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
      return failure('INVALID_PAYLOAD', 'The asset mappings are invalid.', requestId, 422);
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
      return failure('PERMISSION_DENIED', 'You cannot map provider assets.', requestId, 403);
    for (const branchId of new Set(input.mappings.map((mapping) => mapping.branch_id))) {
      const { data: branchPermitted } = await client.rpc('authorize_action', {
        target_organization_id: input.organization_id,
        target_permission: 'integration.manage',
        target_branch_id: branchId,
      });
      if (!branchPermitted)
        return failure(
          'BRANCH_SCOPE_DENIED',
          'One or more mappings are outside your branch scope.',
          requestId,
          403,
        );
    }

    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,provider_key,status,connection_config')
      .eq('id', input.connection_id)
      .eq('organization_id', input.organization_id)
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
      .eq('organization_id', input.organization_id)
      .eq('connected_account_id', connection.id)
      .maybeSingle();
    if (!storedSecret)
      return failure('CREDENTIAL_NOT_CONFIGURED', 'Reconnect this provider.', requestId, 409);
    const provider = connection.provider_key as OAuthProviderKey;
    const currentCredential = await decryptJson<StoredOAuthCredential>(
      storedSecret.encrypted_payload,
    );
    const refreshed = await refreshOAuthCredential(provider, currentCredential);
    const discovered = await discoverProviderAssets(
      provider,
      refreshed.credential,
      input.parent_asset_id,
    );
    const available = new Map(
      discovered.assets.map((asset) => [`${asset.type}:${asset.id}`, asset]),
    );
    const resolvedMappings = input.mappings.map((mapping) => {
      const asset = available.get(`${mapping.asset_type}:${mapping.asset_id}`);
      if (!asset) throw new Error('PROVIDER_ASSET_NOT_ACCESSIBLE');
      return {
        branch_id: mapping.branch_id,
        team_id: mapping.team_id ?? null,
        external_resource_type: asset.type,
        external_resource_id: asset.id,
        external_resource_label: asset.label,
        mapping_metadata: {
          ...(asset.parent_id ? { parent_id: asset.parent_id } : {}),
          ...(asset.metadata ?? {}),
        },
      };
    });
    const selectedTokenIds = new Set(input.mappings.map((mapping) => mapping.asset_id));
    const selectedAssetTokens = Object.fromEntries(
      Object.entries(discovered.assetAccessTokens).filter(([assetId]) =>
        selectedTokenIds.has(assetId),
      ),
    );
    if (provider === 'meta') {
      const graphVersion = Deno.env.get('META_GRAPH_API_VERSION')?.trim();
      if (!graphVersion) throw new Error('META_GRAPH_API_VERSION_MISSING');
      const selectedPages = Array.from(
        new Set(
          input.mappings
            .filter((mapping) => mapping.asset_type === 'META_PAGE')
            .map((mapping) => mapping.asset_id),
        ),
      );
      for (const pageId of selectedPages) {
        const pageAccessToken = selectedAssetTokens[pageId];
        if (!pageAccessToken) throw new Error('META_PAGE_ACCESS_TOKEN_MISSING');
        const subscription = await fetch(
          `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${pageAccessToken}`,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ subscribed_fields: 'leadgen' }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!subscription.ok) throw new Error('META_PAGE_SUBSCRIPTION_FAILED');
      }
    }
    const credentialToStore: StoredOAuthCredential = {
      ...refreshed.credential,
      asset_access_tokens: selectedAssetTokens,
    };
    const { error: credentialError } = await admin
      .from('integration_credentials')
      .update({
        encrypted_payload: await encryptJson(credentialToStore),
        expires_at: credentialToStore.expires_at ?? null,
        replaced_by: auth.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', input.organization_id)
      .eq('connected_account_id', connection.id);
    if (credentialError) throw credentialError;

    const safeConnectionConfig = {
      ...(connection.connection_config ?? {}),
      selected_assets: resolvedMappings.map((mapping) => ({
        type: mapping.external_resource_type,
        id: mapping.external_resource_id,
        branch_id: mapping.branch_id,
        team_id: mapping.team_id,
      })),
    };
    const { data: mappingCount, error: mappingError } = await admin.rpc(
      'replace_integration_asset_mappings',
      {
        target_organization_id: input.organization_id,
        target_connection_id: connection.id,
        target_actor_id: auth.user.id,
        target_mappings: resolvedMappings,
        target_connection_config: safeConnectionConfig,
        target_request_id: requestId,
      },
    );
    if (mappingError) throw mappingError;
    return success(
      { connection_id: connection.id, mapped_assets: mappingCount ?? resolvedMappings.length },
      requestId,
    );
  } catch {
    return failure(
      'ASSET_MAPPING_FAILED',
      'Provider assets could not be mapped. Refresh the asset list and retry.',
      requestId,
      409,
    );
  }
});
