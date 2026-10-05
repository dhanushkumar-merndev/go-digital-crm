import type { IntegrationProviderKey, IntegrationScopeMode } from './integration-workspace-api';

export type OAuthStartInput = {
  organizationId: string;
  connectionId?: string;
  providerKey: Exclude<
    IntegrationProviderKey,
    'whatsapp_cloud' | 'telecmi' | 'whatsapp_personal_baileys' | 'indiamart'
  >;
  displayName: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  redirectPath: string;
};

export function buildOAuthStartPayload(input: OAuthStartInput) {
  return {
    organization_id: input.organizationId,
    ...(input.connectionId ? { connection_id: input.connectionId } : {}),
    provider_key: input.providerKey,
    display_name: input.displayName,
    scope_mode: input.scopeMode,
    branch_ids: input.branchIds,
    redirect_path: input.redirectPath,
  };
}
