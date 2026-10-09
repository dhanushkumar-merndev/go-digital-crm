import { z } from 'npm:zod@4';
import {
  Msg91SmsError,
  normalizeMsg91Mobile,
  sendMsg91TemplateSms,
} from '../../../src/lib/providers/msg91-sms-adapter.ts';
import { decryptJson, encryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import {
  MissingProviderSecretError,
  resolveStoredProviderSecret,
} from '../_shared/stored-provider-secret.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

/**
 * Tenant MSG91 connection for template SMS (drips and customer updates).
 *
 * The authkey is stored encrypted and never returned. MSG91 documents no
 * read-only "validate key" call, so a connection is proven the only honest way:
 * when a test mobile and an approved (DLT) template id are given, one real test
 * SMS is sent before anything is saved, and a failure saves nothing.
 */
const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120).default('MSG91 SMS'),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']).default('ALL_BRANCHES'),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    authkey: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().trim().min(10).max(200).optional(),
    ),
    sender_id: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{6}$/, 'Sender ID is 6 letters.')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    test_mobile: z.string().trim().max(20).optional().or(z.literal('')),
    test_template_id: z.string().trim().max(64).optional().or(z.literal('')),
  })
  .superRefine((input, context) => {
    if (!input.connection_id && !input.authkey)
      context.addIssue({
        code: 'custom',
        path: ['authkey'],
        message: 'An authkey is required for a new connection.',
      });
    if (new Set(input.branch_ids).size !== input.branch_ids.length)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Duplicate branch.' });
    if (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select one branch.' });
    if (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length < 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select branches.' });
    if (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Clear branches.' });
    if (Boolean(input.test_mobile) !== Boolean(input.test_template_id))
      context.addIssue({
        code: 'custom',
        path: ['test_template_id'],
        message: 'Give both a test mobile and a template id, or neither.',
      });
    if (input.test_mobile) {
      try {
        normalizeMsg91Mobile(input.test_mobile);
      } catch {
        context.addIssue({ code: 'custom', path: ['test_mobile'], message: 'Invalid mobile.' });
      }
    }
  });

type StoredCredential = { authkey: string; sender_id?: string | null };

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.filter((part) => typeof part === 'string').join('.');
      return failure(
        'INVALID_PAYLOAD',
        field
          ? `Check the ${field.replaceAll('_', ' ')} field: ${issue.message}`
          : 'The MSG91 connection details are invalid.',
        requestId,
        422,
      );
    }
    const input = parsed.data;

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
    let stored: StoredCredential | undefined;
    if (input.connection_id) {
      const { data: existing, error: existingError } = await admin
        .from('connected_accounts')
        .select('id')
        .eq('id', input.connection_id)
        .eq('organization_id', input.organization_id)
        .eq('provider_key', 'msg91')
        .is('deleted_at', null)
        .maybeSingle();
      if (existingError || !existing)
        return failure(
          'MSG91_CONNECTION_NOT_FOUND',
          'The selected MSG91 connection no longer exists.',
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
        stored = await decryptJson<StoredCredential>(secret.encrypted_payload);
    }
    const credential: StoredCredential = {
      authkey: resolveStoredProviderSecret(input.authkey, stored?.authkey, 'MSG91 authkey'),
      sender_id: input.sender_id ?? stored?.sender_id ?? null,
    };

    let testedAt: string | null = null;
    let testMessageId: string | null = null;
    if (input.test_mobile && input.test_template_id) {
      try {
        testMessageId = await sendMsg91TemplateSms({
          credential,
          templateId: input.test_template_id,
          recipient: input.test_mobile,
          variables: {},
        });
        testedAt = new Date().toISOString();
      } catch (error) {
        const code = error instanceof Msg91SmsError ? error.code : 'DRIP_SMS_PROVIDER_UNAVAILABLE';
        const messages: Record<string, string> = {
          DRIP_SMS_AUTH_FAILED:
            'MSG91 rejected the authkey. Check it, and that this server is allowed in its IP whitelist.',
          DRIP_SMS_IP_NOT_ALLOWED:
            'Allow this server IP in MSG91 Authkey settings, then try again.',
          DRIP_SMS_TEMPLATE_INVALID: 'MSG91 did not accept that template id.',
          DRIP_SMS_RATE_LIMITED: 'MSG91 is rate limiting this account. Try again in a minute.',
          DRIP_SMS_PROVIDER_UNAVAILABLE: 'MSG91 could not be reached. Try again shortly.',
        };
        return failure(
          'MSG91_TEST_FAILED',
          messages[code] ?? 'MSG91 did not send the test SMS. Nothing was saved.',
          requestId,
          422,
        );
      }
    }

    const { data: saved, error: saveError } = await admin.rpc('save_msg91_integration_connection', {
      target_organization_id: input.organization_id,
      target_actor_id: auth.user.id,
      target_connection_id: input.connection_id ?? null,
      target_display_name: input.display_name,
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
      target_encrypted_payload: await encryptJson(credential),
      target_tested_at: testedAt,
      target_sender_id: credential.sender_id,
      target_request_id: requestId,
    });
    if (saveError) throw saveError;
    return success(
      { ...saved, test_message_id: testMessageId },
      requestId,
      input.connection_id ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof MissingProviderSecretError)
      return failure('MSG91_AUTHKEY_REQUIRED', 'Enter the MSG91 authkey.', requestId, 422);
    return failure(
      'MSG91_CONNECT_FAILED',
      'The MSG91 connection could not be saved.',
      requestId,
      500,
    );
  }
});
