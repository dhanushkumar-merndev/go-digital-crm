import { z } from 'npm:zod@4';
import {
  decryptJson,
  encryptJson,
  hmacSha256Hex,
  randomBase64Url,
  sha256Base64Url,
} from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { resolveStoredProviderSecret } from '../_shared/stored-provider-secret.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const optionalSecret = (minimumLength: number, maximumLength: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(minimumLength).max(maximumLength).optional(),
  );

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    default_branch_id: z.uuid(),
    default_team_id: z.uuid(),
    app_id: z
      .string()
      .trim()
      .regex(/^\d{5,32}$/),
    app_secret: optionalSecret(16, 512),
    graph_api_version: z
      .string()
      .trim()
      .regex(/^v\d+\.\d+$/),
    page_id: z
      .string()
      .trim()
      .regex(/^\d{5,32}$/),
    page_access_token: optionalSecret(20, 4096),
    webhook_verify_token: optionalSecret(16, 256),
  })
  .superRefine((input, context) => {
    if (!input.connection_id) {
      for (const [path, value] of [
        ['app_secret', input.app_secret],
        ['page_access_token', input.page_access_token],
        ['webhook_verify_token', input.webhook_verify_token],
      ] as const)
        if (!value)
          context.addIssue({
            code: 'custom',
            path: [path],
            message: 'Required for a new connection.',
          });
    }
    if (new Set(input.branch_ids).size !== input.branch_ids.length)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Duplicate branch.' });
    if (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select one branch.' });
    if (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length < 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select branches.' });
    if (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Clear branches.' });
    if (input.scope_mode !== 'ALL_BRANCHES' && !input.branch_ids.includes(input.default_branch_id))
      context.addIssue({
        code: 'custom',
        path: ['default_branch_id'],
        message: 'The lead destination branch must be inside the connection scope.',
      });
  });

type MetaPage = { id?: string; name?: string; access_token?: string };
type StoredMetaCredential = {
  app_secret?: string;
  page_access_token?: string;
  webhook_verify_token?: string;
  webhook_route_token?: string;
};
type MetaTokenDebug = {
  data?: {
    app_id?: string;
    is_valid?: boolean;
    scopes?: string[];
    type?: string;
  };
};

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  let connectionId: string | undefined;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure(
        'INVALID_PAYLOAD',
        'Meta Manual API connection settings are invalid.',
        requestId,
        422,
      );
    const input = parsed.data;
    connectionId = input.connection_id;

    const functionBase = Deno.env.get('PUBLIC_EDGE_FUNCTION_BASE_URL')?.replace(/\/$/, '');
    if (!functionBase) throw new Error('PUBLIC_EDGE_FUNCTION_BASE_URL_MISSING');
    new URL(functionBase);

    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: scopePermitted } = await client.rpc('authorize_integration_scope', {
      target_organization_id: input.organization_id,
      target_permission: 'integration.manage',
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
    });
    if (!scopePermitted)
      return failure(
        'BRANCH_SCOPE_DENIED',
        'The connection scope exceeds your authority.',
        requestId,
        403,
      );
    if (connectionId) {
      const { data: connectionPermitted } = await client.rpc(
        'authorize_integration_connection_action',
        {
          target_organization_id: input.organization_id,
          target_connection_id: connectionId,
          target_permission: 'integration.manage',
        },
      );
      if (!connectionPermitted)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot replace this connection.',
          requestId,
          403,
        );
    }

    const admin = serviceClient();
    const { data: team } = await admin
      .from('teams')
      .select('id')
      .eq('id', input.default_team_id)
      .eq('organization_id', input.organization_id)
      .eq('branch_id', input.default_branch_id)
      .eq('active', true)
      .maybeSingle();
    if (!team)
      return failure(
        'ACTIVE_TEAM_NOT_FOUND',
        'Select an active team from the lead destination branch.',
        requestId,
        422,
      );

    let routeToken = randomBase64Url(32);
    let previousKeyVersion = 0;
    let existingConfig: Record<string, unknown> = {};
    let previousCredential: StoredMetaCredential = {};
    if (connectionId) {
      const { data: existing } = await admin
        .from('connected_accounts')
        .select('id,connection_config')
        .eq('id', connectionId)
        .eq('organization_id', input.organization_id)
        .eq('provider_key', 'meta')
        .is('deleted_at', null)
        .maybeSingle();
      if (!existing)
        return failure(
          'CONNECTION_NOT_FOUND',
          'The Meta connection was not found.',
          requestId,
          404,
        );
      existingConfig = (existing.connection_config ?? {}) as Record<string, unknown>;
      const { data: stored, error: storedError } = await admin
        .from('integration_credentials')
        .select('encrypted_payload,key_version')
        .eq('organization_id', input.organization_id)
        .eq('connected_account_id', connectionId)
        .maybeSingle();
      if (storedError) throw storedError;
      previousKeyVersion = stored?.key_version ?? 0;
      if (stored?.encrypted_payload) {
        previousCredential = await decryptJson<StoredMetaCredential>(stored.encrypted_payload);
        if (previousCredential.webhook_route_token)
          routeToken = previousCredential.webhook_route_token;
      }
    } else {
      const { data: duplicatePage } = await admin
        .from('connected_accounts')
        .select('id')
        .eq('provider_key', 'meta')
        .eq('external_account_id', input.page_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (duplicatePage)
        return failure(
          'META_PAGE_ALREADY_CONNECTED',
          'This Facebook Page is already connected. Replace that connection instead.',
          requestId,
          409,
        );
    }

    const resolvedAppSecret = resolveStoredProviderSecret(
      input.app_secret,
      previousCredential.app_secret,
      'Meta App Secret',
    );
    const enteredAccessToken = resolveStoredProviderSecret(
      input.page_access_token,
      previousCredential.page_access_token,
      'Meta Page access token',
    );
    const resolvedWebhookVerifyToken = resolveStoredProviderSecret(
      input.webhook_verify_token,
      previousCredential.webhook_verify_token,
      'Meta webhook verify token',
    );

    const tokenDebugUrl = new URL(
      `https://graph.facebook.com/${input.graph_api_version}/debug_token`,
    );
    const debugToken = async (token: string) => {
      tokenDebugUrl.searchParams.set('input_token', token);
      const response = await fetch(tokenDebugUrl, {
        headers: { authorization: `Bearer ${input.app_id}|${resolvedAppSecret}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => null)) as MetaTokenDebug | null;
      return { response, body };
    };

    let resolvedPageAccessToken = enteredAccessToken;
    const initialDebug = await debugToken(resolvedPageAccessToken);
    if (
      !initialDebug.response.ok ||
      !initialDebug.body?.data?.is_valid ||
      initialDebug.body.data.app_id !== input.app_id ||
      !['PAGE', 'USER'].includes(initialDebug.body.data.type ?? '')
    )
      return failure(
        'META_ACCESS_TOKEN_INVALID',
        'Use a valid Page token or authorized User token generated by this Meta app.',
        requestId,
        422,
      );

    if (initialDebug.body.data.type === 'USER') {
      const userTokenProof = await hmacSha256Hex(resolvedAppSecret, resolvedPageAccessToken);
      const pageTokenUrl = new URL(
        `https://graph.facebook.com/${input.graph_api_version}/${encodeURIComponent(input.page_id)}`,
      );
      pageTokenUrl.searchParams.set('fields', 'id,name,access_token');
      pageTokenUrl.searchParams.set('appsecret_proof', userTokenProof);
      const pageTokenResponse = await fetch(pageTokenUrl, {
        headers: { authorization: `Bearer ${resolvedPageAccessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const pageWithToken = (await pageTokenResponse.json().catch(() => null)) as MetaPage | null;
      if (
        !pageTokenResponse.ok ||
        pageWithToken?.id !== input.page_id ||
        !pageWithToken.access_token
      )
        return failure(
          'META_PAGE_NOT_AUTHORIZED',
          'This User token cannot access the selected Facebook Page. Reauthorize the Page in Meta and generate the token again.',
          requestId,
          422,
        );
      resolvedPageAccessToken = pageWithToken.access_token;
    }

    const tokenDebug = await debugToken(resolvedPageAccessToken);
    const tokenScopes = new Set(tokenDebug.body?.data?.scopes ?? []);
    const requiredScopes = [
      'leads_retrieval',
      'pages_manage_ads',
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_show_list',
    ];
    const missingScopes = requiredScopes.filter((scope) => !tokenScopes.has(scope));
    if (
      !tokenDebug.response.ok ||
      !tokenDebug.body?.data?.is_valid ||
      tokenDebug.body.data.app_id !== input.app_id ||
      tokenDebug.body.data.type !== 'PAGE'
    )
      return failure(
        'META_PAGE_TOKEN_INVALID',
        'Meta could not derive a valid Page access token from this credential.',
        requestId,
        422,
      );
    if (missingScopes.length > 0)
      return failure(
        'META_PAGE_TOKEN_SCOPES_MISSING',
        `The Page access token is missing required permissions: ${missingScopes.join(', ')}.`,
        requestId,
        422,
      );

    const appSecretProof = await hmacSha256Hex(resolvedAppSecret, resolvedPageAccessToken);
    const pageUrl = new URL(
      `https://graph.facebook.com/${input.graph_api_version}/${encodeURIComponent(input.page_id)}`,
    );
    pageUrl.searchParams.set('fields', 'id,name');
    pageUrl.searchParams.set('appsecret_proof', appSecretProof);
    const pageResponse = await fetch(pageUrl, {
      headers: { authorization: `Bearer ${resolvedPageAccessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const page = (await pageResponse.json().catch(() => null)) as MetaPage | null;
    if (!pageResponse.ok || page?.id !== input.page_id)
      return failure(
        'META_PAGE_CREDENTIAL_REJECTED',
        'Meta rejected the App Secret, Page ID, or derived Page access token.',
        requestId,
        422,
      );

    // A Page can have only one active webhook route. Check before mutating the
    // connection so a stale mapping produces an actionable conflict instead of
    // leaving a partially replaced credential behind.
    const { data: activePageRoute, error: activePageRouteError } = await admin
      .from('integration_branch_mappings')
      .select('connected_account_id')
      .eq('external_resource_type', 'META_PAGE')
      .eq('external_resource_id', input.page_id)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (activePageRouteError) throw activePageRouteError;
    if (activePageRoute && (!connectionId || activePageRoute.connected_account_id !== connectionId))
      return failure(
        'META_PAGE_ALREADY_MAPPED',
        'This Facebook Page is mapped to another Meta connection. Unmap it there first.',
        requestId,
        409,
      );

    const now = new Date().toISOString();
    const connectionConfig = {
      ...existingConfig,
      connection_type: 'META_DIRECT',
      capabilities: ['LEAD_INGEST'],
      app_id: input.app_id,
      graph_api_version: input.graph_api_version,
      page_id: input.page_id,
      webhook_route_hash: await sha256Base64Url(routeToken),
      subscription_status: 'PENDING',
    };
    if (connectionId) {
      const { error } = await admin
        .from('connected_accounts')
        .update({
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          auth_type: 'API_KEY',
          external_account_id: input.page_id,
          default_team_id: input.default_team_id,
          connection_config: connectionConfig,
          connected_at: now,
          last_tested_at: now,
          last_error_code: null,
        })
        .eq('id', connectionId)
        .eq('organization_id', input.organization_id);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin
        .from('connected_accounts')
        .insert({
          organization_id: input.organization_id,
          provider_key: 'meta',
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          auth_type: 'API_KEY',
          external_account_id: input.page_id,
          default_team_id: input.default_team_id,
          connection_config: connectionConfig,
          connected_at: now,
          last_tested_at: now,
          created_by: auth.user.id,
        })
        .select('id')
        .single();
      if (error) throw error;
      connectionId = created.id;
    }

    const credential = {
      connection_type: 'META_DIRECT',
      app_id: input.app_id,
      app_secret: resolvedAppSecret,
      graph_api_version: input.graph_api_version,
      page_id: input.page_id,
      page_access_token: resolvedPageAccessToken,
      webhook_verify_token: resolvedWebhookVerifyToken,
      webhook_route_token: routeToken,
      access_token: resolvedPageAccessToken,
      token_type: 'bearer',
      external_account_id: input.page_id,
      external_account_label: page.name ?? `Facebook Page ${input.page_id}`,
      asset_access_tokens: { [input.page_id]: resolvedPageAccessToken },
    };
    const { error: credentialError } = await admin.from('integration_credentials').upsert(
      {
        organization_id: input.organization_id,
        connected_account_id: connectionId,
        encrypted_payload: await encryptJson(credential),
        key_version: previousKeyVersion + 1,
        cipher_version: 'AES-256-GCM-v1',
        replaced_by: auth.user.id,
        updated_at: now,
      },
      { onConflict: 'connected_account_id' },
    );
    if (credentialError) throw credentialError;

    await admin
      .from('integration_branch_mappings')
      .update({ deleted_at: now })
      .eq('connected_account_id', connectionId)
      .is('deleted_at', null);
    const scopeBranches =
      input.scope_mode === 'ALL_BRANCHES' ? [] : Array.from(new Set(input.branch_ids));
    if (scopeBranches.length > 0) {
      const { error } = await admin.from('integration_branch_mappings').upsert(
        scopeBranches.map((branchId) => ({
          organization_id: input.organization_id,
          connected_account_id: connectionId,
          branch_id: branchId,
          team_id: branchId === input.default_branch_id ? input.default_team_id : null,
          external_resource_type: 'CONNECTION_SCOPE',
          external_resource_id: branchId,
          deleted_at: null,
        })),
        {
          onConflict: 'connected_account_id,branch_id,external_resource_type,external_resource_id',
        },
      );
      if (error) throw error;
    }
    const { error: pageMappingError } = await admin.from('integration_branch_mappings').upsert(
      {
        organization_id: input.organization_id,
        connected_account_id: connectionId,
        branch_id: input.default_branch_id,
        team_id: input.default_team_id,
        external_resource_type: 'META_PAGE',
        external_resource_id: input.page_id,
        external_resource_label: page.name ?? `Facebook Page ${input.page_id}`,
        deleted_at: null,
      },
      {
        onConflict: 'connected_account_id,branch_id,external_resource_type,external_resource_id',
      },
    );
    if (pageMappingError) throw pageMappingError;

    const subscriptionResponse = await fetch(
      `https://graph.facebook.com/${input.graph_api_version}/${encodeURIComponent(input.page_id)}/subscribed_apps`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${resolvedPageAccessToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          subscribed_fields: 'leadgen',
          appsecret_proof: appSecretProof,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    ).catch(() => null);
    const subscriptionStatus = subscriptionResponse?.ok ? 'SUBSCRIBED' : 'PENDING';
    await admin
      .from('connected_accounts')
      .update({
        connection_config: { ...connectionConfig, subscription_status: subscriptionStatus },
        last_error_code:
          subscriptionStatus === 'SUBSCRIBED' ? null : 'META_PAGE_SUBSCRIPTION_PENDING',
      })
      .eq('id', connectionId)
      .eq('organization_id', input.organization_id);

    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: input.connection_id ? 'integration.credential_replaced' : 'integration.connected',
      resource_type: 'connected_account',
      resource_id: connectionId,
      branch_id: input.default_branch_id,
      request_id: requestId,
      metadata: {
        provider_key: 'meta',
        connection_type: 'META_DIRECT',
        page_id: input.page_id,
        credential_version: previousKeyVersion + 1,
      },
    });

    return success(
      {
        connection_id: connectionId,
        account_label: credential.external_account_label,
        status: 'CONNECTED',
        subscription_status: subscriptionStatus,
        webhook_url: `${functionBase}/provider-webhook-meta?route_token=${encodeURIComponent(routeToken)}`,
      },
      requestId,
      input.connection_id ? 200 : 201,
    );
  } catch {
    if (connectionId) {
      await serviceClient()
        .from('connected_accounts')
        .update({ status: 'ERROR', last_error_code: 'META_DIRECT_CONNECTION_FAILED' })
        .eq('id', connectionId);
    }
    return failure(
      'META_DIRECT_CONNECTION_FAILED',
      'The Meta Manual API connection could not be saved.',
      requestId,
      500,
    );
  }
});
