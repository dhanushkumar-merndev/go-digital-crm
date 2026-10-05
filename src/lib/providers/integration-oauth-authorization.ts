type OAuthStartAuthorizationInput = {
  connectionId?: string;
  organizationId: string;
  scopeMode: 'ONE_BRANCH' | 'SELECTED_BRANCHES' | 'ALL_BRANCHES';
  branchIds: string[];
};

export function oauthStartAuthorization(input: OAuthStartAuthorizationInput) {
  if (input.connectionId) {
    return {
      rpc: 'authorize_integration_connection_action' as const,
      args: {
        target_organization_id: input.organizationId,
        target_connection_id: input.connectionId,
        target_permission: 'integration.manage',
      },
    };
  }

  return {
    rpc: 'authorize_integration_scope' as const,
    args: {
      target_organization_id: input.organizationId,
      target_permission: 'integration.manage',
      target_scope_mode: input.scopeMode,
      target_branch_ids: input.branchIds,
    },
  };
}
