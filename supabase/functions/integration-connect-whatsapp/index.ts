import { z } from 'npm:zod@4';
import { decryptJson, encryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { resolveStoredProviderSecret } from '../_shared/stored-provider-secret.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    default_inbound_branch_id: z.uuid(),
    default_team_id: z.uuid().optional(),
    phone_number_id: z.string().trim().min(3).max(80),
    whatsapp_business_account_id: z.string().trim().min(3).max(80),
    access_token: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().trim().min(20).max(4096).optional(),
    ),
  })
  .superRefine((input, context) => {
    if (!input.connection_id && !input.access_token)
      context.addIssue({
        code: 'custom',
        path: ['access_token'],
        message: 'An access token is required for a new connection.',
      });
    if (new Set(input.branch_ids).size !== input.branch_ids.length)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Duplicate branch.' });
    if (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select one branch.' });
    if (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length < 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select branches.' });
    if (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Clear branches.' });
    if (
      input.scope_mode !== 'ALL_BRANCHES' &&
      !input.branch_ids.includes(input.default_inbound_branch_id)
    )
      context.addIssue({
        code: 'custom',
        path: ['default_inbound_branch_id'],
        message: 'Inbound branch must be in connection scope.',
      });
  });

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  let failureStage = 'REQUEST_VALIDATION';
  let organizationId: string | undefined;
  let connectionId: string | undefined;
  let phoneNumberId: string | undefined;
  let whatsappBusinessAccountId: string | undefined;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure(
        'INVALID_PAYLOAD',
        'WhatsApp connection settings are invalid.',
        requestId,
        422,
      );
    const input = parsed.data;
    organizationId = input.organization_id;
    connectionId = input.connection_id;
    phoneNumberId = input.phone_number_id;
    whatsappBusinessAccountId = input.whatsapp_business_account_id;
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
    if (input.connection_id) {
      const { data: connectionPermitted } = await client.rpc(
        'authorize_integration_connection_action',
        {
          target_organization_id: input.organization_id,
          target_connection_id: input.connection_id,
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
    let storedAccessToken: string | undefined;
    if (connectionId) {
      const { data: stored, error: storedError } = await admin
        .from('integration_credentials')
        .select('encrypted_payload')
        .eq('organization_id', input.organization_id)
        .eq('connected_account_id', connectionId)
        .maybeSingle();
      if (storedError) throw storedError;
      if (stored?.encrypted_payload)
        storedAccessToken = (await decryptJson<{ access_token?: string }>(stored.encrypted_payload))
          .access_token;
    }
    const resolvedAccessToken = resolveStoredProviderSecret(
      input.access_token,
      storedAccessToken,
      'WhatsApp access token',
    );

    failureStage = 'PROVIDER_TEST';
    const graphVersion = Deno.env.get('META_GRAPH_API_VERSION')?.trim();
    if (!graphVersion) throw new Error('META_GRAPH_API_VERSION_MISSING');
    const testUrl = new URL(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(input.phone_number_id)}`,
    );
    testUrl.searchParams.set('fields', 'id,display_phone_number,verified_name');
    const providerTest = await fetch(testUrl, {
      headers: { authorization: `Bearer ${resolvedAccessToken}` },
    });
    const providerAccount = (await providerTest.json().catch(() => null)) as {
      id?: string;
      display_phone_number?: string;
      verified_name?: string;
    } | null;
    if (!providerTest.ok || providerAccount?.id !== input.phone_number_id)
      return failure(
        'WHATSAPP_CONNECTION_TEST_FAILED',
        'WhatsApp rejected the phone-number credential.',
        requestId,
        422,
      );

    failureStage = 'ROUTE_PREFLIGHT';
    const { data: activePhoneRoute, error: activePhoneRouteError } = await admin
      .from('integration_branch_mappings')
      .select('connected_account_id')
      .eq('external_resource_type', 'WHATSAPP_PHONE_NUMBER')
      .eq('external_resource_id', input.phone_number_id)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (activePhoneRouteError) throw activePhoneRouteError;
    if (
      activePhoneRoute &&
      (!connectionId || activePhoneRoute.connected_account_id !== connectionId)
    )
      return failure(
        'WHATSAPP_PHONE_ALREADY_MAPPED',
        'This WhatsApp phone number is mapped to another connection. Replace that connection instead.',
        requestId,
        409,
      );

    failureStage = 'CONNECTION_SAVE';
    if (connectionId) {
      const { data: existing } = await admin
        .from('connected_accounts')
        .select('id')
        .eq('id', connectionId)
        .eq('organization_id', input.organization_id)
        .eq('provider_key', 'whatsapp_cloud')
        .is('deleted_at', null)
        .maybeSingle();
      if (!existing)
        return failure(
          'CONNECTION_NOT_FOUND',
          'The WhatsApp connection was not found.',
          requestId,
          404,
        );
      const { error } = await admin
        .from('connected_accounts')
        .update({
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          auth_type: 'API_KEY',
          external_account_id: input.phone_number_id,
          default_team_id: input.default_team_id ?? null,
          connected_at: new Date().toISOString(),
          last_tested_at: new Date().toISOString(),
          last_error_code: null,
        })
        .eq('id', connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin
        .from('connected_accounts')
        .insert({
          organization_id: input.organization_id,
          provider_key: 'whatsapp_cloud',
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          auth_type: 'API_KEY',
          external_account_id: input.phone_number_id,
          default_team_id: input.default_team_id ?? null,
          connected_at: new Date().toISOString(),
          last_tested_at: new Date().toISOString(),
          created_by: auth.user.id,
        })
        .select('id')
        .single();
      if (error) throw error;
      connectionId = created.id;
    }

    failureStage = 'CREDENTIAL_SAVE';
    const { data: previousSecret, error: previousSecretError } = await admin
      .from('integration_credentials')
      .select('key_version')
      .eq('connected_account_id', connectionId)
      .maybeSingle();
    if (previousSecretError) throw previousSecretError;
    const { error: credentialError } = await admin.from('integration_credentials').upsert(
      {
        organization_id: input.organization_id,
        connected_account_id: connectionId,
        encrypted_payload: await encryptJson({
          access_token: resolvedAccessToken,
          phone_number_id: input.phone_number_id,
          whatsapp_business_account_id: input.whatsapp_business_account_id,
        }),
        key_version: (previousSecret?.key_version ?? 0) + 1,
        cipher_version: 'AES-256-GCM-v1',
        replaced_by: auth.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'connected_account_id' },
    );
    if (credentialError) throw credentialError;

    failureStage = 'MAPPING_SAVE';
    const { error: clearMappingsError } = await admin
      .from('integration_branch_mappings')
      .update({ deleted_at: new Date().toISOString() })
      .eq('connected_account_id', connectionId)
      .is('deleted_at', null);
    if (clearMappingsError) throw clearMappingsError;
    const scopeBranches =
      input.scope_mode === 'ALL_BRANCHES' ? [] : Array.from(new Set(input.branch_ids));
    if (scopeBranches.length > 0) {
      const { error } = await admin.from('integration_branch_mappings').upsert(
        scopeBranches.map((branchId) => ({
          organization_id: input.organization_id,
          connected_account_id: connectionId,
          branch_id: branchId,
          team_id: branchId === input.default_inbound_branch_id ? input.default_team_id : null,
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
    const { error: phoneMappingError } = await admin.from('integration_branch_mappings').upsert(
      {
        organization_id: input.organization_id,
        connected_account_id: connectionId,
        branch_id: input.default_inbound_branch_id,
        team_id: input.default_team_id ?? null,
        external_resource_type: 'WHATSAPP_PHONE_NUMBER',
        external_resource_id: input.phone_number_id,
        deleted_at: null,
      },
      {
        onConflict: 'connected_account_id,branch_id,external_resource_type,external_resource_id',
      },
    );
    if (phoneMappingError) throw phoneMappingError;

    failureStage = 'AUDIT_SAVE';
    const { error: auditError } = await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: input.connection_id ? 'integration.credential_replaced' : 'integration.connected',
      resource_type: 'connected_account',
      resource_id: connectionId,
      branch_id: input.default_inbound_branch_id,
      request_id: requestId,
      metadata: {
        provider_key: 'whatsapp_cloud',
        phone_number_id: input.phone_number_id,
        credential_version: (previousSecret?.key_version ?? 0) + 1,
      },
    });
    if (auditError) throw auditError;
    return success(
      {
        connection_id: connectionId,
        provider_account_label:
          providerAccount.verified_name ??
          providerAccount.display_phone_number ??
          input.display_name,
        webhook_url: `${functionBase}/provider-webhook-whatsapp`,
        credential_status: 'CONFIGURED',
      },
      requestId,
      input.connection_id ? 200 : 201,
    );
  } catch (error) {
    const databaseCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const safeFailure =
      databaseCode === '23505'
        ? {
            code: 'WHATSAPP_CONNECTION_CONFLICT',
            message: 'This WhatsApp account is already connected or mapped.',
            status: 409,
          }
        : databaseCode === '23503'
          ? {
              code: 'WHATSAPP_SCOPE_REFERENCE_INVALID',
              message:
                'The selected branch or team is no longer valid. Refresh and select it again.',
              status: 422,
            }
          : databaseCode === '42501'
            ? {
                code: 'WHATSAPP_CONNECTION_SECURITY_DENIED',
                message: 'Your administrator account is not allowed to save this connection.',
                status: 403,
              }
            : {
                code: 'WHATSAPP_CONNECTION_FAILED',
                message:
                  failureStage === 'PROVIDER_TEST'
                    ? 'WhatsApp could not be reached. Check the provider configuration and retry.'
                    : `WhatsApp accepted the credential, but the CRM could not save it during ${failureStage.toLowerCase().replaceAll('_', ' ')}.`,
                status: 500,
              };

    console.error(
      JSON.stringify({
        request_id: requestId,
        service: 'integration-connect-whatsapp',
        safe_code: safeFailure.code,
        stage: failureStage,
        database_code: databaseCode || null,
      }),
    );
    if (organizationId) {
      const admin = serviceClient();
      await admin.from('error_logs').insert({
        organization_id: organizationId,
        reference_id: requestId,
        service: 'integration-connect-whatsapp',
        safe_code: safeFailure.code,
        safe_message: safeFailure.message,
        sanitized_context: {
          stage: failureStage,
          database_code: databaseCode || null,
          phone_number_id: phoneNumberId,
          whatsapp_business_account_id: whatsappBusinessAccountId,
        },
      });
      if (connectionId)
        await admin
          .from('connected_accounts')
          .update({ status: 'ERROR', last_error_code: safeFailure.code })
          .eq('id', connectionId)
          .eq('organization_id', organizationId);
    }
    return failure(safeFailure.code, safeFailure.message, requestId, safeFailure.status);
  }
});
