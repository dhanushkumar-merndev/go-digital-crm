import { z } from 'npm:zod@4';
import { decryptJson, encryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { piopiyNumber, type PiopiyCredential } from '../_shared/piopiy.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

// Saves a TeleCMI PIOPIY connection for auto calls (keypad IVR and the AI
// agent). The optional agent id names the PIOPIY Voice AI agent our
// voice-agent service connects as; it is not a secret. The Bearer token is
// stored encrypted and never returned; an edit with an empty token keeps the
// stored one. PIOPIY has no documented credential-test endpoint, so the first
// auto call is the live test and a rejected token pauses the dialers with
// PIOPIY_AUTH_FAILED.

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    app_id: z.string().trim().min(1).max(80),
    token: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().trim().min(16).max(2048).optional(),
    ),
    caller_id: z.string().trim().min(8).max(20),
    default_language: z
      .string()
      .trim()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .default('en-IN'),
    default_voice_id: z.string().trim().min(1).max(40).default('female'),
    agent_id: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{8,80}$/)
        .optional(),
    ),
  })
  .superRefine((input, context) => {
    if (!input.token && !input.connection_id)
      context.addIssue({ code: 'custom', path: ['token'], message: 'A token is required.' });
    if (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select one branch.' });
    if (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length < 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select branches.' });
    if (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Clear branches.' });
    try {
      piopiyNumber(input.caller_id);
    } catch {
      context.addIssue({ code: 'custom', path: ['caller_id'], message: 'Invalid number.' });
    }
  });

function newWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

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
          : 'The PIOPIY connection details are invalid.',
        requestId,
        422,
      );
    }
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: scopePermitted } = await client.rpc('authorize_telecmi_management_scope', {
      target_organization_id: input.organization_id,
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

    const admin = serviceClient();
    let previous: PiopiyCredential | null = null;
    if (input.connection_id) {
      const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
        target_organization_id: input.organization_id,
        target_connection_id: input.connection_id,
        target_permission: 'integration.manage',
      });
      if (!permitted)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot replace this connection.',
          requestId,
          403,
        );
      const { data: secret } = await admin
        .from('integration_credentials')
        .select('encrypted_payload')
        .eq('organization_id', input.organization_id)
        .eq('connected_account_id', input.connection_id)
        .maybeSingle();
      if (!secret)
        return failure(
          'PIOPIY_CONNECTION_NOT_FOUND',
          'The selected PIOPIY connection no longer exists.',
          requestId,
          404,
        );
      previous = await decryptJson<PiopiyCredential>(secret.encrypted_payload);
    }
    const token = input.token ?? previous?.token;
    if (!token) return failure('PIOPIY_TOKEN_REQUIRED', 'Enter the PIOPIY token.', requestId, 422);
    const credential: PiopiyCredential = {
      token,
      app_id: input.app_id,
      caller_id: piopiyNumber(input.caller_id),
      // Kept across edits so the callback URLs set in PIOPIY keep working.
      webhook_secret: previous?.webhook_secret ?? newWebhookSecret(),
    };
    const { data: saved, error: saveError } = await admin.rpc('save_piopiy_connection', {
      target_organization_id: input.organization_id,
      target_connection_id: input.connection_id ?? null,
      target_display_name: input.display_name,
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
      target_external_account_id: input.app_id,
      target_connection_config: {
        connection_type: 'AUTO_CALL_PROVIDER',
        capabilities: ['AUTO_CALL_IVR', 'AI_AGENT_CALL', 'CALL_RECORDING'],
        caller_id_label: credential.caller_id,
        default_language: input.default_language,
        default_voice_id: input.default_voice_id,
        ...(input.agent_id ? { agent_id: input.agent_id } : {}),
      },
      target_encrypted_payload: await encryptJson(credential),
      target_cipher_version: 'AES-256-GCM-v1',
      target_actor_id: auth.user.id,
      target_request_id: requestId,
    });
    if (saveError) throw saveError;
    const connectionId = (saved as { connection_id: string }).connection_id;
    const edgeBase = Deno.env.get('PUBLIC_EDGE_FUNCTION_BASE_URL')?.replace(/\/$/, '');
    if (!edgeBase) throw new Error('PUBLIC_EDGE_FUNCTION_BASE_URL_MISSING');
    const query = `connection_id=${connectionId}&token=${encodeURIComponent(credential.webhook_secret)}`;
    return success(
      {
        connection_id: connectionId,
        provider_key: 'telecmi_piopiy',
        status_webhook_url: `${edgeBase}/provider-webhook-piopiy?${query}`,
      },
      requestId,
      input.connection_id ? 200 : 201,
    );
  } catch {
    return failure(
      'PIOPIY_CONNECTION_FAILED',
      'The PIOPIY connection could not be saved.',
      requestId,
      500,
    );
  }
});
