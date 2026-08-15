import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { sha256Base64Url } from './crypto.ts';

export type ProviderAssetRoute = {
  organizationId: string;
  connectionId: string;
  externalResourceId: string;
};

export async function resolveProviderAssetRoutes(
  admin: SupabaseClient,
  providerKey: 'meta' | 'whatsapp_cloud',
  resourceType: 'META_PAGE' | 'WHATSAPP_PHONE_NUMBER',
  resourceIds: string[],
) {
  const uniqueResourceIds = Array.from(new Set(resourceIds));
  if (uniqueResourceIds.length === 0) return new Map<string, ProviderAssetRoute>();
  if (uniqueResourceIds.length > 100) throw new Error('TOO_MANY_PROVIDER_ASSETS');
  const { data: mappings, error: mappingError } = await admin
    .from('integration_branch_mappings')
    .select('organization_id,connected_account_id,external_resource_id')
    .eq('external_resource_type', resourceType)
    .is('deleted_at', null)
    .in('external_resource_id', uniqueResourceIds);
  if (mappingError) throw mappingError;
  const connectionIds = Array.from(
    new Set((mappings ?? []).map((mapping) => String(mapping.connected_account_id))),
  );
  if (connectionIds.length === 0) return new Map<string, ProviderAssetRoute>();
  const { data: connections, error: connectionError } = await admin
    .from('connected_accounts')
    .select('id,organization_id')
    .eq('provider_key', providerKey)
    .eq('status', 'CONNECTED')
    .is('deleted_at', null)
    .in('id', connectionIds);
  if (connectionError) throw connectionError;
  const activeConnections = new Map(
    (connections ?? []).map((connection) => [String(connection.id), connection]),
  );
  const routes = new Map<string, ProviderAssetRoute>();
  for (const mapping of mappings ?? []) {
    const connection = activeConnections.get(String(mapping.connected_account_id));
    if (!connection || connection.organization_id !== mapping.organization_id) continue;
    const externalResourceId = String(mapping.external_resource_id);
    if (routes.has(externalResourceId)) throw new Error('AMBIGUOUS_PROVIDER_ASSET_ROUTE');
    routes.set(externalResourceId, {
      organizationId: String(mapping.organization_id),
      connectionId: String(mapping.connected_account_id),
      externalResourceId,
    });
  }
  return routes;
}

export async function recordUnmappedProviderAssets(
  admin: SupabaseClient,
  service: 'provider-webhook-meta' | 'provider-webhook-whatsapp',
  resourceType: 'META_PAGE' | 'WHATSAPP_PHONE_NUMBER',
  resourceIds: string[],
) {
  const uniqueResourceIds = Array.from(new Set(resourceIds)).sort();
  if (uniqueResourceIds.length === 0) return;
  const { error } = await admin.from('error_logs').insert({
    organization_id: null,
    service,
    safe_code: 'PROVIDER_ASSET_UNMAPPED',
    safe_message: 'A signed provider event did not match an active tenant asset route.',
    sanitized_context: {
      resource_type: resourceType,
      resource_count: uniqueResourceIds.length,
      resource_set_hash: await sha256Base64Url(JSON.stringify(uniqueResourceIds)),
    },
  });
  if (error) throw error;
}
