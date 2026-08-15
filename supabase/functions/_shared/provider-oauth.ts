export type OAuthProviderKey = 'meta' | 'google_ads' | 'google_business_profile';

export type StoredOAuthCredential = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  granted_scope?: string;
  expires_at?: string;
  external_account_id: string;
  external_account_label: string;
  asset_access_tokens?: Record<string, string>;
};

export type ProviderAsset = {
  id: string;
  type:
    | 'META_PAGE'
    | 'INSTAGRAM_ACCOUNT'
    | 'GOOGLE_ADS_CUSTOMER'
    | 'GOOGLE_ADS_CAMPAIGN'
    | 'GOOGLE_ADS_LEAD_FORM'
    | 'GBP_LOCATION';
  label: string;
  parent_id?: string;
  metadata?: Record<string, string | boolean | null>;
};

type OAuthExchangeInput = {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
};

function requiredEnvironment(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function configuration(provider: OAuthProviderKey) {
  if (provider === 'meta') {
    return {
      clientId: requiredEnvironment('META_APP_ID'),
      clientSecret: requiredEnvironment('META_APP_SECRET'),
      apiVersion: requiredEnvironment('META_GRAPH_API_VERSION'),
      scopes: requiredEnvironment('META_OAUTH_SCOPES'),
    };
  }
  return {
    clientId: requiredEnvironment('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: requiredEnvironment('GOOGLE_OAUTH_CLIENT_SECRET'),
    apiVersion: provider === 'google_ads' ? requiredEnvironment('GOOGLE_ADS_API_VERSION') : 'v1',
    scopes:
      provider === 'google_ads'
        ? 'openid email https://www.googleapis.com/auth/adwords'
        : 'openid email https://www.googleapis.com/auth/business.manage',
  };
}

async function responseJson<T>(response: Response, safeCode: string) {
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || !body) throw new Error(safeCode);
  return body;
}

function providerFetch(input: string | URL, init: RequestInit = {}) {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
}

export function authorizationUrl(
  provider: OAuthProviderKey,
  input: { state: string; redirectUri: string; codeChallenge: string },
) {
  const config = configuration(provider);
  if (provider === 'meta') {
    const url = new URL(`https://www.facebook.com/${config.apiVersion}/dialog/oauth`);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      response_type: 'code',
      scope: config.scopes,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: 'code',
    scope: config.scopes,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export async function exchangeOAuthCode(
  provider: OAuthProviderKey,
  input: OAuthExchangeInput,
): Promise<StoredOAuthCredential> {
  const config = configuration(provider);
  if (provider === 'meta') {
    const tokenUrl = new URL(`https://graph.facebook.com/${config.apiVersion}/oauth/access_token`);
    tokenUrl.search = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    }).toString();
    const shortToken = await responseJson<{
      access_token: string;
      token_type?: string;
      expires_in?: number;
    }>(await providerFetch(tokenUrl), 'META_TOKEN_EXCHANGE_FAILED');
    const longTokenUrl = new URL(
      `https://graph.facebook.com/${config.apiVersion}/oauth/access_token`,
    );
    longTokenUrl.search = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      fb_exchange_token: shortToken.access_token,
    }).toString();
    const longToken = await responseJson<{
      access_token: string;
      token_type?: string;
      expires_in?: number;
    }>(await providerFetch(longTokenUrl), 'META_LONG_LIVED_TOKEN_FAILED');
    const profileUrl = new URL(`https://graph.facebook.com/${config.apiVersion}/me`);
    profileUrl.search = new URLSearchParams({
      fields: 'id,name',
      access_token: longToken.access_token,
    }).toString();
    const profile = await responseJson<{ id: string; name?: string }>(
      await providerFetch(profileUrl),
      'META_PROFILE_LOOKUP_FAILED',
    );
    return {
      access_token: longToken.access_token,
      token_type: longToken.token_type ?? shortToken.token_type ?? 'bearer',
      expires_at: longToken.expires_in
        ? new Date(Date.now() + longToken.expires_in * 1000).toISOString()
        : undefined,
      external_account_id: profile.id,
      external_account_label: profile.name ?? 'Meta business account',
    };
  }

  const token = await responseJson<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  }>(
    await providerFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
        ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
      }),
    }),
    'GOOGLE_TOKEN_EXCHANGE_FAILED',
  );
  const profile = await responseJson<{ sub: string; email?: string }>(
    await providerFetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
    'GOOGLE_PROFILE_LOOKUP_FAILED',
  );
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type ?? 'Bearer',
    granted_scope: token.scope,
    expires_at: token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : undefined,
    external_account_id: profile.sub,
    external_account_label: profile.email ?? 'Google business account',
  };
}

export async function testOAuthCredential(
  provider: OAuthProviderKey,
  credential: StoredOAuthCredential,
) {
  const config = configuration(provider);
  if (provider === 'meta') {
    const url = new URL(`https://graph.facebook.com/${config.apiVersion}/me`);
    url.search = new URLSearchParams({
      fields: 'id,name',
      access_token: credential.access_token,
    }).toString();
    const account = await responseJson<{ id: string; name?: string }>(
      await providerFetch(url),
      'META_CONNECTION_TEST_FAILED',
    );
    return {
      accountId: account.id,
      accountLabel: account.name ?? credential.external_account_label,
    };
  }
  if (provider === 'google_ads') {
    const response = await providerFetch(
      `https://googleads.googleapis.com/${config.apiVersion}/customers:listAccessibleCustomers`,
      {
        headers: {
          authorization: `Bearer ${credential.access_token}`,
          'developer-token': requiredEnvironment('GOOGLE_ADS_DEVELOPER_TOKEN'),
        },
      },
    );
    const body = await responseJson<{ resourceNames?: string[] }>(
      response,
      'GOOGLE_ADS_CONNECTION_TEST_FAILED',
    );
    return {
      accountId: credential.external_account_id,
      accountLabel: `${body.resourceNames?.length ?? 0} accessible Google Ads account(s)`,
    };
  }
  const accounts = await responseJson<{ accounts?: Array<{ name: string; accountName?: string }> }>(
    await providerFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { authorization: `Bearer ${credential.access_token}` },
    }),
    'GOOGLE_BUSINESS_PROFILE_CONNECTION_TEST_FAILED',
  );
  return {
    accountId: credential.external_account_id,
    accountLabel: `${accounts.accounts?.length ?? 0} Google Business Profile account(s)`,
  };
}

export async function refreshOAuthCredential(
  provider: OAuthProviderKey,
  credential: StoredOAuthCredential,
) {
  if (provider === 'meta') return { credential, refreshed: false };
  const expiresAt = credential.expires_at ? new Date(credential.expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 5 * 60_000) return { credential, refreshed: false };
  if (!credential.refresh_token) throw new Error('GOOGLE_RECONNECT_REQUIRED');
  const config = configuration(provider);
  const token = await responseJson<{
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
  }>(
    await providerFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: credential.refresh_token,
        grant_type: 'refresh_token',
      }),
    }),
    'GOOGLE_TOKEN_REFRESH_FAILED',
  );
  return {
    refreshed: true,
    credential: {
      ...credential,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? credential.refresh_token,
      token_type: token.token_type ?? credential.token_type,
      granted_scope: token.scope ?? credential.granted_scope,
      expires_at: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : credential.expires_at,
    },
  };
}

export async function discoverProviderAssets(
  provider: OAuthProviderKey,
  credential: StoredOAuthCredential,
  parentAssetId?: string,
): Promise<{ assets: ProviderAsset[]; assetAccessTokens: Record<string, string> }> {
  if (provider === 'meta') {
    const config = configuration(provider);
    const url = new URL(`https://graph.facebook.com/${config.apiVersion}/me/accounts`);
    url.search = new URLSearchParams({
      fields: 'id,name,access_token,instagram_business_account{id,username,name}',
      limit: '100',
    }).toString();
    const result = await responseJson<{
      data?: Array<{
        id: string;
        name?: string;
        access_token?: string;
        instagram_business_account?: { id: string; username?: string; name?: string };
      }>;
    }>(
      await providerFetch(url, {
        headers: { authorization: `Bearer ${credential.access_token}` },
      }),
      'META_ASSET_DISCOVERY_FAILED',
    );
    const assets: ProviderAsset[] = [];
    const assetAccessTokens: Record<string, string> = {};
    for (const page of result.data ?? []) {
      if (!/^\d+$/.test(page.id)) continue;
      assets.push({ id: page.id, type: 'META_PAGE', label: page.name ?? `Page ${page.id}` });
      if (page.access_token) assetAccessTokens[page.id] = page.access_token;
      const instagram = page.instagram_business_account;
      if (instagram && /^\d+$/.test(instagram.id)) {
        assets.push({
          id: instagram.id,
          type: 'INSTAGRAM_ACCOUNT',
          label: instagram.username
            ? `@${instagram.username}`
            : (instagram.name ?? `Instagram ${instagram.id}`),
          parent_id: page.id,
        });
        if (page.access_token) assetAccessTokens[instagram.id] = page.access_token;
      }
    }
    return { assets, assetAccessTokens };
  }

  if (provider === 'google_ads') {
    const config = configuration(provider);
    const result = await responseJson<{ resourceNames?: string[] }>(
      await providerFetch(
        `https://googleads.googleapis.com/${config.apiVersion}/customers:listAccessibleCustomers`,
        {
          headers: {
            authorization: `Bearer ${credential.access_token}`,
            'developer-token': requiredEnvironment('GOOGLE_ADS_DEVELOPER_TOKEN'),
          },
        },
      ),
      'GOOGLE_ADS_ASSET_DISCOVERY_FAILED',
    );
    const customerAssets = (result.resourceNames ?? [])
      .filter((name) => /^customers\/\d+$/.test(name))
      .slice(0, 200)
      .map((name) => ({
        id: name.slice('customers/'.length),
        type: 'GOOGLE_ADS_CUSTOMER' as const,
        label: `Google Ads ${name.slice('customers/'.length)}`,
      }));
    if (!parentAssetId) return { assets: customerAssets, assetAccessTokens: {} };
    if (!/^\d+$/.test(parentAssetId) || !customerAssets.some((asset) => asset.id === parentAssetId))
      throw new Error('GOOGLE_ADS_CUSTOMER_NOT_ACCESSIBLE');
    const headers = {
      authorization: `Bearer ${credential.access_token}`,
      'developer-token': requiredEnvironment('GOOGLE_ADS_DEVELOPER_TOKEN'),
      'content-type': 'application/json',
    };
    const searchUrl = `https://googleads.googleapis.com/${config.apiVersion}/customers/${parentAssetId}/googleAds:search`;
    const campaigns = await responseJson<{
      results?: Array<{ campaign?: { id?: string; name?: string; status?: string } }>;
    }>(
      await providerFetch(searchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query:
            "SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 200",
        }),
      }),
      'GOOGLE_ADS_CAMPAIGN_DISCOVERY_FAILED',
    );
    const forms = await responseJson<{
      results?: Array<{ asset?: { id?: string; name?: string; type?: string } }>;
    }>(
      await providerFetch(searchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query:
            "SELECT asset.id, asset.name, asset.type FROM asset WHERE asset.type = 'LEAD_FORM' LIMIT 200",
        }),
      }),
      'GOOGLE_ADS_LEAD_FORM_DISCOVERY_FAILED',
    );
    const childAssets: ProviderAsset[] = [];
    for (const row of campaigns.results ?? []) {
      const campaign = row.campaign;
      if (!campaign?.id || !/^\d+$/.test(campaign.id)) continue;
      childAssets.push({
        id: campaign.id,
        type: 'GOOGLE_ADS_CAMPAIGN',
        label: campaign.name ?? `Campaign ${campaign.id}`,
        parent_id: parentAssetId,
        metadata: { status: campaign.status ?? null },
      });
    }
    for (const row of forms.results ?? []) {
      const asset = row.asset;
      if (!asset?.id || !/^\d+$/.test(asset.id)) continue;
      childAssets.push({
        id: asset.id,
        type: 'GOOGLE_ADS_LEAD_FORM',
        label: asset.name ?? `Lead form ${asset.id}`,
        parent_id: parentAssetId,
      });
    }
    return { assets: [...customerAssets, ...childAssets], assetAccessTokens: {} };
  }

  const accountResult = await responseJson<{
    accounts?: Array<{ name: string; accountName?: string; type?: string }>;
  }>(
    await providerFetch(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20',
      {
        headers: { authorization: `Bearer ${credential.access_token}` },
      },
    ),
    'GBP_ACCOUNT_DISCOVERY_FAILED',
  );
  const assets: ProviderAsset[] = [];
  for (const account of (accountResult.accounts ?? []).slice(0, 20)) {
    if (!/^accounts\/[A-Za-z0-9_-]+$/.test(account.name)) continue;
    const locationUrl = new URL(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`,
    );
    locationUrl.search = new URLSearchParams({
      readMask: 'name,title,storeCode,metadata',
      pageSize: '100',
    }).toString();
    const locations = await responseJson<{
      locations?: Array<{
        name: string;
        title?: string;
        storeCode?: string;
        metadata?: { canOperateHealthData?: boolean; placeId?: string };
      }>;
    }>(
      await providerFetch(locationUrl, {
        headers: { authorization: `Bearer ${credential.access_token}` },
      }),
      'GBP_LOCATION_DISCOVERY_FAILED',
    );
    for (const location of locations.locations ?? []) {
      if (!/^locations\/[A-Za-z0-9_-]+$/.test(location.name)) continue;
      assets.push({
        id: location.name,
        type: 'GBP_LOCATION',
        label: location.title ?? location.storeCode ?? location.name,
        parent_id: account.name,
        metadata: {
          account_name: account.accountName ?? account.name,
          store_code: location.storeCode ?? null,
          place_id: location.metadata?.placeId ?? null,
        },
      });
      if (assets.length >= 200) break;
    }
    if (assets.length >= 200) break;
  }
  return { assets, assetAccessTokens: {} };
}
