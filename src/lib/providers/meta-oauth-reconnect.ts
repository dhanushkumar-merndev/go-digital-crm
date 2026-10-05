type OAuthCredential = {
  access_token: string;
  token_type: string;
  expires_at?: string;
  external_account_id: string;
  external_account_label: string;
  graph_api_version?: string;
  asset_access_tokens?: Record<string, string>;
};

type MetaAsset = {
  id: string;
  type: string;
  label: string;
};

type MetaConnection = {
  status: string;
  external_account_id: string | null;
  connection_config: Record<string, unknown>;
};

export function prepareMetaOAuthReconnect(input: {
  credential: OAuthCredential;
  connection: MetaConnection;
  graphApiVersion: string;
  assets: MetaAsset[];
  assetAccessTokens: Record<string, string>;
}) {
  const pageId = input.connection.external_account_id?.trim();
  const page = input.assets.find((asset) => asset.type === 'META_PAGE' && asset.id === pageId);
  const pageAccessToken = pageId ? input.assetAccessTokens[pageId] : undefined;
  if (!pageId || !page || !pageAccessToken) throw new Error('META_RECONNECT_PAGE_NOT_ACCESSIBLE');

  const subscriptionStatus =
    input.connection.connection_config.subscription_status === 'SUBSCRIBED'
      ? 'SUBSCRIBED'
      : 'PENDING';
  const connectionConfig = {
    connection_type: 'META_OAUTH',
    page_id: pageId,
    graph_api_version: input.graphApiVersion,
    capabilities: ['LEAD_INGEST'],
    subscription_status: subscriptionStatus,
  };

  return {
    credential: {
      ...input.credential,
      external_account_id: pageId,
      external_account_label: page.label,
      graph_api_version: input.graphApiVersion,
      asset_access_tokens: { [pageId]: pageAccessToken },
    },
    connectionUpdate: {
      status: 'CONNECTED',
      auth_type: 'OAUTH2',
      external_account_id: pageId,
      token_expires_at: input.credential.expires_at ?? null,
      last_error_code: null,
      connection_config: connectionConfig,
    },
  };
}

export function oauthCallbackFailureUpdate(previousStatus: string) {
  return {
    status: previousStatus === 'CONNECTED' ? 'CONNECTED' : 'ERROR',
    last_error_code: 'OAUTH_CALLBACK_FAILED',
  };
}
