import { z } from 'npm:zod@4';
import {
  BrevoAccountError,
  verifyBrevoAccount,
} from '../../../src/lib/providers/brevo-account-adapter.ts';
import { encryptJson, decryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import {
  MissingProviderSecretError,
  resolveStoredProviderSecret,
} from '../_shared/stored-provider-secret.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120).default('Brevo Email'),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    api_key: z.preprocess(
      (v) => (typeof v === 'string' && !v.trim() ? undefined : v),
      z.string().trim().min(10).max(300).optional(),
    ),
    // A server-side installation can import a key whose existing worker delivery
    // was already verified. The interactive Tools flow uses the read-only check.
    test_connection: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    if (!input.connection_id && !input.api_key)
      ctx.addIssue({ code: 'custom', path: ['api_key'], message: 'An API key is required.' });
    if (
      new Set(input.branch_ids).size !== input.branch_ids.length ||
      (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1) ||
      (input.scope_mode === 'SELECTED_BRANCHES' && !input.branch_ids.length) ||
      (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['branch_ids'],
        message: 'Select branches matching the scope.',
      });
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
      return failure('INVALID_PAYLOAD', 'Check the Brevo key and branch scope.', requestId, 422);
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted, error: permissionError } = await client.rpc(
      'authorize_integration_scope',
      {
        target_organization_id: input.organization_id,
        target_permission: 'integration.manage',
        target_scope_mode: input.scope_mode,
        target_branch_ids: input.branch_ids,
      },
    );
    if (permissionError || !permitted)
      return failure(
        'BRANCH_SCOPE_DENIED',
        'The connection scope exceeds your authority.',
        requestId,
        403,
      );
    const admin = serviceClient();
    let stored: { api_key: string } | undefined;
    if (input.connection_id) {
      const { data: allowed, error: allowError } = await client.rpc(
        'authorize_integration_connection_action',
        {
          target_organization_id: input.organization_id,
          target_connection_id: input.connection_id,
          target_permission: 'integration.manage',
        },
      );
      if (allowError || !allowed)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot replace this connection.',
          requestId,
          403,
        );
      const { data: account, error: accountError } = await admin
        .from('connected_accounts')
        .select('id')
        .eq('id', input.connection_id)
        .eq('organization_id', input.organization_id)
        .eq('provider_key', 'brevo')
        .is('deleted_at', null)
        .maybeSingle();
      if (accountError || !account)
        return failure(
          'BREVO_CONNECTION_NOT_FOUND',
          'The Brevo connection no longer exists.',
          requestId,
          404,
        );
      const { data: secret, error: secretError } = await admin
        .from('integration_credentials')
        .select('encrypted_payload')
        .eq('organization_id', input.organization_id)
        .eq('connected_account_id', input.connection_id)
        .maybeSingle();
      if (secretError) throw secretError;
      if (secret?.encrypted_payload)
        stored = await decryptJson<{ api_key: string }>(secret.encrypted_payload);
    }
    const credential = {
      api_key: resolveStoredProviderSecret(input.api_key, stored?.api_key, 'Brevo API key'),
    };
    const account = input.test_connection ? await verifyBrevoAccount(credential.api_key) : null;
    const testedAt = account ? new Date().toISOString() : null;
    // Account, credential, branch mappings and audit are committed together.
    const { data: result, error: saveError } = await admin.rpc(
      'save_brevo_integration_connection',
      {
        target_organization_id: input.organization_id,
        target_actor_id: auth.user.id,
        target_connection_id: input.connection_id ?? null,
        target_display_name: input.display_name,
        target_scope_mode: input.scope_mode,
        target_branch_ids: input.branch_ids,
        target_encrypted_payload: await encryptJson(credential),
        target_tested_at: testedAt,
        target_account_email: account?.email ?? null,
        target_request_id: requestId,
      },
    );
    if (saveError) throw saveError;
    return success(result, requestId, input.connection_id ? 200 : 201);
  } catch (error) {
    if (error instanceof MissingProviderSecretError)
      return failure('BREVO_API_KEY_REQUIRED', 'Enter the Brevo API key.', requestId, 422);
    if (error instanceof BrevoAccountError) {
      const messages = {
        BREVO_IP_NOT_ALLOWED:
          'Authorize this server IP in Brevo Security settings, then try again.',
        BREVO_AUTH_FAILED: 'Brevo rejected the API key.',
        BREVO_RATE_LIMITED: 'Brevo is rate limiting requests. Try again shortly.',
        BREVO_UNAVAILABLE: 'Brevo could not be reached. Try again shortly.',
      };
      return failure(error.code, messages[error.code], requestId, 422);
    }
    return failure(
      'BREVO_CONNECT_FAILED',
      'The Brevo connection could not be saved.',
      requestId,
      500,
    );
  }
});
